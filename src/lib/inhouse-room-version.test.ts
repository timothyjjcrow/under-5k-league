import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// publishInhouseRoomChange and the long-poll: a publish bumps this process's
// count before its statement, and wakes the requests held here only after
// it (so a woken request reads the new version). The database is faked; the
// real thing is in test/integration/inhouse-room-longpoll.itest.ts.

const db = vi.hoisted(() => ({
  version: null as string | null,
  executeRaw: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("./prisma", () => ({
  prisma: {
    $executeRaw: db.executeRaw,
    setting: { findUnique: db.findUnique },
  },
}));

import { INHOUSE } from "./constants";
import {
  inhouseRoomHoldMark,
  inhouseRoomLocalGeneration,
  inhouseRoomVersionToken,
  publishInhouseRoomChange,
  readInhouseRoomVersion,
} from "./inhouse-room-version";
import {
  heldInhouseRoomRequests,
  inhouseRoomGeneration,
  resetInhouseRoomWaitersForTests,
  waitForInhouseRoomChange,
  type InhouseRoomWake,
} from "./inhouse-room-wait";

/** Past the coalesce window and the jitter, still well short of the watch. */
const SETTLE_MS = INHOUSE.LONG_POLL_COALESCE_MS + INHOUSE.LONG_POLL_JITTER_MS + 5;

const token = async () => inhouseRoomVersionToken(await readInhouseRoomVersion());

function hold() {
  const outcome: { wake: InhouseRoomWake | null } = { wake: null };
  void (async () => {
    const mark = inhouseRoomHoldMark();
    const since = await token();
    outcome.wake = await waitForInhouseRoomChange({
      since,
      mark,
      untilMs: Date.now() + INHOUSE.LONG_POLL_HOLD_MS,
      readToken: token,
    });
  })();
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
  db.version = "v1";
  db.executeRaw.mockReset().mockImplementation(async () => {
    db.version = `v${Math.random()}`;
    return 1;
  });
  db.findUnique.mockReset().mockImplementation(async () =>
    db.version === null ? null : { value: db.version },
  );
});
afterEach(() => {
  resetInhouseRoomWaitersForTests();
  vi.useRealTimers();
});

describe("publishInhouseRoomChange and held requests", () => {
  it("wakes a request held in this process well before the watch would", async () => {
    const held = hold();
    await vi.advanceTimersByTimeAsync(0);
    await publishInhouseRoomChange();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    // SABOTAGE CHECK: delete wakeInhouseRoomWaiters() from the publish and
    // this stays null until the watch's read, LONG_POLL_WATCH_MS later.
    expect(held.wake).toBe("changed");
    expect(SETTLE_MS).toBeLessThan(INHOUSE.LONG_POLL_WATCH_MS);
  });

  it("bumps the process's count before its statement, and wakes only after it", async () => {
    const held = hold();
    await vi.advanceTimersByTimeAsync(0);
    let land!: () => void;
    db.executeRaw.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = () => {
            db.version = "v2";
            resolve(1);
          };
        }),
    );
    const before = inhouseRoomGeneration();
    const publishing = publishInhouseRoomChange();
    // The local fence moves at once (the room snapshot stops serving).
    expect(inhouseRoomGeneration()).toBe(before + 1);
    expect(inhouseRoomLocalGeneration()).toBe(before + 1);
    // The statement hasn't landed: nothing wakes on the old version.
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(held.wake).toBeNull();
    land();
    await publishing;
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(held.wake).toBe("changed");
  });

  it("a publish already running when the route reads lands before the hold registers: still prompt", async () => {
    // The interleaving the 2s watch would otherwise have to catch: the
    // publish has bumped its count, the route takes the mark and reads the
    // old version, the INSERT lands and the publish's wake runs with nothing
    // held, and only then does the request register its hold.
    let land!: () => void;
    db.executeRaw.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = () => {
            db.version = "v2";
            resolve(1);
          };
        }),
    );
    const publishing = publishInhouseRoomChange();
    const mark = inhouseRoomHoldMark();
    const since = await token();
    expect(since).toBe("v1");
    land();
    await publishing;
    expect(heldInhouseRoomRequests()).toBe(0);
    const outcome: { wake: InhouseRoomWake | null } = { wake: null };
    void waitForInhouseRoomChange({
      since,
      mark,
      untilMs: Date.now() + INHOUSE.LONG_POLL_HOLD_MS,
      readToken: token,
    }).then((wake) => {
      outcome.wake = wake;
    });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(outcome.wake).toBe("changed");
  });

  it("still wakes held requests when the statement fails (the commit happened)", async () => {
    const held = hold();
    await vi.advanceTimersByTimeAsync(0);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    db.executeRaw.mockRejectedValue(Object.assign(new Error("busy"), { code: "P2034" }));
    await publishInhouseRoomChange();
    // Its version didn't move, so the re-check keeps it held; the other
    // slot's version moving is still caught by the watch.
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(held.wake).toBeNull();
    expect(error).toHaveBeenCalledWith("[inhouse-room-version] publish failed (P2034)");
    db.version = "v-elsewhere";
    await vi.advanceTimersByTimeAsync(INHOUSE.LONG_POLL_WATCH_MS);
    expect(held.wake).toBe("changed");
    error.mockRestore();
  });

  it("a fresh database has a token too, and its first publish moves it", async () => {
    db.version = null;
    expect(await token()).toBe("none");
    const held = hold();
    await vi.advanceTimersByTimeAsync(0);
    await publishInhouseRoomChange();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(held.wake).toBe("changed");
    expect(inhouseRoomVersionToken("abc")).toBe("abc");
  });
});
