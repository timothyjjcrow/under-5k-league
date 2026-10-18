import { INHOUSE, INHOUSE_STATUS } from "./constants";
import { freeGameSlot, queuePresence } from "./inhouse";
import type { InhouseBoardSyncOutcome } from "./inhouse-board-service";

// PURE rules for the room poll (inhouse-room-state.ts): is any resolver due,
// does this viewer's heartbeat need a write, and is a board check due. No
// read, no write, no clock but the `nowMs` passed in.
//
// The due check MIRRORS the resolvers' act conditions in inhouse-service.ts,
// with the same boundaries: a poll that finds nothing due skips the whole
// maintenance chain, so a clause missing here is a lobby that only the
// one-minute worker moves (and dev and e2e have no worker). Each clause names
// the code it mirrors. Where a resolver decides in JS, both call the one
// predicate below, so the two can never disagree; the claims' WHEREs stay
// the only enforcement point.

/** A clock that has run out by `nowMs` (deadline <= now). Null never runs out. */
export function inhouseClockDue(endsAt: Date | null, nowMs: number): boolean {
  return !!endsAt && endsAt.getTime() <= nowMs;
}

/**
 * Every player of a ready check has pressed ACCEPT. resolveReadyCheck flips
 * such a lobby into the captain vote whatever its clock says (the rescue when
 * two final accepts race), so an empty lobby never counts as all accepted.
 */
export function inhouseAllAccepted(
  players: readonly { acceptedAt: Date | null }[],
): boolean {
  return players.length > 0 && players.every((p) => p.acceptedAt);
}

/** Every player has cast a captain-vote ballot (resolveCaptainVote). */
export function inhouseAllVoted(
  players: readonly { votedMethod: string | null }[],
): boolean {
  return players.length > 0 && players.every((p) => p.votedMethod);
}

/** The players still in a draft's pool: on no team yet (resolveStalledPick). */
export function inhouseDraftPool<T extends { team: number | null }>(
  players: readonly T[],
): T[] {
  return players.filter((p) => p.team === null);
}

export type InhouseRoomDueReason =
  | "abandon"
  | "queueExpired"
  | "formation"
  | "readyCheck"
  | "captainVote"
  | "pickTurnLost"
  | "pickClock";

/**
 * The resolver each reason wakes, as named in getInhouseState's chain. Kept
 * as names so a source guard (inhouse-resolver-parity.test.ts) can hold the
 * chain and this table to the same set.
 */
export const REASON_RESOLVER: Record<InhouseRoomDueReason, string> = {
  abandon: "resolveAbandonedLobby",
  queueExpired: "maybeFormLobby",
  formation: "maybeFormLobby",
  readyCheck: "resolveReadyCheck",
  captainVote: "resolveCaptainVote",
  pickTurnLost: "resolveStalledPick",
  pickClock: "resolveStalledPick",
};

/** The fields of the room rows (loadInhouseRoomRows) the due check reads. */
export type InhouseRoomDueInput = {
  queue: readonly {
    lastSeenAt: Date;
    joinedAt: Date;
    idleExpiresAt: Date | null;
  }[];
  /** The live lobbies (INHOUSE_ACTIVE_STATUSES). */
  lobbies: readonly {
    slot: number;
    status: string;
    createdAt: Date;
    startedAt: Date | null;
    acceptEndsAt: Date | null;
    voteEndsAt: Date | null;
    pickTeam: number | null;
    pickEndsAt: Date | null;
    players: readonly {
      team: number | null;
      acceptedAt: Date | null;
      votedMethod: string | null;
    }[];
  }[];
  /** The games marked over (AWAITING_RESULT). */
  pending: readonly { finishedAt: Date | null }[];
};

const HOUR_MS = 3_600_000;

/** Strictly before (`lt`), as the resolvers' Prisma filters compare. */
const before = (at: Date | null, cutoffMs: number) =>
  !!at && at.getTime() < cutoffMs;

/**
 * Which resolvers have work at `nowMs`, in chain order, each reason once.
 * Empty means getInhouseState's maintenance chain would change nothing.
 */
