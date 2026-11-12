/**
 * How long after its start a scrim time can still be posted or claimed:
 * "tonight, an hour ago" is fine. The service and the Join button share it so
 * the page never offers a claim the service would refuse.
 */
export const SCRIM_PAST_GRACE_MS = 60 * 60 * 1000;

/** Shared ownership window for casual scrim result discovery. */
export const SCRIM_DETECT_WINDOW_BEFORE_MS = 12 * 60 * 60 * 1000;
export const SCRIM_DETECT_WINDOW_AFTER_MS = 36 * 60 * 60 * 1000;

export function isWithinScrimResultWindow(
  startTimeSeconds: number,
  scheduledAtMs: number,
): boolean {
  const gameStartMs = Number(startTimeSeconds) * 1000;
  return (
    Number.isFinite(gameStartMs) &&
    gameStartMs > 0 &&
    gameStartMs >= scheduledAtMs - SCRIM_DETECT_WINDOW_BEFORE_MS &&
    gameStartMs <= scheduledAtMs + SCRIM_DETECT_WINDOW_AFTER_MS
  );
}

/**
 * The league feed watches a booked scrim for its ticketed games from shortly
 * after its start (a Dota game can't be over sooner; the same 25 minutes as
 * AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF, which a test pins) until
 * SCRIM_FEED_CLOSES_AFTER_MS after it, or until the series is final.
 *
 * Much shorter than the 36-hour result window on purpose: on a night with no
 * league match the worker reads the feed every few minutes for the scrim
 * alone, and a booking nobody played must not keep it reading for a day and
 * a half. A game that lands later can still be added by its match ID.
 */
export const SCRIM_FEED_OPENS_AFTER_MS = 25 * 60 * 1000;
export const SCRIM_FEED_CLOSES_AFTER_MS = 8 * 60 * 60 * 1000;

export function scrimFeedWindow(scheduledAtMs: number): {
  opensAtMs: number;
  closesAtMs: number;
} {
  return {
    opensAtMs: scheduledAtMs + SCRIM_FEED_OPENS_AFTER_MS,
    closesAtMs: scheduledAtMs + SCRIM_FEED_CLOSES_AFTER_MS,
  };
}

/**
 * Keep only competing scrim kickoffs that could themselves own this candidate.
 * Proximity must never hand a game to a meeting whose result window rejects it:
 * doing so leaves the game importable on neither event.
 */
export function eligibleScrimMeetingKickoffs(
  startTimeSeconds: number,
  scheduledAtMs: readonly number[],
): number[] {
  return scheduledAtMs.filter((kickoffMs) =>
    isWithinScrimResultWindow(startTimeSeconds, kickoffMs),
  );
}
