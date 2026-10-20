// A short, size-bounded, in-process memo of built responses for public GETs
// that read the database and look the same to every caller (the calendar
// feed). It caps the database work of a route at one load per key per
// `ttlMs`, however many clients call and from wherever: on the box no edge
// cache sits in front (DECISIONS.md, 2026-10-15). Concurrent misses for one
// key share one load. Module scope, one copy per process, which the
// per-instance cache rule allows (a release's overlap runs two copies, each
// at most `ttlMs` stale). Only memoize what reads no cookie, session or
// header: an entry is served to everyone who asks for its key.

type Entry<T> = { expiresAt: number; value: Promise<T> };

export type ShortLivedMemo<T> = {
  /**
   * The value stored for `key` while it is younger than `ttlMs`, else
   * `load()`'s. A load that throws, or whose value `keep` refuses, is not
   * kept (the callers waiting on it still get its answer).
   */
  get(key: string, nowMs: number, load: () => Promise<T>): Promise<T>;
};

const memos = new Set<Map<string, unknown>>();

export function createShortLivedMemo<T>(opts: {
  ttlMs: number;
  maxEntries: number;
  keep?: (value: T) => boolean;
}): ShortLivedMemo<T> {
  const entries = new Map<string, Entry<T>>();
  memos.add(entries);

  // Drop a key's entry only while it is still this load's, never a newer one.
  const forget = (key: string, value: Promise<T>) => {
    if (entries.get(key)?.value === value) entries.delete(key);
  };

  return {
    get(key, nowMs, load) {
      const hit = entries.get(key);
      if (hit && nowMs < hit.expiresAt) return hit.value;
      if (hit) entries.delete(key);
      // Map order is insertion order, and every entry lives `ttlMs`, so the
      // oldest is also the first to expire: evict from the front for room.
      while (entries.size >= opts.maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      // The callbacks always run after `value` is stored below.
      const value: Promise<T> = (async () => load())().then(
        (loaded) => {
          if (opts.keep && !opts.keep(loaded)) forget(key, value);
          return loaded;
        },
        (error: unknown) => {
          forget(key, value);
          throw error;
        },
      );
      entries.set(key, { expiresAt: nowMs + opts.ttlMs, value });
      return value;
    },
  };
}

/** For tests only: empty every memo, so each case loads afresh. */
export function __clearShortLivedMemosForTests(): void {
  for (const entries of memos) entries.clear();
}
