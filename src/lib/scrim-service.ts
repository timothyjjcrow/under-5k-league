import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  MATCH_STATUS,
  ROLE,
  SCRIM_STATUS,
  SEASON_STATUS,
  TEAM_STAFF_ROLE,
} from "./constants";
import {
  dotaAccountClaimWhere,
  effectiveDotaAccountId,
} from "./dota-account";
import { parseAccountId } from "./dota";
import { singleActiveSeason } from "./season";
import { UserFacingError } from "./user-facing-error";
import { parseAdminSteamIds, resolveSessionRole } from "./users";
import {
  hasConfirmedScrimConflict,
  scrimCollisionRange,
} from "./scrim-schedule-conflict";

const PAST_GRACE_MS = 60 * 60 * 1000;
const MAX_AHEAD_MS = 180 * 24 * 60 * 60 * 1000;
export { SCRIM_COLLISION_WINDOW_MS } from "./scrim-schedule-conflict";
export const SCRIM_GUEST_LIMIT_PER_TEAM = 5;
export const SCRIM_GUEST_NAME_MAX_LENGTH = 60;

type Db = Prisma.TransactionClient;

type ScrimAccessRow = {
  id: string;
  seasonId: string;
  hostTeamId: string;
  opponentTeamId: string | null;
  status: string;
  hostTeam: { captainId: string; withdrawn: boolean; name: string };
  opponentTeam: {
    captainId: string;
    withdrawn: boolean;
    name: string;
  } | null;
};

export type ScrimMutationSummary = {
  id: string;
  seasonId: string;
  scheduledAt: Date;
  bestOf: number;
  status: string;
  hostTeam: { id: string; name: string };
  opponentTeam: { id: string; name: string } | null;
  snapshottedParticipants: number;
  cancelledOpenOffers: number;
};

export type ScrimManagementAccess = {
  scrim: ScrimAccessRow;
  /** Null only for an unaffiliated administrator. */
  teamId: string | null;
  isAdmin: boolean;
};

export type ScrimGuestSummary = {
  id: string;
  scrimId: string;
  teamId: string;
  displayName: string;
  dotaAccountId: number;
};

export type TeamCoachSummary = {
  id: string;
  teamId: string;
  userId: string;
  name: string;
  dotaAccountId: number;
};

function hasPrismaCode(error: unknown, code: string): boolean {
  return (error as { code?: string }).code === code;
}

function assertSaneScrimTime(scheduledAt: Date, now = new Date()): void {
  if (!(scheduledAt instanceof Date) || !Number.isFinite(scheduledAt.getTime())) {
    throw new UserFacingError("Choose a valid scrim time");
  }
  if (scheduledAt.getTime() < now.getTime() - PAST_GRACE_MS) {
    throw new UserFacingError("That scrim time is in the past");
  }
  if (scheduledAt.getTime() > now.getTime() + MAX_AHEAD_MS) {
    throw new UserFacingError("That scrim time is too far out — check the year");
  }
}

function assertBestOf(bestOf: number): void {
  if (!Number.isInteger(bestOf) || bestOf < 1 || bestOf > 5) {
    throw new UserFacingError("Best-of must be a whole number from 1 to 5");
  }
}

function normalizeGuestName(displayName: string): string {
  const name = typeof displayName === "string" ? displayName.trim() : "";
  if (!name) throw new UserFacingError("Enter the guest's display name");
  if (name.length > SCRIM_GUEST_NAME_MAX_LENGTH) {
    throw new UserFacingError(
      `Guest names must be ${SCRIM_GUEST_NAME_MAX_LENGTH} characters or fewer`,
    );
  }
  if (/\p{Cc}/u.test(name)) {
    throw new UserFacingError("Guest names must stay on one line");
  }
  return name;
}

