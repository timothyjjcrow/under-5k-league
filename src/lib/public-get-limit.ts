import { NextResponse } from "next/server";
import { clientIp, rateLimit, retryAfterSeconds } from "./rate-limit";

// Per-IP ceilings for the public GETs that read the database with no session
// and no other limit: the calendar files and the stream overlay's data. The
// zone's one Cloudflare rule leaves `/api/` to this in-process limiter
// (DECISIONS.md, 2026-10-18), and no edge cache sits in front on the box, so
// without these one looping client spends the one vCPU both leagues and
// Postgres share. Each is a ceiling for one address, far above what its
// callers send; the calendar feed's own memo is what caps its database work.
export const PUBLIC_GET_LIMITS = {
  // `/api/calendar` and the inhouse night and Play later downloads, in one
  // bucket. Google, Apple and Microsoft fetch subscriptions from a few shared
  // addresses on behalf of every subscriber, so this must stay generous: the
  // feed asks for an hourly refresh (REFRESH-INTERVAL PT1H, ics.ts) and Google
  // picks a slower one, so even a thousand subscriptions fetched through one
  // address are under 20 a minute.
  calendar: { limit: 600, windowMs: 60_000, body: "text" },
  // `/api/overlay/[id]/[rev]`. An OBS source asks once per data version (a
  // result, or every ten minutes) and keeps what it shows on a refusal, so a
  // room of casters behind one address with every layout open stays far under
  // this.
  overlay: { limit: 60, windowMs: 60_000, body: "json" },
} as const;

export type PublicGetScope = keyof typeof PUBLIC_GET_LIMITS;

/**
 * Count one request from the caller's address against `scope`'s bucket: null
 * when it may go ahead, else a 429 with Retry-After to send instead (before
 * any database work). Never cached, so a refusal can't outlive its window.
 */
export function limitPublicGet(
  req: { headers: { get(name: string): string | null } },
  scope: PublicGetScope,
  nowMs: number,
): NextResponse | null {
  const { limit, windowMs, body } = PUBLIC_GET_LIMITS[scope];
  const allowance = rateLimit(
    `${scope}:ip:${clientIp(req)}`,
    { limit, windowMs },
    nowMs,
  );
  if (allowance.allowed) return null;
  const init = {
    status: 429,
    headers: {
      "retry-after": retryAfterSeconds(allowance),
      "cache-control": "no-store",
    },
  };
  return body === "json"
    ? NextResponse.json({ error: "Too many requests" }, init)
    : new NextResponse("Too many requests", init);
}
