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

/**
 * Where a to-do or a match chip lands on the Captains page: that match's
 * controls, scrolled to one card when `anchor` is given.
 */
export function captainsMatchHref(matchId: string, anchor?: string): string {
  return `${CAPTAINS_HREF}?match=${encodeURIComponent(matchId)}${anchor ? `#${anchor}` : ""}`;
}
