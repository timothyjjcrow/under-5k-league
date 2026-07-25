import { describe, it, expect } from "vitest";
import {
  teamNeed,
  maxBid,
  canBid,
  nextNominatorIndex,
  mmrWeightedBudgets,
  type DraftTeam,
  wasOutbid,
  shuffle,
} from "./draft";

const team = (rosterCount: number, budget = 100): DraftTeam => ({
  id: "t",
  budget,
  rosterCount,
});

describe("teamNeed", () => {
  it("counts remaining slots and never goes negative", () => {
    expect(teamNeed(5, 1)).toBe(4);
    expect(teamNeed(5, 5)).toBe(0);
    expect(teamNeed(5, 6)).toBe(0);
  });
});

describe("maxBid", () => {
  it("reserves the min bid for every other empty slot", () => {
    // roster 1 of 5 -> needs 4 -> reserve 3 -> 100-3 = 97
    expect(maxBid(team(1), 5)).toBe(97);
    // roster 4 of 5 -> needs 1 -> reserve 0 -> full budget
    expect(maxBid(team(4, 50), 5)).toBe(50);
  });
  it("is 0 for a full team", () => {
    expect(maxBid(team(5), 5)).toBe(0);
  });
  it("never returns negative", () => {
    expect(maxBid(team(1, 2), 5)).toBe(0);
  });
});

describe("canBid", () => {
  it("accepts a legal raise", () => {
    expect(canBid(team(1), 5, 10, 5)).toBe(true);
  });
  it("rejects a bid at or below the current high bid", () => {
    expect(canBid(team(1), 5, 5, 5)).toBe(false);
    expect(canBid(team(1), 5, 4, 5)).toBe(false);
  });
  it("rejects below the minimum bid", () => {
    expect(canBid(team(1), 5, 0, -1)).toBe(false);
  });
  it("rejects above the max affordable bid", () => {
    expect(canBid(team(1), 5, 98, 5)).toBe(false); // max is 97
    expect(canBid(team(1), 5, 97, 5)).toBe(true);
  });
  it("rejects when the team is already full", () => {
    expect(canBid(team(5), 5, 10, 5)).toBe(false);
  });
  it("rejects non-integer amounts", () => {
    expect(canBid(team(1), 5, 10.5, 5)).toBe(false);
  });
});


describe("nextNominatorIndex", () => {
  const teams = [team(1), team(5), team(1)]; // middle team is full

  it("skips full teams", () => {
    expect(nextNominatorIndex(teams, 5, 0)).toBe(2);
  });
  it("wraps around the order", () => {
    expect(nextNominatorIndex(teams, 5, 2)).toBe(0);
  });
  it("returns -1 when all teams are full", () => {
    expect(nextNominatorIndex([team(5)], 5, 0)).toBe(-1);
  });
});

describe("mmrWeightedBudgets", () => {
  const cap = (teamId: string, mmr: number | null) => ({ teamId, mmr });

  it("gives the extremes ±weight% and interpolates between", () => {
    const b = mmrWeightedBudgets(100, 20, [
      cap("low", 2000),
      cap("mid", 3000),
      cap("high", 4000),
    ]);
    expect(b.get("low")).toBe(120);
    expect(b.get("mid")).toBe(100);
    expect(b.get("high")).toBe(80);
  });

  it("interpolates by MMR distance, not rank order", () => {
    const b = mmrWeightedBudgets(100, 20, [
      cap("low", 2000),
      cap("nearHigh", 3900), // 95% of the way up → close to the high budget
      cap("high", 4000),
    ]);
    expect(b.get("nearHigh")).toBe(82);
    expect(b.get("high")).toBe(80);
  });

  it("gives everyone base when MMRs are identical or weight is 0", () => {
    const same = mmrWeightedBudgets(100, 20, [cap("a", 3000), cap("b", 3000)]);
    expect(same.get("a")).toBe(100);
    expect(same.get("b")).toBe(100);
    const flat = mmrWeightedBudgets(100, 0, [cap("a", 1000), cap("b", 4000)]);
    expect(flat.get("a")).toBe(100);
    expect(flat.get("b")).toBe(100);
  });

  it("shrinks the spread when captains are closely matched", () => {
    // 175 MMR apart at 20% weight → 17.5% of the full effect (~±3.5%),
    // not the full ±20% the extremes get at a 1000+ MMR gap.
    const b = mmrWeightedBudgets(100, 20, [
      cap("low", 4200),
      cap("high", 4375),
    ]);
    expect(b.get("low")).toBe(103);
    expect(b.get("high")).toBe(97);
  });

  it("applies the full weight once the captain gap reaches 1000 MMR", () => {
    const b = mmrWeightedBudgets(100, 20, [
      cap("low", 3000),
      cap("high", 4000),
    ]);
    expect(b.get("low")).toBe(120);
    expect(b.get("high")).toBe(80);
  });

  it("gives base to captains with unknown MMR", () => {
    const b = mmrWeightedBudgets(100, 20, [
      cap("a", 2000),
      cap("b", 4000),
      cap("unknown", null),
    ]);
    expect(b.get("unknown")).toBe(100);
    expect(b.get("a")).toBe(120);
    expect(b.get("b")).toBe(80);
  });

  it("never drops below the floor", () => {
    const b = mmrWeightedBudgets(5, 90, [cap("a", 1000), cap("b", 4000)], 4);
    expect(b.get("b")!).toBeGreaterThanOrEqual(4);
  });

  it("treats a non-finite weight as flat budgets (never NaN)", () => {
    const b = mmrWeightedBudgets(100, NaN, [cap("a", 1000), cap("b", 4000)]);
    expect(b.get("a")).toBe(100);
    expect(b.get("b")).toBe(100);
  });
});

