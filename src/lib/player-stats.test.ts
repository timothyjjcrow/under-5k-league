import { describe, expect, it } from "vitest";
import {
  currentStreak,
  summarizePlayerGames,
  topBy,
  wonGame,
  type LeaderEntry,
  type PlayerGameLine,
  decodeGamePlayers,
  parseGamePlayers,
  trustedGamePlayers,
} from "./player-stats";

function line(partial: Partial<PlayerGameLine>): PlayerGameLine {
  return {
    isRadiant: true,
    radiantWin: true,
    kills: 0,
    deaths: 0,
    assists: 0,
    heroId: 1,
    ...partial,
  };
}

describe("wonGame", () => {
  it("radiant player wins when radiant wins", () => {
    expect(wonGame(line({ isRadiant: true, radiantWin: true }))).toBe(true);
  });
  it("dire player wins when radiant loses", () => {
    expect(wonGame(line({ isRadiant: false, radiantWin: false }))).toBe(true);
  });
  it("radiant player loses when radiant loses", () => {
    expect(wonGame(line({ isRadiant: true, radiantWin: false }))).toBe(false);
  });
});

describe("currentStreak", () => {
  const w = () => line({ isRadiant: true, radiantWin: true });
  const l = () => line({ isRadiant: true, radiantWin: false });

  it("returns null streak for no games", () => {
    expect(currentStreak([])).toEqual({ type: null, count: 0 });
  });

  it("counts the leading run of wins (newest first)", () => {
    expect(currentStreak([w(), w(), w(), l()])).toEqual({
      type: "W",
      count: 3,
    });
  });

  it("counts the leading run of losses", () => {
    expect(currentStreak([l(), l(), w()])).toEqual({ type: "L", count: 2 });
  });
});

describe("summarizePlayerGames", () => {
  it("returns zeroed summary for no games", () => {
    const s = summarizePlayerGames([]);
    expect(s).toMatchObject({
      games: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      kda: 0,
      topHeroes: [],
    });
  });

  it("counts wins/losses across both sides", () => {
    const s = summarizePlayerGames([
      line({ isRadiant: true, radiantWin: true }), // win
      line({ isRadiant: false, radiantWin: true }), // loss
      line({ isRadiant: false, radiantWin: false }), // win
    ]);
    expect(s.games).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBe(67);
  });

  it("aggregates KDA and averages", () => {
    const s = summarizePlayerGames([
      line({ kills: 10, deaths: 2, assists: 5 }),
      line({ kills: 4, deaths: 6, assists: 15 }),
    ]);
    expect(s.kills).toBe(14);
    expect(s.deaths).toBe(8);
    expect(s.assists).toBe(20);
    expect(s.avgKills).toBe(7);
    expect(s.avgDeaths).toBe(4);
    expect(s.avgAssists).toBe(10);
    // (14 + 20) / 8 = 4.25 -> 4.3
    expect(s.kda).toBe(4.3);
  });

  it("avoids divide-by-zero when the player never died", () => {
    const s = summarizePlayerGames([line({ kills: 3, deaths: 0, assists: 1 })]);
    expect(s.kda).toBe(4); // (3 + 1) / max(1, 0)
  });

  it("averages net worth/GPM only over games that reported them", () => {
    const s = summarizePlayerGames([
      line({ netWorth: 10000, gpm: 500 }),
      line({ netWorth: 20000, gpm: 700 }),
      line({ netWorth: null, gpm: null }), // missing -> excluded from the average
    ]);
    expect(s.avgNetWorth).toBe(15000);
    expect(s.avgGpm).toBe(600);
    expect(s.netWorthGames).toBe(2);
    expect(s.gpmGames).toBe(2);
  });

  it("reports null economy averages when no game has the data", () => {
    const s = summarizePlayerGames([line({}), line({})]);
    expect(s.avgNetWorth).toBeNull();
    expect(s.avgGpm).toBeNull();
  });

  it("ranks heroes by games then wins", () => {
    const s = summarizePlayerGames([
      line({ heroId: 5, isRadiant: true, radiantWin: true }), // win
      line({ heroId: 5, isRadiant: true, radiantWin: false }), // loss
      line({ heroId: 8, isRadiant: true, radiantWin: true }), // win
      line({ heroId: 8, isRadiant: true, radiantWin: true }), // win
    ]);
    expect(s.topHeroes).toEqual([
      { heroId: 8, games: 2, wins: 2 },
      { heroId: 5, games: 2, wins: 1 },
    ]);
  });
});

