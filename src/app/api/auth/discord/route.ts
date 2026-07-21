import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  DISCORD_OAUTH_COOKIE,
  DISCORD_OAUTH_COOKIE_PATH,
  DISCORD_OAUTH_MAX_AGE,
  buildDiscordAuthUrl,
  codeChallengeS256,
  packOauthCookie,
  randomOauthValue,
} from "@/lib/discord-oauth";

// Kicks off Discord account LINKING (not login — a session is required, so
// the callback knows exactly which site account the proven Discord identity
// belongs to). State + PKCE verifier ride a short-lived httpOnly cookie,
// mirroring the Steam return-path cookie.
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login?next=/me", req.url));
  }

  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId || !process.env.DISCORD_CLIENT_SECRET) {
    return NextResponse.redirect(new URL("/me?discord=unconfigured", req.url));
  }

  const base = process.env.APP_URL || req.nextUrl.origin;
  const state = randomOauthValue();
  const verifier = randomOauthValue();

  const res = NextResponse.redirect(
    buildDiscordAuthUrl({
      clientId,
      redirectUri: `${base}/api/auth/discord/callback`,
      state,
      codeChallenge: codeChallengeS256(verifier),
    }),
  );
  res.cookies.set(DISCORD_OAUTH_COOKIE, packOauthCookie(state, verifier), {
    httpOnly: true,
    sameSite: "lax", // the callback arrives as a top-level nav from discord.com
    secure: process.env.NODE_ENV === "production",
    path: DISCORD_OAUTH_COOKIE_PATH,
    maxAge: DISCORD_OAUTH_MAX_AGE,
  });
  return res;
}