describe("wasOutbid", () => {
  const base = {
    myTeamId: "me",
    prevBidTeamId: "me",
    curBidTeamId: "them",
    prevNominatedId: "p1",
    curNominatedId: "p1",
  };

  it("fires when another team takes the high bid on the same player", () => {
    expect(wasOutbid(base)).toBe(true);
  });

  it("stays quiet when we still hold (or just took) the high bid", () => {
    expect(wasOutbid({ ...base, curBidTeamId: "me" })).toBe(false);
    expect(wasOutbid({ ...base, prevBidTeamId: "them" })).toBe(false);
  });

  it("same-player guard: a sale + fresh nomination within one poll is NOT an outbid", () => {
    expect(wasOutbid({ ...base, curNominatedId: "p2" })).toBe(false);
    expect(wasOutbid({ ...base, curNominatedId: null })).toBe(false);
  });

  it("spectators (no team) are never outbid", () => {
    expect(wasOutbid({ ...base, myTeamId: null })).toBe(false);
  });
});

describe("mmrWeightedBudgets — unknown-MMR captains (stored 0 mapped to null)", () => {
  it("gives an unknown captain the base budget without skewing the others", () => {
    // Call sites map a stored 0 ("unknown") to null via `|| null` — this is
    // the contract that keeps a blank-MMR captain from becoming the pool
    // minimum and pocketing the maximum low-MMR boost.
    const b = mmrWeightedBudgets(100, 20, [
      { teamId: "low", mmr: 2000 },
      { teamId: "high", mmr: 4000 },
      { teamId: "unknown", mmr: null },
    ]);
    expect(b.get("unknown")).toBe(100); // base, not boosted
    const withoutUnknown = mmrWeightedBudgets(100, 20, [
      { teamId: "low", mmr: 2000 },
      { teamId: "high", mmr: 4000 },
    ]);
    expect(b.get("low")).toBe(withoutUnknown.get("low"));
    expect(b.get("high")).toBe(withoutUnknown.get("high"));
  });
});

describe("shuffle", () => {
  it("keeps every element exactly once", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffle(xs);
    expect(out).toHaveLength(xs.length);
    expect([...out].sort((a, b) => a - b)).toEqual(xs);
  });

  it("does not mutate the input", () => {
    const xs = ["a", "b", "c"];
    shuffle(xs);
    expect(xs).toEqual(["a", "b", "c"]);
  });

  it("is uniform — every permutation of 3 shows up over many runs", () => {
    // The old `sort(() => Math.random() - 0.5)` was not: its comparator is
    // inconsistent, so results clustered near the input order and some
    // permutations were far rarer than 1/6. Draft order decides who nominates
    // first all night, so this needs to be genuinely random.
    const counts = new Map<string, number>();
    for (let i = 0; i < 6000; i++) {
      const key = shuffle(["a", "b", "c"]).join("");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    // Each permutation should land near 1000; allow generous slack for noise.
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(700);
      expect(n).toBeLessThan(1300);
    }
  });

  it("is deterministic with an injected rand", () => {
    const seq = [0, 0, 0];
    let i = 0;
    // rand()=0 always: i=2 swaps [2]<->[0] => c,b,a; i=1 swaps [1]<->[0] => b,c,a
    expect(shuffle(["a", "b", "c"], () => seq[i++] ?? 0)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("handles empty and single-element lists", () => {
    expect(shuffle([])).toEqual([]);
    expect(shuffle(["only"])).toEqual(["only"]);
  });
});