export function inhouseRoomDue(
  input: InhouseRoomDueInput,
  nowMs: number,
): InhouseRoomDueReason[] {
  const due = new Set<InhouseRoomDueReason>();

  // resolveAbandonedLobby: READY by createdAt, IN_PROGRESS by startedAt and
  // AWAITING_RESULT by finishedAt, each strictly older than its floor. A null
  // timestamp never matches the `lt` filter.
  for (const l of input.lobbies) {
    if (
      (l.status === INHOUSE_STATUS.READY &&
        before(l.createdAt, nowMs - INHOUSE.ABANDON_READY_HOURS * HOUR_MS)) ||
      (l.status === INHOUSE_STATUS.IN_PROGRESS &&
        before(
          l.startedAt,
          nowMs - INHOUSE.ABANDON_IN_PROGRESS_HOURS * HOUR_MS,
        ))
    ) {
      due.add("abandon");
    }
  }
  for (const g of input.pending) {
    if (
      before(
        g.finishedAt,
        nowMs - INHOUSE.ABANDON_AWAITING_RESULT_HOURS * HOUR_MS,
      )
    ) {
      due.add("abandon");
    }
  }

  // maybeFormLobby → formOneLobby → expireStaticQueue (expiredQueuePredicates):
  // a shared idle deadline strictly passed, or the legacy null deadline with
  // a join strictly older than the idle window.
  for (const q of input.queue) {
    if (
      q.idleExpiresAt
        ? before(q.idleExpiresAt, nowMs)
        : before(q.joinedAt, nowMs - INHOUSE.QUEUE_IDLE_HOURS * HOUR_MS)
    ) {
      due.add("queueExpired");
    }
  }

  // formOneLobby: a free slot by number (freeGameSlot, not a count of live
  // games) and at least LOBBY_SIZE present players (lastSeenAt >= the
  // presence cutoff, which queuePresence spells the same way).
  if (freeGameSlot(input.lobbies.map((l) => l.slot)) !== null) {
    const present = input.queue.filter(
      (q) => queuePresence(q.lastSeenAt.getTime(), nowMs) === "present",
    ).length;
    if (present >= INHOUSE.LOBBY_SIZE) due.add("formation");
  }

  for (const l of input.lobbies) {
    // resolveReadyCheck: all accepted (whatever the clock), or the clock ran
    // out (failReadyCheck).
    if (
      l.status === INHOUSE_STATUS.READY_CHECK &&
      (inhouseAllAccepted(l.players) || inhouseClockDue(l.acceptEndsAt, nowMs))
    ) {
      due.add("readyCheck");
    }
    // resolveCaptainVote: all voted, or the clock ran out.
    if (
      l.status === INHOUSE_STATUS.CAPTAIN_VOTE &&
      (inhouseAllVoted(l.players) || inhouseClockDue(l.voteEndsAt, nowMs))
    ) {
      due.add("captainVote");
    }
    if (l.status === INHOUSE_STATUS.DRAFTING) {
      // restoreLostPickTurn: a draft with no pick turn is always repaired.
      if (l.pickTeam === null) due.add("pickTurnLost");
      // resolveStalledPick: the turn's clock ran out and someone is left to
      // auto-pick.
      else if (
        inhouseClockDue(l.pickEndsAt, nowMs) &&
        inhouseDraftPool(l.players).length > 0
      ) {
        due.add("pickClock");
      }
    }
  }

  const order: InhouseRoomDueReason[] = [
    "abandon",
    "queueExpired",
    "formation",
    "readyCheck",
    "captainVote",
    "pickTurnLost",
    "pickClock",
  ];
  return order.filter((r) => due.has(r));
}

export type RoomHeartbeatAction = "skip" | "write" | "writeAndRefresh";

/**
 * What the polling viewer's own heartbeat needs. `row` is their queue row (null
 * when they are not queued); `seenAtMs` is a later heartbeat this server
 * already wrote for them, if it knows one.
 *
 * - skip: not queued, or seen within QUEUE_HEARTBEAT_SECONDS. That mirrors
 *   touchQueueHeartbeat's strict `lastSeenAt < now - 30s` WHERE, so the
 *   skipped statement would have matched no row.
 * - write: queued, present and due a heartbeat. Presence doesn't change.
 * - writeAndRefresh: the rows show them away (a backdated requeue, or a tab
 *   back after four hours). After the write they count as present, so the
 *   poll re-reads the rows to show them present, count them in `needed` and
 *   let them be the tenth that forms a lobby on this same poll.
 */
