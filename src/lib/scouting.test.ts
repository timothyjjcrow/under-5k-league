import { describe, expect, it } from "vitest";
import {
  dossierEmpty,
  paceProfile,
  playerHeroPool,
  threatBoard,
  type ScoutGame,
  type ScoutLine,
} from "./scouting";

function line(overrides: Partial<ScoutLine> & { heroId: number }): ScoutLine {
  return {
    userId: "a",
    isRadiant: true,
    kills: 5,
    deaths: 3,
    assists: 10,
    ...overrides,
  };
}

function game(overrides: Partial<ScoutGame>): ScoutGame {
  return {
    radiantWin: true,
    durationSecs: 2400,
    startTime: 0,
    lines: [],
    ...overrides,
  };
}

describe("playerHeroPool", () => {
  it("returns no rows for no games", () => {
    expect(playerHeroPool("a", [])).toEqual([]);
  });

  it("only counts that player's lines and wins from isRadiant === radiantWin", () => {
    const games: ScoutGame[] = [
      game({
        radiantWin: true,
        lines: [
          line({ heroId: 1, userId: "a", isRadiant: true }), // a wins
          line({ heroId: 2, userId: "b", isRadiant: true }), // other player
          line({ heroId: 3, userId: null, isRadiant: true }), // unmapped
        ],
      }),
      game({
        radiantWin: true,
        lines: [line({ heroId: 1, userId: "a", isRadiant: false })], // a loses
      }),
    ];
    const pool = playerHeroPool("a", games);
    expect(pool).toHaveLength(1);
    expect(pool[0].heroId).toBe(1);
    expect(pool[0].games).toBe(2);
    expect(pool[0].wins).toBe(1);
    expect(pool[0].winRate).toBe(50);
  });

  it("computes kda over the hero's games, 1 decimal", () => {
    const games: ScoutGame[] = [
      game({
        lines: [line({ heroId: 1, kills: 10, deaths: 2, assists: 4 })],
      }),
      game({
        lines: [line({ heroId: 1, kills: 0, deaths: 0, assists: 1 })],
      }),
    ];
    // (10 + 4 + 0 + 1) / max(1, 2) = 7.5
    expect(playerHeroPool("a", games)[0].kda).toBe(7.5);
  });

  it("sorts by games desc, then winRate desc, then heroId asc", () => {
    const games: ScoutGame[] = [
      // hero 9: 2 games, 1 win (50%)
      game({ radiantWin: true, lines: [line({ heroId: 9, isRadiant: true })] }),
      game({ radiantWin: false, lines: [line({ heroId: 9, isRadiant: true })] }),
      // heroes 7 and 3: 1 game, 1 win each (winRate tie -> heroId asc)
      game({ radiantWin: true, lines: [line({ heroId: 7, isRadiant: true })] }),
      game({ radiantWin: true, lines: [line({ heroId: 3, isRadiant: true })] }),
      // hero 5: 1 game, 0 wins (loses winRate tiebreak)
      game({ radiantWin: false, lines: [line({ heroId: 5, isRadiant: true })] }),
    ];
    expect(playerHeroPool("a", games).map((r) => r.heroId)).toEqual([
      9, 3, 7, 5,
    ]);
  });
});

describe("threatBoard", () => {
  it("keeps sub-floor heroes out of rows but in contested", () => {
    const games: ScoutGame[] = [
      // hero 1: 2 picks, 2 wins; hero 2: 1 pick, 1 win (below floor of 2)
      game({
        radiantWin: true,
        lines: [
          line({ heroId: 1, userId: "a", isRadiant: true }),
          line({ heroId: 2, userId: "b", isRadiant: true }),
        ],
      }),
      game({
        radiantWin: true,
        lines: [line({ heroId: 1, userId: "b", isRadiant: true })],
      }),
    ];
    const board = threatBoard(["a", "b"], games);
    expect(board.minPicks).toBe(2);
    expect(board.rows.map((r) => r.heroId)).toEqual([1]);
    expect(board.contested.map((r) => r.heroId)).toEqual([1, 2]);
  });

  it("ignores lines by users outside the list and unmapped lines", () => {
    const games: ScoutGame[] = [
      game({
        lines: [
          line({ heroId: 1, userId: "a" }),
          line({ heroId: 1, userId: "stranger" }),
          line({ heroId: 1, userId: null }),
        ],
      }),
    ];
    const board = threatBoard(["a"], games);
    expect(board.contested).toHaveLength(1);
    expect(board.contested[0].picks).toBe(1);
  });

  it("counts two listed users on the same hero in one game as 2 picks", () => {
    const games: ScoutGame[] = [
      game({
        radiantWin: true,
        lines: [
          line({ heroId: 1, userId: "a", isRadiant: true }),
          line({ heroId: 1, userId: "b", isRadiant: false }),
        ],
      }),
    ];
    const board = threatBoard(["a", "b"], games);
    expect(board.contested[0].picks).toBe(2);
    expect(board.contested[0].wins).toBe(1);
    expect(board.contested[0].winRate).toBe(50);
  });

  it("floors minPicks at 2 for small totals and scales at ceil(total/25)", () => {
    // 4 total picks -> max(2, ceil(4/25)) = 2
    const small = threatBoard(
      ["a"],
      Array.from({ length: 4 }, () =>
        game({ lines: [line({ heroId: 1 })] }),
      ),
    );
    expect(small.minPicks).toBe(2);

    // 51 total picks -> max(2, ceil(51/25)) = 3
    const large = threatBoard(
      ["a"],
      Array.from({ length: 51 }, (_, i) =>
        game({ lines: [line({ heroId: (i % 3) + 1 })] }),
      ),
    );
    expect(large.minPicks).toBe(3);

    // No picks at all -> still 2
    expect(threatBoard(["a"], []).minPicks).toBe(2);
  });

  it("sorts rows by winRate desc, picks desc, heroId asc and contested by picks desc, wins desc, heroId asc", () => {
    const win = (heroId: number, userId = "a") =>
      game({
        radiantWin: true,
        lines: [line({ heroId, userId, isRadiant: true })],
      });
    const loss = (heroId: number, userId = "a") =>
      game({
        radiantWin: false,
        lines: [line({ heroId, userId, isRadiant: true })],
      });
    const games: ScoutGame[] = [
      // hero 1: 3 picks, 2 wins (67%)
      win(1), win(1), loss(1),
      // hero 2: 2 picks, 2 wins (100%)
      win(2), win(2),
      // hero 3: 2 picks, 2 wins (100%) — ties hero 2 -> heroId asc
      win(3), win(3),
      // hero 4: 3 picks, 1 win (33%) — contested tie with hero 1 on picks -> wins
      win(4), loss(4), loss(4),
    ];
    const board = threatBoard(["a"], games);
    expect(board.rows.map((r) => r.heroId)).toEqual([2, 3, 1, 4]);
    expect(board.contested.map((r) => r.heroId)).toEqual([1, 4, 2, 3]);
  });
});

