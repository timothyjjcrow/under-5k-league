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
