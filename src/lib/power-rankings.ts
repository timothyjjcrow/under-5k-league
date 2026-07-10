// Elo-style power rankings — pure and unit-tested. Standings say who's
// winning; the power ranking says who's *strong*: beating a top team moves
// you more than farming the bottom of the table.
//
// Ratings are computed per GAME (a 2-0 sweep earns more than a 2-1 scrap) by
// expanding each completed series into its game results, processed in week
// order. Game order inside a series is unknown, so home wins apply first —
// a negligible approximation at K=32.

export const ELO = {
  START: 1000,
  K: 32,
} as const;

export type RankableMatch = {
  week: number;
  status: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
};

export type PowerRankingRow = {
  teamId: string;
  rating: number;
  rank: number;
  /** Rank before the latest completed week (0 = unranked then). */
  prevRank: number;
  /** Rating change across the latest completed week. */
  delta: number;
};

function expected(ra: number, rb: number): number {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

/** Apply one game result to a ratings map. */
function applyGame(
  ratings: Map<string, number>,
  winnerId: string,
  loserId: string,
): void {
  const rw = ratings.get(winnerId) ?? ELO.START;
  const rl = ratings.get(loserId) ?? ELO.START;
  const e = expected(rw, rl);
  ratings.set(winnerId, rw + ELO.K * (1 - e));
  ratings.set(loserId, rl - ELO.K * (1 - e));
}

/** Ratings after processing every completed match up to (and incl.) a week. */
export function ratingsThroughWeek(
  matches: RankableMatch[],
  teamIds: string[],
  upToWeek: number,
): Map<string, number> {
  const ratings = new Map<string, number>(teamIds.map((t) => [t, ELO.START]));
  const done = matches
    .filter((m) => m.status === "COMPLETED" && m.week <= upToWeek)
    .sort((a, b) => a.week - b.week);
  for (const m of done) {
    for (let i = 0; i < m.homeScore; i++) {
      applyGame(ratings, m.homeTeamId, m.awayTeamId);
    }
    for (let i = 0; i < m.awayScore; i++) {
      applyGame(ratings, m.awayTeamId, m.homeTeamId);
    }
  }
  return ratings;
}

/** Current power rankings with movement vs. the previous completed week. */
export function powerRankings(
  matches: RankableMatch[],
  teamIds: string[],
): PowerRankingRow[] {
  const completedWeeks = matches
    .filter((m) => m.status === "COMPLETED")
    .map((m) => m.week);
  if (completedWeeks.length === 0) return [];
  const latest = Math.max(...completedWeeks);

  const now = ratingsThroughWeek(matches, teamIds, latest);
  const before = ratingsThroughWeek(matches, teamIds, latest - 1);

  const rankOf = (ratings: Map<string, number>) =>
    new Map(
      [...ratings.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([teamId], i) => [teamId, i + 1]),
    );
  const nowRanks = rankOf(now);
  const beforeRanks = rankOf(before);

  return teamIds
    .map((teamId) => ({
      teamId,
      rating: Math.round(now.get(teamId) ?? ELO.START),
      rank: nowRanks.get(teamId) ?? 0,
      prevRank: beforeRanks.get(teamId) ?? 0,
      delta: Math.round(
        (now.get(teamId) ?? ELO.START) - (before.get(teamId) ?? ELO.START),
      ),
    }))
    .sort((a, b) => a.rank - b.rank);
}
