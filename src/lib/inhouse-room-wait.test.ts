import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INHOUSE } from "./constants";
import {
  bumpInhouseRoomGeneration,
  heldInhouseRoomRequests,
  inhouseRoomGeneration,
  inhouseRoomPublishMark,
  inhouseRoomWakeJitterMs,
  loadAsAnotherProcessForTests,
  parseInhouseHold,
  resetInhouseRoomWaitersForTests,
  waitForInhouseRoomChange,
  wakeInhouseRoomWaiters,
  type InhouseRoomWake,
} from "./inhouse-room-wait";

// The long-poll's waiter registry (inhouse-room-wait.ts), with a fake version
// reader and fake timers. The route's use of it is tested in
// src/app/api/inhouse/route.test.ts, and end to end through the real route,
// database and a server action in test/integration/inhouse-room-longpoll.itest.ts.

const { LONG_POLL_COALESCE_MS, LONG_POLL_JITTER_MS, LONG_POLL_WATCH_MS } = INHOUSE;
/** Past every coalesce, read and jitter wait. */
const SETTLE_MS = LONG_POLL_COALESCE_MS + LONG_POLL_JITTER_MS + 5;

let token = "v1";
const readToken = vi.fn(async () => token);

/** A held request, with what it resolved to once it has. */
function hold(over: Partial<Parameters<typeof waitForInhouseRoomChange>[0]> = {}) {
  const outcome: { wake: InhouseRoomWake | null } = { wake: null };
  const promise = waitForInhouseRoomChange({
    since: "v1",
    mark: inhouseRoomPublishMark(),
    untilMs: Date.now() + INHOUSE.LONG_POLL_HOLD_MS,
    readToken,
    ...over,
  }).then((wake) => {
    outcome.wake = wake;
    return wake;
  });
  return { outcome, promise };
}

/** What a publish does around its statement. */
function publishHere() {
  bumpInhouseRoomGeneration();
  token = `v${Math.random()}`;
  wakeInhouseRoomWaiters();
}

beforeEach(() => {
  vi.useFakeTimers();
  token = "v1";
  readToken.mockClear();
});
afterEach(() => {
  resetInhouseRoomWaitersForTests();
  vi.useRealTimers();
});

