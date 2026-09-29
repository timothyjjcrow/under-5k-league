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

/** A lobby player as the archive needs them: side, captaincy and name. */
export type InhouseHistorySidePlayer = {
  userId: string;
  team: number | null;
  isCaptain: boolean;
  name: string;
};

/**
 * Who a completed game was between, and how it went for the viewer.
 *
 * Sides are named after their captains ("Ember's team beat Wisp's team"),
 * which is how the ten players remember a game. `isCaptain` records who
 * captained the draft, while `team` is the side each player actually played
 * on (the result import can move a player who sat on the wrong side), so the
 * names are only given when each side has exactly one captain on it. Anything
 * else returns null names and the row keeps its plain Radiant/Dire label.
 *
 * `viewer` is "won"/"lost" only for a player who was in the game.
 */
export function inhouseHistorySides(
  players: InhouseHistorySidePlayer[],
  winnerTeam: number | null,
  viewerId: string | null,
): {
  winnerCaptain: string | null;
  loserCaptain: string | null;
  viewer: "won" | "lost" | null;
} {
  let winnerCaptain: string | null = null;
  let loserCaptain: string | null = null;
  if (winnerTeam != null) {
    const captainsOn = (won: boolean) =>
      players.filter(
        (p) => p.isCaptain && p.team != null && (p.team === winnerTeam) === won,
      );
    const winners = captainsOn(true);
    const losers = captainsOn(false);
    if (winners.length === 1 && losers.length === 1) {
      winnerCaptain = winners[0].name;
      loserCaptain = losers[0].name;
    }
  }
  const mine = viewerId ? players.find((p) => p.userId === viewerId) : null;
  const viewer =
    winnerTeam == null || mine?.team == null
      ? null
      : mine.team === winnerTeam
        ? "won"
        : "lost";
  return { winnerCaptain, loserCaptain, viewer };
}
