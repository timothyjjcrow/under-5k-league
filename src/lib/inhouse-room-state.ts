import { createHash } from "node:crypto";
import type { SessionUser } from "./auth";
import { invalidateAutomationGateBestEffort } from "./automation-gate-invalidation";
import { discordMutationsAllowed } from "./discord-mutation-policy";
import { queuePresence } from "./inhouse";
import {
  syncInhouseBoard,
  type BoardSnapshotInput,
} from "./inhouse-board-service";
import {
  boardCheckDue,
  boardCheckKey,
  boardMemoAfterCheck,
  boardMemoAfterLostClaim,
  inhouseRoomDue,
  roomHeartbeatAction,
} from "./inhouse-room-due";
import {
  boardInputFrom,
  buildInhouseState,
  getInhouseState,
  loadInhouseRoomRows,
  loadViewerExtras,
  touchQueueHeartbeat,
  type InhouseRoomRows,
  type InhouseState,
} from "./inhouse-service";
import {
  readRoomBoardMemo,
  writeRoomBoardMemo,
} from "./inhouse-room-memo";
import { raceHook } from "./race-hook";
import { claimThrottle, SETTING_KEYS } from "./settings";

// The room poll: POST /api/inhouse {action:"state"}. The reply is the same
// InhouseState getInhouseState builds, but a poll only does the work that is
// due instead of the whole maintenance chain:
//
// - The viewer's heartbeat is written only when touchQueueHeartbeat's WHERE
//   could match (roomHeartbeatAction). That WHERE stays the one enforcement
//   point; the skip only drops statements that would have written nothing.
// - Maintenance runs only when the pure due check (inhouse-room-due.ts) finds
//   a resolver with work, and then only for the winner of the fleet-wide 2s
//   claim, through getInhouseState itself. This module never calls a resolver
//   (inhouse-room-state.test.ts guards the source).
// - With nothing due, the board is checked when what it shows has moved since
//   this instance last checked, under the same claim.
//
// Anonymous polls only read: no heartbeat, claim, board or resolver.

/** The board input minus its clock and URL: what the rendered board shows. */
function boardInputBasis(input: BoardSnapshotInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.presentNames,
        input.awayCount,
        input.lobbySize,
        input.lobbies,
      ]),
    )
    .digest("hex");
}

/** The present players' ids in queue order, as boardInputFrom judges them. */
function presentIdsOf(rows: InhouseRoomRows, nowMs: number): string[] {
  return rows.queue
    .filter((q) => queuePresence(q.lastSeenAt.getTime(), nowMs) === "present")
    .map((q) => q.userId);
}

export type InhousePollResult = {
  state: InhouseState;
  /**
   * True when this poll changed what the automation gate schedules on (a
   * maintenance win, a presence flip, a board edit): the route then expires
   * AUTOMATION_GATE_TAG.
   */
  invalidateGate: boolean;
};

/** One room poll for `viewer` (null when signed out). */
export async function pollInhouseState(
  viewer: SessionUser | null,
): Promise<InhousePollResult> {
  let rows = await loadInhouseRoomRows(Date.now());
  if (!viewer) {
    return {
      state: buildInhouseState(null, rows, null, Date.now()),
      invalidateGate: false,
    };
  }

  // Set once this poll has changed something the automation gate schedules
  // on. A throw past that point still expires the gate here, since the route
  // never sees the result.
  let invalidateGate = false;
  try {
    // Heartbeat before the due check, as getInhouseState heartbeats before
    // forming: the polling viewer must count as present.
    const mine = rows.queue.find((q) => q.userId === viewer.id) ?? null;
    const heartbeat = roomHeartbeatAction(mine, null, Date.now());
    if (heartbeat !== "skip") {
      // Seam: the decision is made and nothing is written. A rival heartbeat
      // (another tab of this viewer) can land here; the WHERE must refuse.
      await raceHook("inhouse.pollInhouseState.beforeHeartbeat");
      await touchQueueHeartbeat(viewer.id);
      if (heartbeat === "writeAndRefresh") {
        // They were away in the rows. Whoever wrote it (this poll or a
        // rival), they are present now: re-read so the reply shows them
        // present, `needed` counts them, and they can be the tenth that forms
        // a lobby on this same poll. Presence is something the gate
        // schedules on.
        invalidateGate = true;
        rows = await loadInhouseRoomRows(Date.now());
      }
    }

    const now = Date.now();
    if (inhouseRoomDue(rows, now).length > 0) {
      if (
        await claimThrottle(SETTING_KEYS.INHOUSE_ROOM_MAINTENANCE_AT, 2, now)
      ) {
        invalidateGate = true;
        // The winner runs today's maintenance pass, which re-reads everything
        // and repaints the board. The authenticated worker owns automatic
        // OpenDota scans, so this never waits on them.
        const state = await getInhouseState(viewer, {
          runMaintenance: true,
          detectResults: false,
          syncBoard: true,
        });
        return { state, invalidateGate };
      }
      // Another poll holds the claim and is resolving it: read-only, as
      // losers always were.
    } else if (discordMutationsAllowed()) {
      const input = boardInputFrom(rows, now);
      const key = boardCheckKey(
        boardInputBasis(input),
        presentIdsOf(rows, now),
        input.awayCount,
      );
      const memo = readRoomBoardMemo();
      if (boardCheckDue(memo, key, now)) {
        if (
          await claimThrottle(SETTING_KEYS.INHOUSE_ROOM_MAINTENANCE_AT, 2, now)
        ) {
          const outcome = await syncInhouseBoard(input);
          writeRoomBoardMemo(boardMemoAfterCheck(key, outcome, now));
          if (outcome === "edited") invalidateGate = true;
        } else {
          writeRoomBoardMemo(boardMemoAfterLostClaim(memo, now));
        }
      }
    }

    const extras = await loadViewerExtras(viewer, rows);
    return {
      state: buildInhouseState(viewer, rows, extras, Date.now()),
      invalidateGate,
    };
  } catch (e) {
    if (invalidateGate) invalidateAutomationGateBestEffort();
    throw e;
  }
}
