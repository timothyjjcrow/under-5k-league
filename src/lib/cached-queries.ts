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
// Every entry is tagged "games". Server Actions expire it with updateTag for
// read-your-own-writes; the sync Route Handler uses revalidateTag with
// `{ expire: 0 }`, the blocking Route Handler equivalent. The TTL remains a
// defensive bound if an out-of-band database writer bypasses those paths.

const REVALIDATE_SECONDS = 60;
const CACHE_TAGS = ["games"];

/** Every game as {id, players} — attribute games to a player via the userId
 *  embedded in the box-score JSON (player profiles). */
export function fetchAllGameLines() {
  return prisma.game.findMany({ select: { id: true, players: true } });
}
export const getAllGameLines = unstable_cache(
  fetchAllGameLines,
  ["all-game-lines"],
  {
    revalidate: REVALIDATE_SECONDS,
    tags: CACHE_TAGS,
  },
);

/** Every game's box score + win flag, all seasons — Hall of Fame. */
export function fetchAllGameScores() {
  return prisma.game.findMany({ select: { players: true, radiantWin: true } });
}
export const getAllGameScores = unstable_cache(
  fetchAllGameScores,
  ["all-game-scores"],
  {
    revalidate: REVALIDATE_SECONDS,
    tags: CACHE_TAGS,
  },
);

/** Every game with matchup context, chronological — the record book. */
export function fetchAllGamesForRecords() {
  return prisma.game
    .findMany({
      select: {
        id: true,
        startTime: true,
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
    })
    .then((games) =>
      games.sort((a, b) => {
        // OpenDota time is the authoritative chronology. Legacy 0 means
        // unknown, so it belongs after every dated game rather than becoming
        // the league's fictional first achiever. CUID is a stable/import-time
        // final key and cannot be rewritten by a later enrichment fetch.
        const aTime = a.startTime > 0 ? a.startTime : Number.MAX_SAFE_INTEGER;
        const bTime = b.startTime > 0 ? b.startTime : Number.MAX_SAFE_INTEGER;
        return aTime - bTime || a.id.localeCompare(b.id);
      }),
    );
}
export const getAllGamesForRecords = unstable_cache(
  fetchAllGamesForRecords,
  ["records-games"],
  { revalidate: REVALIDATE_SECONDS, tags: CACHE_TAGS },
);

/** Every game with the fields the opponent scouting report needs, all seasons.
 *  The match preview builds both teams' dossiers from every game ever played,
 *  so this is an unbounded scan on a page captains open on match night. */
export function fetchAllGamesForScouting() {
  return prisma.game.findMany({
    select: {
      players: true,
      radiantWin: true,
      durationSecs: true,
      startTime: true,
    },
  });
}
// Deliberately NOT wrapped in unstable_cache. The match preview awaits this
// inside a nested <Suspense> async component, and there the cache wrapper never
// resolved — the whole scouting card silently vanished from the page (caught by
// e2e-mid/match.spec.ts). The raw scan is still shared here so the query lives
// with its siblings and stays covered by the data-equivalence test.

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

/** One season's games with scores/duration — the recap/awards page. Stable
 *  ordering makes equal-margin award ties deterministic across databases. */
export function fetchSeasonGamesForRecap(seasonId: string) {
  return prisma.game.findMany({
    where: { match: { seasonId } },
    orderBy: [{ fetchedAt: "asc" }, { id: "asc" }],
    select: {
      matchId: true,
      radiantWin: true,
      radiantScore: true,
      direScore: true,
      durationSecs: true,
      players: true,
    },
  });
}
export const getSeasonGamesForRecap = unstable_cache(
  fetchSeasonGamesForRecap,
  ["season-games-recap"],
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
