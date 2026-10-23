// When a draft-room tab re-renders its server components.
//
// The header's status chip ("Signups open", "Draft setup", "Draft live",
// "Draft paused", "Draft complete") and the phase-gated navigation come from
// the ROOT LAYOUT's render, which a polled room never repeats. A captain who
// opened /draft before Start read "Signups open" through the whole auction,
// then "Draft live" after it ended. The room's own poll already carries both
// statuses the layout keys on, so the room refreshes its server render when
// either moves: start, pause, resume, completion, abort, a phase move.

/** The two statuses the layout's header chip and navigation are rendered from. */
export type DraftRoomPhase = {
  /** `Season.status` */
  seasonStatus: string;
  /** `Draft.status`, NOT_STARTED when there is no Draft row */
  draftStatus: string;
};

/**
 * Whether the room should call `router.refresh()` now: only when the season
 * phase or the auction status in the latest accepted poll differs from the
 * one this tab's server render shows. Never on a poll where neither moved:
 * every refresh re-renders the layout and the page on the box both leagues
 * share, and a 2s poll would make that a request every two seconds per tab.
 * `rendered` null (nothing known yet) never refreshes; the caller records the
 * poll's phase as rendered either way.
 */
export function draftRoomNeedsRefresh(
  rendered: DraftRoomPhase | null,
  polled: DraftRoomPhase,
): boolean {
  if (!rendered) return false;
  return (
    rendered.seasonStatus !== polled.seasonStatus ||
    rendered.draftStatus !== polled.draftStatus
  );
}

/**
 * The longest a viewer who can't act waits before that refresh
 * (draftRoomRefreshDelayMs).
 */
export const DRAFT_ROOM_REFRESH_SPREAD_MS = 5_000;

/**
 * How long a tab waits before that refresh. A captain or an admin refreshes
 * at once: their controls and header matter now. Everyone else waits a
 * random 0 to DRAFT_ROOM_REFRESH_SPREAD_MS, because the long-poll tells every
 * tab of a Start, a pause or a resume within a second, and fifty renders of
 * the layout and the page landing together on the box would queue the
 * captains' bids behind them; the old 5s poll spread them about that much.
 * `random` is Math.random's contract; anything outside [0, 1) is clamped.
 */
export function draftRoomRefreshDelayMs(
  canAct: boolean,
  random: () => number = Math.random,
): number {
  if (canAct) return 0;
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(r * DRAFT_ROOM_REFRESH_SPREAD_MS);
}