function normalizeAccountId(accountRef: number | string): number {
  if (
    typeof accountRef === "number" &&
    Number.isInteger(accountRef) &&
    accountRef > 0 &&
    accountRef <= 0xffffffff
  ) {
    return accountRef;
  }
  const accountId = parseAccountId(String(accountRef));
  if (accountId == null) {
    throw new UserFacingError("Enter a valid Dota account or Steam profile");
  }
  return accountId;
}

async function requireActiveScrimSeason(db: Db) {
  const season = await db.season
    .findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, status: true },
    })
    .then(singleActiveSeason);
  if (!season) throw new UserFacingError("There is no active season");
  if (season.status === SEASON_STATUS.COMPLETE) {
    throw new UserFacingError("Scrims are closed because the season is complete");
  }
  return season;
}

async function requireCaptainTeam(db: Db, viewerId: string, seasonId: string) {
  const team = await db.team.findUnique({
    where: { seasonId_captainId: { seasonId, captainId: viewerId } },
    select: { id: true, name: true, withdrawn: true },
  });
  if (!team) {
    throw new UserFacingError("Only an active league team captain can do that");
  }
  if (team.withdrawn) {
    throw new UserFacingError("Withdrawn teams cannot schedule scrims");
  }
  return team;
}

async function assertedAdmin(
  db: Db,
  viewerId: string,
  isAdmin: boolean,
): Promise<boolean> {
  if (!isAdmin) return false;
  const viewer = await db.user.findUnique({
    where: { id: viewerId },
    select: { steamId: true, role: true },
  });
  return !!viewer &&
    resolveSessionRole({
      steamId: viewer.steamId,
      storedRole: viewer.role,
      adminSteamIds: parseAdminSteamIds(process.env.ADMIN_STEAM_IDS),
      production: process.env.NODE_ENV === "production",
    }) === ROLE.ADMIN;
}

/**
 * Refuse a confirmed scrim when this team already has another confirmed scrim
 * or an unfinished official fixture within four hours in either direction.
 * OPEN offers are intentionally not reservations: a captain can advertise a
 * few workable times, and joining one atomically cancels the overlapping ones.
 */
async function assertTeamTimeAvailable(
  db: Db,
  seasonId: string,
  team: { id: string; name: string },
  scheduledAt: Date,
  exceptScrimId?: string,
): Promise<void> {
  const range = scrimCollisionRange(scheduledAt);
  const [officialMatch, scrimConflict] = await Promise.all([
    db.match.findFirst({
      where: {
        seasonId,
        scheduledAt: range,
        status: { not: MATCH_STATUS.COMPLETED },
        OR: [{ homeTeamId: team.id }, { awayTeamId: team.id }],
      },
      select: { id: true },
    }),
    hasConfirmedScrimConflict(db, {
      seasonId,
      teamIds: [team.id],
      scheduledAt,
      exceptScrimId,
    }),
  ]);
  if (officialMatch) {
    throw new UserFacingError(
      `${team.name} already has a league match within four hours of that time`,
    );
  }
  if (scrimConflict) {
    throw new UserFacingError(
      `${team.name} already has a confirmed scrim within four hours of that time`,
    );
  }
}

async function rosterSnapshot(
  db: Db,
  scrimId: string,
  teamId: string,
): Promise<Prisma.ScrimParticipantCreateManyInput[]> {
  const memberships = await db.teamMember.findMany({
    where: { teamId },
    orderBy: { createdAt: "asc" },
    select: {
      userId: true,
      user: {
        select: {
          name: true,
          steamId: true,
          dotaAccountIdV2: true,
          legacyDotaAccountId: true,
        },
      },
    },
  });

  const seen = new Set<number>();
  const rows: Prisma.ScrimParticipantCreateManyInput[] = [];
  for (const membership of memberships) {
    const accountId = effectiveDotaAccountId(membership.user);
    // A malformed legacy Steam identity should not prevent the team from
    // posting. It simply cannot help player-id discovery until it is fixed.
    if (accountId == null) continue;
    if (seen.has(accountId)) {
      throw new UserFacingError(
        "This team roster has the same Dota account linked more than once",
      );
    }
    seen.add(accountId);
    rows.push({
      scrimId,
      teamId,
      userId: membership.userId,
      dotaAccountId: accountId,
      displayName: membership.user.name,
      guest: false,
      addedById: null,
    });
  }
  return rows;
}

