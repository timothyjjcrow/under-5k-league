import { NextRequest, NextResponse } from "next/server";
import { verifySteamCallback, fetchSteamProfile } from "@/lib/steam";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/auth";
import { upsertLeagueUser, ensureRankTier, ensurePubStats } from "@/lib/users";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import {
  RETURN_COOKIE,
  STEAM_STATE_COOKIE,
  safeReturnPath,
} from "@/lib/return-path";
import { expireHttpOnlyCookie } from "@/lib/cookie-policy";

function failedLogin(
  req: NextRequest,
  error: "rate" | "steam",
  { consumeFlow = true }: { consumeFlow?: boolean } = {},
) {
  const target = new URL("/login", req.url);
  target.searchParams.set("error", error);
  const next = safeReturnPath(req.cookies.get(RETURN_COOKIE)?.value);
  if (next && next !== "/") target.searchParams.set("next", next);
  const res = NextResponse.redirect(target);
  // Once this callback has been bound to the initiating browser, the login
  // page owns the retry destination in its validated `next` parameter. Clear
  // the one-shot cookies on every bound callback exit so a failed attempt
  // never leaks into a later sign-in. Unbound callbacks leave them untouched.
  if (consumeFlow) {
    expireHttpOnlyCookie(res.cookies, RETURN_COOKIE);
    expireHttpOnlyCookie(res.cookies, STEAM_STATE_COOKIE);
  }
  return res;
}

export async function GET(req: NextRequest) {
  if (req.nextUrl.search.length > 16_384) {
    return failedLogin(req, "steam", { consumeFlow: false });
  }
  // Bind the callback to the browser that initiated this OpenID round-trip.
  // A valid Steam assertion alone is not enough: without this one-shot state,
  // an attacker can make another browser log into the attacker's account.
  const callbackStates = req.nextUrl.searchParams.getAll("state");
  const callbackState = callbackStates.length === 1 ? callbackStates[0] : null;
  const cookieState = req.cookies.get(STEAM_STATE_COOKIE)?.value;
  if (
    !callbackState ||
    !cookieState ||
    callbackState.length > 128 ||
    callbackState !== cookieState
  ) {
    // Do not let an unsolicited or mismatched callback erase a legitimate
    // browser-bound flow already in progress in another tab.
    return failedLogin(req, "steam", { consumeFlow: false });
  }

  // Only a browser-bound callback can spend this IP budget. Invalid requests
  // are rejected above without letting an attacker exhaust sign-in attempts
  // for everyone behind the same school, venue, or household connection.
  // Valid callbacks trigger outbound Steam/OpenDota calls, so retain the
  // best-effort per-instance limit here.
  const ip = clientIp(req);
  if (
    !rateLimit(`auth:steam:${ip}`, { limit: 20, windowMs: 60_000 }, Date.now())
      .allowed
  ) {
    return failedLogin(req, "rate");
  }

  // Pin the assertion to our own callback URL (must match how /api/auth/steam
  // built openid.return_to).
  const base = process.env.APP_URL || req.nextUrl.origin;
  const expectedReturnTo = new URL("/api/auth/steam/callback", base);
  expectedReturnTo.searchParams.set("state", callbackState);

  const steamId = await verifySteamCallback(
    req.nextUrl.searchParams,
    expectedReturnTo.toString(),
  );
  if (!steamId) {
    return failedLogin(req, "steam");
  }
  // null = Steam unreachable; upsertLeagueUser then keeps whatever profile the
  // account already has instead of stamping a placeholder over it.
  const profile = await fetchSteamProfile(steamId);
  const user = await upsertLeagueUser(prisma, { steamId, profile });
  // Pull their ranked medal + pub-scouting snapshot now so accounts that log
  // in but never sign up still show them (best-effort; the medal is a no-op
  // once set, the snapshot once fresh). In parallel — they're independent
  // OpenDota calls and login shouldn't pay them serially.
  await Promise.all([
    ensureRankTier(prisma, user),
    ensurePubStats(prisma, user),
  ]);
  await createSession(user.id);
  // Land back where they clicked Sign in (validated again — the cookie is
  // ours, but defense in depth is free), clearing the one-shot cookie.
  const next = safeReturnPath(req.cookies.get(RETURN_COOKIE)?.value) ?? "/";
  const res = NextResponse.redirect(new URL(next, req.url));
  expireHttpOnlyCookie(res.cookies, RETURN_COOKIE);
  expireHttpOnlyCookie(res.cookies, STEAM_STATE_COOKIE);
  return res;
}
