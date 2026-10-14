import { createHash } from "node:crypto";
import type { SessionUser } from "./auth";
import { invalidateAutomationGateBestEffort } from "./automation-gate-invalidation";
import { INHOUSE } from "./constants";
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
import { createRoomCache } from "./inhouse-room-cache";
import {
  readRoomBoardMemo,
  writeRoomBoardMemo,
} from "./inhouse-room-memo";
import {
  inhouseRoomLocalGeneration,
  publishInhouseRoomChange,
  readInhouseRoomVersion,
} from "./inhouse-room-version";
import { raceHook } from "./race-hook";
import { claimThrottle, SETTING_KEYS } from "./settings";

// The room poll: POST /api/inhouse {action:"state"}. The reply is the same
// InhouseState getInhouseState builds, but a poll only does the work that is
// due instead of the whole maintenance chain, and reads the room's shared
// rows from this instance's snapshot (inhouse-room-cache.ts) while the room
// version says nothing changed:
//
// - The version is read on every poll (the route reads it beside the
//   session). Every writer the room shows publishes a new one after its
//   commit (rule P, inhouse-room-version.ts), so a poll that starts after a
//   change, on any instance, never serves the rows from before it.
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
// Anonymous polls only read: no heartbeat, claim, board, publish or resolver.

/** This instance's room snapshot. */
const roomCache = createRoomCache<InhouseRoomRows>({
  readVersion: readInhouseRoomVersion,
  load: () => loadInhouseRoomRows(Date.now()),
  localGen: inhouseRoomLocalGeneration,
  now: () => Date.now(),
  maxAgeMs: INHOUSE.ROOM_SNAPSHOT_MAX_AGE_MS,
  // A frozen snapshot turns an accidental write to the shared rows into a
  // TypeError in dev and tests instead of one viewer's reply leaking into
  // the next.
  freeze: process.env.NODE_ENV !== "production",
});

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

/**
 * One room poll for `viewer` (null when signed out). `version` is the room
 * version the caller read beside the session; omitted, the poll reads it.
 */
export async function pollInhouseState(
  viewer: SessionUser | null,
  version?: string | null,
): Promise<InhousePollResult> {
  let snap = await roomCache.get(version);
  if (!viewer) {
    return {
      state: buildInhouseState(null, snap.rows, null, Date.now()),
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
    const mine = snap.rows.queue.find((q) => q.userId === viewer.id) ?? null;
    const heartbeat = roomHeartbeatAction(
      mine,
      snap.seenAt.get(viewer.id) ?? null,
      Date.now(),
    );
    if (heartbeat !== "skip") {
      // Seam: the decision is made and nothing is written. A rival heartbeat
      // (another tab of this viewer) can land here; the WHERE must refuse.
      await raceHook("inhouse.pollInhouseState.beforeHeartbeat");
      // Taken before the write, so the stored value is at least this.
      const touchedAtMs = Date.now();
      const written = await touchQueueHeartbeat(viewer.id);
      if (written > 0) snap.seenAt.set(viewer.id, touchedAtMs);
      if (heartbeat === "writeAndRefresh") {
        // They were away in the rows. Whoever wrote it (this poll or a
        // rival), they are present now: publish, then re-read so the reply
        // shows them present, `needed` counts them, and they can be the tenth
        // that forms a lobby on this same poll. Presence is something the
        // gate schedules on.
        await publishInhouseRoomChange();
        invalidateGate = true;
        snap = await roomCache.get();
      }
    }

    const rows = snap.rows;
    const now = Date.now();
    if (inhouseRoomDue(rows, now).length > 0) {
      if (
        await claimThrottle(SETTING_KEYS.INHOUSE_ROOM_MAINTENANCE_AT, 2, now)
      ) {
        invalidateGate = true;
        // The winner runs today's maintenance pass, which publishes after its
        // resolvers, re-reads everything and repaints the board. The
        // authenticated worker owns automatic OpenDota scans, so this never
        // waits on them.
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
      // The version names everything the board is rendered from; with no
      // version yet (nothing ever published), the rendered input itself.
      const key = boardCheckKey(
        snap.version !== "" ? snap.version : boardInputBasis(input),
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
