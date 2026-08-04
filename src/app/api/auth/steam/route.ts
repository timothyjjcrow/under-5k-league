import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { buildSteamLoginUrl } from "@/lib/steam";
import {
  RETURN_COOKIE,
  STEAM_STATE_COOKIE,
  safeReturnPath,
} from "@/lib/return-path";

// Kicks off Steam sign-in by redirecting to Steam's OpenID endpoint. A
// validated ?next= (same-origin relative path) rides a short-lived httpOnly
// cookie so the callback can land the user back where they clicked Sign in,
// keeping the OpenID return_to canonical.
export async function GET(req: NextRequest) {
  const base = process.env.APP_URL || req.nextUrl.origin;
  const state = randomBytes(32).toString("base64url");
  const returnTo = new URL("/api/auth/steam/callback", base);
  returnTo.searchParams.set("state", state);
  const res = NextResponse.redirect(
    buildSteamLoginUrl(returnTo.toString(), base),
  );

  res.cookies.set(STEAM_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  const next = safeReturnPath(req.nextUrl.searchParams.get("next"));
  if (next && next !== "/") {
    res.cookies.set(RETURN_COOKIE, next, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 600, // the Steam round-trip takes seconds, not days
    });
  } else {
    // A player can abandon one Steam round-trip and start another before the
    // ten-minute cookie expires. Starting without a destination must clear the
    // old intent, or an unrelated later sign-in can unexpectedly land there.
    res.cookies.delete(RETURN_COOKIE);
  }
  return res;
}
