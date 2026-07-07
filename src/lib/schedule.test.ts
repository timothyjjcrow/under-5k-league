import { describe, it, expect } from "vitest";
import {
  roundRobin,
  seedOrder,
  playoffFirstRound,
  pickBracketSize,
  bracketRounds,
  roundName,
  nextRoundPairings,
} from "./schedule";

describe("roundRobin", () => {
  it("has every team play every other exactly once (4 teams)", () => {
    const rounds = roundRobin(["a", "b", "c", "d"]);
    expect(rounds).toHaveLength(3);
    rounds.forEach((r) => expect(r).toHaveLength(2));

    const pairs = new Set(
      rounds.flat().map((p) => [p.home, p.away].sort().join("-")),
    );
    expect(pairs.size).toBe(6); // C(4,2)
  });

  it("handles an odd number of teams with a bye", () => {
    const rounds = roundRobin(["a", "b", "c"]);
    expect(rounds).toHaveLength(3);
    expect(rounds.flat()).toHaveLength(3); // C(3,2), one team rests each round
  });

  it("doubles the fixtures for a double round-robin", () => {
    expect(roundRobin(["a", "b", "c", "d"], true).flat()).toHaveLength(12);
  });

  it("returns nothing for fewer than two teams", () => {
    expect(roundRobin(["a"])).toEqual([]);
    expect(roundRobin([])).toEqual([]);
  });
});

describe("roundRobin home/away balance", () => {
  for (const n of [3, 4, 5, 6, 7, 8, 10]) {
    it(`keeps each team's home vs away within 1 for ${n} teams`, () => {
      const teams = Array.from({ length: n }, (_, i) => `t${i}`);
      const rounds = roundRobin(teams);
      const home = new Map(teams.map((t) => [t, 0]));
      const away = new Map(teams.map((t) => [t, 0]));
      for (const r of rounds)
        for (const p of r) {
          home.set(p.home, (home.get(p.home) ?? 0) + 1);
          away.set(p.away, (away.get(p.away) ?? 0) + 1);
        }
      for (const t of teams) {
        expect(
          Math.abs((home.get(t) ?? 0) - (away.get(t) ?? 0)),
          `${t} has ${home.get(t)}H / ${away.get(t)}A`,
        ).toBeLessThanOrEqual(1);
      }
    });
  }
});

describe("seedOrder", () => {
  it("produces standard bracket ordering", () => {
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
});

describe("playoffFirstRound", () => {
  it("pairs top vs bottom seeds", () => {
    const p = playoffFirstRound(["t1", "t2", "t3", "t4"], 4);
    expect(p).toEqual([
      { home: "t1", away: "t4" },
      { home: "t2", away: "t3" },
    ]);
  });
});

describe("pickBracketSize", () => {
  it("picks the largest power of two that fits", () => {
    expect(pickBracketSize(2)).toBe(2);
    expect(pickBracketSize(3)).toBe(2);
    expect(pickBracketSize(4)).toBe(4);
    expect(pickBracketSize(5)).toBe(4);
    expect(pickBracketSize(8)).toBe(8);
    expect(pickBracketSize(9)).toBe(8);
  });
});

describe("bracketRounds", () => {
  it("counts single-elimination rounds", () => {
    expect(bracketRounds(2)).toBe(1);
    expect(bracketRounds(4)).toBe(2);
    expect(bracketRounds(8)).toBe(3);
  });
});

describe("roundName", () => {
  it("names rounds relative to the final", () => {
    expect(roundName(1, 2)).toBe("Final");
    expect(roundName(0, 2)).toBe("Semifinals");
    expect(roundName(0, 3)).toBe("Quarterfinals");
    expect(roundName(2, 3)).toBe("Final");
  });
});

describe("nextRoundPairings", () => {
  it("pairs winners in bracket order", () => {
    expect(nextRoundPairings(["a", "b", "c", "d"])).toEqual([
      { home: "a", away: "b" },
      { home: "c", away: "d" },
    ]);
  });
});
