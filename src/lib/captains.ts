// When the Captains page (/captains) is offered: one rule for the header
// link, the phone tab, Home's captain line and the page itself, so no surface
// links a page that would only say "this is for captains".

import { SEASON_STATUS } from "./constants";

export const CAPTAINS_HREF = "/captains";
export const CAPTAINS_LABEL = "Captains";

/**
 * The viewer captains a team in the active season that hasn't withdrawn, and
 * the season isn't over. From signups (a designated captain's team exists
 * before the draft) through the playoffs; a finished season has nothing left
 * to manage, and an archived season takes no writes.
 */
export function captainsPageOpen(
  season: { isActive: boolean; status: string },
  team: { withdrawn: boolean } | null,
): boolean {
  return (
    !!team &&
    !team.withdrawn &&
    season.isActive &&
    season.status !== SEASON_STATUS.COMPLETE
  );
}

/** What the Captains page has open: one fixture's and one scrim's controls. */
export type CaptainsSelection = {
  match?: string | null;
  scrim?: string | null;
};

/**
 * A link within the Captains page that keeps what is open: picking a scrim
 * must not close the fixture the captain was working on, nor the other way
 * round. `anchor` scrolls to one card.
 */
export function captainsHref(
  selection: CaptainsSelection = {},
  anchor?: string,
): string {
  const query = [
    selection.match ? `match=${encodeURIComponent(selection.match)}` : null,
    selection.scrim ? `scrim=${encodeURIComponent(selection.scrim)}` : null,
  ]
    .filter((part) => part !== null)
    .join("&");
  return `${CAPTAINS_HREF}${query ? `?${query}` : ""}${anchor ? `#${anchor}` : ""}`;
}

/** The Captains page's own anchors (the match cards keep `MATCH_ANCHOR`). */
export const CAPTAINS_ANCHOR = {
  needsYou: "needs-you",
  matches: "matches",
  scrims: "scrims",
  scrimDesk: "scrim-desk",
  team: "team",
} as const;

/**
 * Where a to-do lands on the Captains page: that match's controls, scrolled
 * to one card when `anchor` is given.
 */
export function captainsMatchHref(matchId: string, anchor?: string): string {
  return captainsHref({ match: matchId }, anchor);
}
