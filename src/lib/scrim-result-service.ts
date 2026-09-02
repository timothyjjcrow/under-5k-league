import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  DOTA_MATCH_KIND,
  ROLE,
  SCRIM_STATUS,
  SEASON_STATUS,
  TEAM_STAFF_ROLE,
} from "./constants";
import {
  canStartOpenDotaFetch,
  fetchOpenDotaMatch,
  fetchRecentMatchIds,
  openDotaBudgetExpired,
  parseMatchId,
  type OpenDotaFetchOptions,
  type OpenDotaMatch,
} from "./dota";
import {
  buildPlayers,
  claimsGame,
  classifyGame,
  deriveSeriesProjection,
  eligibleCompetingMeetingKickoffs,
  loadImportSkips,
  pickSeriesGames,
  rememberImportSkip,
  SCAN_BUDGET_MS,
  type GameClassification,
  type SeriesCandidate,
} from "./match-import";
import { claimProviderCooldown } from "./settings";
import { isWithinScrimResultWindow } from "./scrim-window";
import { parseAdminSteamIds, resolveSessionRole } from "./users";

export {
  isWithinScrimResultWindow,
  SCRIM_DETECT_WINDOW_AFTER_MS,
  SCRIM_DETECT_WINDOW_BEFORE_MS,
} from "./scrim-window";

/**
 * Scrims use a deliberately tighter ownership window than league fixtures.
 * They are casual, ad-hoc meetings, so a game from the prior evening should
 * not be swept in just because the same two teams play often. The generous
 * after-window still covers late starts and a long best-of series.
 */
const SCRIM_SCAN_ACCOUNTS_PER_TEAM = 6;
const SCRIM_SCAN_CANDIDATE_LIMIT = 12;
const RECENT_MATCH_LIMIT = 20;
const IMPORT_TRANSACTION_MAX_ATTEMPTS = 3;
const MAX_DOTA_ACCOUNT_ID = 0xffffffff;

export type ScrimResultViewer = {
  id: string;
  /** The action passes the freshly resolved session role, including the
   * ADMIN_STEAM_IDS policy applied by getSessionUser. */
  role: string;
};

export type ScrimResultSuccess = {
  ok: true;
  message: string;
  imported: number;
  scanned?: number;
  hostScore: number;
  awayScore: number;
  winnerTeamId: string | null;
  status: string;
};

export type ScrimResultResponse =
  ScrimResultSuccess | { ok: false; error: string };

type ScrimParticipantRow = {
  teamId: string;
  userId: string | null;
  dotaAccountId: number;
  displayName: string;
  guest: boolean;
  createdAt: Date;
};

type ScrimIdentitySnapshot = {
  hostSet: Set<number>;
  awaySet: Set<number>;
  participantByAccount: Map<number, ScrimParticipantRow>;
  registeredAccountMap: Map<
    number,
    { userId: string; name: string; teamId: string | null }
  >;
  scanHostIds: number[];
  scanAwayIds: number[];
};

type ScrimReadSnapshot = {
  id: string;
  seasonId: string;
  hostTeamId: string;
  opponentTeamId: string | null;
  scheduledAt: Date;
  bestOf: number;
  status: string;
  hostScore: number;
  awayScore: number;
  winnerTeamId: string | null;
  season: { isActive: boolean; status: string };
  hostTeam: { captainId: string };
  opponentTeam: { captainId: string } | null;
  participants: ScrimParticipantRow[];
  games: { winnerTeamId: string | null }[];
};

type ScrimSeriesState = Pick<
  ScrimResultSuccess,
  "hostScore" | "awayScore" | "winnerTeamId" | "status"
>;

type ValidatedScrimGame = {
  dotaMatchId: string;
  classification: GameClassification & { ok: true };
};

type RecentHistory = {
  teamId: string;
  accountId: number;
  matchIds: number[];
};

class ScrimImportError extends Error {}

function validAccountId(value: number): value is number {
  return (
    Number.isSafeInteger(value) && value > 0 && value <= MAX_DOTA_ACCOUNT_ID
  );
}

/**
 * Build the immutable discovery identity for a booked scrim. Both regular
 * snapshot rows and account-only guests count. Only registered users enter the
 * map handed to buildPlayers; guest team attribution is overlaid afterwards,
 * keeping their userId null so casual stats never attach to a league profile.
 */