export function roomHeartbeatAction(
  row: { lastSeenAt: Date } | null,
  seenAtMs: number | null,
  nowMs: number,
): RoomHeartbeatAction {
  if (!row) return "skip";
  const seen = Math.max(row.lastSeenAt.getTime(), seenAtMs ?? -Infinity);
  if (seen >= nowMs - INHOUSE.QUEUE_HEARTBEAT_SECONDS * 1000) return "skip";
  return queuePresence(row.lastSeenAt.getTime(), nowMs) === "away"
    ? "writeAndRefresh"
    : "write";
}

/**
 * The per-instance board memo: what this server instance last checked the
 * board against, when, and how it went.
 */
export type BoardCheckMemo = {
  key: string;
  checkedAtMs: number;
  outcome: InhouseBoardSyncOutcome | null;
  /** No board check before this (another poll held the maintenance claim). */
  backoffUntilMs: number;
};

/**
 * What the board shows, as a memo key: `basis` names the room rows the board
 * was rendered from (the room version, or a digest of the rendered input
 * while nothing has published one), and the present players and away count
 * catch a presence flip that no write made (four hours passing).
 */
export function boardCheckKey(
  basis: string,
  presentIds: readonly string[],
  awayCount: number,
): string {
  return JSON.stringify([basis, presentIds, awayCount]);
}

/**
 * Whether a poll with nothing due should check the board: never inside a
 * back-off; otherwise on a first check, a new key, BOARD_RECHECK_MS after the
 * last check, or after a check that left the board behind (throttled or
 * failed, the board's own retry-on-difference).
 */
export function boardCheckDue(
  memo: BoardCheckMemo | null,
  key: string,
  nowMs: number,
): boolean {
  if (!memo) return true;
  if (nowMs < memo.backoffUntilMs) return false;
  if (memo.key !== key) return true;
  if (memo.outcome === null) return true;
  if (memo.outcome === "throttled" || memo.outcome === "failed") return true;
  return nowMs - memo.checkedAtMs >= INHOUSE.BOARD_RECHECK_MS;
}

/**
 * When a board check that came back `throttled` can next get through, for a
 * held request to wake on (inhouseRoomWakeAt): BOARD_MIN_SECONDS after the
 * check, since the edit whose throttle stopped it claimed no later than the
 * check did, and never inside a lost claim's back-off. A check still
 * throttled then is re-stamped, so this costs at most one wake per
 * BOARD_MIN_SECONDS per signed-in viewer until the edit lands. Null for
 * every other outcome: a `failed` edit's own back-off is 20s and up, so it
 * waits for the hold's end like any other poll.
 */
export function boardRetryAtMs(memo: BoardCheckMemo | null): number | null {
  if (!memo || memo.outcome !== "throttled") return null;
  return Math.max(
    memo.checkedAtMs + INHOUSE.BOARD_MIN_SECONDS * 1000,
    memo.backoffUntilMs,
  );
}

/** The memo after a board check this instance ran. */
export function boardMemoAfterCheck(
  key: string,
  outcome: InhouseBoardSyncOutcome,
  nowMs: number,
): BoardCheckMemo {
  return { key, checkedAtMs: nowMs, outcome, backoffUntilMs: 0 };
}

/**
 * The memo after the maintenance claim was lost: the last check stands, and
 * no check runs for BOARD_CLAIM_BACKOFF_MS (the winner owns the board now).
 */
export function boardMemoAfterLostClaim(
  memo: BoardCheckMemo | null,
  nowMs: number,
): BoardCheckMemo {
  return {
    key: memo?.key ?? "",
    checkedAtMs: memo?.checkedAtMs ?? 0,
    outcome: memo?.outcome ?? null,
    backoffUntilMs: nowMs + INHOUSE.BOARD_CLAIM_BACKOFF_MS,
  };
}
