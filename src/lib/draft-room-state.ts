import type { SessionUser } from "./auth";
import { invalidateAutomationGateBestEffort } from "./automation-gate-invalidation";
import { DRAFT_ROOM } from "./constants";
import { captainInRoom, draftPresenceTracked } from "./draft-presence";
import { recordCaptainPresence } from "./draft-presence-service";
import {
  draftRoomLocalGeneration,
  publishDraftRoomChange,
  readDraftRoomVersion,
  readDraftRoomVersionToken,
} from "./draft-room-version";
import {
  waitForDraftRoomChange,
  type DraftHoldRequest,
  type DraftRoomWake,
} from "./draft-room-wait";
import {
  draftRoomDue,
  draftRoomWakeAt,
  type DraftRoomViewerRole,
} from "./draft-room-wake";
import {
  buildDraftState,
  loadDraftRoomRows,
  resolveExpiredNomination,
  resolveStalledNomination,
  type DraftRoomRows,
  type DraftState,
} from "./draft-service";
import {
  createRoomCache,
  type RoomCache,
  type RoomCacheEntry,
} from "./inhouse-room-cache";
import { claimThrottle, SETTING_KEYS } from "./settings";

// The draft room's tick: POST /api/draft/tick. The reply is the same
// DraftState getDraftState builds, but a tick reads the room's shared rows
// from this instance's snapshot (createRoomCache) while the room version
// says nothing changed, and does only the work that is due:
//
// - The version is read on every tick (the route reads it beside the
//   session). Every writer the room shows publishes a new one after its
//   commit (rule P, draft-room-version.ts), so a tick that starts after a
//   change, on any instance, never serves the rows from before it. Fifty
//   viewers asking about one change cost one read of the rows per instance,
//   not fifty.
// - A captain's tick is their "in the room" heartbeat (one write per
//   DRAFT_PRESENCE.WRITE_SECONDS at most). A captain the rows showed away
//   publishes when their write lands, so every tab shows them back at once.
// - A clock is settled only when the pure due check (draft-room-wake.ts)
//   finds it run out, and then only by the winner of the fleet-wide 2s
//   claim, through getDraftState's resolvers (which publish their commits).
//   Signed-out ticks never settle anything.
//
// THE LONG-POLL (holdDraftRoomPoll, below): a tick whose `since` is the
// version the route just read is held first, with no database connection,
// until the version moves, the auction's clock wakes this viewer, its hold
// ends, or its client goes away; then the route reads the session and the
// version again and polls exactly as above. The hold reads nothing but the
// snapshot it would serve.

/**
 * This instance's snapshot of the active season's room. One season is
 * active at a time, so one cache lives; a tick for another season (an
 * activation between ticks) starts that season's afresh.
 */
let current: {
  seasonId: string;
  cache: RoomCache<DraftRoomRows | null>;
} | null = null;

function roomCacheFor(seasonId: string): RoomCache<DraftRoomRows | null> {
  if (current?.seasonId !== seasonId) {
    current?.cache.retire();
    current = {
      seasonId,
      cache: createRoomCache<DraftRoomRows | null>({
        readVersion: readDraftRoomVersion,
        load: () => loadDraftRoomRows(seasonId),
        localGen: draftRoomLocalGeneration,
        now: () => Date.now(),
        maxAgeMs: DRAFT_ROOM.ROOM_SNAPSHOT_MAX_AGE_MS,
        // A frozen snapshot turns an accidental write to the shared rows into
        // a TypeError in dev and tests instead of one viewer's reply leaking
        // into the next.
        freeze: process.env.NODE_ENV !== "production",
        beforeStoreHook: "draft.roomCache.beforeStore",
      }),
    };
  }
  return current.cache;
}

/** Test-only: forget this instance's room snapshot. */
export function resetDraftRoomCacheForTests(): void {
  current?.cache.reset();
  current = null;
}

/**
 * How `viewer` takes part in the auction's clocks (draft-room-wake.ts): a
 * captain of one of the room's teams or an admin "acts", any other signed-in
 * viewer "maintains", a signed-out one "reads".
 */
export function draftRoomViewerRole(
  viewer: SessionUser | null,
  rows: Pick<DraftRoomRows, "teams"> | null,
): DraftRoomViewerRole {
  if (!viewer) return "reads";
  if (viewer.role === "ADMIN") return "acts";
  return rows?.teams.some((team) => team.captainId === viewer.id)
    ? "acts"
    : "maintains";
}

/**
 * Hold a tick whose client already shows `version` (the route has just read
 * it and found it equal to `hold.since`). Ends at the earliest of: the
 * version moving (a publish in this process, or the watch's database read),
 * the auction's clock as it wakes this viewer (draftRoomWakeAt, from this
 * instance's snapshot of the rows: a cache hit while the version stands),
 * the hold asked for (at most LONG_POLL_HOLD_MS), the process stopping, or
 * `signal`. A clock that ran out after the reply the client shows
 * (`hold.sinceNowMs`) answers at once: that reply is stale already. `mark`
 * is draftRoomHoldMark() read before that version. Writes nothing: the
 * route polls as usual afterwards, unless the client went away
 * ("aborted").
 */
