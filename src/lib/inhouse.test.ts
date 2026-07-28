import { describe, expect, it } from "vitest";
import {
  autoJoinDecision,
  avgKnownMmr,
  detectIntervalSeconds,
  inhouseLobbyCode,
  inhousePollCadence,
  mmrBalance,
  readyCheckEndedToast,
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


describe("playersNeeded", () => {
  it("counts down to a full lobby and never goes negative", () => {
    expect(playersNeeded(0)).toBe(10);
    expect(playersNeeded(7)).toBe(3);
    expect(playersNeeded(10)).toBe(0);
    expect(playersNeeded(12)).toBe(0);
  });
});

describe("inhouseLobbyCode", () => {
  it("is a stable four-digit code for a given lobby id", () => {
    const a = inhouseLobbyCode("clz9k1abc0000xyz");
    expect(a).toMatch(/^\d{4}$/);
    expect(Number(a)).toBeGreaterThanOrEqual(1000);
    expect(Number(a)).toBeLessThanOrEqual(9999);
    // Deterministic — every player derives the same code from the same id.
    expect(inhouseLobbyCode("clz9k1abc0000xyz")).toBe(a);
  });

  it("differs across lobby ids (so back-to-back games don't collide)", () => {
    expect(inhouseLobbyCode("lobby-aaaaaaaa")).not.toBe(
      inhouseLobbyCode("lobby-bbbbbbbb"),
    );
  });
});

// The room's poll loop is ~1800 lines of client component with no unit-testable
// surface (this project's vitest env is `node` — no jsdom), so its cadence
// rules used to be asserted only by whatever a browser spec happened to reach.
// They're the difference between a queue spot held and a lobby lost, so they
// live out here now.
describe("inhousePollCadence", () => {
  const FAST = 1500;
  const IDLE = 10000;
  const base = { activeMs: FAST, idleMs: IDLE, reached: true };

  it("polls FAST for anyone with a stake — in a lobby OR in the queue", () => {
    // The people a filling queue / forming lobby matter to are in it. Seconds
    // decide accepts, votes and picks.
    const c = inhousePollCadence({ ...base, hidden: false, hasStake: true });
    expect(c).toEqual({ skip: false, delayMs: FAST });
  });

  it("polls IDLE-slow for a spectator, however busy the lobby is", () => {
    // Membership, not existence: five people watching a 45-minute game were
    // each firing 40 req/min because a lobby existed.
    expect(
      inhousePollCadence({ ...base, hidden: false, hasStake: false }),
    ).toEqual({ skip: false, delayMs: IDLE });
  });

  it("keeps a HIDDEN tab with a stake on the keepalive", () => {
    // That poll IS the presence heartbeat, and it carries the ready check's
    // chime + tab title. Stop it and the spot is dropped as "away".
    expect(
      inhousePollCadence({ ...base, hidden: true, hasStake: true }),
    ).toEqual({ skip: false, delayMs: INHOUSE.POLL_KEEPALIVE_MS });
  });

  it("the keepalive stays comfortably under the away cutoff", () => {
    // The binding case is a live game: all ten tabs are hidden (everyone is in
    // the Dota client), so the keepalive is the ONLY thing holding ten queue
    // spots — and Chrome clamps hidden timers toward once a minute.
    expect(INHOUSE.POLL_KEEPALIVE_MS).toBeLessThan(
      INHOUSE.QUEUE_AWAY_SECONDS * 1000,
    );
  });

  it("stops fetching entirely in a HIDDEN tab with nothing at stake", () => {
    // Browsers throttle background timers anyway, and the sitewide /api/sync
    // ping advances lobbies without this tab's help.
    expect(
      inhousePollCadence({ ...base, hidden: true, hasStake: false }),
    ).toEqual({ skip: true, delayMs: IDLE });
  });

  it("eases OFF after a 429 instead of hammering — even mid-lobby", () => {
    // The 429 back-off, in one line. The route's speed bump is per-IP and a
    // queued tab polls 40/min, so one household or NAT crosses it just by
    // having a lobby. Retrying at the fast rate kept the fixed window
    // saturated so it never cleared, and ACCEPT (which shares the bucket)
    // stayed unreachable for the whole 45-second ready check.
    expect(
      inhousePollCadence({
        ...base,
        hidden: false,
        hasStake: true,
        rateLimited: true,
      }),
    ).toEqual({ skip: false, delayMs: IDLE });
  });

  it("a 429 outranks even the hidden-tab rules", () => {
    // Both hidden branches would otherwise keep fetching (or skip at the wrong
    // rate) while the bucket is empty; the limit is per-IP, not per-tab.
    for (const hasStake of [true, false]) {
      expect(
        inhousePollCadence({
          ...base,
          hidden: true,
          hasStake,
          rateLimited: true,
        }),
      ).toEqual({ skip: false, delayMs: IDLE });
    }
  });

  it("retries at the FAST rate when a poll didn't land", () => {
    // Sustained failures are what flip `disconnected` (pollHealthAfter);
    // backing off would delay both the recovery and the diagnosis.
    expect(
      inhousePollCadence({
        ...base,
        hidden: false,
        hasStake: false,
        reached: false,
      }),
    ).toEqual({ skip: false, delayMs: FAST });
  });

  it("defaults the idle rate to the INHOUSE constant", () => {
    expect(
      inhousePollCadence({ hidden: false, hasStake: false, activeMs: FAST })
        .delayMs,
    ).toBe(INHOUSE.POLL_IDLE_MS);
  });
});

// Every Discord ping deep-links to /inhouse?join=1, so this decides what
// happens to someone arriving from a notification.
describe("autoJoinDecision", () => {
  const me = (over: Partial<Parameters<typeof autoJoinDecision>[0]> = {}) => ({
    isLoggedIn: true,
    inQueue: false,
    inLobby: false,
    ...over,
  });

  it("joins a signed-in player who isn't in yet", () => {
    expect(autoJoinDecision(me())).toBe("join");
  });

  it("does nothing for a signed-out visitor", () => {
    // Silently, too: the page's own sign-in CTA is the right thing to see.
    expect(autoJoinDecision(me({ isLoggedIn: false }))).toBe("signed-out");
  });

  it("says so instead of re-queuing someone already in the queue", () => {
    expect(autoJoinDecision(me({ inQueue: true }))).toBe("already-in");
  });

  it("refuses to touch the queue for someone already IN the lobby", () => {
    // The teeth: queue membership can drag you into a 45-second ready check.
    // Never do that to someone from a link they may have tapped by accident.
    expect(autoJoinDecision(me({ inLobby: true }))).toBe("already-in");
  });

  it("still joins while a lobby is running — that's the next game", () => {
    // Only one lobby exists at a time, so a new joiner can't be pulled into
    // the running one. Refusing here also broke the board's own
    // "Queue for the next one →" link, which exists for exactly this case.
    expect(autoJoinDecision(me())).toBe("join");
  });
});

// The toast a player gets when the ready check they were in disappears.
describe("readyCheckEndedToast", () => {
  const t = (over: Partial<Parameters<typeof readyCheckEndedToast>[0]>) =>
    readyCheckEndedToast({
      wasInReadyCheck: true,
      inLobby: false,
      inQueue: false,
      ...over,
    });

  it("tells a re-queued player they're back in line", () => {
    expect(t({ inQueue: true })).toMatch(/back in the queue/i);
  });

  it("does NOT claim a dropped player is still queued", () => {
    // failReadyCheck deliberately drops the decliner and the timed-out
    // no-shows. Telling them they were "back in the queue" contradicted the
    // decline dialog they had just confirmed, and left no-shows sitting on the
    // page believing they were in line for the next game.
    const msg = t({ inQueue: false });
    expect(msg).toMatch(/no longer in the queue/i);
    expect(msg).not.toMatch(/back in the queue/i);
  });

  it("stays SILENT while the viewer is still in the lobby", () => {
    // The gate is membership, not a status list. ACCEPT_SECONDS +
    // VOTE_SECONDS fit inside one hidden-tab keepalive gap, so a player who
    // accepted early and tabbed away can poll straight from READY_CHECK to
    // DRAFTING — and was told their very much alive match had been cancelled.
    expect(t({ inLobby: true })).toBeNull();
    expect(t({ inLobby: true, inQueue: true })).toBeNull();
  });

  it("says nothing to someone who was never in the check", () => {
    expect(t({ wasInReadyCheck: false })).toBeNull();
    // Including a spectator who watched it happen from the queue.
    expect(t({ wasInReadyCheck: false, inQueue: true })).toBeNull();
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

describe("avgKnownMmr", () => {
  it("ignores unknowns rather than averaging them in as zero", () => {
    expect(avgKnownMmr([4000, 3800, 3600, 3400, 0])).toBe(3700);
    expect(avgKnownMmr([])).toBe(0);
    expect(avgKnownMmr([0, 0])).toBe(0);
  });

  it("is the same number mmrBalance reports for that side", () => {
    // The room renders this figure on three screens (drafting columns,
    // balance banner, READY/IN_PROGRESS matchup grid) and each used its own
    // copy. The grid's divided by the whole roster, so one unregistered
    // player made a side that the banner had just called 120 MMR STRONGER
    // render 620 weaker the instant the last pick landed and the grid
    // replaced the drafting view — nothing about the teams having changed.
    const t1 = [4000, 3800, 3600, 3400, 0];
    const t2 = [3700, 3700, 3600, 3500, 3400];
    const b = mmrBalance(t1, t2);
    expect(avgKnownMmr(t1)).toBe(b.avg1);
    expect(avgKnownMmr(t2)).toBe(b.avg2);
    expect(b.diff).toBeGreaterThan(0); // team 1 is the STRONGER side here
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

  it("leaves enough slack for a HIDDEN tab's keepalive to re-confirm", () => {
    // The binding case for this window is a live game: all ten tabs are
    // hidden (everyone is in the Dota client), so they re-confirm on
    // POLL_KEEPALIVE_MS — which Chrome clamps toward once a minute for
    // background timers. At 45s of slack the admin's own 1.5s poll ran the
    // prune before a single keepalive landed, so "Lobby cancelled — players
    // re-queued" silently emptied the queue and nobody was left polling to
    // notice. The margin must cover the clamp, not just the nominal period.
    const slack = requeueLastSeenAt(now).getTime() - queueDropCutoff(now).getTime();
    expect(slack).toBeGreaterThan(INHOUSE.POLL_KEEPALIVE_MS * 1.5);
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
