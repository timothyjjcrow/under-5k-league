/**
 * The league feed's wait list (pure). An automatic `syncLeagueGames` pass
 * fails closed: when a feed game is in review, still in its retry backoff, or
 * its details failed this pass, no fixture imports anything from the feed,
 * because a partial newest-first buffer can't prove which games were the real
 * series. The worker records which games a pass waited on (Setting
 * `LEAGUE_FEED_WAIT`, written by `syncDueMatches`), so /admin can name them and
 * the automation gate can sleep to the earliest retry instead of waking the
 * worker for passes that can't make progress.
 */

/** Statuses that make automatic discovery wait (see `syncLeagueGames`). */
const WAITING_STATUSES = new Set(["NEEDS_REVIEW", "RETRYABLE"]);

/** The most game ids one record keeps; more is flagged, never trusted. */
export const LEAGUE_FEED_WAIT_MAX_IDS = 50;

export type LeagueFeedWait = {
  seasonId: string;
  /** The `LEAGUE_AUTO_SYNC_AT` stamp of the pass that recorded the list. */
  at: string;
  /** The feed games that pass waited on, in feed order. */
  ids: string[];
  /** The pass waited on more games than `ids` holds. */
  more: boolean;
};

/** The candidate columns the wait list is checked against. */
export type LeagueFeedWaitRow = {
  dotaMatchId: string;
  status: string;
  nextAttemptAt: Date | null;
};

export function serializeLeagueFeedWait(
  seasonId: string,
  atMs: number,
  ids: readonly string[],
): string {
  const unique = [...new Set(ids)];
  const wait: LeagueFeedWait = {
    seasonId,
    at: new Date(atMs).toISOString(),
    ids: unique.slice(0, LEAGUE_FEED_WAIT_MAX_IDS),
    more: unique.length > LEAGUE_FEED_WAIT_MAX_IDS,
  };
  return JSON.stringify(wait);
}

/** A malformed record reads as no record: nothing waits on it. */
export function parseLeagueFeedWait(
  raw: string | null | undefined,
): LeagueFeedWait | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.seasonId !== "string" ||
    typeof value.at !== "string" ||
    !Number.isFinite(Date.parse(value.at)) ||
    !Array.isArray(value.ids) ||
    value.ids.length > LEAGUE_FEED_WAIT_MAX_IDS ||
    !value.ids.every((id) => typeof id === "string" && /^\d{1,20}$/.test(id)) ||
    typeof value.more !== "boolean"
  ) {
    return null;
  }
  return {
    seasonId: value.seasonId,
    at: value.at,
    ids: value.ids as string[],
    more: value.more,
  };
}

/**
 * The recorded games that still hold the feed, in recorded order: each one's
 * candidate row is still in review or waiting to retry. A game an admin
 * retried or ignored, or that has since been imported (its row is deleted),
 * drops out at once, so /admin never names a game that no longer blocks.
 */
export function stillWaitingRows<Row extends LeagueFeedWaitRow>(
  wait: LeagueFeedWait | null,
  seasonId: string,
  rows: readonly Row[],
): Row[] {
  if (!wait || wait.seasonId !== seasonId) return [];
  const byId = new Map(rows.map((row) => [row.dotaMatchId, row]));
  return wait.ids.flatMap((id) => {
    const row = byId.get(id);
    return row && WAITING_STATUSES.has(row.status) ? [row] : [];
  });
}

/**
 * When the league feed can next make progress, if that is later than its
 * throttle: the earliest retry time of the games the last pass waited on.
 * Only a pass that kept its claim (`wait.at` is the current
 * `LEAGUE_AUTO_SYNC_AT`, so it stopped on nothing but these games) counts,
 * and only while every recorded game is still in retry backoff. A game in
 * review, one that cleared, a truncated list, a pass whose claim was rolled
 * back, or another season all return `null`: the feed keeps its ordinary
 * throttle and the worker wakes as usual.
 */
export function leagueFeedRetryAtMs(input: {
  wait: LeagueFeedWait | null;
  seasonId: string;
  throttleValue: string | undefined;
  rows: readonly LeagueFeedWaitRow[];
  nowMs: number;
}): number | null {
  const { wait } = input;
  if (
    !wait ||
    wait.seasonId !== input.seasonId ||
    wait.at !== input.throttleValue ||
    wait.more ||
    wait.ids.length === 0
  ) {
    return null;
  }
  const byId = new Map(input.rows.map((row) => [row.dotaMatchId, row]));
  let earliest = Number.POSITIVE_INFINITY;
  for (const id of wait.ids) {
    const row = byId.get(id);
    if (!row || row.status !== "RETRYABLE" || !row.nextAttemptAt) return null;
    const retryAt = row.nextAttemptAt.getTime();
    if (!Number.isSafeInteger(retryAt) || retryAt <= input.nowMs) return null;
    earliest = Math.min(earliest, retryAt);
  }
  return earliest;
}

const STATUS_LABEL: Record<string, string> = {
  NEEDS_REVIEW: "review needed",
  RETRYABLE: "waiting to retry",
};

function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The Automatic result sync card's line, naming each waiting game and the
 * Saved import progress controls that clear it.
 */
export function leagueFeedWaitText(rows: readonly LeagueFeedWaitRow[]): string {
  if (rows.length === 0) return "";
  const one = rows.length === 1;
  const games = joinWithAnd(
    rows.map(
      (row) =>
        `game ${row.dotaMatchId} (${STATUS_LABEL[row.status] ?? "waiting"})`,
    ),
  );
  const retrying = rows.some((row) => row.status === "RETRYABLE");
  return (
    `Automatic league-feed imports are waiting on ${games}: until ${one ? "it clears" : "they clear"}, ` +
    "no fixture imports a game from the league feed. " +
    (retrying ? "A game waiting to retry tries again on its own. " : "") +
    `Under Saved import progress, press Retry next sync to fetch ${one ? "it" : "a game"} again, ` +
    "or open Ignore this game and give a reason."
  );
}
