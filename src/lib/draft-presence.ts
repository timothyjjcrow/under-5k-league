import { DRAFT_STATUS } from "./constants";
import { draftSetupOpen } from "./draft-setup";

// Which captains have the draft room open. A captain's own room polls are the
// heartbeat (the tick route records them); team cards show "in room", and the
// Start-draft confirm names the captains who aren't. An absent captain never
// bids, and their nomination turns are picked for them when the clock runs
// out, so the admin wants to know before pressing Start, and the room wants
// to show when one drops mid-auction.

export const DRAFT_PRESENCE = {
  /** A captain's polls refresh their last-seen time at most this often. */
  WRITE_SECONDS: 20,
  /**
   * Seen within this long counts as in the room. It has to outlast a hidden
   * tab: the room keeps a captain's background tab polling, but Chrome can
   * clamp that timer to about once a minute, and the write is throttled on
   * top of that.
   */
  AWAY_SECONDS: 90,
} as const;

/**
 * Is presence worth recording and showing? In the waiting room before Start
 * (draft setup still open) and while the auction is live or paused. Not once
 * it has finished.
 */
export function draftPresenceTracked(
  seasonStatus: string,
  draftStatus: string | null | undefined,
): boolean {
  return (
    draftStatus === DRAFT_STATUS.IN_PROGRESS ||
    draftStatus === DRAFT_STATUS.PAUSED ||
    draftSetupOpen(seasonStatus, draftStatus)
  );
}

/** A stored last-seen time (ISO) recent enough to count as in the room. */
export function captainInRoom(
  lastSeen: string | null | undefined,
  nowMs: number,
): boolean {
  if (!lastSeen) return false;
  const seenMs = Date.parse(lastSeen);
  if (!Number.isFinite(seenMs)) return false;
  return nowMs - seenMs <= DRAFT_PRESENCE.AWAY_SECONDS * 1000;
}

type PresenceTeam = {
  name: string;
  captainId: string;
  /** Null while presence isn't tracked (see draftPresenceTracked). */
  captainInRoom: boolean | null;
  members: readonly { userId: string; name: string }[];
};

/**
 * Who is in the room, from a draft payload. The viewer always counts as here:
 * they are looking at it, and their own poll may not have been recorded yet.
 * Null when presence isn't tracked or there are no captains.
 */
export function captainPresence(
  teams: readonly PresenceTeam[],
  viewerId: string | null,
): { here: number; total: number; away: string[] } | null {
  if (teams.length === 0 || teams.some((t) => t.captainInRoom === null)) {
    return null;
  }
  const away = teams
    .filter((t) => !t.captainInRoom && t.captainId !== viewerId)
    .map(
      (t) => t.members.find((m) => m.userId === t.captainId)?.name ?? t.name,
    );
  return { here: teams.length - away.length, total: teams.length, away };
}

/** The waiting room's line for the admin, above Start draft. */
export function captainPresenceLine(p: {
  here: number;
  total: number;
  away: readonly string[];
}): string {
  if (p.away.length === 0) {
    return p.total === 1
      ? "The captain is in the draft room."
      : `All ${p.total} captains are in the draft room.`;
  }
  return `${p.here} of ${p.total} captains are in the draft room. Not here: ${p.away.join(", ")}.`;
}

/**
 * The Start-draft confirm's line naming captains who aren't in the room, or
 * "" when everyone is. `asOf` says how fresh the list is: the draft room
 * knows who is there right now; /admin only knows who was there when the
 * page loaded.
 */
export function missingCaptainsConfirmLine(
  away: readonly string[],
  asOf: "now" | "pageLoad",
): string {
  if (away.length === 0) return "";
  const lead =
    asOf === "now"
      ? "Not in the draft room right now:"
      : "Not in the draft room when this page loaded:";
  // Its own line of the confirm (see startDraftConfirm).
  return (
    `\n${lead} ${away.join(", ")}.` +
    " They can't bid, and the draft nominates for them when their clock runs out."
  );
}
