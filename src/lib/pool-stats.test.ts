import { describe, expect, it } from "vitest";
import {
  captainsWantedLine,
  averageMmr,
  roleCoverage,
  rosterAverageMmr,
  shortRolesLine,
} from "./pool-stats";

describe("roleCoverage", () => {
  it("counts each position across players", () => {
    const cov = roleCoverage([
      { roles: "1,2" },
      { roles: "1" },
      { roles: "5" },
      { roles: "" },
    ]);
    const byKey = Object.fromEntries(cov.map((r) => [r.key, r.count]));
    expect(byKey["1"]).toBe(2);
    expect(byKey["2"]).toBe(1);
    expect(byKey["3"]).toBe(0);
    expect(byKey["5"]).toBe(1);
  });
  it("always returns all five positions in order", () => {
    const cov = roleCoverage([]);
    expect(cov.map((r) => r.key)).toEqual(["1", "2", "3", "4", "5"]);
    expect(cov.every((r) => r.count === 0)).toBe(true);
  });
});

describe("averageMmr", () => {
  it("rounds the mean", () => {
    expect(averageMmr([{ mmr: 1000 }, { mmr: 2000 }, { mmr: 2001 }])).toBe(1667);
  });
  it("is zero for an empty pool", () => {
    expect(averageMmr([])).toBe(0);
  });
});

describe("MMR 0 = unknown (blank signup)", () => {
  it("averageMmr ignores unknowns instead of dragging the pool down", () => {
    expect(averageMmr([{ mmr: 3000 }, { mmr: 0 }, { mmr: 0 }])).toBe(3000);
    expect(averageMmr([{ mmr: 0 }])).toBe(0);
  });
});

describe("shortRolesLine", () => {
  // Counts per position 1..5, as roleCoverage returns them.
  const coverage = (counts: number[]) =>
    roleCoverage([]).map((role, i) => ({ ...role, count: counts[i] }));

  it("names the one position too few players list", () => {
    expect(shortRolesLine(coverage([8, 8, 7, 7, 3]), 7, 37)).toBe(
      "Short on Hard Support: 3 of 37 players list it, and 7 teams need one each.",
    );
  });

  it("lists several short positions fewest first", () => {
    expect(shortRolesLine(coverage([8, 5, 7, 6, 3]), 7, 37)).toBe(
      "Short on Hard Support, Mid and Soft Support: 3, 5 and 6 of 37 players list them, and 7 teams need one each.",
    );
  });

  it("is quiet when every position has one per team", () => {
    expect(shortRolesLine(coverage([8, 8, 7, 7, 7]), 7, 37)).toBeNull();
  });

  // A small pool is short everywhere; the hero's own count already says
  // how many more players are needed, so a five-role list adds nothing.
  it("is quiet when every position is short", () => {
    expect(shortRolesLine(coverage([2, 1, 1, 0, 1]), 6, 4)).toBeNull();
  });

  it("is quiet with no players or no teams", () => {
    expect(shortRolesLine(coverage([0, 0, 0, 0, 0]), 6, 0)).toBeNull();
    expect(shortRolesLine(coverage([3, 3, 3, 3, 1]), 0, 5)).toBeNull();
  });
});

describe("rosterAverageMmr", () => {
  const regs = [
    { userId: "cap", mmr: 4000 },
    { userId: "p1", mmr: 3000 },
    { userId: "p2", mmr: 0 }, // never entered one: unknown, not zero
    { userId: "other-team", mmr: 9000 },
  ];

  it("averages the members' known MMRs only", () => {
    expect(rosterAverageMmr(["cap", "p1", "p2"], regs)).toBe(3500);
  });

  it("ignores signups of players on other teams", () => {
    expect(rosterAverageMmr(["cap"], regs)).toBe(4000);
  });

  it("counts a member once even with a duplicate row", () => {
    expect(
      rosterAverageMmr(["cap", "p1"], [...regs, { userId: "p1", mmr: 3000 }]),
    ).toBe(3500);
  });

  it("is 0 (unknown) for an empty roster or one with no known MMR", () => {
    expect(rosterAverageMmr([], regs)).toBe(0);
    expect(rosterAverageMmr(["p2"], regs)).toBe(0);
    expect(rosterAverageMmr(["no-signup"], regs)).toBe(0);
  });
});

describe("captainsWantedLine", () => {
  // Teams are captains: 31 signups with 3 volunteers draft 3 teams.
  it("counts volunteers against the teams the season wants", () => {
    expect(captainsWantedLine(3, 10)).toBe(
      "Captains wanted: 3 of 10 so far. Each team needs one.",
    );
    expect(captainsWantedLine(0, 8)).toBe(
      "Captains wanted: 0 of 8 so far. Each team needs one.",
    );
  });

  it("goes quiet once there are enough, or nothing to count", () => {
    expect(captainsWantedLine(10, 10)).toBeNull();
    expect(captainsWantedLine(12, 10)).toBeNull();
    expect(captainsWantedLine(0, 0)).toBeNull();
  });
});
