// Season cross table ("who's played who"): teams × teams, one cell per
// meeting, from the ROW team's perspective. Pure + DB-free — the schedule
// and season pages feed it prisma Match rows, this does the pairing math.

import { MATCH_PHASE, MATCH_STATUS } from "./constants";

export type CrossMatch = {
  id: string;
  week: number;
  phase: string;
  status: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  winnerTeamId: string | null;
  /** Ruled result: the score was awarded, not played. */
  forfeit?: boolean;
};

export type CrossCell = {
  matchId: string;
  week: number;
  played: boolean;
  /** Mid-series (some games imported, series undecided) — labels shouldn't claim "not played". */
  live: boolean;
  /** Row team's result — null until the match is COMPLETED. */
  result: "W" | "L" | "D" | null;
  /** Row team's games first, e.g. "2–0": the final score once played, the
   *  running score while live, null before the first game. */
  score: string | null;
  /** A ruled (forfeit) result — only ever set on a played meeting. */
  forfeit: boolean;
};

export type CrossTable = {
  teamIds: string[];
  /** cells.get(rowTeam)!.get(colTeam)! — meetings in week order ([] = never scheduled). */
  cells: Map<string, Map<string, CrossCell[]>>;
};

/**
 * Build the grid over REGULAR-season matches only (playoffs live in the
 * bracket). Every ordered pair gets a list — usually one meeting, more in a
 * double round robin — sorted by week. Matches naming teams outside
 * `teamIds` are ignored.
 */
export function crossTable(
  teamIds: string[],
  matches: CrossMatch[],
): CrossTable {
  const ids = new Set(teamIds);
  const cells = new Map<string, Map<string, CrossCell[]>>(
    teamIds.map((row) => [
      row,
      new Map(teamIds.filter((c) => c !== row).map((col) => [col, []])),
    ]),
  );

  const regular = matches
    .filter(
      (m) =>
        m.phase === MATCH_PHASE.REGULAR &&
        m.homeTeamId !== m.awayTeamId &&
        ids.has(m.homeTeamId) &&
        ids.has(m.awayTeamId),
    )
    .sort((a, b) => a.week - b.week);

  for (const m of regular) {
    for (const [row, col] of [
      [m.homeTeamId, m.awayTeamId],
      [m.awayTeamId, m.homeTeamId],
    ] as const) {
      const mine = row === m.homeTeamId ? m.homeScore : m.awayScore;
      const theirs = row === m.homeTeamId ? m.awayScore : m.homeScore;
      const played = m.status === MATCH_STATUS.COMPLETED;
      const live = m.status === MATCH_STATUS.LIVE;
      cells.get(row)!.get(col)!.push({
        matchId: m.id,
        week: m.week,
        played,
        live,
        result: !played
          ? null
          : m.winnerTeamId === row
            ? "W"
            : m.winnerTeamId === null
              ? "D"
              : "L",
        score: played || live ? `${mine}–${theirs}` : null,
        forfeit: played && m.forfeit === true,
      });
    }
  }

  return { teamIds, cells };
}
