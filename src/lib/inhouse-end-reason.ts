import { INHOUSE, INHOUSE_STATUS } from "./constants";

/**
 * Why an inhouse lobby ended without a result, in a few plain words for the
 * admin list on /inhouse/history.
 *
 * Every path that cancels a lobby writes one of these into
 * `InhouseLobby.endReason` inside the SAME guarded write that sets the status
 * (never a second write that a crash could separate from it). Before this the
 * only trace of a failed ready check or a timed-out lobby was the CANCELLED
 * status itself, so nobody could tell from the site what had happened to a
 * lobby that never produced a game.
 *
 * Names are stored as they read at the time: this is a record of what
 * happened, not a live roster, and the list it feeds is admin-only.
 */

/** How many names a no-show reason spells out before it says "and N more". */
const NAMES_SHOWN = 5;

/** "A", "A and B", "A, B and C", "A, B, C, D, E and 2 more". */
export function nameList(names: string[], shown = NAMES_SHOWN): string {
  if (names.length === 0) return "";
  if (names.length > shown) {
    return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
  }
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A player pressed Decline on the ready check. */
export function declinedReason(name: string): string {
  return `Declined by ${name}`;
}

/** The accept clock ran out with these players still pending. */
export function noShowReason(names: string[]): string {
  if (names.length === 0) return "The ready check ran out";
  return `${nameList(names)} didn't accept in time`;
}

/**
 * resolveAbandonedLobby tore down a lobby that never produced a result. Both
 * playing phases get the same window now that Start is optional; they differ
 * only in the clock it runs from (formation for READY, Start for IN_PROGRESS).
 * A game marked over runs from "Game over" itself.
 */
export function abandonedReason(status: string): string {
  if (status === INHOUSE_STATUS.AWAITING_RESULT) {
    return `No result on OpenDota ${INHOUSE.ABANDON_AWAITING_RESULT_HOURS}h after the game ended`;
  }
  if (status === INHOUSE_STATUS.IN_PROGRESS) {
    return `No result ${INHOUSE.ABANDON_IN_PROGRESS_HOURS}h after the game started`;
  }
  return `No result ${INHOUSE.ABANDON_READY_HOURS}h after the lobby formed`;
}

const PHASE_WORDS: Record<string, string> = {
  [INHOUSE_STATUS.READY_CHECK]: "during the ready check",
  [INHOUSE_STATUS.CAPTAIN_VOTE]: "during the captain vote",
  [INHOUSE_STATUS.DRAFTING]: "during the draft",
  [INHOUSE_STATUS.READY]: "after teams locked",
  [INHOUSE_STATUS.IN_PROGRESS]: "during the game",
  [INHOUSE_STATUS.AWAITING_RESULT]: "while waiting for the result",
};

/**
 * An admin pressed "cancel this lobby". `status` is the phase the admin saw
 * when they pressed it (the live cancel claim accepts any active phase, so a
 * draft that locked teams mid-confirm still reads "during the draft"). Giving
 * up on a game marked over has its own claim on AWAITING_RESULT.
 */
export function adminCancelReason(adminName: string, status: string): string {
  const when = PHASE_WORDS[status];
  return `Cancelled by admin ${adminName}${when ? ` ${when}` : ""}`;
}

/**
 * An admin voided a recorded result. The void claim nulls the match id, so
 * the reason is the one place that still says which Dota game it was.
 */
export function resultVoidedReason(
  adminName: string,
  dotaMatchId: string | null,
): string {
  return `Result voided by admin ${adminName}${
    dotaMatchId ? ` (match ${dotaMatchId})` : ""
  }`;
}

export type FailedLobbyRow = {
  endReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  players: { acceptedAt: Date | null; team: number | null }[];
};

/**
 * The line the admin list shows for a cancelled lobby: its stored reason, or,
 * for lobbies that ended before reasons were stored, the furthest stage the
 * rows themselves prove it reached. Only facts the columns still hold — a
 * guessed cause would be worse than none.
 */
export function failedLobbyReason(row: FailedLobbyRow): string {
  if (row.endReason) return row.endReason;
  const unknown = "(no reason saved)";
  // A void keeps completedAt; nothing else sets it on a cancelled lobby.
  if (row.completedAt) return `Result voided ${unknown}`;
  if (row.startedAt) return `Ended after the game started ${unknown}`;
  const total = row.players.length;
  const onTeams = row.players.filter((p) => p.team != null).length;
  if (total > 0 && onTeams === total) {
    return `Ended after teams locked ${unknown}`;
  }
  // Captains get a team when the vote resolves, so any team means DRAFTING.
  if (onTeams > 0) return `Ended during the draft ${unknown}`;
  const accepted = row.players.filter((p) => p.acceptedAt != null).length;
  if (total > 0 && accepted === total) {
    return `Ended during the captain vote ${unknown}`;
  }
  return `Ended in the ready check, ${accepted} of ${total} accepted ${unknown}`;
}
