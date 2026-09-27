// Hall-of-fame math — pure and unit-tested. Careers span seasons: game
// counts, and (via appearance-careers and the fantasy/pick'em libs) titles,
// career points and oracle records are all computed from the archive, not
// just the active season.

export type HofRow = { userId: string; value: number };

export type CareerGameCount = { games: number; wins: number };

/** Count only actual mapped appearances from already-validated box scores. */
export function careerGameCounts(
  games: {
    radiantWin: boolean;
    players: { userId?: string | null; isRadiant: boolean }[];
  }[],
): Map<string, CareerGameCount> {
  const counts = new Map<string, CareerGameCount>();
  for (const game of games) {
    for (const player of game.players) {
      if (!player.userId) continue;
      const row = counts.get(player.userId) ?? { games: 0, wins: 0 };
      row.games += 1;
      if (player.isRadiant === game.radiantWin) row.wins += 1;
      counts.set(player.userId, row);
    }
  }
  return counts;
}

/** Top-N of a per-user count map (value desc, id tiebreak for stability). */
export function topCounts(
  counts: Map<string, number>,
  limit = 5,
  min = 1,
): HofRow[] {
  return [...counts.entries()]
    .filter(([, v]) => v >= min)
    .map(([userId, value]) => ({ userId, value }))
    .sort((a, b) => b.value - a.value || a.userId.localeCompare(b.userId))
    .slice(0, limit);
}
