import { DRAFT_ROOM, DRAFT_STATUS, SEASON_STATUS } from "./constants";

// PURE: the draft room's clocks, as a held tick (the room's long-poll) reads
// them from the room snapshot's rows. No read, no write, no clock but the
// `nowMs` passed in.
//
// The auction has one clock at a time: the live lot's bid clock, or with no
// lot on the block the nominator's clock. When it runs out the reply changes
// with no write (bidding closes; the lot is due to sell, or the turn to be
// picked for), and a resolver must settle it (resolveExpiredNomination,
// resolveStalledNomination). Only a signed-in tick settles one, under the
// fleet-wide 2s claim; the leased worker settles whatever nobody did, once a
// minute.
//
// Who wakes at a clock decides how many tabs ask at once. A captain's or an
// admin's held tick wakes just after it (LONG_POLL_CLOCK_GRACE_MS) and
// settles the lot, and that settle's publish wakes everyone else. Every
// other signed-in viewer wakes only if nothing has published by
// LONG_POLL_DUE_RETRY_MS after it (no captain or admin is in the room); a
// signed-out viewer never wakes on a clock. So a full room doesn't send
// sixty requests at every lot's zero, which on the one-vCPU box cost about
// 2.2s of CPU per sale (audit 2026-10-17).
//
// Clocks count from the reply the client shows (`fromMs`, its `now`), not
// from the hold's start: one that ran out in between (a tab back from a hide,
// a request after a 429's back-off) means that reply is already stale, and
// the request answers at once.

/** The rows the clocks read (loadDraftRoomRows' season and draft). */
export type DraftRoomClockInput = {
  season: { isActive: boolean; status: string };
  draft: {
    status: string;
    nominatedUserId: string | null;
    currentBidTeamId: string | null;
    nominatorTeamId: string | null;
    bidEndsAt: Date | null;
    nominationEndsAt: Date | null;
  } | null;
};

/**
 * How a held tick's viewer takes part in the auction's clocks: "acts" (a
 * captain or an admin, who settles a lot at its zero), "maintains" (signed
 * in: settles one that nobody else did), "reads" (signed out: never runs a
 * resolver, and waits for the publish).
 */
export type DraftRoomViewerRole = "acts" | "maintains" | "reads";

/**
 * When the auction's running clock runs out (epoch ms): the live lot's bid
 * clock, or with no lot the nomination clock. Null when no clock runs: no
 * live auction (not started, paused, complete), or a season out of the Draft
 * phase or archived, where the resolvers never act either.
 */
export function draftRoomClockAt(rows: DraftRoomClockInput): number | null {
  const { season, draft } = rows;
  if (
    !season.isActive ||
    season.status !== SEASON_STATUS.DRAFT ||
    !draft ||
    draft.status !== DRAFT_STATUS.IN_PROGRESS
  ) {
    return null;
  }
  if (draft.nominatedUserId) {
    return draft.currentBidTeamId && draft.bidEndsAt
      ? draft.bidEndsAt.getTime()
      : null;
  }
  return draft.nominatorTeamId && draft.nominationEndsAt
    ? draft.nominationEndsAt.getTime()
    : null;
}

/**
 * Whether a clock resolver has work: the running clock has run out (at or
 * before `nowMs`, the resolvers' own test). Mirrors resolveExpiredNomination
 * and resolveStalledNomination's act conditions; draft-room-wake.test.ts
 * pins them against both.
 */
export function draftRoomDue(rows: DraftRoomClockInput, nowMs: number): boolean {
  const at = draftRoomClockAt(rows);
  return at !== null && at <= nowMs;
}

/**
 * The time a held tick for this room should answer by itself, or null when
 * nothing should wake it but a publish or its hold. A time at or before
 * `nowMs` means the clock ran out after the reply the client shows: answer
 * at once.
 *
 * - "acts": LONG_POLL_CLOCK_GRACE_MS after the running clock, so the tick
 *   that wakes finds the lot due and settles it.
 * - "maintains": LONG_POLL_DUE_RETRY_MS after it: past the captains' and
 *   admins' settle, whose publish normally wakes this request first.
 * - "reads": never.
 * - A clock that ran out before the reply the client shows (that reply
 *   already showed it at zero, and nobody has settled it since, or the
 *   version would have moved): LONG_POLL_DUE_RETRY_MS from now, so a lot
 *   nobody finished settling is retried at a fast poll's pace.
 */
export function draftRoomWakeAt(
  rows: DraftRoomClockInput,
  nowMs: number,
  o: { role: DraftRoomViewerRole; fromMs?: number },
): number | null {
  if (o.role === "reads") return null;
  const clockAt = draftRoomClockAt(rows);
  if (clockAt === null) return null;
  const fromMs = Math.min(nowMs, o.fromMs ?? nowMs);
  const wakeMs =
    clockAt +
    (o.role === "acts"
      ? DRAFT_ROOM.LONG_POLL_CLOCK_GRACE_MS
      : DRAFT_ROOM.LONG_POLL_DUE_RETRY_MS);
  if (wakeMs > fromMs) return wakeMs;
  return nowMs + DRAFT_ROOM.LONG_POLL_DUE_RETRY_MS;
}
