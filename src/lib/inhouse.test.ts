import { describe, expect, it } from "vitest";
import {
  autoJoinDecision,
  avgKnownMmr,
  detectIntervalSeconds,
  inhouseAlerts,
  inhouseLobbyCode,
  inhouseTitleFlag,
  mmrBalance,
  readyCheckEndedToast,
  nextPickTeam,
  orderCaptains,
  playersNeeded,
  queueDropCutoff,
  queuePresence,
  queuePresentCutoff,
  queueSlots,
  requeueLastSeenAt,
  seedOrder,
  tallyMethod,
  wasInReadyCheck,
  type CaptainCandidate,
  type InhouseAlertSnapshot,
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

  it("is TOTAL: an exact tie falls back to userId, not to input order", () => {
    // This is what lets the room's vote PREVIEW and the server's captain
    // INSTALLATION agree. Both call this function on the same ten players, but
    // from differently-ordered arrays — Prisma's row order on the server, a
    // name-sorted payload in the room — and every lobby player shares one
    // `createdAt` (they are written by a single createMany), so the
    // earliest-queued tiebreak above can never separate them. Without a total
    // order the two sides silently name different captains on any tie, which
    // on a young ladder (everyone 0-0, unregistered players at MMR 0) is the
    // normal case rather than a corner one.
    const tied = [cand("zeta"), cand("alpha"), cand("mid")];
    for (const method of ["MMR", "RECORD", "VOTE"] as const) {
      expect(orderCaptains(method, tied).map((x) => x.userId)).toEqual([
        "alpha",
        "mid",
        "zeta",
      ]);
      // …and from any starting arrangement, the same answer.
      expect(orderCaptains(method, [...tied].reverse()).map((x) => x.userId)).toEqual(
        ["alpha", "mid", "zeta"],
      );
    }
  });

  it("keeps the real keys ahead of the tiebreak", () => {
    // The fallback must never outrank something that actually distinguishes
    // two players.
    const ordered = orderCaptains("MMR", [
      cand("aaa", { mmr: 1000 }),
      cand("zzz", { mmr: 9000 }),
    ]);
    expect(ordered.map((x) => x.userId)).toEqual(["zzz", "aaa"]);
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

// Which queue entries occupy the ten visible slots. The room used to index the
// raw queue, which put "away" entries in slots that the headline count,
// `needed` and lobby formation itself all ignore.
describe("queueSlots", () => {
  const q = (name: string, away = false) => ({ name, away });

  it("gives present players the slots and pushes nobody else ahead of them", () => {
    // The default state of a fresh database: the seed enqueues six demo
    // players born AWAY, so five real players rendered "5 / 10" above a grid
    // of six dimmed demos with a real, counted player listed under "In line
    // for the next game" — while the pinned Discord board, which lists present
    // names, showed the opposite.
    const queue = [
      q("demo1", true),
      q("demo2", true),
      q("real1"),
      q("real2"),
      q("real3"),
    ];
    const { slots, overflow } = queueSlots(queue, 3);
    expect(slots.map((s) => s?.name)).toEqual(["real1", "real2", "real3"]);
    expect(overflow.map((s) => s.name)).toEqual(["demo1", "demo2"]);
  });

  it("keeps away players visible in the leftover slots", () => {
    // They are still queued — the grace window is the point. They just can't
    // displace someone who is here.
    const { slots } = queueSlots([q("away1", true), q("here")], 4);
    expect(slots.map((s) => s?.name)).toEqual(["here", "away1", undefined, undefined]);
  });

  it("pads out to the lobby size with empty slots", () => {
    const { slots, overflow } = queueSlots([q("a")], 10);
    expect(slots).toHaveLength(10);
    expect(slots.filter(Boolean)).toHaveLength(1);
    expect(overflow).toEqual([]);
  });

  it("preserves join order within each group, and in the overflow", () => {
    const queue = [q("a"), q("b"), q("c"), q("d")];
    const { slots, overflow } = queueSlots(queue, 2);
    expect(slots.map((s) => s?.name)).toEqual(["a", "b"]);
    // The overflow is a waiting LINE; its order is who queued when.
    expect(overflow.map((s) => s.name)).toEqual(["c", "d"]);
  });

  it("never drops or duplicates an entry", () => {
    const queue = [q("a", true), q("b"), q("c", true), q("d"), q("e")];
    for (const size of [0, 1, 3, 5, 9]) {
      const { slots, overflow } = queueSlots(queue, size);
      const seen = [...slots.filter(Boolean), ...overflow];
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(queue.length);
    }
  });

  it("survives a zero lobby size instead of dividing by it", () => {
    expect(queueSlots([q("a")], 0)).toEqual({
      slots: [],
      overflow: [{ name: "a", away: false }],
    });
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

// The bell. Five transitions, diffed against the previous poll, OR'd by the
// room into ONE playChime() — so coinciding transitions never double-strike
// the same AudioContext. Nothing asserted any of this before: no unit test can
// render the room, and no browser spec listens for audio.
describe("inhouseAlerts", () => {
  const snap = (
    over: Partial<InhouseAlertSnapshot> = {},
  ): InhouseAlertSnapshot => ({
    status: null,
    inLobby: false,
    isOnClock: false,
    resultId: null,
    ...over,
  });
  const inCheck = snap({ status: "READY_CHECK", inLobby: true });
  const inVote = snap({ status: "CAPTAIN_VOTE", inLobby: true });

  it("says NOTHING on the first payload after mount", () => {
    // A player who reloads mid-lobby — or inside the 10-minute lastResult
    // window — must not be rung for things that happened before they arrived.
    expect(inhouseAlerts(null, inCheck)).toEqual([]);
    expect(inhouseAlerts(null, snap({ resultId: "g1" }))).toEqual([]);
    expect(
      inhouseAlerts(null, snap({ status: "DRAFTING", inLobby: true, isOnClock: true })),
    ).toEqual([]);
  });

  it("rings when the lobby forms under the viewer", () => {
    expect(inhouseAlerts(snap(), inCheck)).toEqual(["lobby-formed"]);
  });

  it("rings for a hidden tab that first SEES the lobby already past the check", () => {
    // The keyed-on-prevStatus-null rule. A hidden tab polls on the 45s
    // keepalive, so its first sight of the lobby can be CAPTAIN_VOTE or
    // DRAFTING — and that player still needs the bell. Exactly once, though:
    // "vote-opened" requires the PREVIOUS status to have been READY_CHECK,
    // which is what stops this case ringing twice.
    expect(inhouseAlerts(snap(), inVote)).toEqual(["lobby-formed"]);
  });

  it("rings AGAIN when the vote opens after the ready check", () => {
    // Deliberate second bell: a player may have accepted early and tabbed
    // away, which is precisely what the 45s ACCEPT_SECONDS anticipates.
    expect(inhouseAlerts(inCheck, inVote)).toEqual(["vote-opened"]);
  });

  it("rings when the viewer's pick turn starts, and only on the edge", () => {
    const off = snap({ status: "DRAFTING", inLobby: true });
    const on = snap({ status: "DRAFTING", inLobby: true, isOnClock: true });
    expect(inhouseAlerts(off, on)).toEqual(["my-turn"]);
    expect(inhouseAlerts(on, on)).toEqual([]);
  });

  it("rings when teams lock in", () => {
    const drafting = snap({ status: "DRAFTING", inLobby: true });
    const ready = snap({ status: "READY", inLobby: true });
    expect(inhouseAlerts(drafting, ready)).toEqual(["teams-ready"]);
    expect(inhouseAlerts(ready, ready)).toEqual([]);
  });

  it("rings on a RESULT, never on the lobby merely vanishing", () => {
    // The active-lobby query drops COMPLETED and CANCELLED identically, so an
    // admin cancel is indistinguishable by status alone — and would ring a
    // victory bell for a game nobody played.
    const live = snap({ status: "IN_PROGRESS", inLobby: true });
    expect(inhouseAlerts(live, snap())).toEqual([]); // cancelled: silent
    expect(inhouseAlerts(live, snap({ resultId: "g1" }))).toEqual(["game-ended"]);
  });

  it("rings for a SECOND result inside the same lastResult window", () => {
    // Compared by id, not by "was null": back-to-back games in one evening
    // both land inside the 10-minute window.
    const first = snap({ resultId: "g1" });
    expect(inhouseAlerts(first, snap({ resultId: "g2" }))).toEqual(["game-ended"]);
    expect(inhouseAlerts(first, first)).toEqual([]);
    // …and the window expiring is not an event.
    expect(inhouseAlerts(first, snap())).toEqual([]);
  });

  it("ignores a spectator watching someone else's lobby", () => {
    // Every alert but the result requires MEMBERSHIP.
    expect(inhouseAlerts(snap(), snap({ status: "READY_CHECK" }))).toEqual([]);
    expect(
      inhouseAlerts(snap({ status: "DRAFTING" }), snap({ status: "READY" })),
    ).toEqual([]);
  });

  it("reports BOTH when two transitions coincide (the room still rings once)", () => {
    // A hidden tab whose first sight of the lobby is READY satisfies
    // lobby-formed AND teams-ready. The OR in the room is what keeps that one
    // bell; returning the list is what let a test see it at all.
    expect(inhouseAlerts(snap(), snap({ status: "READY", inLobby: true }))).toEqual([
      "lobby-formed",
      "teams-ready",
    ]);
  });

  it("is silent when nothing changed — including a sound toggle re-render", () => {
    // The room's effect re-runs on [state, soundOn], so muting and unmuting
    // hands it the same payload twice. Every predicate must compare false, or
    // unmuting rings a bell for a lobby you've been staring at for minutes.
    for (const s of [snap(), inCheck, inVote, snap({ resultId: "g1" })]) {
      expect(inhouseAlerts(s, s)).toEqual([]);
    }
  });

  it("is edge-triggered, so it DEPENDS on the caller ordering payloads", () => {
    // Not a flaw — the reason room-sequence.ts exists. A stale payload applied
    // after a fresher one presents a regression as a fresh edge, which is
    // exactly the re-fired chime in the reported bug.
    const beforePick = snap({ status: "DRAFTING", inLobby: true, isOnClock: true });
    const afterPick = snap({ status: "DRAFTING", inLobby: true });
    expect(inhouseAlerts(afterPick, beforePick)).toEqual(["my-turn"]);
  });
});

describe("wasInReadyCheck", () => {
  it("reads the previous poll's membership, not the lobby's mere existence", () => {
    // Derived from the same snapshot the chime diffs, so the toast and the
    // bell can never disagree about what the last poll said.
    expect(wasInReadyCheck(null)).toBe(false);
    expect(
      wasInReadyCheck({
        status: "READY_CHECK",
        inLobby: false,
        isOnClock: false,
        resultId: null,
      }),
    ).toBe(false);
    expect(
      wasInReadyCheck({
        status: "READY_CHECK",
        inLobby: true,
        isOnClock: false,
        resultId: null,
      }),
    ).toBe(true);
  });
});

// The tab title. Unlike the chime it is STATE-derived and ungated by the sound
// toggle, so it reaches a backgrounded tab that has never had a user gesture.
describe("inhouseTitleFlag", () => {
  const s = (over: Partial<Parameters<typeof inhouseTitleFlag>[0]> = {}) => ({
    status: null as string | null,
    inLobby: true,
    isOnClock: false,
    hasAccepted: false,
    hasVoted: false,
    ...over,
  });

  it("writes nothing before the first payload", () => {
    expect(inhouseTitleFlag(null)).toBeNull();
  });

  it("puts YOUR PICK above everything else", () => {
    // A captain on the clock during DRAFTING must never read "Teams locked".
    expect(inhouseTitleFlag(s({ status: "DRAFTING", isOnClock: true }))).toBe(
      "(!) Your pick",
    );
    expect(inhouseTitleFlag(s({ status: "READY", isOnClock: true }))).toBe(
      "(!) Your pick",
    );
  });

  it("nags for an accept only until the player has accepted", () => {
    expect(inhouseTitleFlag(s({ status: "READY_CHECK" }))).toBe(
      "(!) Accept your match",
    );
    expect(inhouseTitleFlag(s({ status: "READY_CHECK", hasAccepted: true }))).toBeNull();
  });

  it("nags for a vote only until the player has voted", () => {
    // A CHANGE from the shipped behaviour, and the point of the whole flag:
    // the accept nag has always dropped once you accept, while the vote nag
    // kept a "(!)" in the tab for the rest of the 25s whatever you did. A "(!)"
    // that survives the action it asks for teaches people to ignore "(!)".
    expect(inhouseTitleFlag(s({ status: "CAPTAIN_VOTE" }))).toBe(
      "(!) Lobby up — vote",
    );
    expect(inhouseTitleFlag(s({ status: "CAPTAIN_VOTE", hasVoted: true }))).toBeNull();
  });

  it("announces locked teams (the cue to go host the Dota lobby)", () => {
    expect(inhouseTitleFlag(s({ status: "READY" }))).toBe("(!) Teams locked");
  });

  it("says nothing to a spectator, whatever the lobby is doing", () => {
    for (const status of ["READY_CHECK", "CAPTAIN_VOTE", "DRAFTING", "READY"]) {
      expect(inhouseTitleFlag(s({ status, inLobby: false }))).toBeNull();
    }
  });

  it("says nothing once the game is under way or over", () => {
    // Nothing is being asked of the player any more; the tab goes quiet.
    expect(inhouseTitleFlag(s({ status: "IN_PROGRESS" }))).toBeNull();
    expect(inhouseTitleFlag(s({ status: "COMPLETED" }))).toBeNull();
    expect(inhouseTitleFlag(s({ status: null }))).toBeNull();
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
