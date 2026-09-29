// Pure timing logic for the automatic OpenDota result sync (the service with
// DB access lives in result-sync-service.ts). A match is "due" for a scan while
// it sits inside its post-kickoff detection window and hasn't been decided.

import { AUTO_SYNC, MATCH_STATUS, SEASON_STATUS } from "./constants";

const MINUTE_MS = 60_000;

/** Earliest instant a match's games could plausibly be on OpenDota. */
export function autoSyncOpensAt(scheduledAtMs: number): number {
  return scheduledAtMs + AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF * MINUTE_MS;
}

/** When automatic scanning gives up on a match (captains/admin take over). */
export function autoSyncClosesAt(scheduledAtMs: number): number {
  return scheduledAtMs + AUTO_SYNC.WINDOW_HOURS * 3600_000;
}

/** When a league-ticket fixture may fall back to roster/player-id discovery. */
export function leagueFallbackOpensAt(scheduledAtMs: number): number {
  return (
    scheduledAtMs + AUTO_SYNC.LEAGUE_FALLBACK_MINUTES_AFTER_KICKOFF * MINUTE_MS
  );
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
 * The earliest instant, from `nowMs` on, at which a scanned match becomes
 * claimable for its next roster scan: the service's claim cutoff solved for
 * time. The young-match grace makes the interval jump once the grace ends, so
 * a young deadline that would only arrive after that jump no longer applies.
 * The automation gate sleeps to this; the admin panel prints it.
 */
export function nextRosterScanAt(
  scheduledAt: number,
  autoSyncedAt: number,
  attempts: number,
  nowMs: number,
): number {
  const graceEndsAt =
    autoSyncOpensAt(scheduledAt) + AUTO_SYNC.BACKOFF_GRACE_MINUTES * MINUTE_MS;
  if (nowMs < graceEndsAt) {
    const youngAt =
      autoSyncedAt + autoSyncIntervalSeconds(attempts, 0) * 1_000 + 1;
    // At graceEndsAt the service switches to its full backoff. If the young
    // deadline has not become strictly claimable before that discontinuity,
    // sleeping to it would wake the worker only to discover a longer delay.
    if (youngAt < graceEndsAt) return youngAt;
  }
  return (
    autoSyncedAt +
    autoSyncIntervalSeconds(
      attempts,
      minutesSinceAutoSyncOpen(scheduledAt, Math.max(nowMs, graceEndsAt)),
    ) *
      1_000 +
    1
  );
}

/** Consecutive empty scans from which the panel says the checks slowed down. */
export const AUTO_CHECK_BACKED_OFF_SCANS = 3;

/**
 * When the scheduled worker will next look for a match's games, or why it
 * won't. Mirrors syncDueMatches: only the Regular season and Playoffs run, a
 * fixture needs a kickoff, the window runs from MIN_MINUTES_AFTER_KICKOFF to
 * WINDOW_HOURS after it, a league-ticket season reads the league feed first and
 * scans player accounts only from the fallback (at once for a LIVE series),
 * and each scan backs off after empty ones.
 *
 * "due" means the next run may pick it: the worker scans one match per run,
 * stalest first, at most one every SCAN_GAP_SECONDS. "ending" means no
 * player-account scan falls inside the window any more.
 */
export type AutoCheck =
  | { kind: "none"; reason: "before-season" | "season-over" | "no-kickoff" }
  | { kind: "opens"; at: number }
  | { kind: "ended"; at: number }
  | { kind: "ending"; at: number; league: boolean }
  | { kind: "league-only"; fallbackAt: number }
  | { kind: "due"; league: boolean }
  | { kind: "next"; at: number; emptyScans: number; league: boolean };

/** Null for a finished match: there is nothing left to check. */
export function autoCheckStatus(
  match: {
    status: string;
    scheduledAt: Date | null;
    autoSyncedAt: Date | null;
    autoSyncAttempts: number;
  },
  season: { status: string; dotaLeagueId: string | null },
  nowMs: number,
): AutoCheck | null {
  if (match.status === MATCH_STATUS.COMPLETED) return null;
  if (
    season.status !== SEASON_STATUS.REGULAR_SEASON &&
    season.status !== SEASON_STATUS.PLAYOFFS
  ) {
    return {
      kind: "none",
      reason:
        season.status === SEASON_STATUS.COMPLETE
          ? "season-over"
          : "before-season",
    };
  }
  if (!match.scheduledAt) return { kind: "none", reason: "no-kickoff" };
  const kickoff = match.scheduledAt.getTime();
  const opensAt = autoSyncOpensAt(kickoff);
  const closesAt = autoSyncClosesAt(kickoff);
  if (nowMs > closesAt) return { kind: "ended", at: closesAt };
  if (nowMs < opensAt) return { kind: "opens", at: opensAt };
  const league = !!season.dotaLeagueId?.trim();
  if (league && match.status !== MATCH_STATUS.LIVE) {
    const fallbackAt = leagueFallbackOpensAt(kickoff);
    if (nowMs < fallbackAt) return { kind: "league-only", fallbackAt };
  }
  if (!match.autoSyncedAt) return { kind: "due", league };
  const at = nextRosterScanAt(
    kickoff,
    match.autoSyncedAt.getTime(),
    match.autoSyncAttempts,
    nowMs,
  );
  if (at <= nowMs) return { kind: "due", league };
  if (at > closesAt) return { kind: "ending", at: closesAt, league };
  return { kind: "next", at, emptyScans: match.autoSyncAttempts, league };
}

/**
 * The sentence for an AutoCheck, split around its one time so the page can
 * render that time on the viewer's clock: `lead`, the time, then `tail`.
 * `problem` marks the states no automatic check will fix by itself.
 */
export function autoCheckCopy(check: AutoCheck): {
  lead: string;
  at: number | null;
  tail: string;
  problem: boolean;
} {
  const feed = `League feed checks about every ${Math.round(AUTO_SYNC.LEAGUE_INTERVAL_SECONDS / 60)} minutes; `;
  switch (check.kind) {
    case "none":
      return {
        lead:
          check.reason === "no-kickoff"
            ? "Never checked automatically: this match has no kickoff time."
            : check.reason === "season-over"
              ? "No automatic checks: the season is complete."
              : "No automatic checks until the Regular season starts.",
        at: null,
        tail: "",
        problem: check.reason === "no-kickoff",
      };
    case "opens":
      return {
        lead: "First automatic check ",
        at: check.at,
        tail: ".",
        problem: false,
      };
    case "ended":
      return {
        lead: "Automatic checks ended ",
        at: check.at,
        tail: `, ${AUTO_SYNC.WINDOW_HOURS} hours after kickoff. Use Auto-fetch games, or paste the match ID and press Add game.`,
        problem: true,
      };
    case "ending":
      return {
        lead: check.league
          ? `${feed}no player-account check is left before the window closes `
          : "No automatic check is left before the window closes ",
        at: check.at,
        tail: ". Use Auto-fetch games if games are missing.",
        problem: false,
      };
    case "league-only":
      return {
        lead: `${feed}player accounts are checked too from `,
        at: check.fallbackAt,
        tail: ".",
        problem: false,
      };
    case "due":
      return {
        lead: check.league
          ? `${feed}a player-account check is due now.`
          : "Next automatic check: due now.",
        at: null,
        tail: "",
        problem: false,
      };
    case "next": {
      const slowed =
        check.emptyScans >= AUTO_CHECK_BACKED_OFF_SCANS
          ? ` (slowed down after ${check.emptyScans} checks found nothing)`
          : "";
      return {
        lead: check.league
          ? `${feed}next player-account check `
          : "Next automatic check ",
        at: check.at,
        tail: `${slowed}.`,
        problem: false,
      };
    }
  }
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
