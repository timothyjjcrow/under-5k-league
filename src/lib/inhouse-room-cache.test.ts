import { afterEach, describe, expect, it, vi } from "vitest";
import { INHOUSE } from "./constants";
import {
  createRoomCache,
  deepFreeze,
  resetInhouseRoomCacheForTests,
} from "./inhouse-room-cache";
import { onceAt, setRaceHook } from "./race-hook";

// The room snapshot cache, with its version reader, loader, local fence and
// clock injected. The integration tests (inhouse-room-cache.itest.ts) drive
// it through the real poll; these pin each rule at its boundary.

type Rows = { n: number; list: { id: string }[] };

function harness(opts: { freeze?: boolean } = {}) {
  let version: string | null = "v1";
  let localGen = 0;
  let now = 1_000_000;
  let loads = 0;
  const load = vi.fn(async (): Promise<Rows> => {
    loads += 1;
    return { n: loads, list: [{ id: `row-${loads}` }] };
  });
  const cache = createRoomCache<Rows>({
    readVersion: async () => version,
    load,
    localGen: () => localGen,
    now: () => now,
    maxAgeMs: INHOUSE.ROOM_SNAPSHOT_MAX_AGE_MS,
    freeze: opts.freeze ?? true,
  });
  return {
    cache,
    load,
    setVersion: (v: string | null) => {
      version = v;
    },
    publishLocally: () => {
      localGen += 1;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A promise and the function that settles it, for a load held open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  setRaceHook(null);
});

describe("the room snapshot cache", () => {
  it("serves a hit only for the same version, younger than the max age", async () => {
    const h = harness();
    const first = await h.cache.get();
    expect(first.rows.n).toBe(1);
    expect(first.version).toBe("v1");

    h.advance(INHOUSE.ROOM_SNAPSHOT_MAX_AGE_MS - 1);
    expect((await h.cache.get()).rows.n).toBe(1);
    expect(h.load).toHaveBeenCalledTimes(1);

    // Exactly at the max age: rebuilt.
    h.advance(1);
    expect((await h.cache.get()).rows.n).toBe(2);

    // A new version: rebuilt at once, whatever the age.
    h.setVersion("v2");
    const next = await h.cache.get();
    expect(next.rows.n).toBe(3);
    expect(next.version).toBe("v2");
    expect(h.load).toHaveBeenCalledTimes(3);
  });

  it("uses the version it is handed instead of reading one", async () => {
    const h = harness();
    await h.cache.get("v1");
    h.setVersion("v9"); // the database moved, but this poll read v1
    expect((await h.cache.get("v1")).rows.n).toBe(1);
    expect((await h.cache.get("v9")).rows.n).toBe(2);
  });

  it("ten concurrent misses share one load", async () => {
    const h = harness();
    const entries = await Promise.all(
      Array.from({ length: 10 }, () => h.cache.get()),
    );
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(new Set(entries).size).toBe(1);
  });

  it("a local publish stops the entry at once, before the version moves", async () => {
    const h = harness();
    await h.cache.get();
    h.publishLocally(); // say the statement itself failed: same version
    expect((await h.cache.get()).rows.n).toBe(2);
    expect((await h.cache.get()).rows.n).toBe(2);
  });

  it("a load that started before a local publish is never stored", async () => {
    const h = harness();
    const gate = deferred<Rows>();
    h.load.mockImplementationOnce(() => gate.promise);
    const stale = h.cache.get("v1");
    expect(h.load).toHaveBeenCalledTimes(1); // the load is under way
    h.publishLocally();
    gate.resolve({ n: 100, list: [] });
    // The poll that started first is answered with what it read…
    expect((await stale).rows.n).toBe(100);
    // …but nothing after the publish ever sees it.
    const after = await h.cache.get();
    expect(after.rows.n).not.toBe(100);
    expect((await h.cache.get()).rows.n).toBe(after.rows.n);
  });

  it("an older-started load never replaces a newer entry", async () => {
    const h = harness();
    const slow = deferred<Rows>();
    h.load.mockImplementationOnce(() => slow.promise);
    const older = h.cache.get("v1");
    // A newer version's load starts and stores while the old one is out.
    const newer = await h.cache.get("v2");
    expect(newer.version).toBe("v2");
    slow.resolve({ n: 100, list: [] });
    await older;
    const served = await h.cache.get("v2");
    expect(served).toBe(newer);
  });

  it("never caches a rejected load, and the next poll retries", async () => {
    const h = harness();
    h.load.mockRejectedValueOnce(new Error("db down"));
    await expect(h.cache.get()).rejects.toThrow("db down");
    const retried = await h.cache.get();
    expect(retried.rows.n).toBeGreaterThan(0);
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(await h.cache.get()).toBe(retried);
  });

  it("never stores rows read under no version (nothing published yet)", async () => {
    const h = harness();
    h.setVersion(null);
    const a = await h.cache.get();
    const b = await h.cache.get();
    expect(a.rows.n).toBe(1);
    expect(b.rows.n).toBe(2);
    // And nothing stored shows up once a version exists.
    h.setVersion("v1");
    expect((await h.cache.get()).rows.n).toBe(3);
  });

  it("freezes the stored rows outside production, deeply", async () => {
    const frozen = await harness().cache.get();
    expect(Object.isFrozen(frozen.rows)).toBe(true);
    expect(Object.isFrozen(frozen.rows.list)).toBe(true);
    expect(Object.isFrozen(frozen.rows.list[0])).toBe(true);
    expect(() => {
      (frozen.rows.list as { id: string }[]).push({ id: "x" });
    }).toThrow(TypeError);

    const loose = await harness({ freeze: false }).cache.get();
    expect(Object.isFrozen(loose.rows)).toBe(false);
  });

  it("deepFreeze survives cycles and Dates", () => {
    const a: { self?: unknown; at: Date } = { at: new Date(0) };
    a.self = a;
    expect(deepFreeze(a)).toBe(a);
    expect(Object.isFrozen(a.at)).toBe(true);
  });

  it("keeps heartbeat memory per entry, empty on every rebuild", async () => {
    const h = harness();
    const first = await h.cache.get();
    first.seenAt.set("u1", 123);
    expect((await h.cache.get()).seenAt.get("u1")).toBe(123);
    h.setVersion("v2");
    const rebuilt = await h.cache.get();
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.seenAt.size).toBe(0);
  });

  it("the reset seam forgets every cache", async () => {
    const h = harness();
    await h.cache.get();
    resetInhouseRoomCacheForTests();
    expect((await h.cache.get()).rows.n).toBe(2);
  });

  it("yields at inhouse.roomCache.beforeStore between the read and the store", async () => {
    const h = harness();
    let fired = false;
    setRaceHook(
      onceAt("inhouse.roomCache.beforeStore", async () => {
        fired = true;
        h.publishLocally(); // a rival commits and publishes here
      }),
    );
    const raced = await h.cache.get();
    expect(fired).toBe(true);
    // Not stored: the next poll loads again.
    expect((await h.cache.get()).rows.n).toBe(raced.rows.n + 1);
  });

  it("the max age stays far under the away cutoff", () => {
    expect(INHOUSE.ROOM_SNAPSHOT_MAX_AGE_MS).toBeLessThan(
      INHOUSE.QUEUE_AWAY_SECONDS * 1000 - INHOUSE.QUEUE_HEARTBEAT_SECONDS * 1000,
    );
  });
});
