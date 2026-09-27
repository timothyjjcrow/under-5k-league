import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { MATCH_PHASE, MATCH_STATUS, REGISTRATION_STATUS } from "./constants";
import {
  AVAILABILITY,
  CHECKIN_REFUSAL,
  CHECKIN_REFUSAL_MESSAGE,
  checkinClosedReason,
  type AvailabilityStatus,
  type CheckinRefusal,
} from "./availability";
import {
  awayFixtureLabel,
  awayScheduleVerdict,
  awaySeatVerdict,
  inAwayRange,
  type AwayCardFixture,
  type AwayFixtureRef,
  type AwayRange,
  type AwayRangeReport,
  type AwaySkip,
  type SeenFixture,
} from "./away-range";
import { postAuctionWorkOpen } from "./league-lifecycle";
import { loadPlayoffRoundsBySeason } from "./playoff-rounds";
import { singleActiveSeason } from "./season";
import { UserFacingError } from "./user-facing-error";

// Match-night check-in writes. setAvailability (one fixture) and
// markAwayRange (every fixture in a date range) share the seat rules and the
// write below, so "who may answer this fixture" has one definition.

type Tx = Prisma.TransactionClient;

/** The match fields every check-in decision reads. */
export type CheckinMatch = {
  id: string;
  seasonId: string;
  scheduleRevision: number;
  homeTeamId: string;
  awayTeamId: string;
  homeTeam: { captainId: string; withdrawn: boolean };
  awayTeam: { captainId: string; withdrawn: boolean };
};

export type CheckinSeat =
  | {
      /** The side losing a player on an OUT: the roster seat's team, or the
       *  team a standin covers. Its captain is who has to find cover. */
      teamId: string;
      captainId: string;
    }
  | { refusal: CheckinRefusal };

/**
 * Who answers for `teamId` on this fixture: its rostered players, minus any
 * whose named seat a standin has taken, plus the standins covering it. A
 * booking that names someone no longer on the roster covers nothing, and a
 * standin only counts while their signup (if any) is active and they aren't
 * rostered anywhere this season. Pass the caller's transaction when there is
 * one, so roster, cover and registration changes contend with its write.
 */
export async function loadSidePlayerIds(
  db: Pick<Tx, "teamMember" | "standinAssignment" | "registration">,
  match: { id: string; seasonId: string },
  teamId: string,
): Promise<Set<string>> {
  const [members, bookings] = await Promise.all([
    db.teamMember.findMany({
      where: { seasonId: match.seasonId, teamId },
      select: { userId: true },
    }),
    db.standinAssignment.findMany({
      where: { matchId: match.id, teamId },
      select: { standinUserId: true, replacingUserId: true },
    }),
  ]);
  const memberIds = new Set(members.map((m) => m.userId));
  const cover = bookings.filter(
    (b) => b.replacingUserId == null || memberIds.has(b.replacingUserId),
  );
  const covered = new Set(cover.map((b) => b.replacingUserId));
  const players = new Set([...memberIds].filter((id) => !covered.has(id)));
  const standinIds = cover.map((b) => b.standinUserId);
  if (standinIds.length === 0) return players;
  const [registrations, rostered] = await Promise.all([
    db.registration.findMany({
      where: { seasonId: match.seasonId, userId: { in: standinIds } },
      select: { userId: true, status: true },
    }),
    db.teamMember.findMany({
      where: { seasonId: match.seasonId, userId: { in: standinIds } },
      select: { userId: true },
    }),
  ]);
  const statusOf = new Map(registrations.map((r) => [r.userId, r.status]));
  const rosteredIds = new Set(rostered.map((m) => m.userId));
  for (const id of standinIds) {
    const status = statusOf.get(id);
    if ((status === undefined || status === REGISTRATION_STATUS.ACTIVE) && !rosteredIds.has(id)) {
      players.add(id);
    }
  }
  return players;
}

/**
 * Which side, if any, `userId` answers for on this fixture. Rostered players
 * answer unless a standin has taken their named seat; assigned standins
 * answer for the team they cover; and `loadSidePlayerIds` has the final say.
 * Read inside the caller's SERIALIZABLE transaction, so roster, cover and
 * registration changes contend with the write that follows.
 */
