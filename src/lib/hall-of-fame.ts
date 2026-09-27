// Hall-of-fame math — pure and unit-tested. Careers span seasons: game
// counts, and (via appearance-careers and the fantasy/pick'em libs) titles,
// career points and oracle records are all computed from the archive, not
// just the active season.

import { competitionRanks } from "./leader-ranking";

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

/** Every user with at least `min`, best first. The user id only makes the
 *  order of equal values stable; it never decides a place (see topPlaces). */
export function rankCounts(
  counts: Map<string, number>,
  min = 1,
): HofRow[] {
  return [...counts.entries()]
    .filter(([, v]) => v >= min)
    .map(([userId, value]) => ({ userId, value }))
    .sort((a, b) => b.value - a.value || a.userId.localeCompare(b.userId));
}

type PlacedRow = HofRow & { place: number };
export type HofBoardRows = {
  rows: PlacedRow[];
  /** Players tied with the last shown row who did not fit under maxRows. */
  moreTied: number;
};

/**
 * The top of a board with shared places: equal values share a place
 * (1, 1, 3), and everyone tied with a top-`limit` place is shown, so a tie
 * at the cutoff never drops a player for their user id. `maxRows` caps a
 * board where half the league is tied; the rest are counted in `moreTied`.
 * `placeKey` rounds to the precision the board displays, so two values that
 * read the same share a place. `sorted` must be best first.
 */
export function topPlaces(
  sorted: HofRow[],
  {
    limit = 5,
    maxRows = 10,
    placeKey = (value: number) => value,
  }: {
    limit?: number;
    maxRows?: number;
    placeKey?: (value: number) => number;
  } = {},
): HofBoardRows {
  const places = competitionRanks(sorted.map((row) => placeKey(row.value)));
  let end = Math.min(limit, sorted.length);
  while (end < sorted.length && places[end] <= limit) end++;
  const shown = Math.min(end, Math.max(limit, maxRows));
  return {
    rows: sorted
      .slice(0, shown)
      .map((row, index) => ({
        userId: row.userId,
        value: row.value,
        place: places[index],
      })),
    moreTied: end - shown,
  };
}
