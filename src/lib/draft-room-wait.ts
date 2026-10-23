import { DRAFT_ROOM } from "./constants";
import {
  createRoomWait,
  parseRoomHold,
  type RoomHoldRequest,
  type RoomStopSource,
  type RoomWake,
} from "./room-wait";

// The draft room's long-poll wait (POST /api/draft/tick with `since`): a
// tick whose room version is still the one its client showed is held here
// until the room changes, its deadline, or its client goes away. The
// mechanism is room-wait.ts (shared with the inhouse room); this is its
// draft binding, with its own registry on globalThis (a draft publish never
// wakes an inhouse hold, nor the reverse) and the DRAFT_ROOM timings. A
// leaf: nothing here reads the database itself (the version reader is
// passed in), so test/integration/setup.ts can reset it without loading
// anything a test file mocks.

/** Why a held request ended. */
export type DraftRoomWake = RoomWake;

const wait = createRoomWait("ggd2l.draftRoomWait.v1", {
  coalesceMs: DRAFT_ROOM.LONG_POLL_COALESCE_MS,
  jitterMs: DRAFT_ROOM.LONG_POLL_JITTER_MS,
  watchMs: DRAFT_ROOM.LONG_POLL_WATCH_MS,
});

/** This process's publish count (the room snapshot's local fence). */
export function draftRoomGeneration(): number {
  return wait.generation();
}

/** A publish is about to run its statement (draft-room-version.ts). */
export function bumpDraftRoomGeneration(): void {
  wait.bumpGeneration();
}

/**
 * Moves whenever a publish in this process starts its statement or finishes
 * it. Read BEFORE the version a held request compares with `since`
 * (waitForDraftRoomChange's `mark`).
 */
export function draftRoomPublishMark(): number {
  return wait.publishMark();
}

/**
 * The process is stopping (SIGTERM): holds answer at once, and the route
 * reports them unheld so the room backs off to its ladder while Caddy still
 * routes to this slot.
 */
export function draftRoomShuttingDown(): boolean {
  return wait.shuttingDown();
}

/** Held requests in this process, for tests and diagnostics. */
export function heldDraftRoomRequests(): number {
  return wait.held();
}

/**
 * A publish in this process has run its statement: re-check the version for
 * every held request, once, after LONG_POLL_COALESCE_MS. Called by
 * publishDraftRoomChange after its INSERT, whether or not it succeeded.
 * Never throws.
 */
export function wakeDraftRoomWaiters(): void {
  wait.wakeWaiters();
}

/**
 * Hold a tick until the room version moves past `since`, `untilMs`, the
 * process starts stopping, or `signal` aborts. `mark` is
 * draftRoomPublishMark() read BEFORE the caller read the version it compared
 * with `since`. `readToken` reads the current version as the client sees it
 * (draftRoomVersionToken). Resolves, never rejects; a wake other than
 * "aborted" comes after a random jitter (up to LONG_POLL_JITTER_MS).
 */
export function waitForDraftRoomChange(o: {
  since: string;
  mark: number;
  untilMs: number;
  signal?: AbortSignal;
  readToken: () => Promise<string>;
  nowMs?: number;
}): Promise<DraftRoomWake> {
  return wait.waitForChange(o);
}

/**
 * Test-only: run `load` (a dynamic import after vi.resetModules()) as a
 * second PROCESS would load it: its module copies make their own draft
 * registry (see room-wait.ts).
 */
export async function loadAsAnotherDraftProcessForTests<T>(
  load: () => Promise<T>,
): Promise<T> {
  return wait.loadAsAnotherProcessForTests(load);
}

/** Test-only: end every held request and stop the timers. */
export function resetDraftRoomWaitersForTests(): void {
  wait.resetForTests();
}

/** Test-only: hear "stopping" from `source` instead of SIGTERM. */
export function setDraftRoomStopSourceForTests(source: RoomStopSource | null): void {
  wait.setStopSourceForTests(source);
}

/** The hold a tick asks for (parseDraftHold). */
export type DraftHoldRequest = RoomHoldRequest;

/**
 * Read `since`, `holdMs` and `sinceNow` off a tick's body (parseRoomHold),
 * with the hold clamped to LONG_POLL_HOLD_MS. No usable `since` means
 * "answer at once", as every tick was before the long-poll.
 */
export function parseDraftHold(
  body: Record<string, unknown>,
  nowMs: number = Date.now(),
): DraftHoldRequest | null {
  return parseRoomHold(body, DRAFT_ROOM.LONG_POLL_HOLD_MS, nowMs);
}
