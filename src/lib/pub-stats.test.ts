import { describe, expect, it } from "vitest";
import {
  PUB_QUIET_DAYS,
  PUB_STATS_REFRESH_MS,
  formatGamesCount,
  parsePubStats,
  poolPubRecord,
  pubActivity,
  pubStatsFresh,
  pubWinRate,
  type PubStats,
} from "./pub-stats";

const good: PubStats = {
  recentWins: 54,
  recentLosses: 46,
  totalGames: 2113,
  lastPlayedAt: 1_722_200_000,
  topHeroes: [
    { heroId: 14, games: 220, wins: 121 },
    { heroId: 74, games: 180, wins: 92 },
  ],
};

describe("parsePubStats", () => {
  it("round-trips a well-formed blob", () => {
    expect(parsePubStats(JSON.stringify(good))).toEqual(good);
  });

  it("returns null for null/empty/garbage", () => {
    expect(parsePubStats(null)).toBeNull();
    expect(parsePubStats("")).toBeNull();
    expect(parsePubStats("not json")).toBeNull();
    expect(parsePubStats("[1,2,3]")).toBeNull();
    expect(parsePubStats("42")).toBeNull();
  });

  it("returns null when a required figure is missing or invalid", () => {
    expect(parsePubStats(JSON.stringify({ ...good, recentWins: undefined }))).toBeNull();
    expect(parsePubStats(JSON.stringify({ ...good, recentLosses: -1 }))).toBeNull();
    expect(parsePubStats(JSON.stringify({ ...good, totalGames: "many" }))).toBeNull();
    expect(parsePubStats(JSON.stringify({ ...good, recentWins: NaN }))).toBeNull();
  });

  it("normalizes a missing/zero lastPlayedAt to null", () => {
    expect(
      parsePubStats(JSON.stringify({ ...good, lastPlayedAt: null }))?.lastPlayedAt,
    ).toBeNull();
    expect(
      parsePubStats(JSON.stringify({ ...good, lastPlayedAt: 0 }))?.lastPlayedAt,
    ).toBeNull();
    const noField = { ...good } as Record<string, unknown>;
    delete noField.lastPlayedAt;
    expect(parsePubStats(JSON.stringify(noField))?.lastPlayedAt).toBeNull();
  });

  it("drops malformed hero entries and caps the list at 5", () => {
    const heroes = [
      ...Array.from({ length: 7 }, (_, i) => ({
        heroId: i + 1,
        games: 10,
        wins: 5,
      })),
      { heroId: 0, games: 3, wins: 1 }, // heroId 0 = invalid
      { heroId: 9, games: "3", wins: 1 }, // non-numeric games
      "junk",
    ];
    const parsed = parsePubStats(JSON.stringify({ ...good, topHeroes: heroes }));
    expect(parsed?.topHeroes).toHaveLength(5);
    expect(parsed?.topHeroes.every((h) => h.heroId >= 1)).toBe(true);
  });

  it("tolerates a missing topHeroes array (legacy/partial blob)", () => {
    const noHeroes = { ...good } as Record<string, unknown>;
    delete noHeroes.topHeroes;
    expect(parsePubStats(JSON.stringify(noHeroes))?.topHeroes).toEqual([]);
  });
});

describe("pubWinRate", () => {
  it("computes the recent-window rate", () => {
    expect(pubWinRate({ recentWins: 54, recentLosses: 46 })).toBeCloseTo(0.54);
  });
  it("is null with no games — never a fake 0%", () => {
    expect(pubWinRate({ recentWins: 0, recentLosses: 0 })).toBeNull();
  });
});

describe("formatGamesCount", () => {
  it("keeps small counts exact and compacts thousands", () => {
    expect(formatGamesCount(0)).toBe("0");
    expect(formatGamesCount(872)).toBe("872");
    expect(formatGamesCount(1000)).toBe("1k");
    expect(formatGamesCount(2113)).toBe("2.1k");
    expect(formatGamesCount(9950)).toBe("9.9k");
    expect(formatGamesCount(9999)).toBe("10k"); // trailing .0 stripped
    expect(formatGamesCount(15_200)).toBe("15k");
  });
});

describe("pubActivity", () => {
  const now = Date.UTC(2026, 7, 1); // Aug 1 2026
  const daysAgo = (d: number) => Math.floor((now - d * 86_400_000) / 1000);

  it("is null when the last game time is unknown", () => {
    expect(pubActivity(null, now)).toBeNull();
    expect(pubActivity(0, now)).toBeNull();
  });

  it("buckets labels by recency", () => {
    expect(pubActivity(daysAgo(0), now)?.label).toBe("today");
    expect(pubActivity(daysAgo(5), now)?.label).toBe("5d ago");
    expect(pubActivity(daysAgo(21), now)?.label).toBe("3w ago");
    expect(pubActivity(daysAgo(120), now)?.label).toBe("4mo ago");
    expect(pubActivity(daysAgo(800), now)?.label).toBe("2y ago");
  });

  it("flips quiet exactly at the PUB_QUIET_DAYS boundary", () => {
    expect(pubActivity(daysAgo(PUB_QUIET_DAYS - 1), now)?.quiet).toBe(false);
    expect(pubActivity(daysAgo(PUB_QUIET_DAYS), now)?.quiet).toBe(true);
  });
});

describe("pubStatsFresh", () => {
  const now = Date.UTC(2026, 7, 1);
  it("never fetched = stale; recent = fresh; past the window = stale", () => {
    expect(pubStatsFresh(null, now)).toBe(false);
    expect(pubStatsFresh(new Date(now - 1000), now)).toBe(true);
    expect(pubStatsFresh(new Date(now - PUB_STATS_REFRESH_MS - 1), now)).toBe(
      false,
    );
  });
});

describe("poolPubRecord", () => {
  it("trims to the five scalars — no hero list crosses the wire", () => {
    const rec = poolPubRecord(JSON.stringify(good));
    expect(rec).toEqual({
      recentWins: 54,
      recentLosses: 46,
      totalGames: 2113,
      lastPlayedAt: 1_722_200_000,
    });
    expect(rec && "topHeroes" in rec).toBe(false);
  });

  it("is null with nothing scoutable: no blob, garbage, or an empty recent window", () => {
    expect(poolPubRecord(null)).toBeNull();
    expect(poolPubRecord("garbage")).toBeNull();
    expect(
      poolPubRecord(
        JSON.stringify({ ...good, recentWins: 0, recentLosses: 0 }),
      ),
    ).toBeNull();
  });
});
