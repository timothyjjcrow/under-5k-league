import { unstable_cache } from "next/cache";
import { prisma } from "./prisma";

// The all-games stat roll-ups (leaders, hero meta, records, hall of fame,
// player profiles) recompute from every stored Game on each request — a
// player's userId lives inside each row's `players` JSON, not a column, so
// there is no way to query "games for player X" without scanning the table.
// The exported `get*` wrappers cache the raw, VIEWER-INDEPENDENT scans for a
// short window; the derived math still runs per request, but the expensive DB
// read is shared across all viewers instead of repeated per view.
//
// Each scan is split into a plain `fetch*` (the actual query — unit-tested for
// data-equivalence in test/integration/cached-queries.itest.ts, since
// unstable_cache needs the Next server runtime and can't run under vitest) and
// a `get*` cache wrapper. Pages import the `get*` versions.
//
// Every entry is tagged "games" so an import path can `revalidateTag("games")`
// for instant freshness later; until then the TTL bounds staleness to a minute
// (games import infrequently, so this is imperceptible in practice).

const REVALIDATE_SECONDS = 60;
const CACHE_TAGS = ["games"];

/** Every game as {id, players} — attribute games to a player via the userId
 *  embedded in the box-score JSON (player profiles). */
export function fetchAllGameLines() {
  return prisma.game.findMany({ select: { id: true, players: true } });
}
export const getAllGameLines = unstable_cache(fetchAllGameLines, ["all-game-lines"], {
  revalidate: REVALIDATE_SECONDS,
  tags: CACHE_TAGS,
});

/** Every game's box score + win flag, all seasons — Hall of Fame. */
export function fetchAllGameScores() {
  return prisma.game.findMany({ select: { players: true, radiantWin: true } });
}
export const getAllGameScores = unstable_cache(fetchAllGameScores, ["all-game-scores"], {
  revalidate: REVALIDATE_SECONDS,
  tags: CACHE_TAGS,
});

/** Every game with matchup context, chronological — the record book. */
export function fetchAllGamesForRecords() {
  return prisma.game.findMany({
    orderBy: [{ startTime: "asc" }, { fetchedAt: "asc" }],
    select: {
      matchId: true,
      radiantWin: true,
      durationSecs: true,
      radiantScore: true,
      direScore: true,
      players: true,
      match: {
        select: {
          seasonId: true,
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
        },
      },
    },
  });
}
export const getAllGamesForRecords = unstable_cache(
  fetchAllGamesForRecords,
  ["records-games"],
  { revalidate: REVALIDATE_SECONDS, tags: CACHE_TAGS },
);

/** One season's games with box score + win flag — Hero meta page. */
export function fetchSeasonGameScores(seasonId: string) {
  return prisma.game.findMany({
    where: { match: { seasonId } },
    select: { players: true, radiantWin: true },
  });
}
export const getSeasonGameScores = unstable_cache(
  fetchSeasonGameScores,
  ["season-game-scores"],
  { revalidate: REVALIDATE_SECONDS, tags: CACHE_TAGS },
);

/** One season's games with week/phase context — the Leaders boards. */
export function fetchSeasonGameLeaders(seasonId: string) {
  return prisma.game.findMany({
    where: { match: { seasonId } },
    select: {
      players: true,
      radiantWin: true,
      match: { select: { week: true, phase: true } },
    },
  });
}
export const getSeasonGameLeaders = unstable_cache(
  fetchSeasonGameLeaders,
  ["season-game-leaders"],
  { revalidate: REVALIDATE_SECONDS, tags: CACHE_TAGS },
);
