// When automatic result import can't find a fixture's games, the captains —
// who can report them in one click on the match page — are the people to
// tell. Pure rules here; the worker step is result-nudge-service.ts.

import { AUTO_SYNC, MATCH_STATUS } from "./constants";

export const RESULT_NUDGE = {
  /** No games found this long after kickoff: nudge the captains. */
  HOURS_AFTER_KICKOFF: 4,
  /** A part-played series whose newest game ended this long ago is stuck. */
  HOURS_SINCE_LAST_GAME: 3,
  /**
   * Stuck behind a webhook outage for longer than this, the nudge is dropped
   * instead of posted late (the result has likely been sorted out by then).
   */
  EXPIRES_AFTER_HOURS: 6,
} as const;

const HOUR_MS = 3_600_000;

/** The parts of a fixture (and its imported games) the rule reads. */
export type NudgeFixture = {
  status: string;
  scheduledAt: Date | null;
  games: readonly {
    /** OpenDota start time, epoch SECONDS; 0 when unknown. */
    startTime: number;
    durationSecs: number;
    /** When we imported it: the fallback when the start time is unknown. */
    fetchedAt: Date;
  }[];
};

/**
 * When this fixture's captains become due a nudge, given the games imported
 * so far: HOURS_AFTER_KICKOFF past kickoff with no games, or, for a
 * part-played series, HOURS_SINCE_LAST_GAME after its newest game ended (and
 * never before HOURS_AFTER_KICKOFF). Null when no nudge can fall due from
 * `nowMs` on: the fixture is decided or unscheduled, or the automatic import's
 * window (WINDOW_HOURS after kickoff) closes first. It stops looking then, and
 * a fixture that old is an admin matter, not a nudge.
 *
 * The automation gate sleeps until this time, so it and resultNudgeReason
 * must never disagree: the reason is defined from it.
 */
export function resultNudgeDueAt(
  fixture: NudgeFixture,
  nowMs: number,
): number | null {
  if (!fixture.scheduledAt || fixture.status === MATCH_STATUS.COMPLETED) {
    return null;
  }
  const kickoffMs = fixture.scheduledAt.getTime();
  if (!Number.isFinite(kickoffMs)) return null;
  const closesAtMs = kickoffMs + AUTO_SYNC.WINDOW_HOURS * HOUR_MS;
  if (nowMs > closesAtMs) return null;
  const opensAtMs = kickoffMs + RESULT_NUDGE.HOURS_AFTER_KICKOFF * HOUR_MS;
  if (fixture.games.length === 0) return opensAtMs;
  const lastEndedMs = Math.max(
    ...fixture.games.map((game) =>
      game.startTime > 0
        ? (game.startTime + Math.max(0, game.durationSecs)) * 1000
        : game.fetchedAt.getTime(),
    ),
  );
  const dueAtMs = Math.max(
    opensAtMs,
    lastEndedMs + RESULT_NUDGE.HOURS_SINCE_LAST_GAME * HOUR_MS,
  );
  // NaN (an unreadable game time) fails this comparison too: never due.
  return dueAtMs <= closesAtMs ? dueAtMs : null;
}

/**
 * Why this fixture's captains should be asked to report it, or null.
 *
 * "missing": no games at all, HOURS_AFTER_KICKOFF past kickoff.
 * "stalled": some games imported, but the series is still open and its
 * newest game ended HOURS_SINCE_LAST_GAME ago (a Bo3 stuck at 1-0).
 *
 * Only inside the automatic import's own window (see resultNudgeDueAt).
 * Unscheduled fixtures are never scanned, so they are never nudged either.
 */
export function resultNudgeReason(
  fixture: NudgeFixture,
  nowMs: number,
): "missing" | "stalled" | null {
  const dueAtMs = resultNudgeDueAt(fixture, nowMs);
  if (dueAtMs === null || nowMs < dueAtMs) return null;
  return fixture.games.length === 0 ? "missing" : "stalled";
}