describe("paceProfile", () => {
  it("returns the empty profile when nothing qualifies", () => {
    expect(paceProfile(["a"], [])).toEqual({
      games: 0,
      winAvgMins: null,
      lossAvgMins: null,
      longestMins: null,
      shortestMins: null,
    });
  });

  it("excludes games with durationSecs 0 and games without our players", () => {
    const games: ScoutGame[] = [
      game({ durationSecs: 0, lines: [line({ heroId: 1, userId: "a" })] }),
      game({ durationSecs: 1800, lines: [line({ heroId: 1, userId: "z" })] }),
      game({ durationSecs: 1800, lines: [line({ heroId: 1, userId: null })] }),
      game({ durationSecs: 2400, lines: [line({ heroId: 1, userId: "a" })] }),
    ];
    const pace = paceProfile(["a"], games);
    expect(pace.games).toBe(1);
    expect(pace.longestMins).toBe(40);
    expect(pace.shortestMins).toBe(40);
  });

  it("attributes wins to the majority side, even when players split across sides", () => {
    const games: ScoutGame[] = [
      // 2 of 3 lines on radiant -> team side radiant; radiant wins -> win (30m)
      game({
        radiantWin: true,
        durationSecs: 1800,
        lines: [
          line({ heroId: 1, userId: "a", isRadiant: true }),
          line({ heroId: 2, userId: "b", isRadiant: true }),
          line({ heroId: 3, userId: "c", isRadiant: false }),
        ],
      }),
      // all on dire; radiant wins -> loss (50m)
      game({
        radiantWin: true,
        durationSecs: 3000,
        lines: [line({ heroId: 1, userId: "a", isRadiant: false })],
      }),
    ];
    const pace = paceProfile(["a", "b", "c"], games);
    expect(pace.games).toBe(2);
    expect(pace.winAvgMins).toBe(30);
    expect(pace.lossAvgMins).toBe(50);
    expect(pace.longestMins).toBe(50);
    expect(pace.shortestMins).toBe(30);
  });

  it("breaks a side tie toward radiant", () => {
    const games: ScoutGame[] = [
      game({
        radiantWin: true,
        durationSecs: 1200,
        lines: [
          line({ heroId: 1, userId: "a", isRadiant: true }),
          line({ heroId: 2, userId: "b", isRadiant: false }),
        ],
      }),
    ];
    // Tie -> radiant; radiant won -> counted as a win.
    const pace = paceProfile(["a", "b"], games);
    expect(pace.winAvgMins).toBe(20);
    expect(pace.lossAvgMins).toBeNull();
  });

  it("averages minutes to 1 decimal and nulls a side with no games", () => {
    const games: ScoutGame[] = [
      game({ radiantWin: true, durationSecs: 1500, lines: [line({ heroId: 1, isRadiant: true })] }),
      game({ radiantWin: true, durationSecs: 1600, lines: [line({ heroId: 1, isRadiant: true })] }),
    ];
    const pace = paceProfile(["a"], games);
    // (1500 + 1600) / 2 / 60 = 25.833... -> 25.8
    expect(pace.winAvgMins).toBe(25.8);
    expect(pace.lossAvgMins).toBeNull();
    expect(pace.longestMins).toBe(26.7);
    expect(pace.shortestMins).toBe(25);
  });
});

describe("dossierEmpty", () => {
  const emptyBoard = threatBoard([], []);

  it("is true when every pool is empty and nothing was ever picked", () => {
    expect(dossierEmpty([[], [], []], emptyBoard)).toBe(true);
    expect(dossierEmpty([], emptyBoard)).toBe(true);
  });

  it("is false when any pool has rows or the board saw picks", () => {
    const games = [game({ lines: [line({ heroId: 1, userId: "a" })] })];
    expect(dossierEmpty([playerHeroPool("a", games), []], emptyBoard)).toBe(
      false,
    );
    expect(dossierEmpty([[], []], threatBoard(["a"], games))).toBe(false);
  });
});
