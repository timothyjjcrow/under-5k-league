// Pure helpers for surfacing outstanding results and gating the playoffs on a
// fully-entered regular season. DB-free so they're unit-testable.

import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import { matchResultsOpen } from "./league-lifecycle";

export type WeekStatus = {
  week: number;
  total: number;
  completed: number;
  pending: number;
};

export type RegularStatus = {
  total: number;
  completed: number;
  pending: number;
  /** True when there is a schedule and every regular-season match is entered. */
  allComplete: boolean;
  weeks: WeekStatus[];
  pendingWeeks: number[];
};

type MatchLike = { week: number; phase: string; status: string };

/**
 * Per-week and overall completion of the regular season. Used to warn admins /
 * captains about missing results and to block starting the playoffs on an
 * incomplete (and therefore mis-seeded) standings table.
 */
export function regularSeasonStatus(matches: MatchLike[]): RegularStatus {
  const byWeek = new Map<number, WeekStatus>();
  for (const m of matches) {
    if (m.phase !== MATCH_PHASE.REGULAR) continue;
    const w =
      byWeek.get(m.week) ??
      { week: m.week, total: 0, completed: 0, pending: 0 };
    w.total++;
    if (m.status === MATCH_STATUS.COMPLETED) w.completed++;
    else w.pending++;
    byWeek.set(m.week, w);
  }
  const weeks = [...byWeek.values()].sort((a, b) => a.week - b.week);
  const total = weeks.reduce((n, w) => n + w.total, 0);
  const completed = weeks.reduce((n, w) => n + w.completed, 0);
  const pending = total - completed;
  return {
    total,
    completed,
    pending,
    allComplete: total > 0 && pending === 0,
    weeks,
    pendingWeeks: weeks.filter((w) => w.pending > 0).map((w) => w.week),
  };
}

/** A short human summary of what's outstanding, e.g. for a toast/banner. */
export function pendingResultsMessage(status: RegularStatus): string | null {
  if (status.pending === 0) return null;
  const m = status.pending === 1 ? "match" : "matches";
  const w = status.pendingWeeks.length === 1 ? "week" : "weeks";
  return `${status.pending} regular-season ${m} still ${
    status.pending === 1 ? "needs" : "need"
  } results (${w} ${status.pendingWeeks.join(", ")}).`;
}

/**
 * The Standings card's one-line caption, decided by what has been PLAYED
 * rather than by the phase name: a table of zeros is never "final", and the
 * table stops being a race once every regular result is in (or the playoffs
 * have started).
 */
export function standingsCaption({
  status,
  postseason,
  bracketSize,
  eligibleTeams,
}: {
  status: RegularStatus;
  postseason: boolean;
  bracketSize: number;
  eligibleTeams: number;
}): string {
  const places =
    bracketSize > 0
      ? `${bracketSize} playoff place${bracketSize === 1 ? "" : "s"}`
      : null;
  if (status.completed === 0)
    return ["No results yet", places].filter(Boolean).join(" · ");
  if (status.allComplete || postseason) return "Final regular-season table";
  return [places, `${eligibleTeams} eligible teams`]
    .filter(Boolean)
    .join(" · ");
}

type TimedMatchLike = MatchLike & { scheduledAt: Date | null };

/**
 * Regular fixtures whose result is actually due: live, or past kickoff with
 * no result yet. A fixture weeks in the future is still to play, not
 * "missing a result", so counting every unplayed match told admins on day
 * one to enter scores for games nobody had played.
 */
export function regularResultsDue<M extends TimedMatchLike>(
  matches: M[],
  nowMs: number,
): M[] {
  return matches.filter(
    (m) =>
      m.phase === MATCH_PHASE.REGULAR &&
      m.status !== MATCH_STATUS.COMPLETED &&
      (m.status === MATCH_STATUS.LIVE ||
        (m.scheduledAt != null && m.scheduledAt.getTime() <= nowMs)),
  );
}

/** The next regular fixture still to kick off: its week and kickoff. */
export function nextRegularKickoff(
  matches: TimedMatchLike[],
  nowMs: number,
): { week: number; at: Date } | null {
  let next: { week: number; at: Date } | null = null;
  for (const m of matches) {
    if (
      m.phase !== MATCH_PHASE.REGULAR ||
      m.status !== MATCH_STATUS.SCHEDULED ||
      m.scheduledAt == null ||
      m.scheduledAt.getTime() <= nowMs
    ) {
      continue;
    }
    const at = m.scheduledAt.getTime();
    if (
      !next ||
      at < next.at.getTime() ||
      (at === next.at.getTime() && m.week < next.week)
    ) {
      next = { week: m.week, at: m.scheduledAt };
    }
  }
  return next;
}

type ReportableMatch = {
  phase: string;
  status: string;
  scheduledAt: Date | null;
  homeTeamId: string;
  awayTeamId: string;
};

/**
 * A fixture whose result never came through: it kicked off before
 * `freshFrom` (the end of the automatic result-sync window) and not a single
 * game is recorded. Schedule marks these "Awaiting result".
 */
export function resultOverdue(
  match: Pick<ReportableMatch, "status" | "scheduledAt">,
  freshFrom: number,
): boolean {
  return (
    match.status === MATCH_STATUS.SCHEDULED &&
    match.scheduledAt != null &&
    match.scheduledAt.getTime() < freshFrom
  );
}

/**
 * The overdue fixtures a viewer should report themselves, oldest kickoff
 * first: they captain one of the two teams, and captains can still report
 * that match in the league's current phase (the match page's report card
 * uses the same phase rule).
 */
export function captainOverdueResults<M extends ReportableMatch>(
  matches: M[],
  captainTeamIds: ReadonlySet<string>,
  seasonStatus: string,
  freshFrom: number,
): M[] {
  if (captainTeamIds.size === 0) return [];
  return matches
    .filter(
      (m) =>
        (captainTeamIds.has(m.homeTeamId) ||
          captainTeamIds.has(m.awayTeamId)) &&
        resultOverdue(m, freshFrom) &&
        matchResultsOpen(seasonStatus, m.phase),
    )
    .sort((a, b) => a.scheduledAt!.getTime() - b.scheduledAt!.getTime());
}
