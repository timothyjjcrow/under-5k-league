import { describe, expect, it } from "vitest";
import {
  summarizePlayerGames,
  topBy,
  wonGame,
  type LeaderEntry,
  type PlayerGameLine,
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
    expect(topBy(entries, "winRate", { minGames: 3 }).map((r) => r.id)).toEqual([
      "grinder",
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
