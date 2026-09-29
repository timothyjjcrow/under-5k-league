import { captainMmrWarning, unverifiedCaptainMmrsFor } from "./captain-mmr";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "./constants";
import { draftReadinessCounts } from "./draft-readiness";
import {
  draftRosterCounts,
  draftSetupOpen,
  startDraftCheck,
  startDraftConfirm,
} from "./draft-setup";
import { prisma } from "./prisma";
import {
  recoverablePostseasonBracket,
  seasonPhasePolicy,
  type SeasonPhasePolicyInput,
} from "./season-phase-policy";

// Admin controls the draft room renders itself, so an admin running draft
// night from a phone doesn't have to leave the room for /admin. Each one is
// built from the same helpers and posts to the same server action as its
// /admin twin, so the guards and the confirm text are the same in both places.

export type StartDraftPreflight = {
  /** Start draft's confirm before the Discord line (StartDraftControl adds it). */
  confirm: string;
  canStart: boolean;
  /** Why Start is unavailable, when it is. */
  blocker: string | null;
};

/**
 * What the draft room's waiting room needs to offer an admin the Start draft
 * button: the same checks and confirm text as the Captains & draft card on
 * /admin, built by the same helpers from the same rows (the season's teams
 * and its ACTIVE PLAYER registrations). Null once setup has closed, when
 * there is nothing to start.
 */
export async function loadStartDraftPreflight(season: {
  id: string;
  status: string;
  teamSize: number;
  minTeams: number;
  draftAt: Date | null;
  budgetMmrWeight: number;
  draftRevision: number;
}): Promise<StartDraftPreflight | null> {
  const [draft, teams, players] = await Promise.all([
    prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true },
    }),
    // Draft order, like /admin's query: the MMR warning names captains in
    // this order, and the two confirms must read the same.
    prisma.team.findMany({
      where: { seasonId: season.id },
      orderBy: { draftOrder: "asc" },
      select: {
        id: true,
        captainId: true,
        captain: { select: { name: true, rankTier: true } },
        members: { select: { userId: true, isCaptain: true } },
      },
    }),
    prisma.registration.findMany({
      where: {
        seasonId: season.id,
        status: REGISTRATION_STATUS.ACTIVE,
        type: REGISTRATION_TYPE.PLAYER,
      },
      select: {
        userId: true,
        mmr: true,
        draftConfirmedRevision: true,
        draftConfirmedAt: true,
      },
    }),
  ]);
  if (!draftSetupOpen(season.status, draft?.status)) return null;
  const { captainCount, boughtCount, poolCount } = draftRosterCounts(
    teams,
    players,
  );
  const { seats, canStart, blocker } = startDraftCheck({
    captainCount,
    teamSize: season.teamSize,
    poolCount,
    boughtCount,
  });
  const confirm = startDraftConfirm({
    captainCount,
    minTeams: season.minTeams,
    teamSize: season.teamSize,
    seats,
    draftScheduled: !!season.draftAt,
    confirmations: draftReadinessCounts(players, season.draftRevision),
    mmrWarning: captainMmrWarning(
      unverifiedCaptainMmrsFor(season, { draft, players, teams }),
    ),
  });
  return { confirm, canStart, blocker };
}

/**
 * The finished room's one next step for an admin: move the season to Regular
 * season (the /admin next-step banner's DRAFT + auction-complete step), with
 * the phase button's own confirm from seasonPhasePolicy. Built for the
 * finished auction (the room shows it only once its poll sees COMPLETE,
 * which can happen after this page rendered), so the draft status is taken
 * as COMPLETE here; setSeasonPhase re-checks the real state when pressed.
 * `needsSchedule` when the only thing in the way is the missing schedule
 * (the Regular season waits for fixtures). Null outside the Draft phase or
 * when the policy would refuse the move for any other reason.
 */
export async function loadRegularSeasonStep(season: {
  id: string;
  status: string;
  championTeamId: string | null;
}): Promise<{ confirmation: string } | { needsSchedule: true } | null> {
  if (season.status !== SEASON_STATUS.DRAFT) return null;
  const matches = await prisma.match.findMany({
    where: { seasonId: season.id },
    select: {
      status: true,
      phase: true,
      bracketSlot: true,
      _count: { select: { games: true } },
    },
  });
  const postseason = matches.filter(
    (m) => m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL,
  );
  const input: SeasonPhasePolicyInput = {
    current: season.status,
    target: SEASON_STATUS.REGULAR_SEASON,
    draftStatus: DRAFT_STATUS.COMPLETE,
    matchCount: matches.length,
    regularMatchCount: matches.filter((m) => m.phase === MATCH_PHASE.REGULAR)
      .length,
    hasPlayedResult: matches.some((m) => m.status === MATCH_STATUS.COMPLETED),
    hasImportedGame: matches.some((m) => m._count.games > 0),
    postseasonMatchCount: postseason.length,
    postseasonBracketReady: recoverablePostseasonBracket(postseason),
    hasChampion: season.championTeamId != null,
  };
  const policy = seasonPhasePolicy(input);
  if (policy.available) return { confirmation: policy.confirmation };
  // The usual first sight of a finished auction has no fixtures yet: point
  // the admin at the schedule rather than leaving the room with no step.
  if (
    input.regularMatchCount === 0 &&
    seasonPhasePolicy({ ...input, regularMatchCount: 1 }).available
  ) {
    return { needsSchedule: true };
  }
  return null;
}
