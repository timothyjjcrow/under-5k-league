import { describe, expect, it } from "vitest";
import {
  comfortPicks,
  dossierEmpty,
  playerHeroPool,
  SCOUT_MIN_GAMES,
  threatBoard,
  threatList,
  type HeroPoolRow,
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

function poolRow(heroId: number, games: number, wins = 0): HeroPoolRow {
  return {
    heroId,
    games,
    wins,
    winRate: Math.round((wins / games) * 100),
    kda: 3,
  };
}

describe("comfortPicks", () => {
  it("shows only league heroes played at least twice, most played first", () => {
    expect(SCOUT_MIN_GAMES).toBe(2);
    const picks = comfortPicks(
      [poolRow(1, 4), poolRow(2, 2), poolRow(3, 1), poolRow(4, 1)],
      [{ heroId: 9, games: 300, wins: 150 }],
    );
    expect(picks?.source).toBe("league");
    expect(picks?.heroes.map((h) => h.heroId)).toEqual([1, 2]);
  });

  it("caps the list", () => {
    const picks = comfortPicks(
      [poolRow(1, 5), poolRow(2, 4), poolRow(3, 3), poolRow(4, 2)],
      null,
    );
    expect(picks?.heroes.map((h) => h.heroId)).toEqual([1, 2, 3]);
  });

  it("falls back to pub heroes when no league hero reaches the floor", () => {
    const picks = comfortPicks(
      [poolRow(1, 1), poolRow(2, 1)],
      [
        { heroId: 7, games: 210, wins: 110 },
        { heroId: 8, games: 0, wins: 0 },
        { heroId: 9, games: 90, wins: 40 },
      ],
    );
    expect(picks).toEqual({
      source: "pubs",
      heroes: [
        { heroId: 7, games: 210, wins: 110 },
        { heroId: 9, games: 90, wins: 40 },
      ],
    });
  });

  it("is null with nothing to show", () => {
    expect(comfortPicks([poolRow(1, 1)], null)).toBeNull();
    expect(comfortPicks([], [])).toBeNull();
    expect(comfortPicks([], undefined)).toBeNull();
  });
});

describe("threatList", () => {
  const win = (heroId: number) =>
    game({ radiantWin: true, lines: [line({ heroId, isRadiant: true })] });
  const loss = (heroId: number) =>
    game({ radiantWin: false, lines: [line({ heroId, isRadiant: true })] });

  it("ranks heroes they win on as the ban board", () => {
    const board = threatBoard(["a"], [win(1), win(1), loss(2), loss(2), win(3)]);
    expect(threatList(board)).toEqual({
      ranked: true,
      rows: [expect.objectContaining({ heroId: 1, picks: 2, wins: 2 })],
    });
  });

  it("falls back to most picked, but never a one-off", () => {
    const board = threatBoard(
      ["a"],
      [loss(1), loss(1), loss(1), loss(2), loss(2), win(3), loss(4)],
    );
    const list = threatList(board);
    expect(list.ranked).toBe(false);
    expect(list.rows.map((r) => r.heroId)).toEqual([1, 2]);
  });

  it("is empty when every hero was picked once", () => {
    const board = threatBoard(["a"], [win(1), loss(2), win(3)]);
    expect(threatList(board)).toEqual({ ranked: false, rows: [] });
  });

  it("caps the list", () => {
    const games = [1, 2, 3, 4, 5, 6, 7].flatMap((hero) => [win(hero), win(hero)]);
    expect(threatList(threatBoard(["a"], games)).rows).toHaveLength(5);
  });
});