describe("waitForInhouseRoomChange", () => {
  it("a publish in this process wakes a held request after the coalesce window", async () => {
    const held = hold();
    expect(heldInhouseRoomRequests()).toBe(1);
    publishHere();
    await vi.advanceTimersByTimeAsync(LONG_POLL_COALESCE_MS - 1);
    expect(held.outcome.wake).toBeNull();
    await vi.advanceTimersByTimeAsync(LONG_POLL_JITTER_MS + 5);
    expect(held.outcome.wake).toBe("changed");
    expect(heldInhouseRoomRequests()).toBe(0);
    // Well before the watch would have noticed on its own.
    expect(LONG_POLL_COALESCE_MS + LONG_POLL_JITTER_MS).toBeLessThan(LONG_POLL_WATCH_MS);
  });

  it("a mutation's two publishes cost one version read and one wake", async () => {
    const held = [hold(), hold(), hold()];
    publishHere();
    await vi.advanceTimersByTimeAsync(30);
    publishHere();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(held.map((h) => h.outcome.wake)).toEqual(["changed", "changed", "changed"]);
    expect(readToken).toHaveBeenCalledTimes(1);
  });

  it("a publish that left the version where the client has it keeps the request held", async () => {
    const held = hold();
    // The statement failed: same token.
    bumpInhouseRoomGeneration();
    wakeInhouseRoomWaiters();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(held.outcome.wake).toBeNull();
    expect(heldInhouseRoomRequests()).toBe(1);
  });

  it("wakes only the requests the version moved past", async () => {
    const behind = hold({ since: "v1" });
    const current = hold({ since: "v2" });
    token = "v2";
    wakeInhouseRoomWaiters();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(behind.outcome.wake).toBe("changed");
    expect(current.outcome.wake).toBeNull();
  });

  it("the watch timer catches a version moved outside this process", async () => {
    const held = hold();
    // The other release slot published: nothing here was told.
    token = "v-other-slot";
    await vi.advanceTimersByTimeAsync(LONG_POLL_WATCH_MS - 1);
    expect(held.outcome.wake).toBeNull();
    await vi.advanceTimersByTimeAsync(1 + LONG_POLL_JITTER_MS + 5);
    expect(held.outcome.wake).toBe("changed");
  });

  it("the watch reads only while something is held, once per tick", async () => {
    const held = hold();
    await vi.advanceTimersByTimeAsync(3 * LONG_POLL_WATCH_MS);
    expect(readToken).toHaveBeenCalledTimes(3);
    token = "v2";
    await vi.advanceTimersByTimeAsync(LONG_POLL_WATCH_MS + SETTLE_MS);
    expect(held.outcome.wake).toBe("changed");
    readToken.mockClear();
    await vi.advanceTimersByTimeAsync(10 * LONG_POLL_WATCH_MS);
    expect(readToken).not.toHaveBeenCalled();
  });

  it("a failed read leaves the request held for the next check", async () => {
    const held = hold();
    token = "v2";
    readToken.mockRejectedValueOnce(new Error("pool timeout"));
    await vi.advanceTimersByTimeAsync(LONG_POLL_WATCH_MS + SETTLE_MS);
    expect(held.outcome.wake).toBeNull();
    await vi.advanceTimersByTimeAsync(LONG_POLL_WATCH_MS + SETTLE_MS);
    expect(held.outcome.wake).toBe("changed");
  });

  it("a check asked for during a read runs once that read is done", async () => {
    // The watch's read started before the publish's statement and returns
    // the old version; the publish's own check must still happen.
    let release!: () => void;
    readToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("v1");
        }),
    );
    const held = hold();
    await vi.advanceTimersByTimeAsync(LONG_POLL_WATCH_MS);
    expect(readToken).toHaveBeenCalledTimes(1);
    publishHere();
    await vi.advanceTimersByTimeAsync(LONG_POLL_COALESCE_MS);
    release();
    await vi.advanceTimersByTimeAsync(LONG_POLL_JITTER_MS + 5);
    expect(readToken).toHaveBeenCalledTimes(2);
    expect(held.outcome.wake).toBe("changed");
  });

  it("re-checks at once when a publish started after the caller's version read", async () => {
    // The route took the hold mark, read the version (maybe before the
    // publish's statement landed), and only then held: trust nothing.
    const before = inhouseRoomPublishMark();
    bumpInhouseRoomGeneration();
    token = "v2";
    const held = hold({ mark: before });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(held.outcome.wake).toBe("changed");
  });

  it("re-checks at once when a publish that started before the mark landed before the hold registered", async () => {
    // The publish bumps its count, then the route takes the mark (which
    // already includes that bump) and reads the version before the INSERT
    // lands. The INSERT lands and the publish's wake runs while nothing is
    // held yet, so its re-check has nobody to wake. The hold registers on the
    // stale version: only `landed` moving tells it so.
    bumpInhouseRoomGeneration();
    const mark = inhouseRoomPublishMark();
    const since = token; // the route's version read: still "v1"
    token = "v2";
    wakeInhouseRoomWaiters();
    expect(heldInhouseRoomRequests()).toBe(0);
    const held = hold({ since, mark });
    // SABOTAGE CHECK: drop `registry.landed += 1` from the wake and this
    // stays null until the watch's read, LONG_POLL_WATCH_MS later.
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(held.outcome.wake).toBe("changed");
    expect(SETTLE_MS).toBeLessThan(LONG_POLL_WATCH_MS);
  });

  it("an unmoved mark trusts the caller's version read: no extra re-check", async () => {
    const held = hold();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(readToken).not.toHaveBeenCalled();
    expect(held.outcome.wake).toBeNull();
  });

  it("ends at its deadline: the hold's end or the room's next clock", async () => {
    const held = hold({ untilMs: Date.now() + 4_000 });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(held.outcome.wake).toBeNull();
    await vi.advanceTimersByTimeAsync(1 + LONG_POLL_JITTER_MS);
    expect(held.outcome.wake).toBe("deadline");
    // A deadline already past ends it on the next turn.
    const late = hold({ untilMs: Date.now() - 50 });
    await vi.advanceTimersByTimeAsync(LONG_POLL_JITTER_MS + 1);
    expect(late.outcome.wake).toBe("deadline");
  });

  it("an abort ends the hold at once, with no jitter, and stops the timers", async () => {
    const controller = new AbortController();
    const held = hold({ signal: controller.signal });
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(held.outcome.wake).toBe("aborted");
    expect(heldInhouseRoomRequests()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * LONG_POLL_WATCH_MS);
    expect(readToken).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an already-aborted request is never held", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(hold({ signal: controller.signal }).promise).resolves.toBe("aborted");
    expect(heldInhouseRoomRequests()).toBe(0);
  });
});

