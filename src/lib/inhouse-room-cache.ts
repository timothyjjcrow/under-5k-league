import { raceHook } from "./race-hook";

// One server instance's copy of the inhouse room's viewer-independent rows
// (loadInhouseRoomRows), labelled with the room version (inhouse-room-
// version.ts). Generic over the rows and with every dependency injected, so
// it imports nothing of the engine: test/integration/setup.ts resets it
// without loading inhouse-service ahead of a test file's own vi.mock calls.
//
// Freshness is decided by the DATABASE version, read on every poll and read
// BEFORE the rows of any load: a poll serves only an entry whose label equals
// the version it has just read, so every change published before that read
// is in the reply, whichever instance made it. The rest only narrows it:
//
// - localGen: this instance's own publishes, which stop an entry (and any
//   load already running) at once, before the next version read;
// - gen: an older-started load never replaces a newer one;
// - maxAgeMs: a backstop for writers that never publish (admin display
//   edits, the worker's rank refresh) and for a lost publish.
//
// The rows hold every captain-vote ballot. They live in server memory only:
// never serialized, returned or logged; buildInhouseState is the one place
// they turn into a reply.

export type RoomCacheEntry<R> = {
  /** The version read before these rows. */
  readonly version: string;
  /** This instance's publish count when the load started. */
  readonly localGen: number;
  /** Load order on this instance: higher started later. */
  readonly gen: number;
  readonly builtAtMs: number;
  readonly rows: R;
  /**
   * Heartbeats this instance wrote against these rows (userId → ms): the
   * stored lastSeenAt is at least this, so the next poll need not ask again.
   */
  readonly seenAt: Map<string, number>;
};

export type RoomCacheDeps<R> = {
  readVersion: () => Promise<string | null>;
  load: () => Promise<R>;
  /** The local fence (inhouseRoomLocalGeneration). */
  localGen: () => number;
  now: () => number;
  maxAgeMs: number;
  /** Deep-freeze stored rows (outside production) to catch a mutation. */
  freeze: boolean;
};

export type RoomCache<R> = {
  /**
   * The rows for this poll: the stored entry when its label equals `version`
   * (read now when not given), this instance has not published since it was
   * built and it is younger than maxAgeMs; otherwise one shared load. A null
   * version loads fresh and stores nothing.
   */
  get(version?: string | null): Promise<RoomCacheEntry<R>>;
  /** Test-only: forget the entry and any load in flight. */
  reset(): void;
};

/** Freeze an object graph in place (plain objects and arrays; Dates too). */
export function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

const caches = new Set<{ reset(): void }>();

export function createRoomCache<R>(deps: RoomCacheDeps<R>): RoomCache<R> {
  let entry: RoomCacheEntry<R> | null = null;
  let nextGen = 0;
  // Single flight per (version, localGen): concurrent misses share one load.
  const inflight = new Map<string, Promise<RoomCacheEntry<R>>>();

  const fresh = (e: RoomCacheEntry<R>, version: string, nowMs: number) =>
    e.version === version &&
    e.localGen === deps.localGen() &&
    nowMs - e.builtAtMs < deps.maxAgeMs;

  async function build(
    version: string | null,
    localGen: number,
  ): Promise<RoomCacheEntry<R>> {
    const gen = ++nextGen;
    const builtAtMs = deps.now();
    const rows = await deps.load();
    const built: RoomCacheEntry<R> = {
      version: version ?? "",
      localGen,
      gen,
      builtAtMs,
      rows: deps.freeze ? deepFreeze(rows) : rows,
      seenAt: new Map(),
    };
    if (version === null) return built;
    // Seam: the rows are read and nothing is stored. A rival commit and
    // publish landing here must keep these rows from ever serving a poll
    // that starts after that publish.
    await raceHook("inhouse.roomCache.beforeStore");
    if (
      deps.localGen() === localGen &&
      (entry === null || gen > entry.gen)
    ) {
      entry = built;
    }
    return built;
  }

  const cache: RoomCache<R> = {
    async get(known) {
      const version = known === undefined ? await deps.readVersion() : known;
      if (version === null) return build(null, deps.localGen());
      if (entry && fresh(entry, version, deps.now())) return entry;
      const localGen = deps.localGen();
      const key = `${localGen}:${version}`;
      let pending = inflight.get(key);
      if (!pending) {
        pending = build(version, localGen).finally(() => {
          if (inflight.get(key) === pending) inflight.delete(key);
        });
        inflight.set(key, pending);
      }
      return pending;
    },
    reset() {
      entry = null;
      inflight.clear();
    },
  };
  caches.add(cache);
  return cache;
}

/** Test-only: forget every room snapshot (test/integration/setup.ts). */
export function resetInhouseRoomCacheForTests(): void {
  for (const cache of caches) cache.reset();
}