export async function resolveCheckinSeat(
  tx: Tx,
  match: CheckinMatch,
  userId: string,
): Promise<CheckinSeat> {
  const teamIds = [match.homeTeamId, match.awayTeamId];
  const [onRoster, replacedSeat, standinSeat] = await Promise.all([
    tx.teamMember.findFirst({
      where: { seasonId: match.seasonId, userId, teamId: { in: teamIds } },
      select: { teamId: true },
    }),
    tx.standinAssignment.findFirst({
      where: { matchId: match.id, replacingUserId: userId },
      select: { id: true },
    }),
    tx.standinAssignment.findFirst({
      where: { matchId: match.id, standinUserId: userId, teamId: { in: teamIds } },
      select: { teamId: true },
    }),
  ]);
  if (onRoster && replacedSeat) return { refusal: CHECKIN_REFUSAL.COVERED };
  if (!onRoster && !standinSeat) return { refusal: CHECKIN_REFUSAL.NOT_PLAYING };
  const teamId = onRoster?.teamId ?? standinSeat!.teamId;
  const team = teamId === match.homeTeamId ? match.homeTeam : match.awayTeam;
  if (team.withdrawn) return { refusal: CHECKIN_REFUSAL.WITHDRAWN };
  if (!(await loadSidePlayerIds(tx, match, teamId)).has(userId)) {
    return { refusal: CHECKIN_REFUSAL.INELIGIBLE };
  }
  return { teamId, captainId: team.captainId };
}

/**
 * The player's answer for the fixture's CURRENT kickoff. A row written for an
 * earlier scheduleRevision answered a night nobody is playing, so it counts
 * as no answer — exactly how every check-in count reads it.
 */
export async function currentCheckinStatus(
  tx: Tx,
  match: { id: string; scheduleRevision: number },
  userId: string,
): Promise<string | null> {
  const prior = await tx.matchAvailability.findUnique({
    where: { matchId_userId: { matchId: match.id, userId } },
    select: { status: true, scheduleRevision: true },
  });
  return prior?.scheduleRevision === match.scheduleRevision ? prior.status : null;
}

/** Write an answer for the fixture's current kickoff. */
export async function recordCheckin(
  tx: Tx,
  match: { id: string; scheduleRevision: number },
  userId: string,
  status: AvailabilityStatus,
): Promise<void> {
  await tx.matchAvailability.upsert({
    where: { matchId_userId: { matchId: match.id, userId } },
    create: { matchId: match.id, userId, status, scheduleRevision: match.scheduleRevision },
    update: { status, scheduleRevision: match.scheduleRevision },
  });
}

/**
 * The fixtures an "I'm away" range can mark for this player right now: the
 * active season's upcoming, timed, unplayed fixtures they hold a seat on,
 * judged by the same seat rules markAwayRange writes with. Null when there
 * are none, which is also the card's render gate.
 */