describe("one registry per process", () => {
  it("a publish through another module instance wakes this one's held request", async () => {
    // `next start` loads src/lib twice (route handlers; pages and server
    // actions): the server action's publish must reach the route's waiters.
    vi.resetModules();
    const other = await import("./inhouse-room-wait");
    expect(other.inhouseRoomGeneration()).toBe(inhouseRoomGeneration());
    const held = hold();
    other.bumpInhouseRoomGeneration();
    token = "v2";
    other.wakeInhouseRoomWaiters();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(held.outcome.wake).toBe("changed");
    // And the publish count is the same count.
    expect(other.inhouseRoomGeneration()).toBe(inhouseRoomGeneration());
  });

  it("a registry kept per module instance would miss it (what globalThis buys)", async () => {
    // Load a second copy with the global entry out of the way: a separate
    // registry, as another process has. Its publish wakes nothing here; only
    // the watch's database read does.
    const elsewhere = await loadAsAnotherProcessForTests(async () => {
      vi.resetModules();
      return import("./inhouse-room-wait");
    });
    expect(elsewhere.inhouseRoomPublishMark).not.toBe(inhouseRoomPublishMark);
    const markHere = inhouseRoomPublishMark();
    const held = hold();
    elsewhere.bumpInhouseRoomGeneration();
    token = "v2";
    elsewhere.wakeInhouseRoomWaiters();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(held.outcome.wake).toBeNull();
    // Its counts are its own.
    expect(inhouseRoomPublishMark()).toBe(markHere);
    await vi.advanceTimersByTimeAsync(LONG_POLL_WATCH_MS);
    expect(held.outcome.wake).toBe("changed");
    // And this process's registry is back for the next module load.
    vi.resetModules();
    const again = await import("./inhouse-room-wait");
    expect(again.inhouseRoomPublishMark()).toBe(inhouseRoomPublishMark());
  });
});

describe("inhouseRoomWakeJitterMs", () => {
  it("stays within [0, LONG_POLL_JITTER_MS]", () => {
    expect(inhouseRoomWakeJitterMs(() => 0)).toBe(0);
    expect(inhouseRoomWakeJitterMs(() => 0.999999)).toBe(LONG_POLL_JITTER_MS);
    expect(inhouseRoomWakeJitterMs(() => 0.5)).toBe(Math.round(LONG_POLL_JITTER_MS / 2));
    // Out-of-contract randoms are clamped.
    expect(inhouseRoomWakeJitterMs(() => 7)).toBe(LONG_POLL_JITTER_MS);
    expect(inhouseRoomWakeJitterMs(() => -1)).toBe(0);
    for (let i = 0; i < 1000; i++) {
      const ms = inhouseRoomWakeJitterMs();
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(LONG_POLL_JITTER_MS);
    }
  });

  it("a woken request really waits out its jitter", async () => {
    // Math.random drives the wait: at 0.99 a woken request answers 149ms
    // after the re-check's read, at 0 straight after it.
    // SABOTAGE CHECK: resolve settle()'s wake without the jitter timer and
    // the first assertion below goes red.
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
    const late = hold();
    publishHere();
    await vi.advanceTimersByTimeAsync(LONG_POLL_COALESCE_MS + 140);
    expect(late.outcome.wake).toBeNull();
    await vi.advanceTimersByTimeAsync(15);
    expect(late.outcome.wake).toBe("changed");

    random.mockReturnValue(0);
    const prompt = hold({ since: token });
    publishHere();
    await vi.advanceTimersByTimeAsync(LONG_POLL_COALESCE_MS + 1);
    expect(prompt.outcome.wake).toBe("changed");
    random.mockRestore();
  });

  it("every woken request lands inside its jitter window", async () => {
    const held = Array.from({ length: 20 }, () => hold());
    publishHere();
    await vi.advanceTimersByTimeAsync(LONG_POLL_COALESCE_MS);
    // Nothing answers before the re-check plus its read.
    expect(held.every((h) => h.outcome.wake === null || h.outcome.wake === "changed")).toBe(true);
    await vi.advanceTimersByTimeAsync(LONG_POLL_JITTER_MS + 1);
    expect(held.every((h) => h.outcome.wake === "changed")).toBe(true);
  });
});

describe("parseInhouseHold", () => {
  it("holds only a request that sends a usable version", () => {
    for (const since of [undefined, null, 7, "", "x".repeat(65), { v: 1 }]) {
      expect(parseInhouseHold({ action: "state", since })).toBeNull();
    }
    expect(parseInhouseHold({ action: "state", since: "x".repeat(64) })?.since).toHaveLength(64);
  });

  it("clamps the hold to what the server grants", () => {
    const at = (holdMs: unknown) => parseInhouseHold({ action: "state", since: "v", holdMs })?.holdMs;
    expect(at(10_000)).toBe(10_000);
    expect(at(999_999)).toBe(INHOUSE.LONG_POLL_HOLD_MS);
    expect(at(-5)).toBe(0);
    expect(at(1234.6)).toBe(1235);
    for (const odd of [undefined, "10000", Number.NaN, Infinity]) {
      expect(at(odd)).toBe(INHOUSE.LONG_POLL_HOLD_MS);
    }
  });
});
