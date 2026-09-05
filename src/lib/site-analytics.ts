import type { BeforeSendEvent } from "@vercel/analytics";

/** Keep account/admin activity and URL query values out of traffic reports. */
export function publicPageView(event: BeforeSendEvent): BeforeSendEvent | null {
  if (event.type !== "pageview") return null;

  const url = new URL(event.url);
  if (/^\/(admin|api|login|logout|me)(\/|$)/.test(url.pathname)) return null;

  url.search = "";
  url.hash = "";
  return { ...event, url: url.toString() };
}
