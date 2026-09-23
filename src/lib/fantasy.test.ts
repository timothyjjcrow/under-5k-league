import { describe, it, expect } from "vitest";
import {
  fantasyPoints,
  fantasyScore,
  fantasyTotalsByPlayer,
  fantasyCap,
  fantasyPrices,
  validateFantasyPicks,
  pointsByPlayer,
  fantasyStandings,
} from "./fantasy";

describe("fantasyPoints", () => {
  it("scores the common line plus only the strongest contribution bonus", () => {
    // Base: 20 + 16 - 3 + 8 = 41. Farm: (500-300)*.02 + 200*.01 = 6.
    expect(
      fantasyPoints(
        { kills: 10, deaths: 4, assists: 8, gpm: 500, lastHits: 200 },
        true,
      ),
    ).toBe(47);
  });

  it("still rewards playmaking when optional OpenDota stats are missing", () => {
    // Base 6.75 + playmaking 1.8, rounded once.
    expect(fantasyPoints({ kills: 2, deaths: 7, assists: 4 }, false)).toBe(8.6);
  });

  it("lets support and offlane production compete with core farm", () => {
    const carry = fantasyScore({ kills: 12, deaths: 4, assists: 7, gpm: 600, lastHits: 320, heroDamage: 29000, towerDamage: 5000 }, true);
    const support = fantasyScore({ kills: 2, deaths: 5, assists: 17, heroHealing: 2000 }, true);
    const offlane = fantasyScore({ kills: 6, deaths: 6, assists: 12, heroDamage: 26000, towerDamage: 2500, denies: 15 }, true);
    expect(carry).toMatchObject({ bonus: 8, impact: "pressure", points: 51 });
    expect(support).toMatchObject({ bonus: 8, impact: "playmaking", points: 50.3 });
    expect(offlane).toMatchObject({ bonus: 8, impact: "pressure", points: 47.5 });
  });

  it("caps the bonus even when a player farms and deals huge damage", () => {
    const score = fantasyScore({ kills: 0, deaths: 0, assists: 0, gpm: 900, lastHits: 400, heroDamage: 80000, towerDamage: 12000 }, false);
    expect(score.bonus).toBe(8);
    expect(score.points).toBe(8);
  });
});

describe("fantasyCap", () => {
  it("is slots × league average with slack, rounded to 50", () => {
    // avg 3000 × 5 × 1.05 = 15750
    expect(fantasyCap([2000, 3000, 4000], 5)).toBe(15750);
  });

  it("ignores unknown MMRs and handles an empty pool", () => {
    expect(fantasyCap([3000, 0, 0], 5)).toBe(fantasyCap([3000], 5));
    expect(fantasyCap([], 5)).toBe(0);
  });
});

describe("fantasyPrices", () => {
  it("charges an unrated player the rounded known-pool average", () => {
    expect(
      [...fantasyPrices(new Map([
        ["known-a", 3000],
        ["known-b", 4100],
        ["unknown", 0],
      ]))],
    ).toEqual([
      ["known-a", 3000],
      ["known-b", 4100],
      ["unknown", 3550],
    ]);
  });

  it("uses explicit uncapped zeroes only when the entire pool is unrated", () => {
    expect(
      [...fantasyPrices(new Map([
        ["a", 0],
        ["b", 0],
      ]))],
    ).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
  });
});

describe("validateFantasyPicks", () => {
  const mmr = new Map([
    ["a", 4000],
    ["b", 3500],
    ["c", 3000],
    ["d", 2500],
    ["e", 2000],
    ["f", 4400],
  ]);

  it("accepts a legal five under the cap", () => {
    expect(validateFantasyPicks(["a", "b", "c", "d", "e"], mmr, 15750)).toBeNull();
  });

  it("rejects wrong counts, duplicates, non-rostered picks, and cap busts", () => {
    expect(validateFantasyPicks(["a", "b"], mmr, 15750)).toMatch(/exactly 5/);
    expect(
      validateFantasyPicks(["a", "a", "b", "c", "d"], mmr, 15750),
    ).toMatch(/duplicate/i);
    expect(
      validateFantasyPicks(["a", "b", "c", "d", "zz"], mmr, 15750),
    ).toMatch(/rostered/);
    expect(
      validateFantasyPicks(["a", "b", "c", "d", "f"], mmr, 15750),
    ).toMatch(/Over the cap/);
  });
});

describe("pointsByPlayer + fantasyStandings", () => {
  const games = [
    {
      radiantWin: true,
      players: [
        { userId: "a", isRadiant: true, kills: 10, deaths: 0, assists: 0 }, // 20 + 8 = 28
        { userId: "b", isRadiant: false, kills: 0, deaths: 5, assists: 0 }, // -3.7
        { userId: null, isRadiant: true, kills: 5, deaths: 0, assists: 0 }, // anonymous, ignored
      ],
    },
    {
      radiantWin: false,
      players: [
        { userId: "a", isRadiant: true, kills: 2, deaths: 2, assists: 2 }, // 6.5 + .9 = 7.4
      ],
    },
  ];

  it("totals points per league player across games", () => {
    const pts = pointsByPlayer(games);
    expect(pts.get("a")).toBe(35.4);
    expect(pts.get("b")).toBe(-3.7);
    expect(pts.has("null")).toBe(false);
    expect(fantasyTotalsByPlayer(games).get("a")).toMatchObject({ games: 2, wins: 1, impacts: { economy: 0, playmaking: 1, pressure: 0 } });
  });

  it("ranks fantasy rosters with per-pick breakdowns", () => {
    const pts = pointsByPlayer(games);
    const standings = fantasyStandings(
      [
        { managerId: "m1", pickUserIds: ["a", "b"] },
        { managerId: "m2", pickUserIds: ["b"] },
      ],
      pts,
    );
    expect(standings[0]).toMatchObject({ managerId: "m1", points: 31.7 });
    expect(standings[0].breakdown[0]).toEqual({ userId: "a", points: 35.4 });
    expect(standings[1]).toMatchObject({ managerId: "m2", points: -3.7 });
  });
});

describe("ownershipByPlayer", () => {
  it("reports the fraction of rosters picking each player", async () => {
    const { ownershipByPlayer } = await import("./fantasy");
    const own = ownershipByPlayer([
      { pickUserIds: ["a", "b"] },
      { pickUserIds: ["a", "c"] },
      { pickUserIds: ["a", "a"] }, // dupes in one roster count once
      { pickUserIds: [] },
    ]);
    expect(own.get("a")).toBeCloseTo(3 / 4);
    expect(own.get("b")).toBeCloseTo(1 / 4);
    expect(own.get("c")).toBeCloseTo(1 / 4);
    expect(own.has("nobody")).toBe(false);
  });

  it("returns an empty map with no rosters", async () => {
    const { ownershipByPlayer } = await import("./fantasy");
    expect(ownershipByPlayer([]).size).toBe(0);
  });
});