export async function listAwayFixtures(
  userId: string,
  nowMs: number,
): Promise<{ seasonId: string; fixtures: AwayCardFixture[] } | null> {
  const season = await prisma.season
    .findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, status: true, draft: { select: { status: true } } },
    })
    .then(singleActiveSeason);
  if (!season || !postAuctionWorkOpen(season.status, season.draft?.status)) {
    return null;
  }
  const memberships = await prisma.teamMember.findMany({
    where: { seasonId: season.id, userId },
    select: { teamId: true },
  });
  const teamIds = memberships.map((m) => m.teamId);
  const matches = await prisma.match.findMany({
    where: {
      seasonId: season.id,
      status: MATCH_STATUS.SCHEDULED,
      scheduledAt: { gte: new Date(nowMs) },
      OR: [
        ...(teamIds.length
          ? [{ homeTeamId: { in: teamIds } }, { awayTeamId: { in: teamIds } }]
          : []),
        { standins: { some: { standinUserId: userId } } },
      ],
    },
    orderBy: [{ scheduledAt: "asc" }, { week: "asc" }, { id: "asc" }],
    select: {
      id: true,
      seasonId: true,
      week: true,
      phase: true,
      bracketSlot: true,
      status: true,
      scheduledAt: true,
      scheduleRevision: true,
      homeTeamId: true,
      awayTeamId: true,
      homeTeam: { select: { name: true, captainId: true, withdrawn: true } },
      awayTeam: { select: { name: true, captainId: true, withdrawn: true } },
    },
  });
  // A playoff fixture is named by its round ("Semifinal"), which needs the
  // bracket's depth; read it only when one is listed.
  const playoffRounds = matches.some((m) => m.phase === MATCH_PHASE.PLAYOFF)
    ? ((await loadPlayoffRoundsBySeason([season.id])).get(season.id) ?? 0)
    : 0;
  const rows = await Promise.all(
    matches.map(async (match) => {
      if (checkinClosedReason(season.status, season.draft?.status, match, nowMs)) {
        return null;
      }
      const [seat, rsvp] = await Promise.all([
        resolveCheckinSeat(prisma, match, userId),
        currentCheckinStatus(prisma, match, userId),
      ]);
      if ("refusal" in seat) return null;
      const opponent =
        seat.teamId === match.homeTeamId ? match.awayTeam : match.homeTeam;
      return {
        matchId: match.id,
        scheduleRevision: match.scheduleRevision,
        kickoffMs: match.scheduledAt!.getTime(),
        label: awayFixtureLabel(match, playoffRounds, opponent.name),
        standin: !teamIds.includes(seat.teamId),
        rsvp,
      };
    }),
  );
  const fixtures = rows.filter((row): row is AwayCardFixture => row !== null);
  return fixtures.length ? { seasonId: season.id, fixtures } : null;
}

/** One newly-OUT fixture, with what the captain's announcement needs. */
export type AwayMarkedFixture = AwayFixtureRef & {
  week: number;
  phase: string;
  homeName: string;
  awayName: string;
  whenMs: number;
  captainId: string;
};

export type AwayRangeOutcome = Omit<AwayRangeReport, "marked"> & {
  marked: AwayMarkedFixture[];
};

/**
 * Mark the player OUT for every fixture of theirs whose kickoff falls in
 * `range`, in one SERIALIZABLE transaction.
 *
 * Every per-fixture rule is setAvailability's (the shared helpers above), plus
 * the revision contract: `seen` is what the page listed, and a fixture is only
 * written when its scheduleRevision still matches — never for a kickoff the
 * player didn't see. Already-OUT fixtures are left untouched, so a second
 * save is a no-op. Every fixture is judged before the first write, so a
 * refusal can only ever throw with nothing written.
 */
