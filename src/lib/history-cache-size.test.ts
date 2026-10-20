import { beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticHistory } from "../../test/support/synthetic-history";
import { PUBLIC_GAME_CACHE_MAX_BYTES, publicGameCacheEntry } from "./public-game-cache-policy";
import { careerGameCounts } from "./hall-of-fame";
import { pointsByPlayer } from "./fantasy";
import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";
import {
  analyzeRecordGames,
  leagueRecords,
  recordWatchBook,
  recordWatchFor,
  toRecordGames,
  type RecordGame,
} from "./records";

// What the public cache holds for the all-history readers, measured on a
// realistic synthetic history: 500 games over five seasons, every line in the
// shape the importer writes today (test/support/synthetic-history.ts). The
// raw rows outgrow Next's 2 MiB entry at about 160 games; the derived entries
// the readers use (cached-queries.ts) must stay far below it, match what the
// pages computed from the raw rows, and once they exist a view reads no Game.

const history = syntheticHistory({ games: 500, seasons: 5 });
/** "Far below": a twentieth of the budget, about 95 KB. */
const DERIVED_BUDGET = PUBLIC_GAME_CACHE_MAX_BYTES / 20;

const mocks = vi.hoisted(() => ({
  revision: "v1",
  entries: new Map<string, unknown>(),
  gameReads: 0,
}));
vi.mock("./prisma", () => ({
  prisma: {
    game: {
      findMany: async () => {
        mocks.gameReads++;
        return history.games.map(({ fetchedAtMs, ...game }) => ({ ...game, fetchedAt: new Date(fetchedAtMs) }));
      },
    },
    match: { findMany: async () => history.matches },
    team: { findMany: async () => history.teams },
  },
}));
vi.mock("./honors-readiness-service", () => ({ getSeasonHonorReadiness: async () => [] }));
vi.mock("./public-read-signals", () => ({
  getPublicReadSignals: async () => ({ publicGameRevision: mocks.revision }),
}));
vi.mock("./db-observability", () => ({ databaseDiagnostics: { refresh: () => {}, snapshotSize: () => {} } }));
// Next's persistent entry, modelled with its JSON round trip.
vi.mock("next/cache", () => ({
  unstable_cache: (load: (...args: unknown[]) => Promise<unknown>, keys: string[]) =>
    async (...args: unknown[]) => {
      const key = JSON.stringify([keys, args]);
      if (!mocks.entries.has(key)) {
        mocks.entries.set(key, JSON.parse(JSON.stringify(await load(...args))));
      }
      return mocks.entries.get(key);
    },
}));

/** Each cached entry's size in Next's FETCH envelope, by key and scope. */
function entrySizes() {
  return Object.fromEntries([...mocks.entries].map(([key, entry]) => {
    const [[name], [scope]] = JSON.parse(key) as [[string], [string | null]];
    const { kind, value } = entry as { kind: string; value: unknown };
    expect(kind, name).toBe("data");
    return [`${name}:${scope ?? "all"}`, publicGameCacheEntry(value).serializedBytes];
  }));
}

async function readEveryDerivedEntry() {
  const queries = await import("./cached-queries");
  return {
    watch: await queries.getRecordWatchBook(),
    allTime: await queries.getRecordBookView(null),
    season: await queries.getRecordBookView(history.seasons[2].id),
    careers: await queries.getCareerFacts(),
  };
}

beforeEach(() => {
  vi.resetModules();
  mocks.revision = "v1";
  mocks.entries.clear();
  mocks.gameReads = 0;
});

