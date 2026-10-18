import { INHOUSE } from "./constants";

// The inhouse room's long-poll wait (POST /api/inhouse {action:"state",
// since}): a state request whose room version is still the one its client
// showed is held here until the room changes, its deadline, or its client
// goes away. A leaf: nothing here reads the database itself (the version
// reader is passed in), so test/integration/setup.ts can reset it without
// loading anything a test file mocks.
//
// ONE REGISTRY PER PROCESS, on globalThis. A `next start` process loads
// src/lib twice (route handlers in one module instance, pages and server
// actions in another), so a registry in module scope would never hear a
// server action's publish (the signup save, the admin void). The publish
// count that fences each instance's room snapshot (inhouse-room-cache.ts)
// lives here too, for the same reason.
//
// A held request costs no database connection while it waits. Wakes are
// coalesced and jittered: a publish in this process re-checks the version
// once LONG_POLL_COALESCE_MS later (a mutation publishes twice), and each
// woken request then waits up to LONG_POLL_JITTER_MS more, so a room of
// viewers doesn't queue on Prisma's four connections at once. While anything
// is held, one timer re-reads the version every LONG_POLL_WATCH_MS: the other
// slot's publishes during a release's overlap, and writes made outside this
// process, reach a held request that way.
//
// A publish is counted twice, when it starts its statement (`generation`, the
// snapshot's fence) and when that statement has run (`landed`, in the wake).
// The route reads both (inhouseRoomPublishMark) before the version it
// compares with `since`, and a hold that finds either moved re-checks at
// once. So a publish that started before the route's read and finished
// before the hold registered (its wake then found nobody held) is still
// caught, without waiting for the watch.

/** Why a held request ended. */
export type InhouseRoomWake =
  /** The room version moved past the client's. */
  | "changed"
  /** The deadline: the hold's end, or the room's next clock. */
  | "deadline"
  /** The client went away; nobody reads the reply. */
  | "aborted";

type Waiter = {
  since: string;
  settle: (wake: InhouseRoomWake) => void;
};

type Registry = {
  /** Publishes started in this process (bumped before each statement). */
  generation: number;
  /** Publishes whose statement has run, landed or not (bumped by the wake). */
  landed: number;
  waiters: Set<Waiter>;
  /** The latest version reader a waiter brought (the watch's and re-check's). */
  readToken: (() => Promise<string>) | null;
  /** A coalesced re-check queued by a publish. */
  recheck: ReturnType<typeof setTimeout> | null;
  /** The watch timer, running while any request is held. */
  watch: ReturnType<typeof setInterval> | null;
  /** A version read in flight (reads never overlap). */
  reading: boolean;
  /** A check was asked for during that read: run one more after it. */
  again: boolean;
};

// v2: `landed` joined the registry. A dev server's hot reload keeps the
// older shape on globalThis under v1, where it can't be mistaken for this.
const REGISTRY_KEY = Symbol.for("ggd2l.inhouseRoomWait.v2");

/**
 * This module instance's registry: the one already on globalThis, or a new
 * one put there. Taken once, at load, so every module instance in a process
 * shares it, and a test that removes the key before loading a second copy of
 * the modules gets a second "process".
 */
const registry: Registry = (() => {
  const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  g[REGISTRY_KEY] ??= {
    generation: 0,
    landed: 0,
    waiters: new Set(),
    readToken: null,
    recheck: null,
    watch: null,
    reading: false,
    again: false,
  };
  return g[REGISTRY_KEY];
})();

/** This process's publish count (the room snapshot's local fence). */
export function inhouseRoomGeneration(): number {
  return registry.generation;
}

/** A publish is about to run its statement (inhouse-room-version.ts). */
export function bumpInhouseRoomGeneration(): void {
  registry.generation += 1;
}

/**
 * Moves whenever a publish in this process starts its statement or finishes
 * it. Read BEFORE the version a held request compares with `since`
 * (waitForInhouseRoomChange's `mark`).
 */
export function inhouseRoomPublishMark(): number {
  return registry.generation + registry.landed;
}

/** Held requests in this process, for tests and diagnostics. */
export function heldInhouseRoomRequests(): number {
  return registry.waiters.size;
}

/**
 * A random wait in [0, LONG_POLL_JITTER_MS], whole milliseconds. `random`
 * is Math.random's contract (0 <= r < 1); anything outside it is clamped.
 */
export function inhouseRoomWakeJitterMs(random: () => number = Math.random): number {
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(r * INHOUSE.LONG_POLL_JITTER_MS);
}

function stopWatchIfIdle(): void {
  if (registry.waiters.size > 0) return;
  if (registry.watch) clearInterval(registry.watch);
  registry.watch = null;
}

/**
 * Read the version once and wake every held request it has moved past.
 * Never throws: a failed read leaves them held for the next check.
 */
async function recheckVersion(): Promise<void> {
  const read = registry.readToken;
  if (!read || registry.waiters.size === 0) return;
  if (registry.reading) {
    // That read may have started before the statement this check is for.
    registry.again = true;
    return;
  }
  registry.reading = true;
  try {
    const token = await read();
    for (const waiter of [...registry.waiters]) {
      if (waiter.since !== token) waiter.settle("changed");
    }
  } catch {
    // The next watch tick (or publish) tries again.
  } finally {
    registry.reading = false;
  }
  if (registry.again) {
    registry.again = false;
    await recheckVersion();
  }
}

