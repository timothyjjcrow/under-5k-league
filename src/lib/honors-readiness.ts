import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import type { HonorsGame } from "./honors";
import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";

export const HONOR_WEEK_STATE = {
  IN_PROGRESS: "IN_PROGRESS",
  AWAITING_BOX_SCORES: "AWAITING_BOX_SCORES",
  READY: "READY",
} as const;

export type HonorWeekState =
  (typeof HONOR_WEEK_STATE)[keyof typeof HONOR_WEEK_STATE];

export type HonorReadinessGameInput = {
  id: string;
  radiantWin: boolean;
  radiantTeamId: string | null;
  direTeamId: string | null;
  winnerTeamId: string | null;
  players: string;
};

export type HonorReadinessMatchInput = {
  id: string;
  week: number;
  phase: string;
  status: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  forfeit: boolean;
  games: HonorReadinessGameInput[];
};

export type HonorReadinessIssue =
  | "MATCH_NOT_FINAL"
  | "GAME_COUNT_MISMATCH"
  | "INVALID_BOX_SCORE"
  | "UNATTRIBUTED_PLAYER"
  | "DUPLICATE_PLAYER"
  | "SIDE_TEAM_MISMATCH"
  | "RESULT_MISMATCH";

export type HonorWeekReadiness = {
  week: number;
  state: HonorWeekState;
  issues: HonorReadinessIssue[];
  /** Safe, attributed games. Empty until the whole week is publishable. */
  games: HonorsGame[];
};

/** A final slate with no played evidence (normally all unplayed forfeits). */
export function isNoPerformanceHonorWeek(
  row: HonorWeekReadiness | undefined,
): boolean {
  return row?.state === HONOR_WEEK_STATE.READY && row.games.length === 0;
}

type ValidatedGame = {
  honorsGame: HonorsGame | null;
  issues: HonorReadinessIssue[];
};

function validateGame(
  match: HonorReadinessMatchInput,
  game: HonorReadinessGameInput,
): ValidatedGame {
  const decoded = decodeGamePlayers(game.players);
  const players = trustedGamePlayers(decoded);
  if (players.length !== 10) {
    return { honorsGame: null, issues: ["INVALID_BOX_SCORE"] };
  }

  const issues = new Set<HonorReadinessIssue>();
  const attributed = players.every((player) => player.userId && player.teamId);
  if (!attributed) issues.add("UNATTRIBUTED_PLAYER");

  const userIds = players.flatMap((player) =>
    player.userId ? [player.userId] : [],
  );
  if (userIds.length !== 10 || new Set(userIds).size !== 10) {
    issues.add("DUPLICATE_PLAYER");
  }

  const matchTeams = new Set([match.homeTeamId, match.awayTeamId]);
  if (
    !game.radiantTeamId ||
    !game.direTeamId ||
    game.radiantTeamId === game.direTeamId ||
    !matchTeams.has(game.radiantTeamId) ||
    !matchTeams.has(game.direTeamId)
  ) {
    issues.add("SIDE_TEAM_MISMATCH");
  } else if (
    players.some(
      (player) =>
        player.teamId !==
        (player.isRadiant ? game.radiantTeamId : game.direTeamId),
    )
  ) {
    issues.add("SIDE_TEAM_MISMATCH");
  }

  const expectedWinner = game.radiantWin ? game.radiantTeamId : game.direTeamId;
  if (!expectedWinner || game.winnerTeamId !== expectedWinner) {
    issues.add("RESULT_MISMATCH");
  }

  return {
    honorsGame:
      issues.size === 0 ? { radiantWin: game.radiantWin, players } : null,
    issues: [...issues],
  };
}

function evaluateWeek(
  week: number,
  matches: HonorReadinessMatchInput[],
): HonorWeekReadiness {
  if (matches.some((match) => match.status !== MATCH_STATUS.COMPLETED)) {
    return {
      week,
      state: HONOR_WEEK_STATE.IN_PROGRESS,
      issues: ["MATCH_NOT_FINAL"],
      games: [],
    };
  }

  const issues = new Set<HonorReadinessIssue>();
  const games: HonorsGame[] = [];
  for (const match of matches) {
    const expectedGames = match.homeScore + match.awayScore;
    // A forfeit may correctly have fewer (including zero) Game rows than its
    // ruled score, but it cannot contain more played games than that score.
    // A played series must have a non-zero final and exactly that many rows.
    if (
      (!match.forfeit &&
        (expectedGames === 0 || match.games.length !== expectedGames)) ||
      (match.forfeit && match.games.length > expectedGames)
    ) {
      issues.add("GAME_COUNT_MISMATCH");
    }

    const winnerCounts = new Map<string, number>();
    for (const game of match.games) {
      const validated = validateGame(match, game);
      for (const issue of validated.issues) issues.add(issue);
      if (validated.honorsGame) games.push(validated.honorsGame);
      if (game.winnerTeamId) {
        winnerCounts.set(
          game.winnerTeamId,
          (winnerCounts.get(game.winnerTeamId) ?? 0) + 1,
        );
      }
    }
    if (
      !match.forfeit &&
      ((winnerCounts.get(match.homeTeamId) ?? 0) !== match.homeScore ||
        (winnerCounts.get(match.awayTeamId) ?? 0) !== match.awayScore)
    ) {
      issues.add("RESULT_MISMATCH");
    }
  }

  if (issues.size > 0) {
    return {
      week,
      state: HONOR_WEEK_STATE.AWAITING_BOX_SCORES,
      issues: [...issues],
      games: [],
    };
  }
  return { week, state: HONOR_WEEK_STATE.READY, issues: [], games };
}

/**
 * Pure publication gate for weekly honors. Callers may safely pass a season's
 * whole schedule: postseason matches are ignored here, so a playoff fixture
 * reusing week 1 can never hold or contaminate regular-week awards.
 */
export function evaluateHonorWeeks(
  matches: HonorReadinessMatchInput[],
): HonorWeekReadiness[] {
  const byWeek = new Map<number, HonorReadinessMatchInput[]>();
  for (const match of matches) {
    if (match.phase !== MATCH_PHASE.REGULAR) continue;
    const rows = byWeek.get(match.week) ?? [];
    rows.push(match);
    byWeek.set(match.week, rows);
  }
  return [...byWeek.entries()]
    .sort(([left], [right]) => right - left)
    .map(([week, rows]) => evaluateWeek(week, rows));
}
