import { ROOM_POLL_FAIL_THRESHOLD } from "./constants";

/**
 * The live rooms' connection-health state machine, as a pure reducer.
 *
 * WHY IT LIVES HERE. `usePollHealth` (room-clock.tsx) is what stands between a
 * captain and a frozen auction that still looks live: at three consecutive
 * failures every control in the room disables and an aria-live strip says so.
 * That behaviour was reasoned about in comments and asserted nowhere — the
 * rooms have no unit-testable surface (the vitest env is `node`, with no
 * jsdom), so the hook's rule could only be exercised through a browser spec.
 * The rule itself needs no React at all, so it lives out here where a test can
 * state it directly.
 *
 * CONSECUTIVE is the whole subtlety. A flaky-but-alive connection alternating
 * ok/fail must never trip the gate — that would disable the room for someone
 * who is still talking to the server perfectly well half the time — while a
 * genuinely dead one must trip it and STAY tripped until a poll succeeds.
 */
export type PollHealth = {
  /** Consecutive failures since the last success. */
  fails: number;
  /** At/over the threshold: the room disables its controls and says so. */
  disconnected: boolean;
};

export const POLL_HEALTH_OK: PollHealth = { fails: 0, disconnected: false };

/**
 * Fold one poll outcome in. A success always clears — a room that had to
 * recover twice is not more fragile than one recovering for the first time.
 */
export function pollHealthAfter(
  prev: PollHealth,
  outcome: "ok" | "fail",
  threshold: number = ROOM_POLL_FAIL_THRESHOLD,
): PollHealth {
  if (outcome === "ok") return POLL_HEALTH_OK;
  const fails = prev.fails + 1;
  // `>=`, not `===`: the threshold can be crossed by a caller that resumes
  // from a higher count, and the flag must not un-set itself while failing.
  return { fails, disconnected: fails >= threshold };
}
