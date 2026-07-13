import { NextRequest, NextResponse } from "next/server";
import { verifySteamCallback, fetchSteamProfile } from "@/lib/steam";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/auth";
import { upsertLeagueUser, ensureRankTier } from "@/lib/users";

export async function GET(req: NextRequest) {
  const steamId = await verifySteamCallback(req.nextUrl.searchParams);
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