export async function markAwayRange(opts: {
  userId: string;
  expectedSeasonId: string;
  range: AwayRange;
  seen: Map<string, SeenFixture>;
  nowMs: number;
}): Promise<AwayRangeOutcome> {
  const { userId, range, seen, nowMs } = opts;
  // Bracket depth, only to name playoff fixtures in the report ("Semifinal").
  // Read before the transaction so a display label adds nothing to its
  // SERIALIZABLE read set; the depth is fixed by the first round anyway.
  const playoffRounds =
    (await loadPlayoffRoundsBySeason([opts.expectedSeasonId])).get(
      opts.expectedSeasonId,
    ) ?? 0;
  return prisma.$transaction(
    async (tx) => {
      const season = await tx.season
        .findMany({
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 2,
          select: { id: true, status: true, draft: { select: { status: true } } },
        })
        .then(singleActiveSeason);
      // The page listed one season's fixtures. If that season was archived
      // since, an OUT would ping a captain about fixtures nobody is playing.
      if (!season || season.id !== opts.expectedSeasonId) {
        throw new UserFacingError(
          "Those fixtures belong to an archived season. Reload the page.",
        );
      }
      const draftStatus = season.draft?.status;
      if (!postAuctionWorkOpen(season.status, draftStatus)) {
        throw new UserFacingError(CHECKIN_REFUSAL_MESSAGE.PHASE);
      }

      const memberships = await tx.teamMember.findMany({
        where: { seasonId: season.id, userId },
        select: { teamId: true },
      });
      const teamIds = memberships.map((m) => m.teamId);
      const seenIds = [...seen.keys()];
      // Everything the page listed, plus anything of theirs in the range now
      // (roster fixtures and standin bookings) — whatever its status, so a
      // played or covered fixture in the range is reported, not ignored.
      const matches = await tx.match.findMany({
        where: {
          seasonId: season.id,
          OR: [
            ...(seenIds.length ? [{ id: { in: seenIds } }] : []),
            {
              scheduledAt: {
                gte: new Date(range.fromMs),
                lt: new Date(range.backMs),
              },
              OR: [
                ...(teamIds.length
                  ? [
                      { homeTeamId: { in: teamIds } },
                      { awayTeamId: { in: teamIds } },
                    ]
                  : []),
                { standins: { some: { standinUserId: userId } } },
              ],
            },
          ],
        },
        orderBy: [{ scheduledAt: "asc" }, { week: "asc" }, { id: "asc" }],
        select: {
          id: true,
          seasonId: true,
          week: true,
          phase: true,
          bracketSlot: true,
          status: true,
          scheduledAt: true,
          scheduleRevision: true,
          homeTeamId: true,
          awayTeamId: true,
          homeTeam: { select: { name: true, captainId: true, withdrawn: true } },
          awayTeam: { select: { name: true, captainId: true, withdrawn: true } },
          standins: {
            where: { standinUserId: userId },
            select: { teamId: true },
          },
        },
      });

      const gone = seenIds.filter(
        (id) =>
          !matches.some((m) => m.id === id) &&
          inAwayRange(seen.get(id)!.kickoffMs, range),
      ).length;

      const toMark: { match: (typeof matches)[number]; ref: AwayMarkedFixture }[] = [];
      const alreadyOut: AwayFixtureRef[] = [];
      const skipped: (AwayFixtureRef & { reason: AwaySkip })[] = [];
      for (const match of matches) {
        const seenFixture = seen.get(match.id);
        const kickoffMs = match.scheduledAt?.getTime() ?? null;
        let outcome = awayScheduleVerdict(
          {
            seen: seenFixture,
            status: match.status,
            scheduleRevision: match.scheduleRevision,
            kickoffMs,
            closedReason: checkinClosedReason(season.status, draftStatus, match, nowMs),
          },
          range,
          nowMs,
        );
        if (outcome?.kind === "ignore") continue;
        let seat: CheckinSeat | null = null;
        if (!outcome) {
          const [resolved, priorStatus] = await Promise.all([
            resolveCheckinSeat(tx, match, userId),
            currentCheckinStatus(tx, match, userId),
          ]);
          seat = resolved;
          outcome = awaySeatVerdict({
            seen: seenFixture,
            seatRefusal: "refusal" in resolved ? resolved.refusal : null,
            priorStatus,
          });
        }
        // Named from the side the player answers for: their seat's team, or
        // for a fixture they can't answer, whichever of their teams (or
        // bookings) put it on their list.
        const sideId =
          seat && "teamId" in seat
            ? seat.teamId
            : (teamIds.find((id) => id === match.homeTeamId || id === match.awayTeamId) ??
              match.standins[0]?.teamId ??
              match.homeTeamId);
        const opponent = sideId === match.homeTeamId ? match.awayTeam : match.homeTeam;
        const ref = {
          matchId: match.id,
          label: awayFixtureLabel(match, playoffRounds, opponent.name),
        };
        if (outcome.kind === "skip") skipped.push({ ...ref, reason: outcome.reason });
        else if (outcome.kind === "already-out") alreadyOut.push(ref);
        else if (outcome.kind === "mark" && seat && "teamId" in seat) {
          toMark.push({
            match,
            ref: {
              ...ref,
              week: match.week,
              phase: match.phase,
              homeName: match.homeTeam.name,
              awayName: match.awayTeam.name,
              whenMs: kickoffMs!,
              captainId: seat.captainId,
            },
          });
        }
      }

      // Every fixture is judged; now write. Nothing below can refuse.
      for (const { match } of toMark) {
        await recordCheckin(tx, match, userId, AVAILABILITY.OUT);
      }
      return {
        marked: toMark.map((m) => m.ref),
        alreadyOut,
        skipped,
        gone,
      };
    },
    // A 90-day range can hold a dozen fixtures, each judged with several reads
    // before any write; Prisma's 5s default is too tight on a cold database.
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 },
  );
}