describe("all-history public cache entries at 500 games", () => {
  it("leaves the raw rows past the entry limit and keeps every derived entry far below it", async () => {
    const { fetchPublicGameSnapshot } = await import("./public-game-snapshot");
    expect(publicGameCacheEntry(await fetchPublicGameSnapshot(null)).entry.kind).toBe("oversize");
    await readEveryDerivedEntry();
    const sizes = entrySizes();
    expect(Object.keys(sizes).sort()).toEqual([
      "career-facts-v1:all",
      "record-book-view-v1:all",
      `record-book-view-v1:${history.seasons[2].id}`,
      "record-watch-book-v1:all",
    ]);
    for (const [entry, bytes] of Object.entries(sizes)) {
      expect(bytes, entry).toBeLessThan(DERIVED_BUDGET);
    }
  });

  it("serves every later view from the entries without reading a Game row", async () => {
    await readEveryDerivedEntry();
    const reads = mocks.gameReads;
    expect(reads).toBeGreaterThan(0);
    vi.resetModules(); // another render, even another process, on one revision
    await readEveryDerivedEntry();
    expect(mocks.gameReads).toBe(reads);
    // A result write moves the revision: the next view rebuilds every entry.
    mocks.revision = "v2";
    await readEveryDerivedEntry();
    expect(mocks.gameReads).toBeGreaterThan(reads);
  });

  it("gives the pages what they computed from the raw rows", async () => {
    const { fetchAllGamesForRecords } = await import("./cached-queries");
    const rows = await fetchAllGamesForRecords();
    const { watch, allTime, season, careers } = await readEveryDerivedEntry();

    // Record watch and the profile: the book and every career best.
    const book = recordWatchBook(toRecordGames(rows));
    expect(watch).toEqual(book);
    expect(book.records.length).toBeGreaterThan(0);
    for (const userId of new Set(history.games.flatMap((game) =>
      JSON.parse(game.players).map((line: { userId: string }) => line.userId)))) {
      expect(recordWatchFor(watch, userId)).toEqual(recordWatchFor(book, userId));
    }

    // /records, as the page derived it before (all time and one season).
    const extended = (game: RecordGame) => game.lines.some((line) => line.userId != null && (
      line.xpm != null || line.denies != null || line.heroDamage != null ||
      line.towerDamage != null || line.heroHealing != null));
    for (const [view, seasonId] of [[allTime, null], [season, history.seasons[2].id]] as const) {
      const scoped = seasonId ? rows.filter((row) => row.match.seasonId === seasonId) : rows;
      const analysis = analyzeRecordGames(scoped);
      const expectedBook = leagueRecords(analysis.games);
      expect(view.book).toEqual(expectedBook);
      expect(view.diagnostics).toEqual(analysis.diagnostics);
      expect(view.scopedGames).toBe(scoped.length);
      expect(view.eligibleGames).toBe(analysis.games.length);
      expect(view.extendedGames).toBe(analysis.games.filter(extended).length);
      expect(new Set(view.seasonIdsWithGames)).toEqual(new Set(rows.map((row) => row.match.seasonId)));
      const matchupOf = new Map(rows.map((row) => [row.matchId,
        { home: row.match.homeTeam.name, away: row.match.awayTeam.name }]));
      expect(expectedBook.games.length).toBeGreaterThan(0);
      for (const record of expectedBook.games) {
        expect(view.matchups.find((matchup) => matchup.matchId === record.matchId))
          .toEqual({ matchId: record.matchId, ...matchupOf.get(record.matchId) });
      }
    }

    // The Hall of Fame's game boards (careers: appearance-careers.test.ts).
    const { hallOfFameGameBoards } = await import("./hall-of-fame");
    const seasonOfMatch = new Map(history.matches.map((match) => [match.id, match.seasonId]));
    const trustedGames = history.games.map((game) => ({
      seasonId: seasonOfMatch.get(game.matchId),
      radiantWin: game.radiantWin,
      players: trustedGamePlayers(decodeGamePlayers(game.players)),
    })).filter((game) => game.players.length === 10);
    expect(trustedGames).toHaveLength(500);
    expect(hallOfFameGameBoards(careers.games)).toEqual({
      seasonsWithGames: 5,
      gameCounts: careerGameCounts(trustedGames),
      impact: pointsByPlayer(trustedGames),
    });
  });
});
