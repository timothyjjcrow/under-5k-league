import { NextRequest, NextResponse } from "next/server";
import { buildSteamLoginUrl } from "@/lib/steam";
import { RETURN_COOKIE, safeReturnPath } from "@/lib/return-path";

// Kicks off Steam sign-in by redirecting to Steam's OpenID endpoint. A
// validated ?next= (same-origin relative path) rides a short-lived httpOnly
// cookie so the callback can land the user back where they clicked Sign in,
// keeping the OpenID return_to canonical.
export async function GET(req: NextRequest) {
  const base = process.env.APP_URL || req.nextUrl.origin;
  const returnTo = `${base}/api/auth/steam/callback`;
  const res = NextResponse.redirect(buildSteamLoginUrl(returnTo, base));

  const next = safeReturnPath(req.nextUrl.searchParams.get("next"));
  if (next && next !== "/") {
    res.cookies.set(RETURN_COOKIE, next, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600, // the Steam round-trip takes seconds, not days
    });
  }
  return res;
}
