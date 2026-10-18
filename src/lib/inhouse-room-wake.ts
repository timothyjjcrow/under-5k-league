import { INHOUSE, INHOUSE_STATUS } from "./constants";
import { inhouseDetectWindow } from "./inhouse";
import { inhouseRoomDue, type InhouseRoomDueInput } from "./inhouse-room-due";

// PURE: when a held state request (the room's long-poll) must answer on its
// own, because the room's reply changes with no write. No read, no write, no
// clock but the `nowMs` passed in.
//
// Each clock below is a boundary where a resolver's act condition flips
// (inhouseRoomDue mirrors them: the accept, vote and pick deadlines, the
// abandon floors, the queue's idle reset) or where the reply itself reads
// differently (a queued player turning away, a played game's result window
// opening the "Game over" button). The request wakes LONG_POLL_CLOCK_GRACE_MS
// after it, so the signed-in poll that wakes finds the work due. The
// automation gate (automation-gate.ts) schedules the worker on the same
// clocks; this is the room's copy, read from the room snapshot's rows.

const HOUR_MS = 3_600_000;

/**
 * The earliest time after `nowMs` a held request for this room should answer
 * by itself, or null when no clock is ahead. `maintains`: the viewer is signed
 * in, so their poll may run due work; when some is due already (another poll
 * holds the 2s claim), the request answers by LONG_POLL_DUE_RETRY_MS so work
 * nobody finished is retried. Signed-out requests never run it and wait for
 * the publish.
 */
export function inhouseRoomWakeAt(
  rows: InhouseRoomDueInput,
  nowMs: number,
  o: { maintains: boolean },
): number | null {
  let next = Infinity;
  const clock = (atMs: number | null | undefined) => {
    if (atMs == null || !Number.isFinite(atMs)) return;
    const wakeMs = atMs + INHOUSE.LONG_POLL_CLOCK_GRACE_MS;
    if (wakeMs > nowMs && wakeMs < next) next = wakeMs;
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
  return next === Infinity ? null : next;
}
