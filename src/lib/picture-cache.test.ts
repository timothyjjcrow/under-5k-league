import { describe, expect, it, vi } from "vitest";
import { createPictureCache } from "./picture-cache";

const MINUTE = 60_000;

/** A cache over strings whose size is their length; "skip" is never kept. */
function cacheWith(
  overrides: { maxEntries?: number; maxBytes?: number } = {},
) {
  let clock = 1_000_000;
  const cache = createPictureCache<string>({
    ttlMs: 5 * MINUTE,
    maxEntries: overrides.maxEntries ?? 10,
    maxBytes: overrides.maxBytes ?? 1_000,
    keepBytes: (value) => (value === "skip" ? null : value.length),
    now: () => clock,
  });
  return {
    cache,
    advance(ms: number) {
      clock += ms;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("createPictureCache", () => {
  it("serves a kept value until its five minutes are up, then loads again", async () => {
    const { cache, advance } = cacheWith();
    const load = vi.fn(async () => "picture");
    expect(await cache.get("/matches/1", load)).toEqual({ value: "picture", ageMs: 0 });
    advance(5 * MINUTE - 1);
    expect(await cache.get("/matches/1", load)).toEqual({
      value: "picture",
      ageMs: 5 * MINUTE - 1,
    });
    expect(load).toHaveBeenCalledTimes(1);
    advance(1);
    expect(await cache.get("/matches/1", load)).toEqual({ value: "picture", ageMs: 0 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("counts the five minutes from when the load started reading", async () => {
    const { cache, advance } = cacheWith();
    const slow = deferred<string>();
    const started = deferred<void>();
    const first = cache.get("/teams/1", () => {
      started.resolve();
      return slow.promise;
    });
    await started.promise;
    advance(2 * MINUTE);
    slow.resolve("picture");
    expect(await first).toEqual({ value: "picture", ageMs: 2 * MINUTE });
    advance(3 * MINUTE);
    const load = vi.fn(async () => "redrawn");
    expect((await cache.get("/teams/1", load)).value).toBe("redrawn");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps one value per key", async () => {
    const { cache } = cacheWith();
    expect((await cache.get("/players/a", async () => "a")).value).toBe("a");
    expect((await cache.get("/players/b", async () => "b")).value).toBe("b");
    expect((await cache.get("/players/a", async () => "wrong")).value).toBe("a");
  });

  it("shares one load among concurrent misses for a key", async () => {
    const { cache } = cacheWith();
    const slow = deferred<string>();
    const load = vi.fn(() => slow.promise);
    const reads = [
      cache.get("/seasons/1", load),
      cache.get("/seasons/1", load),
      cache.get("/seasons/1", load),
    ];
    // A different key loads on its own.
    const other = vi.fn(async () => "other");
    expect((await cache.get("/seasons/2", other)).value).toBe("other");
    slow.resolve("picture");
    expect((await Promise.all(reads)).map((r) => r.value)).toEqual([
      "picture",
      "picture",
      "picture",
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("never keeps a failed load, and shares the failure with its waiters", async () => {
    const { cache } = cacheWith();
    const slow = deferred<string>();
    const failing = vi.fn(() => slow.promise);
    const reads = [cache.get("/matches/1", failing), cache.get("/matches/1", failing)];
    slow.reject(new Error("database unreachable"));
    for (const read of reads) {
      await expect(read).rejects.toThrow("database unreachable");
    }
    expect(failing).toHaveBeenCalledTimes(1);
    const load = vi.fn(async () => "picture");
    expect((await cache.get("/matches/1", load)).value).toBe("picture");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("never keeps a value keepBytes refuses (a 404, the league's fallback)", async () => {
    const { cache } = cacheWith();
    const load = vi.fn(async () => "skip");
    expect((await cache.get("/players/x", load)).value).toBe("skip");
    expect((await cache.get("/players/x", load)).value).toBe("skip");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("drops the least recently served value past the entry limit", async () => {
    const { cache } = cacheWith({ maxEntries: 2 });
    await cache.get("a", async () => "a");
    await cache.get("b", async () => "b");
    // Serving "a" makes "b" the least recently served.
    await cache.get("a", async () => "wrong");
    await cache.get("c", async () => "c");
    const reloads = vi.fn(async () => "again");
    expect((await cache.get("a", reloads)).value).toBe("a");
    expect((await cache.get("c", reloads)).value).toBe("c");
    expect(reloads).not.toHaveBeenCalled();
    expect((await cache.get("b", reloads)).value).toBe("again");
  });

  it("drops the least recently served values past the byte limit", async () => {
    const { cache } = cacheWith({ maxBytes: 10 });
    await cache.get("a", async () => "aaaa");
    await cache.get("b", async () => "bbbb");
    await cache.get("c", async () => "cccc");
    // 12 bytes is over 10, so "a", the oldest, went.
    const reloads = vi.fn(async (value: string) => value);
    expect((await cache.get("b", () => reloads("x"))).value).toBe("bbbb");
    expect((await cache.get("c", () => reloads("x"))).value).toBe("cccc");
    expect(reloads).not.toHaveBeenCalled();
    expect((await cache.get("a", () => reloads("aaaa"))).value).toBe("aaaa");
    expect(reloads).toHaveBeenCalledTimes(1);
    // Keeping "a" again pushed out "b", now the least recently served.
    expect((await cache.get("b", () => reloads("bbbb"))).value).toBe("bbbb");
    expect(reloads).toHaveBeenCalledTimes(2);
  });

  it("serves but never keeps a value bigger than the whole byte budget", async () => {
    const { cache } = cacheWith({ maxBytes: 4 });
    await cache.get("small", async () => "ok");
    const big = vi.fn(async () => "too big");
    expect((await cache.get("big", big)).value).toBe("too big");
    expect((await cache.get("big", big)).value).toBe("too big");
    expect(big).toHaveBeenCalledTimes(2);
    // The kept value survived the oversized one.
    const reload = vi.fn(async () => "wrong");
    expect((await cache.get("small", reload)).value).toBe("ok");
    expect(reload).not.toHaveBeenCalled();
  });

  it("replaces an expired value's bytes rather than adding to them", async () => {
    const { cache, advance } = cacheWith({ maxBytes: 8 });
    await cache.get("a", async () => "aaaa");
    advance(5 * MINUTE);
    // "a" expired: reloading it replaces its bytes rather than adding to them.
    await cache.get("a", async () => "AAAA");
    await cache.get("b", async () => "bbbb");
    const reload = vi.fn(async () => "wrong");
    expect((await cache.get("a", reload)).value).toBe("AAAA");
    expect((await cache.get("b", reload)).value).toBe("bbbb");
    expect(reload).not.toHaveBeenCalled();
  });
});
