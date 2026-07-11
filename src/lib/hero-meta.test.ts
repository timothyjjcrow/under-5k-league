import { describe, expect, it } from "vitest";
import {
  bestWinRates,
  heroMeta,
  metaMinPicks,
  type MetaGame,
  type MetaLine,
} from "./hero-meta";

function line(overrides: Partial<MetaLine> & { heroId: number }): MetaLine {
  return {
    userId: null,
    isRadiant: true,
    kills: 5,
    deaths: 3,
    assists: 10,
    ...overrides,
  };
}

describe("heroMeta", () => {
  it("returns no rows for no games", () => {
    const meta = heroMeta([]);
    expect(meta.games).toBe(0);
    expect(meta.rows).toEqual([]);
  });

  it("tallies picks, wins, losses, and rates per hero", () => {
    const games: MetaGame[] = [
      {
        radiantWin: true,
        lines: [
          line({ heroId: 1, isRadiant: true }), // win
          line({ heroId: 2, isRadiant: false }), // loss
        ],
      },
      {
        radiantWin: false,
        lines: [
          line({ heroId: 1, isRadiant: true }), // loss
          line({ heroId: 3, isRadiant: false }), // win
        ],
      },
    ];
    const meta = heroMeta(games);
    expect(meta.games).toBe(2);

    const h1 = meta.rows.find((r) => r.heroId === 1)!;
    expect(h1.picks).toBe(2);
    expect(h1.wins).toBe(1);
    expect(h1.losses).toBe(1);
    expect(h1.winRate).toBe(50);
    expect(h1.pickRate).toBe(100); // appeared in both games

    const h2 = meta.rows.find((r) => r.heroId === 2)!;
    expect(h2.picks).toBe(1);
    expect(h2.winRate).toBe(0);
    expect(h2.pickRate).toBe(50);
  });

  it("sorts by picks, then win rate, then heroId", () => {
    const games: MetaGame[] = [
      {
        radiantWin: true,
        lines: [
          line({ heroId: 5, isRadiant: true }),
          line({ heroId: 9, isRadiant: false }),
          line({ heroId: 7, isRadiant: true }),
        ],
      },
    ];
    const meta = heroMeta(games);
    // All 1 pick; 5 and 7 won (tie → lower id first), 9 lost.
    expect(meta.rows.map((r) => r.heroId)).toEqual([5, 7, 9]);
  });

  it("computes an aggregate KDA across picks", () => {
    const games: MetaGame[] = [
      {
        radiantWin: true,
        lines: [
          line({ heroId: 1, kills: 10, deaths: 2, assists: 4 }),
        ],
      },
      {
        radiantWin: true,
        lines: [
          line({ heroId: 1, kills: 0, deaths: 0, assists: 1 }),
        ],
      },
    ];
    const [row] = heroMeta(games).rows;
    // (10 + 4 + 0 + 1) / max(1, 2) = 7.5
    expect(row.kda).toBe(7.5);
  });

  it("crowns the top player by games with a wins tiebreak, ignoring unmapped lines", () => {
    const games: MetaGame[] = [
      {
        radiantWin: true,
        lines: [line({ heroId: 1, isRadiant: true, userId: "a" })], // a: 1 game, 1 win
      },
      {
        radiantWin: false,
        lines: [line({ heroId: 1, isRadiant: true, userId: "b" })], // b: 1 game, 0 wins
      },
      {
        radiantWin: true,
        lines: [line({ heroId: 1, isRadiant: true, userId: null })], // unmapped
      },
    ];
    const [row] = heroMeta(games).rows;
    expect(row.picks).toBe(3);
    expect(row.topPlayer).toEqual({ userId: "a", games: 1, wins: 1 });
  });

  it("counts pick rate once per game even if the hero appears twice", () => {
    // Shouldn't happen in a real lobby, but bad imports must not exceed 100%.
    const games: MetaGame[] = [
      {
        radiantWin: true,
        lines: [
          line({ heroId: 1, isRadiant: true }),
          line({ heroId: 1, isRadiant: false }),
        ],
      },
    ];
    const [row] = heroMeta(games).rows;
    expect(row.picks).toBe(2);
    expect(row.pickRate).toBe(100);
    expect(row.wins).toBe(1);
    expect(row.losses).toBe(1);
  });
});

describe("metaMinPicks", () => {
  it("floors at 2 for young seasons and scales with games", () => {
    expect(metaMinPicks(0)).toBe(2);
    expect(metaMinPicks(10)).toBe(2);
    expect(metaMinPicks(25)).toBe(3);
    expect(metaMinPicks(60)).toBe(6);
  });
});

describe("bestWinRates", () => {
  it("filters below the floor and ranks by rate, then picks", () => {
    const rows = heroMeta([
      {
        radiantWin: true,
        lines: [
          line({ heroId: 1, isRadiant: true }),
          line({ heroId: 2, isRadiant: false }),
        ],
      },
      {
        radiantWin: true,
        lines: [
          line({ heroId: 1, isRadiant: true }),
          line({ heroId: 3, isRadiant: true }),
        ],
      },
      {
        radiantWin: true,
        lines: [
          line({ heroId: 3, isRadiant: true }),
          line({ heroId: 4, isRadiant: true }),
        ],
      },
    ]).rows;

    const best = bestWinRates(rows, 2);
    // Heroes 2 (1 pick, 0%) and 4 (1 pick) are filtered out.
    expect(best.map((r) => r.heroId)).toEqual([1, 3]);
    expect(best.every((r) => r.picks >= 2)).toBe(true);
  });
});
