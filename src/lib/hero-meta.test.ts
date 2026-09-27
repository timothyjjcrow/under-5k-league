import { describe, expect, it } from "vitest";
import {
  allHeroesKnown,
  heroMeta,
  metaHeadlines,
  type HeroMetaRow,
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
        lines: [line({ heroId: 1, kills: 10, deaths: 2, assists: 4 })],
      },
      {
        radiantWin: true,
        lines: [line({ heroId: 1, kills: 0, deaths: 0, assists: 1 })],
      },
    ];
    const [row] = heroMeta(games).rows;
    // (10 + 4 + 0 + 1) / max(1, 2) = 7.5
    expect(row.kda).toBe(7.5);
  });

  it("reports per-pick contributions and counts distinct mapped players", () => {
    const games: MetaGame[] = [
      {
        radiantWin: true,
        lines: [
          line({ heroId: 1, userId: "a", kills: 4, deaths: 2, assists: 13 }),
        ],
      },
      {
        radiantWin: false,
        lines: [
          line({ heroId: 1, userId: "a", kills: 1, deaths: 3, assists: 8 }),
        ],
      },
      {
        radiantWin: true,
        lines: [
          line({ heroId: 1, userId: "b", kills: 0, deaths: 4, assists: 11 }),
        ],
      },
      {
        radiantWin: false,
        lines: [
          line({ heroId: 1, userId: null, kills: 1, deaths: 1, assists: 12 }),
        ],
      },
    ];
    const [row] = heroMeta(games).rows;
    expect(row.killsPerPick).toBe(1.5);
    expect(row.deathsPerPick).toBe(2.5);
    expect(row.assistsPerPick).toBe(11);
    expect(row.mappedPlayers).toBe(2);
    expect(row.picks).toBe(4);
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

  it("uses a stable user id tiebreak for identical signature-player records", () => {
    const players = [
      line({ heroId: 1, isRadiant: true, userId: "z-player" }),
      line({ heroId: 1, isRadiant: true, userId: "a-player" }),
    ];
    const first = heroMeta([{ radiantWin: true, lines: players }]).rows[0];
    const reversed = heroMeta([
      { radiantWin: true, lines: [...players].reverse() },
    ]).rows[0];

    expect(first.topPlayer?.userId).toBe("a-player");
    expect(reversed.topPlayer).toEqual(first.topPlayer);
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

describe("catalogue boundary", () => {
  const known = new Set([1, 2, 3]);

  it("rejects a whole game's hero lines when even one id is unknown", () => {
    expect(allHeroesKnown([line({ heroId: 1 })], known)).toBe(true);
    expect(
      allHeroesKnown([line({ heroId: 1 }), line({ heroId: 99 })], known),
    ).toBe(false);
    expect(allHeroesKnown([], known)).toBe(false);
  });
});

describe("metaHeadlines", () => {
  const row = (heroId: number, picks: number, wins: number): HeroMetaRow => ({
    heroId,
    picks,
    wins,
    losses: picks - wins,
    winRate: Math.round((wins / picks) * 100),
    pickRate: 0,
    kda: 0,
    killsPerPick: 0,
    deathsPerPick: 0,
    assistsPerPick: 0,
    mappedPlayers: 0,
    topPlayer: null,
  });

  it("is empty for no picks", () => {
    expect(metaHeadlines([])).toEqual({ mostPicked: null, bestWinRate: null });
  });

  it("never headlines a small sample's win rate", () => {
    // A 5-for-5 hero is not "the best"; nothing has 8 picks yet.
    const rows = [row(1, 7, 4), row(2, 5, 5)];
    const headlines = metaHeadlines(rows);
    expect(headlines.mostPicked?.heroId).toBe(1);
    expect(headlines.bestWinRate).toBeNull();
  });

  it("picks the best exact win rate among heroes with 8+ picks", () => {
    const rows = [row(1, 12, 7), row(2, 9, 6), row(3, 8, 5), row(4, 3, 3)];
    // 6/9 = 66.7% beats 5/8 = 62.5% and 7/12 = 58.3%; 3/3 lacks the sample.
    expect(metaHeadlines(rows).bestWinRate?.heroId).toBe(2);
  });

  it("breaks an equal rate by the bigger sample", () => {
    const rows = [row(1, 8, 6), row(2, 12, 9)];
    expect(metaHeadlines(rows).bestWinRate?.heroId).toBe(2);
  });
});