function startWatch(): void {
  if (registry.watch) return;
  registry.watch = setInterval(() => {
    void recheckVersion();
  }, INHOUSE.LONG_POLL_WATCH_MS);
  // Never keep a process (or a test run) alive for this.
  registry.watch.unref?.();
}

function queueRecheck(): void {
  if (registry.recheck || registry.waiters.size === 0) return;
  registry.recheck = setTimeout(() => {
    registry.recheck = null;
    void recheckVersion();
  }, INHOUSE.LONG_POLL_COALESCE_MS);
  registry.recheck.unref?.();
}

/**
 * A publish in this process has run its statement: re-check the version for
 * every held request, once, after LONG_POLL_COALESCE_MS. Called by
 * publishInhouseRoomChange after its INSERT, whether or not it succeeded (the
 * commit it announces happened either way). Never throws.
 */
export function wakeInhouseRoomWaiters(): void {
  // Counted even with nothing held: a request that read the version before
  // this statement landed may be about to register (inhouseRoomPublishMark).
  registry.landed += 1;
  queueRecheck();
}

/**
 * Hold a state request until the room version moves past `since`, `untilMs`,
 * or `signal` aborts. `mark` is inhouseRoomPublishMark() read BEFORE the
 * caller read the version it compared with `since`: when it has moved by
 * registration, a publish in this process started or finished around that
 * read, which may have missed it, so the hold re-checks at once instead of
 * trusting it. `readToken` reads the current version as the client sees it
 * (inhouseRoomVersionToken). Resolves, never rejects; a wake other than
 * "aborted" comes after a random jitter.
 */
export function waitForInhouseRoomChange(o: {
  since: string;
  mark: number;
  untilMs: number;
  signal?: AbortSignal;
  readToken: () => Promise<string>;
  nowMs?: number;
}): Promise<InhouseRoomWake> {
  if (o.signal?.aborted) return Promise.resolve("aborted");
  const nowMs = o.nowMs ?? Date.now();
  return new Promise<InhouseRoomWake>((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => waiter.settle("aborted");
    const waiter: Waiter = {
      since: o.since,
      settle(wake) {
        if (settled) return;
        settled = true;
        registry.waiters.delete(waiter);
        if (deadline) clearTimeout(deadline);
        o.signal?.removeEventListener("abort", onAbort);
        stopWatchIfIdle();
        if (wake === "aborted") {
          resolve(wake);
          return;
        }
        const jitter = setTimeout(
          () => resolve(wake),
          inhouseRoomWakeJitterMs(),
        );
        jitter.unref?.();
      },
    };
    registry.waiters.add(waiter);
    registry.readToken = o.readToken;
    o.signal?.addEventListener("abort", onAbort, { once: true });
    deadline = setTimeout(
      () => waiter.settle("deadline"),
      Math.max(0, o.untilMs - nowMs),
    );
    deadline.unref?.();
    startWatch();
    // A publish started or finished since the caller's mark, around its
    // version read: re-check rather than hold on a version that may already
    // be stale.
    if (inhouseRoomPublishMark() !== o.mark) queueRecheck();
  });
}

/**
 * Test-only: run `load` (a dynamic import after vi.resetModules()) as a
 * second PROCESS would load it: the module copies it loads make their own
 * registry, so their publishes never reach this one's fence or held requests
 * (only the database is shared). This process's registry is back on
 * globalThis afterwards. A second module graph loaded without it shares this
 * process's registry, as a `next start` process's two instances do.
 */
export async function loadAsAnotherProcessForTests<T>(
  load: () => Promise<T>,
): Promise<T> {
  const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  const mine = g[REGISTRY_KEY];
  delete g[REGISTRY_KEY];
  try {
    return await load();
  } finally {
    g[REGISTRY_KEY] = mine;
  }
}

/** Test-only: end every held request and stop the timers. */
export function resetInhouseRoomWaitersForTests(): void {
  for (const waiter of [...registry.waiters]) waiter.settle("aborted");
  if (registry.recheck) clearTimeout(registry.recheck);
  registry.recheck = null;
  if (registry.watch) clearInterval(registry.watch);
  registry.watch = null;
  registry.reading = false;
  registry.again = false;
  registry.readToken = null;
}

/** The hold a state request asks for: its client's version, and how long. */
export type InhouseHoldRequest = { since: string; holdMs: number };

/**
 * Read `since` and `holdMs` off a state request's body. No usable `since`
 * (absent, not a string, empty, or longer than any token) means "answer at
 * once", as every request was before the long-poll. The hold is clamped to
 * [0, LONG_POLL_HOLD_MS]; absent or unreadable, it is the longest.
 */
export function parseInhouseHold(
  body: Record<string, unknown>,
): InhouseHoldRequest | null {
  const since = body.since;
  if (typeof since !== "string" || since.length === 0 || since.length > 64) {
    return null;
  }
  const asked = body.holdMs;
  const holdMs =
    typeof asked === "number" && Number.isFinite(asked)
      ? Math.min(INHOUSE.LONG_POLL_HOLD_MS, Math.max(0, Math.round(asked)))
      : INHOUSE.LONG_POLL_HOLD_MS;
  return { since, holdMs };
}
