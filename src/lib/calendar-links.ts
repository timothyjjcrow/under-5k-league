import { resolveSiteUrl } from "./site-url";

/**
 * The two ways to take the league calendar. The download is a one-off copy:
 * calendar apps never look at it again, so a moved match keeps its old time.
 * The webcal:// subscription is re-fetched by the calendar app, so retimes
 * reach players on their own.
 */
export function calendarFeedLinks(teamId?: string, site = resolveSiteUrl()) {
  const path = teamId
    ? `/api/calendar?team=${encodeURIComponent(teamId)}`
    : "/api/calendar";
  return {
    download: path,
    subscribe: `${site.replace(/^https?:\/\//i, "webcal://")}${path}`,
  };
}
