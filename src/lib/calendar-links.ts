import { resolveSiteUrl } from "./site-url";

/**
 * The ways to take the league calendar. The download is a one-off copy:
 * calendar apps never look at it again, so a moved match keeps its old time.
 * The webcal:// subscription is re-fetched by the calendar app (Apple
 * Calendar, Outlook), so retimes reach players on their own. Google Calendar
 * won't open a webcal:// link, so it gets its own "add by URL" link that
 * subscribes to the same feed.
 */
export function calendarFeedLinks(
  teamId?: string | null,
  site = resolveSiteUrl(),
) {
  const path = teamId
    ? `/api/calendar?team=${encodeURIComponent(teamId)}`
    : "/api/calendar";
  const subscribe = `${site.replace(/^https?:\/\//i, "webcal://")}${path}`;
  return {
    download: path,
    subscribe,
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(subscribe)}`,
  };
}
