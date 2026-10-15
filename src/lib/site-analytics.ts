import type { BeforeSendEvent } from "@vercel/analytics";

/**
 * Whether this deployment counts traffic with Vercel Web Analytics: exactly
 * Vercel production. Previews, local development, the tests and the
 * self-hosted league box (which counts traffic in Cloudflare's zone analytics
 * instead) load no analytics script. The layout mounts <SiteAnalytics>, and
 * /admin shows its "Website traffic" link, only behind this; source guards in
 * site-analytics.test.ts and web-analytics.test.ts keep both call sites on it.
 */
export function siteAnalyticsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.VERCEL_ENV === "production";
}

/** Keep account/admin activity and URL query values out of traffic reports. */
export function publicPageView(event: BeforeSendEvent): BeforeSendEvent | null {
  if (event.type !== "pageview") return null;

  const url = new URL(event.url);
  if (/^\/(admin|api|login|logout|me)(\/|$)/.test(url.pathname)) return null;

  url.search = "";
  url.hash = "";
  return { ...event, url: url.toString() };
}
