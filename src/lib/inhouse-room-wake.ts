import { INHOUSE, INHOUSE_STATUS } from "./constants";
import { inhouseDetectWindow } from "./inhouse";
import { duelRoomClocks } from "./inhouse-duel";
import { inhouseRoomDue, type InhouseRoomDueInput } from "./inhouse-room-due";

// PURE: when a held state request (the room's long-poll) must answer on its
// own, because the room's reply changes with no write. No read, no write, no
// clock but the `nowMs` passed in.
//
// Each clock below is a boundary where a resolver's act condition flips
// (inhouseRoomDue mirrors them: the accept, vote and pick deadlines, the
// abandon floors, the queue's idle reset) or where the reply itself reads
// differently (a queued player turning away, a played game's result window
// opening the "Game over" button, the viewer's post-game banner ending, the
// 1v1 block's queue expiries, presence and results window), or,
// for a signed-in viewer, where a throttled Discord board edit can be
// retried. The request wakes LONG_POLL_CLOCK_GRACE_MS after it, so the
// signed-in poll that wakes finds the work due. The automation gate
// (automation-gate.ts) schedules the worker on the same resolver and board
// clocks; this is the room's copy, read from the room snapshot's rows.
//
// Clocks count from the reply the client shows (`fromMs`, its `now`), not
// from the hold's start: one that ran out in between (a tab back from a
// hide, a request after a 429's back-off) means that reply is already
// stale, and the request answers at once.

const HOUR_MS = 3_600_000;

/** The room rows the wake reads: the due check's, and the recent results. */
export type InhouseRoomWakeInput = InhouseRoomDueInput & {
  /** Games completed inside the banner window (loadInhouseRoomRows). */
  recentResults?: readonly {
    completedAt: Date | null;
    players: readonly { userId: string }[];
  }[];
  /** The 1v1 rows (loadDuelRoomRows): their queue and duels. */
  duel?: Parameters<typeof duelRoomClocks>[0];
};

/**
 * The earliest time after `fromMs` a held request for this room should
 * answer by itself, or null when no clock is ahead. A time at or before
 * `nowMs` means a clock ran out after the reply the client shows: answer at
 * once.
 *
 * - `maintains`: the viewer is signed in, so their poll may run due work;
 *   when some is due already (another poll holds the 2s claim), the request
 *   answers by LONG_POLL_DUE_RETRY_MS so work nobody finished is retried.
 *   Signed-out requests never run it and wait for the publish.
 * - `fromMs`: the `now` of the reply the client shows (parseInhouseHold's
 *   `sinceNowMs`); absent, or later than `nowMs`, it is `nowMs`.
 * - `boardRetryAtMs`: when this instance's throttled board edit can be
 *   retried (boardRetryAtMs, inhouse-room-due.ts). Counted only for a
 *   viewer who `maintains`: only a signed-in poll checks the board.
 * - `viewerId`: the signed-in viewer, whose post-game banner (the newest
 *   game they played, LAST_RESULT_WINDOW_MS after it completed) ends on a
 *   clock too.
 */
export function inhouseRoomWakeAt(
  rows: InhouseRoomWakeInput,
  nowMs: number,
  o: {
    maintains: boolean;
    fromMs?: number;
    boardRetryAtMs?: number | null;
    viewerId?: string | null;
  },
): number | null {
  const fromMs = Math.min(nowMs, o.fromMs ?? nowMs);
  let next = Infinity;
  const clock = (atMs: number | null | undefined) => {
    if (atMs == null || !Number.isFinite(atMs)) return;
    const wakeMs = atMs + INHOUSE.LONG_POLL_CLOCK_GRACE_MS;
    if (wakeMs > fromMs && wakeMs < next) next = wakeMs;
  };
  const ms = (at: Date | null | undefined) => (at ? at.getTime() : null);

  if (o.maintains && inhouseRoomDue(rows, nowMs).length > 0) {
    next = nowMs + INHOUSE.LONG_POLL_DUE_RETRY_MS;
  }

  for (const l of rows.lobbies) {
    if (l.status === INHOUSE_STATUS.READY_CHECK) clock(ms(l.acceptEndsAt));
    else if (l.status === INHOUSE_STATUS.CAPTAIN_VOTE) clock(ms(l.voteEndsAt));
    else if (l.status === INHOUSE_STATUS.DRAFTING) clock(ms(l.pickEndsAt));
    else if (
      l.status === INHOUSE_STATUS.READY ||
      l.status === INHOUSE_STATUS.IN_PROGRESS
    ) {
      // The result window: "Game over" opens, and a READY game counts as
      // being played (inhouseReadyInPlay), on the reply's `now`.
      clock(
        inhouseDetectWindow({
          status: l.status,
          createdAtMs: l.createdAt.getTime(),
          startedAtMs: ms(l.startedAt),
        })?.opensAtMs,
      );
      // resolveAbandonedLobby's floors: strictly older than (lt).
      if (l.status === INHOUSE_STATUS.READY) {
        clock(l.createdAt.getTime() + INHOUSE.ABANDON_READY_HOURS * HOUR_MS + 1);
      } else if (l.startedAt) {
        clock(
          l.startedAt.getTime() + INHOUSE.ABANDON_IN_PROGRESS_HOURS * HOUR_MS + 1,
        );
      }
    }
  }
  for (const g of rows.pending) {
    if (g.finishedAt) {
      clock(
        g.finishedAt.getTime() +
          INHOUSE.ABANDON_AWAITING_RESULT_HOURS * HOUR_MS +
          1,
      );
    }
  }
  for (const q of rows.queue) {
    // The queue's idle reset (expireStaticQueue, strictly past), with the
    // legacy null deadline on the join.
    clock(
      q.idleExpiresAt
        ? q.idleExpiresAt.getTime() + 1
        : q.joinedAt.getTime() + INHOUSE.QUEUE_IDLE_HOURS * HOUR_MS + 1,
    );
    // Turning away (queuePresence: strictly more than the cutoff unseen).
    clock(q.lastSeenAt.getTime() + INHOUSE.QUEUE_AWAY_SECONDS * 1000 + 1);
  }
  if (o.viewerId) {
    for (const r of rows.recentResults ?? []) {
      // The banner shows while completedAt >= now - LAST_RESULT_WINDOW_MS
      // (buildInhouseState), so it is gone 1ms past the window.
      if (r.completedAt && r.players.some((p) => p.userId === o.viewerId)) {
        clock(r.completedAt.getTime() + INHOUSE.LAST_RESULT_WINDOW_MS + 1);
      }
    }
  }
  // The 1v1 block's own boundaries, for every viewer: a queue row's expiry,
  // a waiter turning away, a result leaving its window (duelRoomClocks).
  if (rows.duel) for (const at of duelRoomClocks(rows.duel)) clock(at);
  if (o.maintains) clock(o.boardRetryAtMs);
  return next === Infinity ? null : next;
}
