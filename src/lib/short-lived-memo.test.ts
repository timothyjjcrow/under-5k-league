import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearShortLivedMemosForTests,
  createShortLivedMemo,
} from "./short-lived-memo";

const T0 = 1_000_000;

beforeEach(() => __clearShortLivedMemosForTests());

describe("createShortLivedMemo", () => {
  it("serves a kept value until its time is up, then loads afresh", async () => {
    const memo = createShortLivedMemo<string>({ ttlMs: 30_000, maxEntries: 10 });
    const load = vi.fn(async () => `built ${load.mock.calls.length}`);

    expect(await memo.get("league", T0, load)).toBe("built 1");
    expect(await memo.get("league", T0 + 29_999, load)).toBe("built 1");
    expect(load).toHaveBeenCalledTimes(1);
    expect(await memo.get("league", T0 + 30_000, load)).toBe("built 2");
    expect(await memo.get("league", T0 + 30_001, load)).toBe("built 2");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps each key apart", async () => {
    const memo = createShortLivedMemo<string>({ ttlMs: 30_000, maxEntries: 10 });
    expect(await memo.get("team:a", T0, async () => "a")).toBe("a");
    expect(await memo.get("team:b", T0, async () => "b")).toBe("b");
    expect(await memo.get("team:a", T0 + 1, async () => "stale a")).toBe("a");
  });

  it("gives concurrent misses for one key one load", async () => {
    const memo = createShortLivedMemo<string>({ ttlMs: 30_000, maxEntries: 10 });
    let finish!: (value: string) => void;
    const load = vi.fn(
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    const first = memo.get("league", T0, load);
    const second = memo.get("league", T0 + 5, load);
    finish("built once");
    expect(await Promise.all([first, second])).toEqual(["built once", "built once"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps no value its `keep` refuses, but still answers the callers waiting on it", async () => {
    const memo = createShortLivedMemo<string | null>({
      ttlMs: 30_000,
      maxEntries: 10,
      keep: (value) => value !== null,
    });
    expect(await memo.get("team:new", T0, async () => null)).toBeNull();
    // The team was created a moment later: its feed must not stay a 404.
    expect(await memo.get("team:new", T0 + 1, async () => "feed")).toBe("feed");
    expect(await memo.get("team:new", T0 + 2, async () => "rebuilt")).toBe("feed");
  });

  it("keeps no failed load, and the next caller tries again", async () => {
    const memo = createShortLivedMemo<string>({ ttlMs: 30_000, maxEntries: 10 });
    const failing = memo.get("league", T0, async () => {
      throw new Error("database unreachable");
    });
    await expect(failing).rejects.toThrow("database unreachable");
    expect(await memo.get("league", T0 + 1, async () => "built")).toBe("built");
  });

  it("turns a load that throws at once into a rejection", async () => {
    const memo = createShortLivedMemo<string>({ ttlMs: 30_000, maxEntries: 10 });
    const failing = memo.get("league", T0, () => {
      throw new Error("sync failure");
    });
    await expect(failing).rejects.toThrow("sync failure");
    expect(await memo.get("league", T0 + 1, async () => "built")).toBe("built");
  });

  it("holds at most maxEntries, dropping the oldest first", async () => {
    const memo = createShortLivedMemo<string>({ ttlMs: 30_000, maxEntries: 2 });
    await memo.get("a", T0, async () => "a1");
    await memo.get("b", T0 + 1, async () => "b1");
    await memo.get("c", T0 + 2, async () => "c1");
    // "a" was evicted to make room for "c"; "b" and "c" are still kept.
    expect(await memo.get("b", T0 + 3, async () => "b2")).toBe("b1");
    expect(await memo.get("c", T0 + 3, async () => "c2")).toBe("c1");
    expect(await memo.get("a", T0 + 3, async () => "a2")).toBe("a2");
    // Making room for "a" again evicted "b", the oldest left.
    expect(await memo.get("b", T0 + 4, async () => "b3")).toBe("b3");
  });

  it("is emptied by the test hook", async () => {
    const memo = createShortLivedMemo<string>({ ttlMs: 30_000, maxEntries: 10 });
    await memo.get("league", T0, async () => "before");
    __clearShortLivedMemosForTests();
    expect(await memo.get("league", T0 + 1, async () => "after")).toBe("after");
  });
});
