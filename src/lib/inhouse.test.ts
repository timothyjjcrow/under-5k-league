import { describe, expect, it } from "vitest";
import {
  detectIntervalSeconds,
  isDraftComplete,
  mmrBalance,
  nextPickTeam,
  orderCaptains,
  playersNeeded,
  queueDropCutoff,
  queuePresence,
  queuePresentCutoff,
  requeueLastSeenAt,
  seedOrder,
  tallyMethod,
  type CaptainCandidate,
} from "./inhouse";
import { INHOUSE } from "./constants";

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

  /** Walk the whole draft, returning the team-per-pick order. */
  function draftOrder(
    teamSize: number,
    firstPickTeam: 1 | 2,
  ): { order: (1 | 2)[]; t1: number; t2: number } {
    const order: (1 | 2)[] = [];
    let t1 = 0;
    let t2 = 0;
    // (teamSize-1) picks per side.
    for (let i = 0; i < (teamSize - 1) * 2; i++) {
      const team = nextPickTeam(t1, t2, teamSize, firstPickTeam);
      if (team === null) break;
      order.push(team);
      if (team === 1) t1++;
      else t2++;
    }
    return { order, t1, t2 };
  }

  it("runs a SNAKE (1-2-2-…-1) draft for a 5v5, not strict alternation", () => {
    const { order, t1, t2 } = draftOrder(5, 2);
    // firstPickTeam = 2: single, then pairs, ending on a single.
    expect(order).toEqual([2, 1, 1, 2, 2, 1, 1, 2]);
    expect(t1).toBe(4);
    expect(t2).toBe(4);
    // Both rosters (captain + 4 picks) are now full.
    expect(nextPickTeam(t1, t2, 5, 2)).toBeNull();
  });

  it("mirrors the snake when team 1 picks first", () => {
    expect(draftOrder(5, 1).order).toEqual([1, 2, 2, 1, 1, 2, 2, 1]);
  });

  it("equalises each side's summed pick position — the fairness guarantee", () => {
    // The sum of 1-indexed pick positions must be identical for both sides;
    // that's what makes neither captain systematically advantaged. (Strict
    // alternation would give 16 vs 20.)
    for (const first of [1, 2] as const) {
      const { order } = draftOrder(5, first);
      let sum1 = 0;
      let sum2 = 0;
      order.forEach((team, i) => {
        if (team === 1) sum1 += i + 1;
        else sum2 += i + 1;
      });
      expect(sum1).toBe(sum2);
    }
  });

  it("keeps the pick counts balanced at every step (never more than one apart)", () => {
    let t1 = 0;
    let t2 = 0;
    for (let i = 0; i < 8; i++) {
      const team = nextPickTeam(t1, t2, 5, 2)!;
      if (team === 1) t1++;
      else t2++;
      expect(Math.abs(t1 - t2)).toBeLessThanOrEqual(1);
    }
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

describe("mmrBalance", () => {
  it("averages each side and reports the gap", () => {
    const b = mmrBalance([4000, 3000], [2000, 2000]);
    expect(b.avg1).toBe(3500);
    expect(b.avg2).toBe(2000);
    expect(b.diff).toBe(1500);
  });

  it("excludes unknown (0) MMRs from averages", () => {
    const b = mmrBalance([4000, 0], [3000]);
    expect(b.avg1).toBe(4000);
    expect(b.avg2).toBe(3000);
  });

  it("handles empty or all-unknown sides", () => {
    expect(mmrBalance([], [0, 0])).toEqual({ avg1: 0, avg2: 0, diff: 0 });
  });
});

describe("queue presence (heartbeat math)", () => {
  const now = 1_700_000_000_000;
  const secsAgo = (s: number) => now - s * 1000;

  it("classifies entries as present until the away window elapses", () => {
    expect(queuePresence(now, now)).toBe("present");
    expect(queuePresence(secsAgo(INHOUSE.QUEUE_AWAY_SECONDS), now)).toBe(
      "present", // boundary: exactly at the window is still present
    );
    expect(queuePresence(secsAgo(INHOUSE.QUEUE_AWAY_SECONDS + 1), now)).toBe(
      "away",
    );
  });

  it("cutoffs mirror the presence/drop windows for SQL filters", () => {
    // Seen exactly at the present cutoff → counts as present.
    expect(
      queuePresence(queuePresentCutoff(now).getTime(), now),
    ).toBe("present");
    expect(queuePresentCutoff(now).getTime()).toBe(
      secsAgo(INHOUSE.QUEUE_AWAY_SECONDS),
    );
    expect(queueDropCutoff(now).getTime()).toBe(
      secsAgo(INHOUSE.QUEUE_DROP_SECONDS),
    );
    // The drop window must be wider than the away window: entries go "away"
    // (stop counting) before they're removed outright.
    expect(INHOUSE.QUEUE_DROP_SECONDS).toBeGreaterThan(
      INHOUSE.QUEUE_AWAY_SECONDS,
    );
  });

  it("requeued players are away (no instant ghost lobby) but not dropped", () => {
    const seen = requeueLastSeenAt(now).getTime();
    // Doesn't count toward re-forming a lobby…
    expect(queuePresence(seen, now)).toBe("away");
    // …isn't pruned before their next poll can re-confirm them…
    expect(seen).toBeGreaterThan(queueDropCutoff(now).getTime());
    // …with the full reconfirm window of slack…
    expect(seen - queueDropCutoff(now).getTime()).toBe(
      INHOUSE.QUEUE_RECONFIRM_SECONDS * 1000,
    );
    // …and is stale enough that the throttled heartbeat fires immediately.
    expect(now - seen).toBeGreaterThan(INHOUSE.QUEUE_HEARTBEAT_SECONDS * 1000);
  });
});

describe("detectIntervalSeconds", () => {
  const HOUR = 3_600_000;

  it("holds the base interval through a normal game's length", () => {
    expect(detectIntervalSeconds(0)).toBe(INHOUSE.DETECT_INTERVAL_SECONDS);
    expect(detectIntervalSeconds(30 * 60_000)).toBe(
      INHOUSE.DETECT_INTERVAL_SECONDS,
    );
    // 1h × 1/20 = 180s — exactly the base; growth starts past this.
    expect(detectIntervalSeconds(HOUR)).toBe(INHOUSE.DETECT_INTERVAL_SECONDS);
  });

  it("stretches linearly for long-running games", () => {
    expect(detectIntervalSeconds(2 * HOUR)).toBe(360);
    expect(detectIntervalSeconds(4 * HOUR)).toBe(720);
  });

  it("caps so an abandoned lobby scans at a trickle, forever", () => {
    expect(detectIntervalSeconds(24 * HOUR)).toBe(
      INHOUSE.DETECT_INTERVAL_MAX_SECONDS,
    );
    expect(detectIntervalSeconds(400 * HOUR)).toBe(
      INHOUSE.DETECT_INTERVAL_MAX_SECONDS,
    );
  });
});
