import { describe, expect, it } from "vitest";
import {
  isDraftComplete,
  nextPickTeam,
  orderCaptains,
  playersNeeded,
  seedOrder,
  tallyMethod,
  type CaptainCandidate,
} from "./inhouse";

const p = (userId: string, mmr: number, joinedAt: number) => ({
  userId,
  mmr,
  joinedAt,
});

// A captain candidate with sensible defaults; override what a test cares about.
const cand = (
  userId: string,
  over: Partial<CaptainCandidate> = {},
): CaptainCandidate => ({
  userId,
  mmr: 0,
  joinedAt: 0,
  nominations: 0,
  wins: 0,
  winRate: 0,
  games: 0,
  ...over,
});

describe("seedOrder", () => {
  it("orders by MMR desc, breaking ties by earliest join", () => {
    const ordered = seedOrder([
      p("a", 3000, 100),
      p("b", 5000, 200),
      p("c", 3000, 50), // same MMR as a, but queued earlier
    ]);
    expect(ordered.map((x) => x.userId)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate the input", () => {
    const input = [p("a", 1, 1), p("b", 2, 2)];
    seedOrder(input);
    expect(input.map((x) => x.userId)).toEqual(["a", "b"]);
  });
});

describe("tallyMethod", () => {
  it("defaults to MMR when nobody voted", () => {
    expect(tallyMethod([])).toBe("MMR");
  });

  it("returns the method with the most votes", () => {
    expect(tallyMethod(["VOTE", "VOTE", "MMR", "RECORD"])).toBe("VOTE");
    expect(tallyMethod(["RECORD", "RECORD", "MMR"])).toBe("RECORD");
  });

  it("breaks ties toward the more variable method (VOTE > RECORD > MMR)", () => {
    expect(tallyMethod(["MMR", "VOTE"])).toBe("VOTE");
    expect(tallyMethod(["MMR", "RECORD"])).toBe("RECORD");
  });
});

describe("orderCaptains", () => {
  it("MMR ranks by MMR then earliest queued", () => {
    const ordered = orderCaptains("MMR", [
      cand("a", { mmr: 2000, joinedAt: 1 }),
      cand("b", { mmr: 6000, joinedAt: 2 }),
      cand("c", { mmr: 4000, joinedAt: 3 }),
    ]);
    expect(ordered.slice(0, 2).map((x) => x.userId)).toEqual(["b", "c"]);
  });

  it("RECORD ranks by wins, then win rate, falling back to MMR", () => {
    const ordered = orderCaptains("RECORD", [
      cand("a", { wins: 1, winRate: 0.5, games: 2, mmr: 5000 }),
      cand("b", { wins: 3, winRate: 0.6, games: 5, mmr: 1000 }),
      cand("c", { wins: 0, winRate: 0, games: 0, mmr: 9000 }), // no games → last
    ]);
    expect(ordered.map((x) => x.userId)).toEqual(["b", "a", "c"]);
  });

  it("VOTE ranks by nominations, breaking ties by MMR", () => {
    const ordered = orderCaptains("VOTE", [
      cand("a", { nominations: 1, mmr: 3000 }),
      cand("b", { nominations: 4, mmr: 1000 }),
      cand("c", { nominations: 1, mmr: 5000 }), // tie with a on votes, higher MMR
    ]);
    // b (4 votes), then c & a tie at 1 vote → c's higher MMR wins.
    expect(ordered.map((x) => x.userId)).toEqual(["b", "c", "a"]);
  });
});

describe("nextPickTeam", () => {
  it("starts with the configured first-pick team", () => {
    expect(nextPickTeam(0, 0, 5, 2)).toBe(2);
    expect(nextPickTeam(0, 0, 5, 1)).toBe(1);
  });

  it("alternates strictly back and forth for a 5v5 draft", () => {
    // firstPickTeam = 2 → order of teams to pick the 8 remaining slots.
    const order: (1 | 2 | null)[] = [];
    let t1 = 0;
    let t2 = 0;
    for (let i = 0; i < 8; i++) {
      const team = nextPickTeam(t1, t2, 5, 2);
      order.push(team);
      if (team === 1) t1++;
      else if (team === 2) t2++;
    }
    expect(order).toEqual([2, 1, 2, 1, 2, 1, 2, 1]);
    expect(t1).toBe(4);
    expect(t2).toBe(4);
    // Both rosters (captain + 4 picks) are now full.
    expect(nextPickTeam(t1, t2, 5, 2)).toBeNull();
  });

  it("skips a full side instead of overfilling it", () => {
    // team 1 already has all 4 picks, team 2 has 2 → must be team 2's turn.
    expect(nextPickTeam(4, 2, 5, 2)).toBe(2);
  });
});

describe("isDraftComplete", () => {
  it("is complete only when both rosters are full", () => {
    expect(isDraftComplete(5, 5)).toBe(true);
    expect(isDraftComplete(5, 4)).toBe(false);
    expect(isDraftComplete(3, 5)).toBe(false);
  });
});

describe("playersNeeded", () => {
  it("counts down to a full lobby and never goes negative", () => {
    expect(playersNeeded(0)).toBe(10);
    expect(playersNeeded(7)).toBe(3);
    expect(playersNeeded(10)).toBe(0);
    expect(playersNeeded(12)).toBe(0);
  });
});
