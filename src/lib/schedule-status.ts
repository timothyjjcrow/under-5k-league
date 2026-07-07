// Pure helpers for surfacing outstanding results and gating the playoffs on a
// fully-entered regular season. DB-free so they're unit-testable.

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
    if (m.phase !== "REGULAR") continue;
    const w =
      byWeek.get(m.week) ??
      { week: m.week, total: 0, completed: 0, pending: 0 };
    w.total++;
    if (m.status === "COMPLETED") w.completed++;
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
