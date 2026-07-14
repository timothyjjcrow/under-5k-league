// Relative "time until match night" label. Pure + testable.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How long a match night plausibly runs — show "happening now" within it. */
export const LIVE_WINDOW_MS = 3 * HOUR;

/**
 * Short human label for how far away `target` is: "in 12 min", "in 5h 20m",
 * "in 2d 5h", "happening now" (within the live window after start), or null
 * once the night is clearly over.
 */
export function countdownLabel(targetMs: number, nowMs: number): string | null {
  const d = targetMs - nowMs;
  if (d <= -LIVE_WINDOW_MS) return null;
  if (d <= 0) return "happening now";
  if (d < HOUR) return `in ${Math.max(1, Math.ceil(d / MIN))} min`;
  if (d < DAY) {
    const h = Math.floor(d / HOUR);
    const m = Math.floor((d % HOUR) / MIN);
    return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  const days = Math.floor(d / DAY);
  const hours = Math.floor((d % DAY) / HOUR);
  return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
}

// --- Live-room clocks (auction bid/nomination, inhouse vote/pick/elapsed) ----
// The draft & inhouse rooms drive their countdowns off a SERVER deadline
// (epoch ms) corrected by `offsetMs` (= serverNow − clientNow, captured on each
// poll) so every viewer's clock agrees regardless of local skew. Pure so the
// tick math is unit-tested independently of the React tick.

/**
 * Whole seconds remaining until `endsAtMs`, corrected by clock skew `offsetMs`,
 * clamped to ≥ 0. Returns 0 when there is no active deadline (null/undefined) —
 * matching the rooms' "no clock running" state.
 */
export function secondsUntil(
  endsAtMs: number | null | undefined,
  offsetMs: number,
  nowMs: number,
): number {
  if (!endsAtMs) return 0;
  return Math.max(0, Math.ceil((endsAtMs - (nowMs + offsetMs)) / 1000));
}

/**
 * Milliseconds elapsed since `startedAtMs` (server epoch), corrected by
 * `offsetMs`; null when not started. Feeds the inhouse "game in progress" timer.
 */
export function elapsedSince(
  startedAtMs: number | null | undefined,
  offsetMs: number,
  nowMs: number,
): number | null {
  if (startedAtMs == null) return null;
  return nowMs + offsetMs - startedAtMs;
}
