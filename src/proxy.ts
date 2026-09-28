import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";
import {
  refreshSessionToken,
  sessionCookieOptions,
} from "@/lib/session-token";

/**
 * Keeps active players signed in. A sign-in used to last exactly 30 days
 * however often someone visited, so every regular player was signed out
 * partway through a season. On a page visit with a session more than a week
 * old, this re-issues it for another 30 days (session-token.ts has the rules
 * and the absolute cap).
 *
 * Deliberately small: no database, no redirects, nothing that can refuse a
 * request. Whether the session still counts (the revoke-all epoch, the user
 * row, the admin allowlist) is decided by getSessionUser on every request,
 * and the re-issued token keeps the same user, epoch and sign-in time, so
 * all of that works exactly as before. Only GET page loads are touched:
 * sign-in, sign-out and every other /api route set or clear the cookie
 * themselves, and a form post (server action) is left alone.
 */
export async function proxy(request: NextRequest) {
  const response = NextResponse.next();
  if (request.method !== "GET") return response;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return response;
  try {
    const fresh = await refreshSessionToken(token);
    if (fresh) {
      response.cookies.set(SESSION_COOKIE, fresh, sessionCookieOptions());
    }
  } catch {
    // Never let a re-issue failure break a page; the old cookie still works.
  }
  return response;
}

export const config = {
  // Pages only: not /api, Next's static files and image optimizer, or any
  // file with an extension (icons, images, robots.txt, the hero video). And
  // only requests that carry a session cookie: signed-out page views,
  // crawlers and their prefetches would pay for a proxy call that can do
  // nothing. Next reads this object at build time and resolves no names, so
  // everything here is a literal: the session cookie is "__Host-ld2l_session"
  // in production and "ld2l_session" in development, and proxy.test.ts keeps
  // both in step with SESSION_COOKIE.
  matcher: [
    {
      source: "/((?!api/|_next/static/|_next/image|.*\\.[A-Za-z0-9]+$).*)",
      has: [{ type: "cookie", key: "__Host-ld2l_session" }],
    },
    {
      source: "/((?!api/|_next/static/|_next/image|.*\\.[A-Za-z0-9]+$).*)",
      has: [{ type: "cookie", key: "ld2l_session" }],
    },
  ],
};