async function loadScrimAccessRow(
  db: Db,
  scrimId: string,
): Promise<ScrimAccessRow> {
  const scrim = await db.scrim.findUnique({
    where: { id: scrimId },
    select: {
      id: true,
      seasonId: true,
      hostTeamId: true,
      opponentTeamId: true,
      status: true,
      hostTeam: {
        select: { captainId: true, withdrawn: true, name: true },
      },
      opponentTeam: {
        select: { captainId: true, withdrawn: true, name: true },
      },
    },
  });
  if (!scrim) throw new UserFacingError("Scrim not found");
  return scrim;
}

async function managementAccess(
  db: Db,
  viewerId: string,
  isAdmin: boolean,
  scrimId: string,
): Promise<ScrimManagementAccess> {
  const [scrim, admin] = await Promise.all([
    loadScrimAccessRow(db, scrimId),
    assertedAdmin(db, viewerId, isAdmin),
  ]);
  const sideIds = [scrim.hostTeamId, scrim.opponentTeamId].filter(
    (teamId): teamId is string => teamId != null,
  );
  const captainSides = [
    scrim.hostTeam.captainId === viewerId ? scrim.hostTeamId : null,
    scrim.opponentTeam?.captainId === viewerId
      ? scrim.opponentTeamId
      : null,
  ].filter((teamId): teamId is string => teamId != null);
  const coachedSides = await db.teamStaff.findMany({
    where: {
      userId: viewerId,
      role: TEAM_STAFF_ROLE.COACH,
      teamId: { in: sideIds },
    },
    select: { teamId: true },
  });
  const affiliatedSides = [
    ...new Set([
      ...captainSides,
      ...coachedSides.map((staff) => staff.teamId),
    ]),
  ];
  if (affiliatedSides.length > 1) {
    throw new UserFacingError(
      "Your staff roles cover both sides of this scrim; ask an admin to resolve them",
    );
  }
  if (affiliatedSides.length === 0 && !admin) {
    throw new UserFacingError(
      "Only a participating captain, coach, or admin can manage this scrim",
    );
  }
  return {
    scrim,
    teamId: affiliatedSides[0] ?? null,
    isAdmin: admin,
  };
}

/** Read-time access helper for result/reporting services and thin actions. */
export async function getScrimManagementAccess(
  viewerId: string,
  isAdmin: boolean,
  scrimId: string,
): Promise<ScrimManagementAccess> {
  return managementAccess(prisma, viewerId, isAdmin, scrimId);
}