export function buildScrimIdentitySnapshot(
  participants: ScrimParticipantRow[],
  hostTeamId: string,
  awayTeamId: string,
): ScrimIdentitySnapshot {
  const hostSet = new Set<number>();
  const awaySet = new Set<number>();
  const participantByAccount = new Map<number, ScrimParticipantRow>();
  const registeredAccountMap = new Map<
    number,
    { userId: string; name: string; teamId: string | null }
  >();

  for (const participant of participants) {
    const accountId = Number(participant.dotaAccountId);
    if (!validAccountId(accountId)) continue;
    if (
      participant.teamId !== hostTeamId &&
      participant.teamId !== awayTeamId
    ) {
      continue;
    }
    participantByAccount.set(accountId, participant);
    (participant.teamId === hostTeamId ? hostSet : awaySet).add(accountId);
    if (participant.userId) {
      registeredAccountMap.set(accountId, {
        userId: participant.userId,
        name: participant.displayName,
        teamId: participant.teamId,
      });
    }
  }

  const pickScanIds = (teamId: string) => {
    const rows = [...participantByAccount.entries()]
      .filter(([, participant]) => participant.teamId === teamId)
      .sort((a, b) => b[1].createdAt.getTime() - a[1].createdAt.getTime());
    const guests = rows.filter(([, participant]) => participant.guest);
    const roster = rows.filter(([, participant]) => !participant.guest);
    // Reserve half the bounded scan for recently-added guests while retaining
    // regular roster coverage. One public history on each side is sufficient
    // to surface a candidate; classification below still requires 3+ known
    // accounts per side in the actual match payload.
    const guestHead = guests.slice(0, SCRIM_SCAN_ACCOUNTS_PER_TEAM / 2);
    return [...guestHead, ...roster, ...guests.slice(guestHead.length)]
      .slice(0, SCRIM_SCAN_ACCOUNTS_PER_TEAM)
      .map(([accountId]) => accountId);
  };

  return {
    hostSet,
    awaySet,
    participantByAccount,
    registeredAccountMap,
    scanHostIds: pickScanIds(hostTeamId),
    scanAwayIds: pickScanIds(awayTeamId),
  };
}

