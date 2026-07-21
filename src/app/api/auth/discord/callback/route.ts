import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import {
  DISCORD_OAUTH_COOKIE,
  DISCORD_OAUTH_COOKIE_PATH,
} from "@/lib/discord-oauth";
import { handleDiscordCallback } from "@/lib/discord-link-service";

// Thin shell over handleDiscordCallback (all guards + branches live there,
// integration-tested). Every exit clears the one-shot state cookie and lands
// on a fixed same-origin path — never anything derived from the query.
export async function GET(req: NextRequest) {
  // Triggers outbound calls to Discord — same per-IP speed bump as the Steam
  // callback (best-effort, per-instance).
  const ip = clientIp(req);
  if (
    !rateLimit(`auth:discord:${ip}`, { limit: 10, windowMs: 60_000 }, Date.now())
      .allowed
  ) {
    const limited = NextResponse.redirect(new URL("/me?discord=error", req.url));
    limited.cookies.delete({
      name: DISCORD_OAUTH_COOKIE,
      path: DISCORD_OAUTH_COOKIE_PATH,
    });
    return limited;
  }

  const user = await getSessionUser();
  const q = req.nextUrl.searchParams;
  const { redirect } = await handleDiscordCallback(prisma, {
    userId: user?.id ?? null,
    code: q.get("code"),
    state: q.get("state"),
    errorParam: q.get("error"),
    cookie: req.cookies.get(DISCORD_OAUTH_COOKIE)?.value ?? null,
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
