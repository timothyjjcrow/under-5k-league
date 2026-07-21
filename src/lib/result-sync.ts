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
export function autoSyncIntervalSeconds(attempts: number): number {
  const doublings = Math.min(Math.max(0, attempts), AUTO_SYNC.BACKOFF_DOUBLINGS);
  return AUTO_SYNC.MATCH_INTERVAL_SECONDS * 2 ** doublings;
}

/** Matches auto-synced before this instant may be claimed for a rescan. */
export function autoSyncClaimCutoff(nowMs: number, attempts = 0): Date {
  return new Date(nowMs - autoSyncIntervalSeconds(attempts) * 1000);
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