/** Common to both sides, ordered by strongest shared-history evidence. */
export function selectCommonRecentMatchIds(
  histories: RecentHistory[],
  hostTeamId: string,
  awayTeamId: string,
  limit = SCRIM_SCAN_CANDIDATE_LIMIT,
): number[] {
  const counts = new Map<number, { host: number; away: number }>();
  for (const history of histories) {
    if (history.teamId !== hostTeamId && history.teamId !== awayTeamId)
      continue;
    // A malformed provider response must not let one player's duplicate ids
    // inflate the candidate's evidence score.
    for (const matchId of new Set(history.matchIds)) {
      if (!Number.isSafeInteger(matchId) || matchId <= 0) continue;
      const count = counts.get(matchId) ?? { host: 0, away: 0 };
      if (history.teamId === hostTeamId) count.host += 1;
      else count.away += 1;
      counts.set(matchId, count);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count.host > 0 && count.away > 0)
    .sort((a, b) => {
      const total = b[1].host + b[1].away - (a[1].host + a[1].away);
      if (total !== 0) return total;
      const balance =
        Math.min(b[1].host, b[1].away) - Math.min(a[1].host, a[1].away);
      return balance !== 0 ? balance : b[0] - a[0];
    })
    .slice(0, Math.max(0, limit))
    .map(([matchId]) => matchId);
}

function buildScrimPlayers(
  match: OpenDotaMatch,
  identities: ScrimIdentitySnapshot,
) {
  return buildPlayers(match, identities.registeredAccountMap).map((line) => {
    const participant =
      line.accountId == null
        ? undefined
        : identities.participantByAccount.get(line.accountId);
    if (!participant) return line;
    return {
      ...line,
      // buildPlayers already fills registered user ids. Account-only guests
      // stay deliberately unattached to User/career/fantasy data.
      userId: participant.userId ?? null,
      teamId: participant.teamId,
      // Keep the per-scrim name in the immutable box score. A coach may
      // remove a guest between games, but that must not erase the name from a
      // game the guest already played or split their scrim-only history.
      personaname: participant.displayName,
    };
  });
}

function writableStatus(status: string): boolean {
  return status === SCRIM_STATUS.SCHEDULED || status === SCRIM_STATUS.LIVE;
}

function statusError(status: string): string {
  if (status === SCRIM_STATUS.COMPLETED)
    return "This scrim series is already final";
  if (status === SCRIM_STATUS.CANCELLED) return "This scrim was cancelled";
  return "This scrim must be booked before games can be recorded";
}

function captainCanManage(
  viewerId: string,
  scrim: Pick<ScrimReadSnapshot, "hostTeam" | "opponentTeam">,
): boolean {
  return (
    scrim.hostTeam.captainId === viewerId ||
    scrim.opponentTeam?.captainId === viewerId
  );
}

async function assertedAdmin(
  db: Pick<Prisma.TransactionClient, "user">,
  viewer: ScrimResultViewer,
): Promise<boolean> {
  if (viewer.role !== ROLE.ADMIN) return false;
  const current = await db.user.findUnique({
    where: { id: viewer.id },
    select: { steamId: true, role: true },
  });
  return (
    !!current &&
    resolveSessionRole({
      steamId: current.steamId,
      storedRole: current.role,
      adminSteamIds: parseAdminSteamIds(process.env.ADMIN_STEAM_IDS),
      production: process.env.NODE_ENV === "production",
    }) === ROLE.ADMIN
  );
}

async function canManageScrimAtRead(
  viewer: ScrimResultViewer,
  scrim: ScrimReadSnapshot,
  admin: boolean,
): Promise<boolean> {
  if (admin) return true;
  if (captainCanManage(viewer.id, scrim)) {
    return true;
  }
  if (!scrim.opponentTeamId) return false;
  return !!(await prisma.teamStaff.findFirst({
    where: {
      userId: viewer.id,
      role: TEAM_STAFF_ROLE.COACH,
      teamId: { in: [scrim.hostTeamId, scrim.opponentTeamId] },
    },
    select: { id: true },
  }));
}

const scrimReadSelect = {
  id: true,
  seasonId: true,
  hostTeamId: true,
  opponentTeamId: true,
  scheduledAt: true,
  bestOf: true,
  status: true,
  hostScore: true,
  awayScore: true,
  winnerTeamId: true,
  season: { select: { isActive: true, status: true } },
  hostTeam: { select: { captainId: true } },
  opponentTeam: { select: { captainId: true } },
  participants: {
    select: {
      teamId: true,
      userId: true,
      dotaAccountId: true,
      displayName: true,
      guest: true,
      createdAt: true,
    },
  },
  games: { select: { winnerTeamId: true } },
} as const;

async function loadAuthorizedScrim(
  viewer: ScrimResultViewer,
  scrimId: string,
): Promise<
  | { ok: true; scrim: ScrimReadSnapshot; awayTeamId: string }
  | { ok: false; error: string }
> {
  const scrim = await prisma.scrim.findUnique({
    where: { id: scrimId },
    select: scrimReadSelect,
  });
  if (!scrim) return { ok: false, error: "Scrim not found" };
  const admin = await assertedAdmin(prisma, viewer);
  if (!(await canManageScrimAtRead(viewer, scrim, admin))) {
    return {
      ok: false,
      error:
        "Only an admin, captain, or coach for these teams can record this scrim",
    };
  }
  if (!scrim.opponentTeamId || !scrim.opponentTeam) {
    return {
      ok: false,
      error: "This scrim must be booked before games can be recorded",
    };
  }
  if (
    (!scrim.season.isActive ||
      scrim.season.status === SEASON_STATUS.COMPLETE) &&
    scrim.status !== SCRIM_STATUS.LIVE &&
    !admin
  ) {
    return {
      ok: false,
      error: "This scrim belongs to a season whose results are closed",
    };
  }
  if (!writableStatus(scrim.status)) {
    return { ok: false, error: statusError(scrim.status) };
  }
  if (scrim.games.length >= scrim.bestOf) {
    return {
      ok: false,
      error: `This best-of-${scrim.bestOf} already has all of its games`,
    };
  }
  return { ok: true, scrim, awayTeamId: scrim.opponentTeamId };
}

function assertEnoughRecognizedPlayers(
  identities: ScrimIdentitySnapshot,
): string | null {
  if (identities.hostSet.size < 3 || identities.awaySet.size < 3) {
    return "Add at least 3 Dota player IDs for each team before fetching games";
  }
  return null;
}

async function loadOtherMeetingKickoffs(
  db: Pick<Prisma.TransactionClient, "scrim" | "match">,
  scrim: Pick<
    ScrimReadSnapshot,
    "id" | "seasonId" | "hostTeamId" | "opponentTeamId"
  > & { opponentTeamId: string },
): Promise<{ scrims: number[]; league: number[] }> {
  const pair = [
    {
      hostTeamId: scrim.hostTeamId,
      opponentTeamId: scrim.opponentTeamId,
    },
    {
      hostTeamId: scrim.opponentTeamId,
      opponentTeamId: scrim.hostTeamId,
    },
  ];
  const leaguePair = [
    {
      homeTeamId: scrim.hostTeamId,
      awayTeamId: scrim.opponentTeamId,
    },
    {
      homeTeamId: scrim.opponentTeamId,
      awayTeamId: scrim.hostTeamId,
    },
  ];
  const [otherScrims, leagueMatches] = await Promise.all([
    db.scrim.findMany({
      where: {
        seasonId: scrim.seasonId,
        id: { not: scrim.id },
        status: { not: SCRIM_STATUS.CANCELLED },
        OR: pair,
      },
      select: { scheduledAt: true },
    }),
    db.match.findMany({
      where: {
        seasonId: scrim.seasonId,
        scheduledAt: { not: null },
        OR: leaguePair,
      },
      select: { scheduledAt: true },
    }),
  ]);
  return {
    scrims: otherScrims.map((meeting) => meeting.scheduledAt.getTime()),
    league: leagueMatches
      .map((meeting) => meeting.scheduledAt?.getTime())
      .filter((time): time is number => typeof time === "number"),
  };
}

function validateFetchedGame(
  scrim: Pick<
    ScrimReadSnapshot,
    "hostTeamId" | "opponentTeamId" | "scheduledAt"
  > & { opponentTeamId: string },
  identities: ScrimIdentitySnapshot,
  match: OpenDotaMatch,
  competingMeetings: { scrims: number[]; league: number[] },
): { ok: true; value: ValidatedScrimGame } | { ok: false; error: string } {
  const dotaMatchId = String(match.match_id);
  if (!parseMatchId(dotaMatchId)) {
    return { ok: false, error: "OpenDota returned an invalid match" };
  }
  const kickoffMs = scrim.scheduledAt.getTime();
  if (!isWithinScrimResultWindow(match.start_time, kickoffMs)) {
    return {
      ok: false,
      error:
        "That Dota game is outside this scrim's window (12 hours before through 36 hours after kickoff)",
    };
  }
  const gameStartMs = match.start_time * 1000;
  const otherKickoffsMs = eligibleCompetingMeetingKickoffs(
    match.start_time,
    competingMeetings,
  );
  if (!claimsGame(gameStartMs, kickoffMs, otherKickoffsMs)) {
    return {
      ok: false,
      error:
        "That Dota game is closer to another scrim or official match between these teams",
    };
  }
  const classification = classifyGame(
    match,
    { teamId: scrim.hostTeamId, accountIds: identities.hostSet },
    { teamId: scrim.opponentTeamId, accountIds: identities.awaySet },
    3,
  );
  if (!classification.ok) {
    return {
      ok: false,
      error:
        classification.reason?.replace(
          "not a league match",
          "not a scrim between these teams",
        ) ?? "That game does not match these teams",
    };
  }
  return {
    ok: true,
    value: {
      dotaMatchId,
      classification: classification as GameClassification & { ok: true },
    },
  };
}

async function existingGameError(
  db: Pick<Prisma.TransactionClient, "dotaMatchClaim" | "game" | "scrimGame">,
  dotaMatchId: string,
  scrimId: string,
): Promise<string | null> {
  // Game/ScrimGame are checked explicitly for pre-claim migration rows. New
  // imports also create DotaMatchClaim, whose primary key is the race arbiter.
  const [claim, leagueGame, scrimGame] = await Promise.all([
    db.dotaMatchClaim.findUnique({ where: { dotaMatchId } }),
    db.game.findUnique({ where: { dotaMatchId } }),
    db.scrimGame.findUnique({ where: { dotaMatchId } }),
  ]);
  if (scrimGame) {
    return scrimGame.scrimId === scrimId
      ? "That game is already recorded for this scrim"
      : "That game is already recorded for another scrim";
  }
  if (leagueGame)
    return "That game is already recorded as an official league game";
  if (claim) {
    if (claim.kind === DOTA_MATCH_KIND.LEAGUE)
      return "That game is already reserved for an official league match";
    return claim.contextId === scrimId
      ? "That game is already reserved for this scrim"
      : "That game is already reserved for another scrim";
  }
  return null;
}

async function canManageScrimInTransaction(
  tx: Prisma.TransactionClient,
  viewer: ScrimResultViewer,
  scrim: ScrimReadSnapshot,
  admin: boolean,
): Promise<boolean> {
  if (admin) return true;
  if (captainCanManage(viewer.id, scrim)) {
    return true;
  }
  if (!scrim.opponentTeamId) return false;
  return !!(await tx.teamStaff.findFirst({
    where: {
      userId: viewer.id,
      role: TEAM_STAFF_ROLE.COACH,
      teamId: { in: [scrim.hostTeamId, scrim.opponentTeamId] },
    },
    select: { id: true },
  }));
}

async function commitFetchedScrimGame(
  viewer: ScrimResultViewer,
  scrimId: string,
  match: OpenDotaMatch,
): Promise<({ ok: true } & ScrimSeriesState) | { ok: false; error: string }> {
  for (let attempt = 0; attempt < IMPORT_TRANSACTION_MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Every decisive fact is re-read after provider I/O: team booking,
          // authority, participant snapshot, competing meetings, capacity and
          // match ownership. The insert and score projection commit together.
          const fresh = await tx.scrim.findUnique({
            where: { id: scrimId },
            select: scrimReadSelect,
          });
          if (!fresh) throw new ScrimImportError("Scrim not found");
          const admin = await assertedAdmin(tx, viewer);
          if (!(await canManageScrimInTransaction(tx, viewer, fresh, admin))) {
            throw new ScrimImportError(
              "You no longer captain or coach either team in this scrim",
            );
          }
          if (!fresh.opponentTeamId || !fresh.opponentTeam) {
            throw new ScrimImportError(
              "This scrim is no longer booked between two teams",
            );
          }
          if (
            (!fresh.season.isActive ||
              fresh.season.status === SEASON_STATUS.COMPLETE) &&
            fresh.status !== SCRIM_STATUS.LIVE &&
            !admin
          ) {
            throw new ScrimImportError(
              "This scrim's season closed while the game was being fetched",
            );
          }
          if (!writableStatus(fresh.status)) {
            throw new ScrimImportError(statusError(fresh.status));
          }
          if (fresh.games.length >= fresh.bestOf) {
            throw new ScrimImportError(
              `This best-of-${fresh.bestOf} already has all of its games`,
            );
          }

          const identities = buildScrimIdentitySnapshot(
            fresh.participants,
            fresh.hostTeamId,
            fresh.opponentTeamId,
          );
          const participantError = assertEnoughRecognizedPlayers(identities);
          if (participantError) throw new ScrimImportError(participantError);

          const otherKickoffs = await loadOtherMeetingKickoffs(tx, {
            ...fresh,
            opponentTeamId: fresh.opponentTeamId,
          });
          const validation = validateFetchedGame(
            { ...fresh, opponentTeamId: fresh.opponentTeamId },
            identities,
            match,
            otherKickoffs,
          );
          if (!validation.ok) throw new ScrimImportError(validation.error);

          const duplicate = await existingGameError(
            tx,
            validation.value.dotaMatchId,
            scrimId,
          );
          if (duplicate) throw new ScrimImportError(duplicate);

          await tx.dotaMatchClaim.create({
            data: {
              dotaMatchId: validation.value.dotaMatchId,
              kind: DOTA_MATCH_KIND.SCRIM,
              contextId: scrimId,
            },
          });
          await tx.scrimGame.create({
            data: {
              scrimId,
              dotaMatchId: validation.value.dotaMatchId,
              radiantWin: match.radiant_win,
              durationSecs: match.duration,
              startTime: match.start_time,
              radiantScore: match.radiant_score ?? 0,
              direScore: match.dire_score ?? 0,
              radiantTeamId: validation.value.classification.radiantTeamId,
              direTeamId: validation.value.classification.direTeamId,
              winnerTeamId: validation.value.classification.winnerTeamId,
              players: JSON.stringify(buildScrimPlayers(match, identities)),
            },
          });

          const projection = deriveSeriesProjection(
            {
              homeTeamId: fresh.hostTeamId,
              awayTeamId: fresh.opponentTeamId,
              bestOf: fresh.bestOf,
            },
            [
              ...fresh.games,
              {
                winnerTeamId: validation.value.classification.winnerTeamId,
              },
            ],
          );
          const status = projection.decided
            ? SCRIM_STATUS.COMPLETED
            : SCRIM_STATUS.LIVE;
          await tx.scrim.update({
            where: { id: scrimId },
            data: {
              hostScore: projection.homeScore,
              awayScore: projection.awayScore,
              winnerTeamId: projection.winnerTeamId,
              status,
            },
          });

          return {
            ok: true as const,
            hostScore: projection.homeScore,
            awayScore: projection.awayScore,
            winnerTeamId: projection.winnerTeamId,
            status,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof ScrimImportError) {
        return { ok: false, error: error.message };
      }
      const code = (error as { code?: string }).code;
      if (code === "P2002") {
        return {
          ok: false,
          error: "That Dota game was just recorded for another event",
        };
      }
      if (code === "P2034") {
        if (attempt + 1 < IMPORT_TRANSACTION_MAX_ATTEMPTS) continue;
        return {
          ok: false,
          error:
            "This scrim changed while the game was being recorded — try again",
        };
      }
      // Never serialize a provider/database exception (which may include a
      // connection URL) into an action toast or console log.
      console.error("[scrim-result] game import failed");
      return {
        ok: false,
        error: "Couldn't record that scrim game — wait a moment and try again",
      };
    }
  }
  return {
    ok: false,
    error: "This scrim changed while the game was being recorded — try again",
  };
}

