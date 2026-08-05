// Pure timing logic for the automatic OpenDota result sync (the service with
// DB access lives in result-sync-service.ts). A match is "due" for a scan while
// it sits inside its post-kickoff detection window and hasn't been decided.

import { AUTO_SYNC, MATCH_STATUS } from "./constants";

const MINUTE_MS = 60_000;

/** Earliest instant a match's games could plausibly be on OpenDota. */
export function autoSyncOpensAt(scheduledAtMs: number): number {
  return scheduledAtMs + AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF * MINUTE_MS;
}

/** When automatic scanning gives up on a match (captains/admin take over). */
export function autoSyncClosesAt(scheduledAtMs: number): number {
  return scheduledAtMs + AUTO_SYNC.WINDOW_HOURS * 3600_000;
}

/**
 * Is this match inside its automatic-detection window? Unscheduled matches are
 * never auto-scanned (no kickoff → no way to window the roster scan, and the
 * existing per-night filter in autoDetectGamesForMatch needs scheduledAt too).
 */
export function isAutoSyncDue(
  match: { scheduledAt: Date | null; status: string },
  nowMs: number,
): boolean {
  if (match.status === MATCH_STATUS.COMPLETED) return false;
  if (!match.scheduledAt) return false;
  const t = match.scheduledAt.getTime();
  return nowMs >= autoSyncOpensAt(t) && nowMs <= autoSyncClosesAt(t);
}

/**
 * Seconds until a match may be rescanned, given how many consecutive scans
 * found nothing: exponential backoff, doubling per empty scan and capped at
 * MATCH_INTERVAL << BACKOFF_DOUBLINGS (≈4.3h). A stuck fixture (forfeit,
 * private match data) then costs ~15 scans over its whole 48h window instead
 * of ~700, while a productive match (attempts reset on import) stays brisk.
 */
export function autoSyncIntervalSeconds(
  attempts: number,
  minutesSinceOpen = Number.POSITIVE_INFINITY,
): number {
  // Backoff counts EMPTY scans, but the early ones are usually empty for a
  // boring reason: amateur league nights start late, so nothing is on OpenDota
  // yet. Letting those buy hours of silence meant a 2h-late start had its first
  // result land 1-4h after the games actually finished, and the Discord post
  // arrived in the middle of the night. Cap the doublings while the match is
  // still young; full backoff resumes afterwards so a genuinely dead fixture
  // (forfeit, private match data) still costs only a handful of scans.
  const cap =
    minutesSinceOpen < AUTO_SYNC.BACKOFF_GRACE_MINUTES
      ? AUTO_SYNC.BACKOFF_GRACE_DOUBLINGS
      : AUTO_SYNC.BACKOFF_DOUBLINGS;
  const doublings = Math.min(Math.max(0, attempts), cap);
  return AUTO_SYNC.MATCH_INTERVAL_SECONDS * 2 ** doublings;
}

/** Minutes a match has been inside its detection window (0 before it opens). */
export function minutesSinceAutoSyncOpen(
  scheduledAtMs: number,
  nowMs: number,
): number {
  return Math.max(0, (nowMs - autoSyncOpensAt(scheduledAtMs)) / MINUTE_MS);
}

/** Matches auto-synced before this instant may be claimed for a rescan. */
export function autoSyncClaimCutoff(
  nowMs: number,
  attempts = 0,
  minutesSinceOpen = Number.POSITIVE_INFINITY,
): Date {
  return new Date(
    nowMs - autoSyncIntervalSeconds(attempts, minutesSinceOpen) * 1000,
  );
}

/**
 * When a match becomes claimable for its next automatic scan (admin health
 * card). Null = never scanned yet, so it's claimable immediately.
 */
export function nextAutoSyncAt(
  autoSyncedAt: Date | null,
  attempts: number,
): Date | null {
  if (!autoSyncedAt) return null;
  return new Date(
    autoSyncedAt.getTime() + autoSyncIntervalSeconds(attempts) * 1000,
  );
}

/**
 * One step of the sitewide `<ResultSyncPing>` loop: given a `/api/sync`
 * response and the cursor baseline from previous responses, decide how long to
 * wait before the next ping, whether to `router.refresh()`, and the new
 * baseline. The component keeps the timer/fetch plumbing; this is the rule.
 *
 * `cursor` advancing is the normal production refresh signal: the scheduled
 * worker changes it and every parked viewer observes that change. `updated`
 * remains a compatible immediate-refresh signal for a trusted caller that
 * already knows its request committed work.
 *
 * The cursor baseline comes from the page's Server Component render, not the
 * first heartbeat response. That ordering is essential: if two first pings
 * race and another request wins the import claim after this page rendered,
 * the first response can already carry a newer cursor and must refresh. A null
 * baseline is meaningful (there was no
 * result yet), so the first non-null cursor is an advance. A null/absent
 * response cursor keeps the existing baseline rather than resetting it.
 */
export function syncPingStep(
  data: { updated?: boolean; watch?: boolean; cursor?: string | null },
  lastCursor: string | null,
): { delayMs: number; refresh: boolean; cursor: string | null } {
  const delayMs =
    (data.watch ? AUTO_SYNC.WATCH_POLL_SECONDS : AUTO_SYNC.IDLE_POLL_SECONDS) *
    1000;
  const cursor = data.cursor ?? null;
  const cursorAdvanced = cursor !== null && cursor !== lastCursor;
  return {
    delayMs,
    refresh: Boolean(data.updated) || cursorAdvanced,
    cursor: cursor ?? lastCursor,
  };
}
