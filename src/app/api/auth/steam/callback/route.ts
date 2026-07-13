import { NextRequest, NextResponse } from "next/server";
import { verifySteamCallback, fetchSteamProfile } from "@/lib/steam";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/auth";
import { upsertLeagueUser, ensureRankTier } from "@/lib/users";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
  // Unauthenticated + triggers outbound calls to Steam/OpenDota — throttle per
  // IP as a speed bump against amplification/abuse (best-effort, per-instance).
  const ip = clientIp(req);
  if (
    !rateLimit(`auth:steam:${ip}`, { limit: 20, windowMs: 60_000 }, Date.now())
      .allowed
  ) {
    return NextResponse.redirect(new URL("/login?error=rate", req.url));
  }

  // Pin the assertion to our own callback URL (must match how /api/auth/steam
  // built openid.return_to).
  const base = process.env.APP_URL || req.nextUrl.origin;
  const expectedReturnTo = `${base}/api/auth/steam/callback`;

  const steamId = await verifySteamCallback(
    req.nextUrl.searchParams,
    expectedReturnTo,
  );
  if (!steamId) {
    return NextResponse.redirect(new URL("/login?error=steam", req.url));
  }
  const profile = await fetchSteamProfile(steamId);
  const user = await upsertLeagueUser(prisma, {
    steamId,
    name: profile.name,
    avatar: profile.avatar,
    profileUrl: profile.profileUrl,
  });
  // Pull their ranked medal now so accounts that log in but never sign up still
  // show one (best-effort; a no-op once they have a medal).
  await ensureRankTier(prisma, user);
  await createSession(user.id);
  return NextResponse.redirect(new URL("/", req.url));
}