function successMessage(state: ScrimSeriesState, imported: number): string {
  const prefix =
    imported === 1 ? "Game imported" : `Imported ${imported} games`;
  return state.status === SCRIM_STATUS.COMPLETED
    ? `${prefix} — scrim final ${state.hostScore}–${state.awayScore}`
    : `${prefix} — scrim ${state.hostScore}–${state.awayScore}; add the next game when it finishes`;
}

/** Manual match-id/URL fallback for private histories or delayed discovery. */
export async function importScrimGame(
  viewer: ScrimResultViewer,
  scrimId: string,
  dotaRef: string,
): Promise<ScrimResultResponse> {
  try {
    const authorized = await loadAuthorizedScrim(viewer, scrimId);
    if (!authorized.ok) return authorized;
    const identities = buildScrimIdentitySnapshot(
      authorized.scrim.participants,
      authorized.scrim.hostTeamId,
      authorized.awayTeamId,
    );
    const participantError = assertEnoughRecognizedPlayers(identities);
    if (participantError) return { ok: false, error: participantError };
    const dotaMatchId = parseMatchId(dotaRef);
    if (!dotaMatchId) {
      return { ok: false, error: "Enter a valid Dota match ID or URL" };
    }

    const duplicate = await existingGameError(prisma, dotaMatchId, scrimId);
    if (duplicate) return { ok: false, error: duplicate };

    const cooldown = await claimProviderCooldown(
      "open-dota-match-import",
      viewer.id,
      `scrim:${scrimId}`,
    );
    if (cooldown === "cooldown") {
      return {
        ok: false,
        error:
          "A Dota match ID was checked for this scrim recently — wait about a minute before trying another ID",
      };
    }
    if (cooldown === "unavailable") {
      return {
        ok: false,
        error:
          "Couldn't safely start the OpenDota lookup — wait a minute and try again",
      };
    }

    const match = await fetchOpenDotaMatch(dotaMatchId);
    if (!match) {
      return {
        ok: false,
        error:
          "Could not fetch that match from OpenDota (check the ID and that the match is public)",
      };
    }
    if (String(match.match_id) !== dotaMatchId) {
      return { ok: false, error: "OpenDota returned a different match ID" };
    }

    const committed = await commitFetchedScrimGame(viewer, scrimId, match);
    if (!committed.ok) return committed;
    return {
      ...committed,
      imported: 1,
      message: successMessage(committed, 1),
    };
  } catch {
    console.error("[scrim-result] manual import unavailable");
    return {
      ok: false,
      error: "Couldn't check that scrim game — wait a moment and try again",
    };
  }
}

