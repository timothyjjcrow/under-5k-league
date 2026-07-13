import { describe, it, expect } from "vitest";
import {
  fantasyPoints,
  fantasyCap,
  validateFantasyPicks,
  pointsByPlayer,
  fantasyStandings,
} from "./fantasy";

describe("fantasyPoints", () => {
  it("weights kills, assists, deaths, economy, and the win bonus", () => {
    // 10*3 + 8*1.5 - 4 + 500*0.02 + 200*0.02 + 10 = 30+12-4+10+4+10 = 62
    expect(
      fantasyPoints(
        { kills: 10, deaths: 4, assists: 8, gpm: 500, lastHits: 200 },
        true,
      ),
    ).toBe(62);
  });

  it("handles missing economy stats and losses", () => {
    // 2*3 + 4*1.5 - 7 = 5
    expect(fantasyPoints({ kills: 2, deaths: 7, assists: 4 }, false)).toBe(5);
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
        { userId: "a", isRadiant: true, kills: 10, deaths: 0, assists: 0 }, // 30 + 10 = 40
        { userId: "b", isRadiant: false, kills: 0, deaths: 5, assists: 0 }, // -5
        { userId: null, isRadiant: true, kills: 5, deaths: 0, assists: 0 }, // anonymous, ignored
      ],
    },
    {
      radiantWin: false,
      players: [
        { userId: "a", isRadiant: true, kills: 2, deaths: 2, assists: 2 }, // 6-2+3 = 7
      ],
    },
  ];

  it("totals points per league player across games", () => {
    const pts = pointsByPlayer(games);
    expect(pts.get("a")).toBe(47);
    expect(pts.get("b")).toBe(-5);
    expect(pts.has("null")).toBe(false);
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
    expect(standings[0]).toMatchObject({ managerId: "m1", points: 42 });
    expect(standings[0].breakdown[0]).toEqual({ userId: "a", points: 47 });
    expect(standings[1]).toMatchObject({ managerId: "m2", points: -5 });
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
