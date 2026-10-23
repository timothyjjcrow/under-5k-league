import { INHOUSE } from "./constants";
import {
  createRoomWait,
  parseRoomHold,
  type RoomHoldRequest,
  type RoomStopSource,
  type RoomWake,
} from "./room-wait";

// The inhouse room's long-poll wait (POST /api/inhouse {action:"state",
// since}): a state request whose room version is still the one its client
// showed is held here until the room changes, its deadline, or its client
// goes away. The mechanism is room-wait.ts (shared with the draft room);
// this is its inhouse binding, with its own registry on globalThis and the
// INHOUSE timings. A leaf: nothing here reads the database itself (the
// version reader is passed in), so test/integration/setup.ts can reset it
// without loading anything a test file mocks.
//
// ONE REGISTRY PER PROCESS, on globalThis. A `next start` process loads
// src/lib twice (route handlers in one module instance, pages and server
// actions in another), so a registry in module scope would never hear a
// server action's publish (the signup save, the admin void). The publish
// count that fences each instance's room snapshot (inhouse-room-cache.ts)
// lives here too, for the same reason.

/** Why a held request ended. */
export type InhouseRoomWake = RoomWake;

// v3: `shuttingDown` and `stopInstalled` joined the registry (v2 added
// `landed`). A dev server's hot reload keeps an older shape on globalThis
// under its own key, where it can't be mistaken for this.
const wait = createRoomWait("ggd2l.inhouseRoomWait.v3", {
  coalesceMs: INHOUSE.LONG_POLL_COALESCE_MS,
  jitterMs: INHOUSE.LONG_POLL_JITTER_MS,
  watchMs: INHOUSE.LONG_POLL_WATCH_MS,
});

/** This process's publish count (the room snapshot's local fence). */
export function inhouseRoomGeneration(): number {
  return wait.generation();
}

/** A publish is about to run its statement (inhouse-room-version.ts). */
export function bumpInhouseRoomGeneration(): void {
  wait.bumpGeneration();
}

/**
 * Moves whenever a publish in this process starts its statement or finishes
 * it. Read BEFORE the version a held request compares with `since`
 * (waitForInhouseRoomChange's `mark`).
 */
export function inhouseRoomPublishMark(): number {
  return wait.publishMark();
}

/**
 * The process is stopping (SIGTERM): holds answer at once. A slot Caddy still
 * routes to keeps getting requests on its open connections until it exits,
 * so the route reports them unheld and the room backs off to its ladder
 * instead of re-polling every second.
 */
export function inhouseRoomShuttingDown(): boolean {
  return wait.shuttingDown();
}

/** Held requests in this process, for tests and diagnostics. */
export function heldInhouseRoomRequests(): number {
  return wait.held();
}

/**
 * A random wait in [0, LONG_POLL_JITTER_MS], whole milliseconds. `random`
 * is Math.random's contract (0 <= r < 1); anything outside it is clamped.
 */
export function inhouseRoomWakeJitterMs(random: () => number = Math.random): number {
  return wait.wakeJitterMs(random);
}

/**
 * A publish in this process has run its statement: re-check the version for
 * every held request, once, after LONG_POLL_COALESCE_MS. Called by
 * publishInhouseRoomChange after its INSERT, whether or not it succeeded (the
 * commit it announces happened either way). Never throws.
 */
export function wakeInhouseRoomWaiters(): void {
  wait.wakeWaiters();
}

/**
 * Hold a state request until the room version moves past `since`, `untilMs`,
 * the process starts stopping, or `signal` aborts. `mark` is
 * inhouseRoomPublishMark() read BEFORE the
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
  return wait.waitForChange(o);
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
  return wait.loadAsAnotherProcessForTests(load);
}

/**
 * Test-only: end every held request and stop the timers. The stop listener
 * stays installed (one per process, or a run's tests would stack them), and
 * a process a test stopped holds again.
 */
export function resetInhouseRoomWaitersForTests(): void {
  wait.resetForTests();
}

/**
 * Test-only: hear "stopping" from `source` instead of SIGTERM (null: SIGTERM
 * again). The next hold installs it, as the first hold in a process does.
 */
export function setInhouseRoomStopSourceForTests(source: RoomStopSource | null): void {
  wait.setStopSourceForTests(source);
}

/**
 * The hold a state request asks for: its client's version, how long, and
 * the server clock of the reply its client shows (`sinceNowMs`).
 */
export type InhouseHoldRequest = RoomHoldRequest;

/**
 * Read `since`, `holdMs` and `sinceNow` off a state request's body. No
 * usable `since` (absent, not a string, empty, or longer than any token)
 * means "answer at once", as every request was before the long-poll. The
 * hold is clamped to [0, LONG_POLL_HOLD_MS]; absent or unreadable, it is the
 * longest. `sinceNow` (the shown reply's `now`) is clamped to
 * [nowMs - 2 * LONG_POLL_HOLD_MS, nowMs]; absent or unreadable, it is
 * nowMs, and only clocks still ahead count. An old value can only make the
 * request answer at once, which leaving out `since` does anyway.
 */
export function parseInhouseHold(
  body: Record<string, unknown>,
  nowMs: number = Date.now(),
): InhouseHoldRequest | null {
  return parseRoomHold(body, INHOUSE.LONG_POLL_HOLD_MS, nowMs);
}
