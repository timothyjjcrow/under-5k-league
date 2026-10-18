// The link preview pictures' in-process cache (src/components/og-share-images.tsx).
// Drawing one costs about a second of the box's one vCPU, and no CDN keeps
// dynamic routes off the box (docs/DECISIONS.md, Hosting), so each process
// keeps a drawn picture for a while instead. Pure apart from the clock, which
// tests pass in.

import { createSingleFlight } from "./single-flight";

export type PictureCacheOptions<T> = {
  /** How long a kept value serves, counted from when its load started (its
   *  data was read then, so it is never served older than this). */
  ttlMs: number;
  /** The most values kept, and the most bytes they hold in all. Past either,
   *  the least recently served go first. */
  maxEntries: number;
  maxBytes: number;
  /** A value's size in bytes when it may be kept, or null when it must not
   *  be (a missing page, the league's fallback picture): only a drawn
   *  picture is worth keeping. */
  keepBytes: (value: T) => number | null;
  now?: () => number;
};

export type CachedValue<T> = {
  value: T;
  /** How long ago its data was read, for the response's Age header. */
  ageMs: number;
};

export type PictureCache<T> = {
  /**
   * The value kept under `key` while it is fresh, else `load`'s. Concurrent
   * misses for one key share a single load; a load that throws is never kept,
   * so the next request tries again.
   */
  get(key: string, load: () => Promise<T>): Promise<CachedValue<T>>;
};

type Entry<T> = { value: T; bytes: number; readAt: number };

export function createPictureCache<T>(
  options: PictureCacheOptions<T>,
): PictureCache<T> {
  const { ttlMs, maxEntries, maxBytes, keepBytes } = options;
  const now = options.now ?? Date.now;
  // A Map iterates in insertion order, and a hit is re-inserted, so the
  // first entry is always the least recently served.
  const kept = new Map<string, Entry<T>>();
  let keptBytes = 0;
  const loadOnce = createSingleFlight<{ value: T; readAt: number }>();

  function forget(key: string): void {
    const entry = kept.get(key);
    if (!entry) return;
    kept.delete(key);
    keptBytes -= entry.bytes;
  }

  function keep(key: string, value: T, readAt: number): void {
    const bytes = keepBytes(value);
    if (bytes === null || bytes > maxBytes || maxEntries < 1) return;
    forget(key);
    kept.set(key, { value, bytes, readAt });
    keptBytes += bytes;
    for (const oldest of kept.keys()) {
      if (kept.size <= maxEntries && keptBytes <= maxBytes) break;
      forget(oldest);
    }
  }

  return {
    async get(key, load) {
      const hit = kept.get(key);
      if (hit) {
        const ageMs = now() - hit.readAt;
        if (ageMs < ttlMs) {
          kept.delete(key);
          kept.set(key, hit);
          return { value: hit.value, ageMs: Math.max(0, ageMs) };
        }
        forget(key);
      }
      const loaded = await loadOnce(key, async () => {
        const readAt = now();
        const value = await load();
        keep(key, value, readAt);
        return { value, readAt };
      });
      return {
        value: loaded.value,
        ageMs: Math.max(0, now() - loaded.readAt),
      };
    },
  };
}
