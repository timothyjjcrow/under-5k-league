import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import {
  DISCORD_OAUTH_COOKIE,
  DISCORD_OAUTH_COOKIE_PATH,
  safeEqual,
  unpackOauthCookie,
} from "@/lib/discord-oauth";
import { handleDiscordCallback } from "@/lib/discord-link-service";

// Thin shell over handleDiscordCallback (all guards + branches live there,
// integration-tested). Every exit clears the one-shot state cookie and lands
// on a fixed same-origin path — never anything derived from the query.
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  const q = req.nextUrl.searchParams;
  const states = q.getAll("state");
  const codes = q.getAll("code");
  const state = states.length === 1 ? states[0] : null;
  const code = codes.length === 1 ? codes[0] : null;
  const cookie = req.cookies.get(DISCORD_OAUTH_COOKIE)?.value ?? null;
  const packed = unpackOauthCookie(cookie);
  const errorParam = q.get("error");

  // Only a callback that passed the cheap local session/state/user checks can
  // trigger outbound Discord work, so only that callback spends the shared-IP
  // budget. Forged callbacks and normal consent cancellation cannot exhaust a
  // household/NAT's ten real linking attempts.
  const canReachDiscord =
    !!user &&
    !errorParam &&
    !!code &&
    !!state &&
    !!packed &&
    safeEqual(packed.state, state) &&
    safeEqual(packed.userId, user.id);
  if (canReachDiscord) {
    const ip = clientIp(req);
    if (
      !rateLimit(
        `auth:discord:${ip}`,
        { limit: 10, windowMs: 60_000 },
        Date.now(),
      ).allowed
    ) {
      const limited = NextResponse.redirect(
        new URL("/me?discord=error", req.url),
      );
      limited.cookies.delete({
        name: DISCORD_OAUTH_COOKIE,
        path: DISCORD_OAUTH_COOKIE_PATH,
      });
      return limited;
    }
  }

  const { redirect } = await handleDiscordCallback(prisma, {
    userId: user?.id ?? null,
    code,
    state,
    errorParam,
    cookie,
    clientId: process.env.DISCORD_CLIENT_ID ?? "",
    clientSecret: process.env.DISCORD_CLIENT_SECRET ?? "",
    redirectUri: `${process.env.APP_URL || req.nextUrl.origin}/api/auth/discord/callback`,
  });

  const res = NextResponse.redirect(new URL(redirect, req.url));
  res.cookies.delete({
    name: DISCORD_OAUTH_COOKIE,
    path: DISCORD_OAUTH_COOKIE_PATH,
  });
  return res;
}