describe("topBy", () => {
  function entry(id: string, lines: PlayerGameLine[]): LeaderEntry {
    return { id, summary: summarizePlayerGames(lines) };
  }
  const win = (heroId = 1) =>
    line({ isRadiant: true, radiantWin: true, heroId });
  const loss = (heroId = 1) =>
    line({ isRadiant: true, radiantWin: false, heroId });

  it("ranks by total wins, most first", () => {
    const entries = [
      entry("a", [win(), win(), loss()]), // 2 wins
      entry("b", [win()]), // 1 win
      entry("c", [win(), win(), win()]), // 3 wins
    ];
    expect(topBy(entries, "wins").map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("applies a minGames floor for rate stats", () => {
    const entries = [
      entry("oneshot", [win()]), // 100% but only 1 game
      entry("grinder", [win(), win(), win(), loss()]), // 75% over 4
    ];
    // Without the floor the 1-game player would top winRate; with minGames=3
    // they're excluded.
    expect(topBy(entries, "winRate", { minGames: 3 }).map((r) => r.id)).toEqual(
      ["grinder"],
    );
  });

  it("ranks by average GPM and excludes players with no economy data", () => {
    const entries = [
      entry("rich", [line({ gpm: 700 }), line({ gpm: 500 })]), // avg 600
      entry("poor", [line({ gpm: 300 }), line({ gpm: 300 })]), // avg 300
      entry("nodata", [line({}), line({})]), // no gpm -> value 0 -> excluded
    ];
    expect(topBy(entries, "gpm").map((r) => r.id)).toEqual(["rich", "poor"]);
  });

  it("applies economy floors to reported samples, not unrelated game count", () => {
    const entries = [
      entry("one-sample", [
        line({ gpm: 900 }),
        line({ gpm: null }),
        line({ gpm: null }),
      ]),
      entry("qualified", [
        line({ gpm: 500 }),
        line({ gpm: 550 }),
        line({ gpm: 600 }),
      ]),
    ];
    expect(topBy(entries, "gpm", { minGames: 3 }).map((r) => r.id)).toEqual([
      "qualified",
    ]);
  });

  it("drops zero-value rows and respects the limit", () => {
    const entries = [
      entry("a", [win(), win()]),
      entry("b", [loss(), loss()]), // 0 wins -> excluded from a wins board
      entry("c", [win()]),
    ];
    const rows = topBy(entries, "wins", { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("a");
  });
});

describe("parseGamePlayers", () => {
  it("parses a stored box score into lines", () => {
    const lines = parseGamePlayers(
      '[{"heroId":7,"isRadiant":true,"kills":7,"deaths":2,"assists":9,"userId":"u1"}]',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      heroId: 7,
      isRadiant: true,
      kills: 7,
      deaths: 2,
      assists: 9,
      userId: "u1",
      netWorth: null,
    });
  });

  it("returns [] for malformed JSON instead of throwing", () => {
    // Every stat page parses this column; one bad row must not take a whole
    // leaderboard off the air.
    expect(parseGamePlayers("not json")).toEqual([]);
    expect(parseGamePlayers("")).toEqual([]);
  });

  it("returns [] when the JSON isn't an array", () => {
    expect(parseGamePlayers('{"kills":7}')).toEqual([]);
    expect(parseGamePlayers("null")).toEqual([]);
    expect(parseGamePlayers("42")).toEqual([]);
  });

  it("handles the default empty column value", () => {
    expect(parseGamePlayers("[]")).toEqual([]);
  });

  it("rejects structurally unsafe array members instead of casting them", () => {
    const decoded = decodeGamePlayers(
      JSON.stringify([
        {},
        { heroId: 1, isRadiant: true, kills: "7", deaths: 1, assists: 2 },
        { heroId: 1, isRadiant: true, kills: 7, deaths: null, assists: 2 },
        {
          heroId: 1,
          isRadiant: true,
          kills: 7,
          deaths: 1,
          assists: 2,
          userId: 42,
        },
      ]),
    );
    expect(decoded).toEqual({
      players: [],
      invalidLines: 4,
      malformed: false,
      completeRoster: false,
    });
  });

  it("normalizes unsafe optional economy and benchmark values to null", () => {
    const [line] = parseGamePlayers(
      JSON.stringify([
        {
          heroId: 1,
          isRadiant: false,
          kills: 2,
          deaths: 3,
          assists: 4,
          gpm: "fast",
          netWorth: -1,
          lastHits: 1e308,
          benchmarks: {
            gold_per_min: { raw: "unknown", pct: 2 },
            broken: { pct: "high" },
          },
        },
      ]),
    );
    expect(line.gpm).toBeNull();
    expect(line.netWorth).toBeNull();
    expect(line.lastHits).toBeNull();
    expect(line.benchmarks).toEqual({
      gold_per_min: { raw: null, pct: 1 },
    });
  });

  it("preserves real 32-bit account ids but rejects fractional or oversized ids", () => {
    const base = {
      heroId: 1,
      isRadiant: true,
      kills: 2,
      deaths: 3,
      assists: 4,
    };
    const lines = parseGamePlayers(
      JSON.stringify([
        { ...base, accountId: 4_000_000_000 },
        { ...base, heroId: 2, accountId: 12.5 },
        { ...base, heroId: 3, accountId: Number.MAX_SAFE_INTEGER },
      ]),
    );
    expect(lines.map((line) => line.accountId)).toEqual([
      4_000_000_000,
      null,
      null,
    ]);
  });

  it("reports malformed top-level data separately from invalid lines", () => {
    expect(decodeGamePlayers("not json")).toEqual({
      players: [],
      invalidLines: 0,
      malformed: true,
      completeRoster: false,
    });
    expect(decodeGamePlayers("[{}]")).toMatchObject({
      invalidLines: 1,
      malformed: false,
    });
  });

  it("rejects unsafe required counters and implausible hero ids", () => {
    const decoded = decodeGamePlayers(
      JSON.stringify([
        {
          heroId: 1,
          isRadiant: true,
          kills: Number.MAX_SAFE_INTEGER,
          deaths: 1,
          assists: 1,
        },
        {
          heroId: 99_999,
          isRadiant: false,
          kills: 1,
          deaths: 1,
          assists: 1,
        },
      ]),
    );
    expect(decoded.invalidLines).toBe(2);
    expect(decoded.players).toEqual([]);
  });

  it("trusts only a unique complete 5v5 roster for public roll-ups", () => {
    const roster = Array.from({ length: 10 }, (_, index) => ({
      accountId: 1000 + index,
      userId: `u${index}`,
      heroId: index + 1,
      isRadiant: index < 5,
      kills: index,
      deaths: 2,
      assists: 4,
    }));
    const complete = decodeGamePlayers(JSON.stringify(roster));
    expect(complete.completeRoster).toBe(true);
    expect(trustedGamePlayers(complete)).toHaveLength(10);

    const duplicate = decodeGamePlayers(
      JSON.stringify([...roster.slice(0, 9), { ...roster[9], userId: "u0" }]),
    );
    expect(duplicate.completeRoster).toBe(false);
    expect(trustedGamePlayers(duplicate)).toEqual([]);

    const sixRadiant = decodeGamePlayers(
      JSON.stringify(
        roster.map((line, index) => ({
          ...line,
          isRadiant: index < 6,
        })),
      ),
    );
    expect(sixRadiant.completeRoster).toBe(false);
  });

  it("allows a complete hero box without mappings while rejecting supplied duplicates", () => {
    const roster = Array.from({ length: 10 }, (_, index) => ({
      accountId: null,
      userId: null,
      heroId: index + 1,
      isRadiant: index < 5,
      kills: index,
      deaths: 2,
      assists: 4,
    }));
    const unmapped = decodeGamePlayers(JSON.stringify(roster));
    expect(unmapped.completeRoster).toBe(true);
    expect(trustedGamePlayers(unmapped)).toHaveLength(10);

    const duplicateAccount = decodeGamePlayers(
      JSON.stringify(
        roster.map((line, index) => ({
          ...line,
          accountId: index < 2 ? 42 : 100 + index,
        })),
      ),
    );
    expect(duplicateAccount.completeRoster).toBe(false);

    const duplicateHero = decodeGamePlayers(
      JSON.stringify(
        roster.map((line, index) => ({
          ...line,
          heroId: index < 2 ? 42 : 100 + index,
        })),
      ),
    );
    expect(duplicateHero.completeRoster).toBe(false);
  });
});
