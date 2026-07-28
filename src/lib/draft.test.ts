import { describe, it, expect } from "vitest";
import {
  teamNeed,
  maxBid,
  canBid,
  canNominate,
  draftTitleFlag,
  draftViewerStake,
  nextNominatorIndex,
  mmrWeightedBudgets,
  outbidLatchAfter,
  stripDraftTitleFlag,
  type DraftTeam,
  wasOutbid,
  shuffle,
  DRAFT_TITLE_PREFIXES,
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


describe("canNominate", () => {
  it("needs both an open seat and the money for one", () => {
    expect(canNominate(team(1, 100), 5)).toBe(true);
    expect(canNominate(team(5, 100), 5)).toBe(false); // full roster
    expect(canNominate(team(4, 0), 5)).toBe(false); // last seat, no money
  });

  it("is exactly the budget >= need * minBid invariant", () => {
    // need 2, minBid 1 -> needs at least $2
    expect(canNominate(team(3, 2), 5)).toBe(true);
    expect(canNominate(team(3, 1), 5)).toBe(false);
  });

  it("is false for the state a non-refunding roster move used to create", () => {
    // spent out at 5/5, then a player is released: 4/5 with $0 left. The stall
    // resolver would otherwise open a $1 lot and drive the budget to -1.
    expect(canNominate(team(4, 0), 5)).toBe(false);
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

  it("skips a needy team that cannot afford the minimum bid", () => {
    // index 1 needs a player but has $0 — the clock must not land there, or the
    // stall resolver opens a lot it can't pay for.
    const teams = [team(5, 100), team(4, 0), team(2, 50)];
    expect(nextNominatorIndex(teams, 5, 0)).toBe(2);
  });

  it("returns -1 when every needy team is broke, so the draft completes", () => {
    const teams = [team(4, 0), team(3, 1)]; // need 1 with $0; need 2 with $1
    expect(nextNominatorIndex(teams, 5, 0)).toBe(-1);
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

// The other half of the 💸 Outbid! banner: when to DROP it. It was two
// sequential `if`s in the room, and their mutual exclusivity was assumed
// rather than stated — which matters now that one call returns one decision.
describe("outbidLatchAfter", () => {
  const base = {
    myTeamId: "me",
    prevBidTeamId: "me",
    curBidTeamId: "them",
    prevNominatedId: "p1",
    curNominatedId: "p1",
  };

  it("raises the latch the moment another team takes the lot", () => {
    expect(outbidLatchAfter(base)).toBe("set");
  });

  it("drops it when the viewer's team takes the high bid back", () => {
    expect(outbidLatchAfter({ ...base, curBidTeamId: "me" })).toBe("clear");
  });

  it("drops it when the lot moves on, or bidding closes", () => {
    expect(outbidLatchAfter({ ...base, curNominatedId: "p2" })).toBe("clear");
    expect(outbidLatchAfter({ ...base, curNominatedId: null })).toBe("clear");
  });

  it("KEEPS it while the same lot runs on above the viewer", () => {
    // The rule the signature exists to protect: no budget or `canBid` input,
    // because a captain who has been priced out is exactly the person who most
    // needs to see that they lost the player. Their re-bid button disables
    // itself; the banner is the news.
    expect(
      outbidLatchAfter({ ...base, prevBidTeamId: "them", curBidTeamId: "them" }),
    ).toBe("keep");
  });

  it("never both sets and clears — the decisions are exclusive by construction", () => {
    // Exhaustive over every combination the room can hand it. The old code ran
    // a clear `if` and then a set `if` and depended on this without saying so.
    const ids = [null, "me", "them"];
    const noms = [null, "p1", "p2"];
    for (const myTeamId of ids)
      for (const prevBidTeamId of ids)
        for (const curBidTeamId of ids)
          for (const prevNominatedId of noms)
            for (const curNominatedId of noms) {
              const args = {
                myTeamId,
                prevBidTeamId,
                curBidTeamId,
                prevNominatedId,
                curNominatedId,
              };
              const d = outbidLatchAfter(args);
              expect(["set", "clear", "keep"]).toContain(d);
              // "set" and wasOutbid must agree, exactly.
              expect(d === "set").toBe(wasOutbid(args));
            }
  });

  it("never sets for a spectator", () => {
    expect(outbidLatchAfter({ ...base, myTeamId: null })).not.toBe("set");
  });
});

describe("draftTitleFlag", () => {
  const base = {
    loaded: true,
    status: "IN_PROGRESS" as string | null,
    canNominate: false,
    outbid: false,
  };

  it("writes nothing before the first payload", () => {
    expect(draftTitleFlag({ ...base, loaded: false, canNominate: true })).toBeNull();
  });

  it("flags YOUR PICK while the nomination is the viewer's to make", () => {
    // The moment auto-skip punishes hardest: a captain tabbed away loses the
    // nomination to the resolver, which picks for them.
    expect(draftTitleFlag({ ...base, canNominate: true })).toBe("⏰ Your pick — ");
  });

  it("prefers YOUR PICK over OUTBID when both hold", () => {
    // Losing a lot costs one player; missing your nomination costs the pick.
    expect(draftTitleFlag({ ...base, canNominate: true, outbid: true })).toBe(
      "⏰ Your pick — ",
    );
  });

  it("flags OUTBID only from the latch, never from 'not holding the high bid'", () => {
    // Deriving it from the state instead would mislabel every nomination the
    // captain never bid on.
    expect(draftTitleFlag({ ...base, outbid: true })).toBe("💸 Outbid — ");
    expect(draftTitleFlag(base)).toBeNull();
  });

  it("goes quiet once the draft is COMPLETE, even on a stale canNominate", () => {
    // Belt-and-braces against a payload that arrived seconds late; invisible
    // until it isn't.
    expect(
      draftTitleFlag({ ...base, status: "COMPLETE", canNominate: true }),
    ).toBeNull();
  });
});

describe("stripDraftTitleFlag", () => {
  it("round-trips every flag the room can write", () => {
    // The room used to keep its own hand-copied array of these two literals
    // five lines below where they were defined. A one-character drift — an en
    // dash for an em dash, a lost trailing space — would have stacked prefixes
    // in the tab forever, with nothing anywhere to notice.
    const base = "LD2L — draft";
    for (const flag of DRAFT_TITLE_PREFIXES) {
      expect(stripDraftTitleFlag(flag + base)).toBe(base);
    }
  });

  it("leaves an unflagged title alone", () => {
    expect(stripDraftTitleFlag("LD2L — draft")).toBe("LD2L — draft");
    expect(stripDraftTitleFlag("")).toBe("");
  });

  it("removes at most ONE prefix", () => {
    // It never has to remove two, because the effect always strips before it
    // writes — this pins that invariant rather than papering over it.
    const doubled = DRAFT_TITLE_PREFIXES[0] + DRAFT_TITLE_PREFIXES[1] + "LD2L";
    expect(stripDraftTitleFlag(doubled)).toBe(DRAFT_TITLE_PREFIXES[1] + "LD2L");
  });
});

describe("draftViewerStake", () => {
  const state = (over: Partial<Parameters<typeof draftViewerStake>[0]> = {}) => ({
    me: { userId: "u1", myTeamId: null, isAdmin: false },
    available: [] as { userId: string }[],
    ...over,
  });

  it("captains and admins always have one", () => {
    expect(draftViewerStake(state({ me: { userId: "u1", myTeamId: "t1", isAdmin: false } }))).toBe(true);
    expect(draftViewerStake(state({ me: { userId: "u1", myTeamId: null, isAdmin: true } }))).toBe(true);
  });

  it("so does a player still in the pool — they can be nominated at any moment", () => {
    expect(draftViewerStake(state({ available: [{ userId: "u1" }] }))).toBe(true);
  });

  it("goes false the moment the viewer is SOLD", () => {
    // Correct — and it means their "you were drafted" chime has to arrive on
    // the very poll that removes them from the pool.
    expect(draftViewerStake(state({ available: [{ userId: "someone-else" }] }))).toBe(
      false,
    );
  });

  it("a signed-out spectator never has one", () => {
    // Explicit rather than accidental: without the userId guard this would
    // depend on no pool entry ever carrying a null id.
    expect(
      draftViewerStake({
        me: { userId: null, myTeamId: null, isAdmin: false },
        available: [{ userId: "u1" }],
      }),
    ).toBe(false);
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