/**
 * Scan a bounded selection of snapshot/guest player histories, validate common
 * candidates against both complete lineups, then import the selected series.
 * This is request-driven only; no background automation is registered here.
 */
export async function autoDetectScrimGames(
  viewer: ScrimResultViewer,
  scrimId: string,
): Promise<ScrimResultResponse> {
  try {
    const authorized = await loadAuthorizedScrim(viewer, scrimId);
    if (!authorized.ok) return authorized;
    const { scrim, awayTeamId } = authorized;
    const identities = buildScrimIdentitySnapshot(
      scrim.participants,
      scrim.hostTeamId,
      awayTeamId,
    );
    const participantError = assertEnoughRecognizedPlayers(identities);
    if (participantError) return { ok: false, error: participantError };

    const cooldown = await claimProviderCooldown(
      "open-dota-match-scan",
      viewer.id,
      `scrim:${scrimId}`,
    );
    if (cooldown === "cooldown") {
      return {
        ok: false,
        error:
          "This scrim was scanned recently — wait about three minutes, or add the Dota match ID directly",
      };
    }
    if (cooldown === "unavailable") {
      return {
        ok: false,
        error:
          "Couldn't safely start the OpenDota scan — add the Dota match ID directly or try again later",
      };
    }

    const deadlineMs = Date.now() + SCAN_BUDGET_MS;
    const fetchOptions: OpenDotaFetchOptions = { deadlineMs };
    const histories: RecentHistory[] = [];
    let scanned = 0;
    let unreachable = false;
    const scanRows = [
      ...identities.scanHostIds.map((accountId) => ({
        teamId: scrim.hostTeamId,
        accountId,
      })),
      ...identities.scanAwayIds.map((accountId) => ({
        teamId: awayTeamId,
        accountId,
      })),
    ];
    for (const row of scanRows) {
      if (!canStartOpenDotaFetch(fetchOptions)) break;
      const matchIds = await fetchRecentMatchIds(
        row.accountId,
        RECENT_MATCH_LIMIT,
        fetchOptions,
      );
      scanned += 1;
      if (matchIds === null) {
        if (openDotaBudgetExpired(fetchOptions)) break;
        unreachable = true;
        continue;
      }
      histories.push({ ...row, matchIds });
    }

    const candidateIds = selectCommonRecentMatchIds(
      histories,
      scrim.hostTeamId,
      awayTeamId,
    );
    if (candidateIds.length === 0) {
      if (openDotaBudgetExpired(fetchOptions)) {
        return {
          ok: false,
          error:
            "The bounded OpenDota scan reached its deadline — add the Dota match ID directly",
        };
      }
      if (unreachable) {
        return {
          ok: false,
          error:
            "OpenDota could not read enough player histories — add the Dota match ID directly",
        };
      }
      return {
        ok: true,
        imported: 0,
        scanned,
        message: `Scanned ${scanned} player IDs — no matching games found yet. Add the Dota match ID if histories are private or delayed.`,
        hostScore: scrim.hostScore,
        awayScore: scrim.awayScore,
        winnerTeamId: scrim.winnerTeamId,
        status: scrim.status,
      };
    }

    const candidateStrings = candidateIds.map(String);
    const [claims, leagueGames, scrimGames, otherKickoffs, importSkips] =
      await Promise.all([
        prisma.dotaMatchClaim.findMany({
          where: { dotaMatchId: { in: candidateStrings } },
          select: { dotaMatchId: true },
        }),
        prisma.game.findMany({
          where: { dotaMatchId: { in: candidateStrings } },
          select: { dotaMatchId: true },
        }),
        prisma.scrimGame.findMany({
          where: { dotaMatchId: { in: candidateStrings } },
          select: { dotaMatchId: true },
        }),
        loadOtherMeetingKickoffs(prisma, {
          ...scrim,
          opponentTeamId: awayTeamId,
        }),
        loadImportSkips(scrim.seasonId),
      ]);
    const unavailableIds = new Set([
      ...claims.map((row) => row.dotaMatchId),
      ...leagueGames.map((row) => row.dotaMatchId),
      ...scrimGames.map((row) => row.dotaMatchId),
      ...importSkips,
    ]);

    const fetched = new Map<number, OpenDotaMatch>();
    const valid: SeriesCandidate[] = [];
    for (const candidateId of candidateIds) {
      if (!canStartOpenDotaFetch(fetchOptions)) break;
      if (unavailableIds.has(String(candidateId))) continue;
      const match = await fetchOpenDotaMatch(String(candidateId), fetchOptions);
      if (!match) continue;
      if (String(match.match_id) !== String(candidateId)) continue;
      const validation = validateFetchedGame(
        { ...scrim, opponentTeamId: awayTeamId },
        identities,
        match,
        otherKickoffs,
      );
      if (!validation.ok) continue;
      fetched.set(candidateId, match);
      valid.push({
        id: candidateId,
        startTime: match.start_time,
        winnerTeamId: validation.value.classification.winnerTeamId,
      });
    }

    const chosen = pickSeriesGames(valid, scrim.bestOf);
    let imported = 0;
    let state: ScrimSeriesState = {
      hostScore: scrim.hostScore,
      awayScore: scrim.awayScore,
      winnerTeamId: scrim.winnerTeamId,
      status: scrim.status,
    };
    for (const candidate of chosen) {
      const match = fetched.get(candidate.id);
      if (!match) continue;
      const committed = await commitFetchedScrimGame(viewer, scrimId, match);
      if (!committed.ok) {
        if (imported === 0) return committed;
        break;
      }
      imported += 1;
      state = committed;
    }

    if (imported === 0) {
      if (openDotaBudgetExpired(fetchOptions)) {
        return {
          ok: false,
          error:
            "The bounded OpenDota scan reached its deadline — add the Dota match ID directly",
        };
      }
      return {
        ok: true,
        imported: 0,
        scanned,
        message: `Scanned ${scanned} player IDs — no matching games found yet. Add the Dota match ID if histories are private or delayed.`,
        ...state,
      };
    }
    return {
      ok: true,
      imported,
      scanned,
      message: successMessage(state, imported),
      ...state,
    };
  } catch {
    console.error("[scrim-result] automatic scan unavailable");
    return {
      ok: false,
      error:
        "Couldn't scan for scrim games — add the Dota match ID or try again later",
    };
  }
}

