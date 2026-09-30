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

/**
 * Has `targetMs` gone by — i.e. is it far enough past that `countdownLabel`
 * goes quiet? The two are the SAME boundary and `countdown.test.ts` pins that
 * they agree at every offset, because a caller that renders a "this has passed"
 * state needs to know WHY the label vanished.
 *
 * Nothing else returns null, so inferring "passed" from `countdownLabel() ===
 * null` works today — and would quietly start lying the first time the label
 * gains another quiet case. A scheduled date that has been and gone is the one
 * state that must never render as an upcoming plan.
 */
export function hasPassed(targetMs: number, nowMs: number): boolean {
  return targetMs - nowMs <= -LIVE_WINDOW_MS;
}

/**
 * A kickoff countdown split into whole units, for the segmented clock on a
 * match page ("2 d 05 h 12 m 33 s"). "now" runs through the same live window
 * as `countdownLabel`'s "happening now"; "over" is past it, where the clock
 * hides. Seconds round UP, so the clock reads 00:00:01 in the last second and
 * never 00:00:00 before kickoff.
 */
export type KickoffClock =
  | {
      state: "upcoming";
      days: number;
      hours: number;
      minutes: number;
      seconds: number;
    }
  | { state: "now" }
  | { state: "over" };

export function kickoffClock(targetMs: number, nowMs: number): KickoffClock {
  const d = targetMs - nowMs;
  if (d <= -LIVE_WINDOW_MS) return { state: "over" };
  if (d <= 0) return { state: "now" };
  const total = Math.ceil(d / 1000);
  return {
    state: "upcoming",
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3_600),
    minutes: Math.floor((total % 3_600) / 60),
    seconds: total % 60,
  };
}

/**
 * What a screen reader hears for the clock, to the minute: "2 days, 5 hours
 * and 12 minutes". The seconds stay visual; a label that changed every
 * second would be noise.
 */
export function kickoffClockSpoken(
  clock: Extract<KickoffClock, { state: "upcoming" }>,
): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [
    clock.days > 0 ? unit(clock.days, "day") : null,
    clock.days > 0 || clock.hours > 0 ? unit(clock.hours, "hour") : null,
    unit(
      clock.days === 0 && clock.hours === 0
        ? Math.max(1, clock.minutes + (clock.seconds > 0 ? 1 : 0))
        : clock.minutes,
      "minute",
    ),
  ].filter((part): part is string => part !== null);
  return parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
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

/** A whole second — the smallest change any of these countdowns can render. */
export const CLOCK_OFFSET_STEP_MS = 1000;

/**
 * The offset above, folded across polls: adopt a newly measured skew only when
 * it MOVES by at least a whole second, otherwise keep the previous value
 * IDENTICALLY.
 *
 * Both halves matter and both are load-bearing. `serverNow - clientNow` jitters
 * by a few milliseconds on every poll, and the offset is React state feeding
 * every clock in the room — so adopting each measurement would re-render the
 * room and its player pool on every poll, undoing the leaf-clock optimisation
 * these functions exist for. Returning the SAME number (not a recomputed equal
 * one) is what lets React's same-value setState bail out.
 *
 * The floor is a whole second because nothing here can render finer: no
 * sub-second change is observable, so adopting one buys nothing.
 */
export function nextClockOffset(
  prev: number,
  serverNowMs: number,
  clientNowMs: number,
  stepMs: number = CLOCK_OFFSET_STEP_MS,
): number {
  const skew = serverNowMs - clientNowMs;
  return Math.abs(prev - skew) >= stepMs ? skew : prev;
}
