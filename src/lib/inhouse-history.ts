/**
 * Presentation helpers shared by the inhouse archive, recent-result cards and
 * player profiles. The lobby's `createdAt` is when the ten were pulled from
 * the queue, not when they played; OpenDota's match start is authoritative,
 * with the site's Start click and formation time retained as fallbacks for old
 * rows.
 */
export type InhouseTimeline = {
  matchStartTime: Date | null;
  startedAt: Date | null;
  createdAt: Date;
};

export function inhousePlayedAt(row: InhouseTimeline): Date {
  return row.matchStartTime ?? row.startedAt ?? row.createdAt;
}

export type InhouseCompletionTimeline = InhouseTimeline & {
  durationSecs: number | null;
  completedAt: Date | null;
};

/**
 * Best available game-end time for “last game” summaries. Valve's start plus
 * duration is authoritative when present; `completedAt` is the stable result
 * claim clock for legacy/incomplete boxes. Generic `updatedAt` is deliberately
 * excluded because settlement retries are operational work, not new games.
 */
export function inhouseEndedAt(row: InhouseCompletionTimeline): Date {
  const started = inhousePlayedAt(row);
  if (
    row.durationSecs != null &&
    Number.isFinite(row.durationSecs) &&
    row.durationSecs > 0
  ) {
    return new Date(started.getTime() + row.durationSecs * 1000);
  }
  return row.completedAt ?? started;
}

export const INHOUSE_HISTORY_PAGE_SIZE = 100;

/** Clamp a URL page number to the permanent archive's actual bounds. */
export function inhouseHistoryPage(
  raw: string | string[] | undefined,
  total: number,
  pageSize = INHOUSE_HISTORY_PAGE_SIZE,
): { page: number; pages: number; skip: number } {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = value && /^\d+$/.test(value) ? Number(value) : 1;
  const requested = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  const pages = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  const page = Math.min(requested, pages);
  return { page, pages, skip: (page - 1) * pageSize };
}