/** A captain posts one available scrim time for their current active team. */
export async function createScrim(
  viewerId: string,
  scheduledAt: Date,
  bestOf: number,
): Promise<ScrimMutationSummary> {
  assertSaneScrimTime(scheduledAt);
  assertBestOf(bestOf);
  try {
    return await prisma.$transaction(
      async (tx) => {
        assertSaneScrimTime(scheduledAt);
        const season = await requireActiveScrimSeason(tx);
        const team = await requireCaptainTeam(tx, viewerId, season.id);
        await assertTeamTimeAvailable(tx, season.id, team, scheduledAt);

        const scrim = await tx.scrim.create({
          data: {
            seasonId: season.id,
            hostTeamId: team.id,
            createdById: viewerId,
            scheduledAt,
            bestOf,
            status: SCRIM_STATUS.OPEN,
          },
          select: {
            id: true,
            seasonId: true,
            scheduledAt: true,
            bestOf: true,
            status: true,
          },
        });
        const participants = await rosterSnapshot(tx, scrim.id, team.id);
        if (participants.length > 0) {
          await tx.scrimParticipant.createMany({ data: participants });
        }
        return {
          ...scrim,
          hostTeam: { id: team.id, name: team.name },
          opponentTeam: null,
          snapshottedParticipants: participants.length,
          cancelledOpenOffers: 0,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (hasPrismaCode(error, "P2034")) {
      throw new UserFacingError(
        "Your team schedule just changed — reload and try posting that scrim again",
      );
    }
    throw error;
  }
}

/** An opposing captain atomically claims an OPEN offer for their own team. */
export async function joinScrim(
  viewerId: string,
  scrimId: string,
): Promise<ScrimMutationSummary> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const season = await requireActiveScrimSeason(tx);
        const joiningTeam = await requireCaptainTeam(tx, viewerId, season.id);
        const offer = await tx.scrim.findUnique({
          where: { id: scrimId },
          select: {
            id: true,
            seasonId: true,
            hostTeamId: true,
            opponentTeamId: true,
            scheduledAt: true,
            bestOf: true,
            status: true,
            hostTeam: {
              select: { id: true, name: true, withdrawn: true },
            },
          },
        });
        if (!offer || offer.status !== SCRIM_STATUS.OPEN) {
          throw new UserFacingError("That scrim offer is no longer open");
        }
        if (offer.seasonId !== season.id) {
          throw new UserFacingError("That scrim belongs to an archived season");
        }
        if (offer.opponentTeamId != null) {
          throw new UserFacingError("Another team already joined that scrim");
        }
        if (offer.hostTeam.withdrawn) {
          throw new UserFacingError("The team that posted this scrim withdrew");
        }
        if (offer.hostTeamId === joiningTeam.id) {
          throw new UserFacingError("A team cannot join its own scrim offer");
        }
        assertSaneScrimTime(offer.scheduledAt);
        await Promise.all([
          assertTeamTimeAvailable(
            tx,
            season.id,
            offer.hostTeam,
            offer.scheduledAt,
            offer.id,
          ),
          assertTeamTimeAvailable(
            tx,
            season.id,
            joiningTeam,
            offer.scheduledAt,
            offer.id,
          ),
        ]);

        const participants = await rosterSnapshot(
          tx,
          offer.id,
          joiningTeam.id,
        );
        if (participants.length > 0) {
          const existingAccounts = new Set(
            (
              await tx.scrimParticipant.findMany({
                where: { scrimId: offer.id },
                select: { dotaAccountId: true },
              })
            ).map((participant) => participant.dotaAccountId),
          );
          if (
            participants.some((participant) =>
              existingAccounts.has(participant.dotaAccountId),
            )
          ) {
            throw new UserFacingError(
              "The two lineups share a Dota account, so this scrim cannot be matched safely",
            );
          }
        }

        const claimed = await tx.scrim.updateMany({
          where: {
            id: offer.id,
            status: SCRIM_STATUS.OPEN,
            opponentTeamId: null,
          },
          data: {
            opponentTeamId: joiningTeam.id,
            status: SCRIM_STATUS.SCHEDULED,
          },
        });
        if (claimed.count !== 1) {
          throw new UserFacingError("Another team already joined that scrim");
        }
        if (participants.length > 0) {
          await tx.scrimParticipant.createMany({ data: participants });
        }

        const cancelled = await tx.scrim.updateMany({
          where: {
            id: { not: offer.id },
            seasonId: season.id,
            status: SCRIM_STATUS.OPEN,
            scheduledAt: scrimCollisionRange(offer.scheduledAt),
            OR: [
              { hostTeamId: { in: [offer.hostTeamId, joiningTeam.id] } },
              { opponentTeamId: { in: [offer.hostTeamId, joiningTeam.id] } },
            ],
          },
          data: { status: SCRIM_STATUS.CANCELLED },
        });

        return {
          id: offer.id,
          seasonId: offer.seasonId,
          scheduledAt: offer.scheduledAt,
          bestOf: offer.bestOf,
          status: SCRIM_STATUS.SCHEDULED,
          hostTeam: { id: offer.hostTeam.id, name: offer.hostTeam.name },
          opponentTeam: { id: joiningTeam.id, name: joiningTeam.name },
          snapshottedParticipants: participants.length,
          cancelledOpenOffers: cancelled.count,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (hasPrismaCode(error, "P2034")) {
      throw new UserFacingError(
        "That scrim or a team schedule just changed — reload and try again",
      );
    }
    if (hasPrismaCode(error, "P2002")) {
      throw new UserFacingError(
        "That scrim was claimed or one of its Dota accounts is already in the lineup",
      );
    }
    throw error;
  }
}

/** A participating captain or a verified admin cancels an unplayed scrim. */
export async function cancelScrim(
  viewerId: string,
  isAdmin: boolean,
  scrimId: string,
): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        const season = await requireActiveScrimSeason(tx);
        const [scrim, admin] = await Promise.all([
          loadScrimAccessRow(tx, scrimId),
          assertedAdmin(tx, viewerId, isAdmin),
        ]);
        if (scrim.seasonId !== season.id) {
          throw new UserFacingError("That scrim belongs to an archived season");
        }
        if (scrim.status === SCRIM_STATUS.LIVE) {
          throw new UserFacingError("A live scrim can no longer be cancelled");
        }
        if (
          scrim.status === SCRIM_STATUS.COMPLETED ||
          scrim.status === SCRIM_STATUS.CANCELLED
        ) {
          throw new UserFacingError("That scrim can no longer be cancelled");
        }
        const isCaptain =
          scrim.hostTeam.captainId === viewerId ||
          scrim.opponentTeam?.captainId === viewerId;
        if (!isCaptain && !admin) {
          throw new UserFacingError(
            "Only a participating captain or admin can cancel this scrim",
          );
        }
        const cancelled = await tx.scrim.updateMany({
          where: {
            id: scrim.id,
            status: { in: [SCRIM_STATUS.OPEN, SCRIM_STATUS.SCHEDULED] },
          },
          data: { status: SCRIM_STATUS.CANCELLED },
        });
        if (cancelled.count !== 1) {
          throw new UserFacingError("That scrim can no longer be cancelled");
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (hasPrismaCode(error, "P2034")) {
      throw new UserFacingError(
        "That scrim just changed — reload before cancelling it",
      );
    }
    throw error;
  }
}

/** Add one account-only, per-scrim guest to the viewer's participating side. */
export async function addScrimGuest(
  viewerId: string,
  isAdmin: boolean,
  scrimId: string,
  displayName: string,
  accountRef: number | string,
): Promise<ScrimGuestSummary> {
  const name = normalizeGuestName(displayName);
  const accountId = normalizeAccountId(accountRef);
  try {
    return await prisma.$transaction(
      async (tx) => {
        const access = await managementAccess(tx, viewerId, isAdmin, scrimId);
        if (
          access.scrim.status !== SCRIM_STATUS.OPEN &&
          access.scrim.status !== SCRIM_STATUS.SCHEDULED &&
          access.scrim.status !== SCRIM_STATUS.LIVE
        ) {
          throw new UserFacingError("Guests can only be changed before a scrim is played");
        }
        if (access.scrim.status !== SCRIM_STATUS.LIVE) {
          const season = await requireActiveScrimSeason(tx);
          if (access.scrim.seasonId !== season.id) {
            throw new UserFacingError("That scrim belongs to an archived season");
          }
        }
        // With no team id in the public API, an unaffiliated admin cannot make
        // an ambiguous cross-side write. Remove is still admin-repairable
        // because the participant row identifies the side.
        if (!access.teamId) {
          throw new UserFacingError(
            "Choose a participating team account before adding a guest",
          );
        }
        const sideWithdrawn =
          access.teamId === access.scrim.hostTeamId
            ? access.scrim.hostTeam.withdrawn
            : access.scrim.opponentTeam?.withdrawn;
        if (sideWithdrawn && access.scrim.status !== SCRIM_STATUS.LIVE) {
          throw new UserFacingError("Withdrawn teams cannot add scrim guests");
        }
        const [guestCount, duplicate] = await Promise.all([
          tx.scrimParticipant.count({
            where: {
              scrimId,
              teamId: access.teamId,
              guest: true,
            },
          }),
          tx.scrimParticipant.findUnique({
            where: {
              scrimId_dotaAccountId: { scrimId, dotaAccountId: accountId },
            },
            select: { teamId: true },
          }),
        ]);
        if (guestCount >= SCRIM_GUEST_LIMIT_PER_TEAM) {
          throw new UserFacingError(
            `A team can add at most ${SCRIM_GUEST_LIMIT_PER_TEAM} guests to one scrim`,
          );
        }
        if (duplicate) {
          throw new UserFacingError(
            duplicate.teamId === access.teamId
              ? "That Dota account is already on your scrim lineup"
              : "That Dota account is already on the opposing scrim lineup",
          );
        }
        const participant = await tx.scrimParticipant.create({
          data: {
            scrimId,
            teamId: access.teamId,
            userId: null,
            dotaAccountId: accountId,
            displayName: name,
            guest: true,
            addedById: viewerId,
          },
          select: {
            id: true,
            scrimId: true,
            teamId: true,
            displayName: true,
            dotaAccountId: true,
          },
        });
        return participant;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (hasPrismaCode(error, "P2034") || hasPrismaCode(error, "P2002")) {
      throw new UserFacingError(
        "That scrim lineup just changed — reload and try adding the guest again",
      );
    }
    throw error;
  }
}

/** Remove only a guest row; official roster snapshots stay immutable. */
export async function removeScrimGuest(
  viewerId: string,
  isAdmin: boolean,
  participantId: string,
): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        const participant = await tx.scrimParticipant.findUnique({
          where: { id: participantId },
          select: {
            id: true,
            scrimId: true,
            teamId: true,
            guest: true,
          },
        });
        if (!participant || !participant.guest) {
          throw new UserFacingError("Scrim guest not found");
        }
        const access = await managementAccess(
          tx,
          viewerId,
          isAdmin,
          participant.scrimId,
        );
        if (
          access.scrim.status !== SCRIM_STATUS.OPEN &&
          access.scrim.status !== SCRIM_STATUS.SCHEDULED &&
          access.scrim.status !== SCRIM_STATUS.LIVE
        ) {
          throw new UserFacingError("Guests can only be changed before a scrim is played");
        }
        if (access.scrim.status !== SCRIM_STATUS.LIVE) {
          const season = await requireActiveScrimSeason(tx);
          if (access.scrim.seasonId !== season.id) {
            throw new UserFacingError("That scrim belongs to an archived season");
          }
        }
        if (access.teamId !== participant.teamId && !access.isAdmin) {
          throw new UserFacingError("You can only remove guests from your own side");
        }
        const removed = await tx.scrimParticipant.deleteMany({
          where: { id: participant.id, guest: true },
        });
        if (removed.count !== 1) {
          throw new UserFacingError("That scrim guest was already removed");
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (hasPrismaCode(error, "P2034")) {
      throw new UserFacingError(
        "That scrim lineup just changed — reload before removing the guest",
      );
    }
    throw error;
  }
}

async function userByAccountRef(db: Db, accountRef: string) {
  const accountId = normalizeAccountId(accountRef);
  const candidates = await db.user.findMany({
    where: dotaAccountClaimWhere(accountId),
    take: 3,
    select: {
      id: true,
      name: true,
      steamId: true,
      dotaAccountIdV2: true,
      legacyDotaAccountId: true,
    },
  });
  const matches = candidates.filter(
    (candidate) => effectiveDotaAccountId(candidate) === accountId,
  );
  if (matches.length === 0) {
    throw new UserFacingError(
      "That account does not belong to an existing site user",
    );
  }
  if (matches.length > 1) {
    throw new UserFacingError(
      "More than one user claims that Dota account; resolve the account links first",
    );
  }
  return { ...matches[0], accountId };
}

/**
 * Add an existing site user as COACH. Captains always target their own team.
 * An unaffiliated verified admin may name an active-season team explicitly.
 */
export async function addTeamCoach(
  viewerId: string,
  isAdmin: boolean,
  coachRef: string,
  adminTeamId?: string,
): Promise<TeamCoachSummary> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const season = await requireActiveScrimSeason(tx);
        const captainTeam = await tx.team.findUnique({
          where: {
            seasonId_captainId: { seasonId: season.id, captainId: viewerId },
          },
          select: { id: true, withdrawn: true, captainId: true },
        });
        const admin = await assertedAdmin(tx, viewerId, isAdmin);
        const team = captainTeam
          ? captainTeam
          : admin && adminTeamId
            ? await tx.team.findFirst({
                where: { id: adminTeamId, seasonId: season.id },
                select: { id: true, withdrawn: true, captainId: true },
              })
            : null;
        if (!team) {
          throw new UserFacingError(
            admin
              ? "Choose an active-season team for this coach"
              : "Only a team captain or admin can add a coach",
          );
        }
        if (team.withdrawn) {
          throw new UserFacingError("Withdrawn teams cannot add coaches");
        }
        const coach = await userByAccountRef(tx, coachRef);
        if (coach.id === team.captainId) {
          throw new UserFacingError("That user already captains this team");
        }
        const existing = await tx.teamStaff.findUnique({
          where: { teamId_userId: { teamId: team.id, userId: coach.id } },
          select: { id: true },
        });
        if (existing) throw new UserFacingError("That user is already this team's coach");

        const staff = await tx.teamStaff.create({
          data: {
            teamId: team.id,
            userId: coach.id,
            role: TEAM_STAFF_ROLE.COACH,
          },
          select: { id: true, teamId: true, userId: true },
        });
        return {
          ...staff,
          name: coach.name,
          dotaAccountId: coach.accountId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (hasPrismaCode(error, "P2034") || hasPrismaCode(error, "P2002")) {
      throw new UserFacingError(
        "That team's staff just changed — reload and try adding the coach again",
      );
    }
    throw error;
  }
}

/** A team's captain or a verified admin removes its COACH row. */
export async function removeTeamCoach(
  viewerId: string,
  isAdmin: boolean,
  staffId: string,
): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        const season = await requireActiveScrimSeason(tx);
        const [staff, admin] = await Promise.all([
          tx.teamStaff.findUnique({
            where: { id: staffId },
            select: {
              id: true,
              role: true,
              team: {
                select: { id: true, seasonId: true, captainId: true },
              },
            },
          }),
          assertedAdmin(tx, viewerId, isAdmin),
        ]);
        if (!staff || staff.role !== TEAM_STAFF_ROLE.COACH) {
          throw new UserFacingError("Team coach not found");
        }
        if (staff.team.seasonId !== season.id) {
          throw new UserFacingError("That coach belongs to an archived season");
        }
        if (staff.team.captainId !== viewerId && !admin) {
          throw new UserFacingError("Only the team's captain or admin can remove a coach");
        }
        const removed = await tx.teamStaff.deleteMany({
          where: { id: staff.id, role: TEAM_STAFF_ROLE.COACH },
        });
        if (removed.count !== 1) {
          throw new UserFacingError("That coach was already removed");
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (hasPrismaCode(error, "P2034")) {
      throw new UserFacingError(
        "That team's staff just changed — reload before removing the coach",
      );
    }
    throw error;
  }
}