export type ScrimGameRemovalResponse =
  | ({ ok: true; message: string } & ScrimSeriesState)
  | { ok: false; error: string };

/** Admin correction path mirroring official Game removal. */
export async function removeScrimGame(
  viewer: ScrimResultViewer,
  scrimId: string,
  scrimGameId: string,
): Promise<ScrimGameRemovalResponse> {
  if (viewer.role !== ROLE.ADMIN) {
    return { ok: false, error: "Only an admin can remove a scrim game" };
  }
  if (!(await assertedAdmin(prisma, viewer))) {
    return { ok: false, error: "Only an admin can remove a scrim game" };
  }

  const existing = await prisma.scrimGame.findUnique({
    where: { id: scrimGameId },
    select: {
      id: true,
      scrimId: true,
      dotaMatchId: true,
      scrim: { select: { seasonId: true } },
    },
  });
  if (!existing || existing.scrimId !== scrimId) {
    return { ok: false, error: "That scrim game is already gone" };
  }

  // Remember the correction before releasing either unique match-id guard so
  // a background player-history scan cannot race the delete and put the same
  // game straight back. Manual import remains an explicit override.
  try {
    await rememberImportSkip(existing.scrim.seasonId, existing.dotaMatchId);
  } catch {
    return {
      ok: false,
      error: "Couldn't safely remember that correction — try again",
    };
  }

  for (let attempt = 0; attempt < IMPORT_TRANSACTION_MAX_ATTEMPTS; attempt++) {
    try {
      const state = await prisma.$transaction(
        async (tx) => {
          if (!(await assertedAdmin(tx, viewer))) {
            throw new ScrimImportError(
              "You are no longer an admin who can correct this scrim",
            );
          }
          const fresh = await tx.scrim.findUnique({
            where: { id: scrimId },
            select: {
              id: true,
              hostTeamId: true,
              opponentTeamId: true,
              bestOf: true,
              status: true,
              games: {
                select: {
                  id: true,
                  dotaMatchId: true,
                  winnerTeamId: true,
                },
              },
            },
          });
          if (!fresh || !fresh.opponentTeamId) {
            throw new ScrimImportError("Scrim not found");
          }
          if (fresh.status === SCRIM_STATUS.CANCELLED) {
            throw new ScrimImportError("Cancelled scrims cannot be corrected");
          }
          const game = fresh.games.find((row) => row.id === scrimGameId);
          if (!game || game.dotaMatchId !== existing.dotaMatchId) {
            throw new ScrimImportError("That scrim game is already gone");
          }

          const remaining = fresh.games.filter((row) => row.id !== game.id);
          const projection = deriveSeriesProjection(
            {
              homeTeamId: fresh.hostTeamId,
              awayTeamId: fresh.opponentTeamId,
              bestOf: fresh.bestOf,
            },
            remaining,
          );
          const status = projection.decided
            ? SCRIM_STATUS.COMPLETED
            : remaining.length > 0
              ? SCRIM_STATUS.LIVE
              : SCRIM_STATUS.SCHEDULED;
          const removed = await tx.scrimGame.deleteMany({
            where: { id: game.id, scrimId },
          });
          if (removed.count !== 1) {
            throw new ScrimImportError("That scrim game is already gone");
          }
          await tx.dotaMatchClaim.deleteMany({
            where: {
              dotaMatchId: game.dotaMatchId,
              kind: DOTA_MATCH_KIND.SCRIM,
              contextId: scrimId,
            },
          });
          await tx.scrim.update({
            where: { id: scrimId },
            data: {
              hostScore: projection.homeScore,
              awayScore: projection.awayScore,
              winnerTeamId: projection.winnerTeamId,
              status,
            },
          });
          return {
            hostScore: projection.homeScore,
            awayScore: projection.awayScore,
            winnerTeamId: projection.winnerTeamId,
            status,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return {
        ok: true,
        message: "Scrim game removed and the practice score was recalculated.",
        ...state,
      };
    } catch (error) {
      if (error instanceof ScrimImportError) {
        return { ok: false, error: error.message };
      }
      if ((error as { code?: string }).code === "P2034") {
        if (attempt + 1 < IMPORT_TRANSACTION_MAX_ATTEMPTS) continue;
        return {
          ok: false,
          error: "This scrim changed while the game was removed — try again",
        };
      }
      console.error("[scrim-result] game removal failed");
      return {
        ok: false,
        error: "Couldn't remove that scrim game — try again",
      };
    }
  }
  return {
    ok: false,
    error: "This scrim changed while the game was removed — try again",
  };
}