export async function holdDraftRoomPoll(o: {
  viewer: SessionUser | null;
  seasonId: string;
  version: string | null;
  hold: DraftHoldRequest;
  mark: number;
  signal?: AbortSignal;
}): Promise<DraftRoomWake> {
  if (o.signal?.aborted) return "aborted";
  // A signed-out viewer never wakes on a clock (draftRoomWakeAt): its hold
  // needs no rows, so it never loads the copy.
  const snap = o.viewer
    ? await roomCacheFor(o.seasonId).get(o.version)
    : null;
  const nowMs = Date.now();
  const wakeAt = snap?.rows
    ? draftRoomWakeAt(snap.rows, nowMs, {
        role: draftRoomViewerRole(o.viewer, snap.rows),
        fromMs: o.hold.sinceNowMs,
      })
    : null;
  // A clock ran out after the reply the client shows: answer now.
  if (wakeAt !== null && wakeAt <= nowMs) return "deadline";
  const holdMs = Math.min(
    DRAFT_ROOM.LONG_POLL_HOLD_MS,
    Math.max(0, o.hold.holdMs),
  );
  return waitForDraftRoomChange({
    since: o.hold.since,
    mark: o.mark,
    untilMs: Math.min(nowMs + holdMs, wakeAt ?? Infinity),
    signal: o.signal,
    readToken: readDraftRoomVersionToken,
    nowMs,
  });
}

export type DraftPollResult = {
  /** Null when the season's row is gone (the route answers 404). */
  state: DraftState | null;
  /**
   * The room version the reply's rows were read under, never a newer one:
   * the version the caller passed, or the copy's after this tick published
   * (a captain back in the room, a settled clock), so its client holds next
   * instead of asking again. Null with no version row yet.
   */
  version: string | null;
  /**
   * True when this tick won the 2s claim and settled a clock: the route then
   * expires AUTOMATION_GATE_TAG, as it did after every claim it won.
   */
  invalidateGate: boolean;
};

/** A copy's label as a reply's version: "" is an uncached load (no row). */
function versionOf(entry: RoomCacheEntry<DraftRoomRows | null>): string | null {
  return entry.version === "" ? null : entry.version;
}

/**
 * One room tick for `viewer` (null when signed out) in `seasonId`, the
 * active season the route checked. `version` is the room version the caller
 * read beside the session; omitted, the tick reads it.
 */
export async function pollDraftRoomState(
  viewer: SessionUser | null,
  seasonId: string,
  version?: string | null,
): Promise<DraftPollResult> {
  const cache = roomCacheFor(seasonId);
  let snap = await cache.get(version);
  if (!snap.rows || !viewer) {
    return {
      state: snap.rows ? buildDraftState(null, snap.rows, Date.now()) : null,
      version: versionOf(snap),
      invalidateGate: false,
    };
  }

  // A captain's tick is their "in the room" heartbeat (throttled to one
  // write per window), shown on team cards and in the Start-draft confirm.
  if (
    snap.rows.teams.some((team) => team.captainId === viewer.id) &&
    draftPresenceTracked(snap.rows.season.status, snap.rows.draft?.status)
  ) {
    const shownAway = !captainInRoom(
      snap.rows.captainLastSeen?.[viewer.id],
      Date.now(),
    );
    const wrote = await recordCaptainPresence(seasonId, viewer.id);
    if (wrote && shownAway) {
      // They were away in the rows: publish, then re-read, so every tab
      // (this one included) shows them in the room now rather than at the
      // snapshot's max age.
      await publishDraftRoomChange();
      snap = await cache.get();
      if (!snap.rows) {
        return { state: null, version: versionOf(snap), invalidateGate: false };
      }
    }
  }

  const rows = snap.rows;
  const now = Date.now();
  if (
    draftRoomDue(rows, now) &&
    (await claimThrottle(SETTING_KEYS.DRAFT_ROOM_MAINTENANCE_AT, 2, now))
  ) {
    // The winner settles the clock through the resolvers, which publish
    // their own commits, then answers from the copy read after them, under
    // its version. Another tick holding the claim is settling it: losers read
    // the snapshot, as they always did, and the settle's publish wakes their
    // next hold.
    try {
      await resolveExpiredNomination(seasonId);
      await resolveStalledNomination(seasonId);
      const settled = await cache.get();
      return {
        state: settled.rows
          ? buildDraftState(viewer, settled.rows, Date.now())
          : null,
        version: versionOf(settled),
        invalidateGate: true,
      };
    } catch (e) {
      // A resolver may have committed before the failure: the route never
      // sees a result, so the gate is expired here.
      invalidateAutomationGateBestEffort();
      throw e;
    }
  }
  return {
    state: buildDraftState(viewer, rows, Date.now()),
    version: versionOf(snap),
    invalidateGate: false,
  };
}
