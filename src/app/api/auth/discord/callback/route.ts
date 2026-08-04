import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import {
  DISCORD_OAUTH_COOKIE,
  isDiscordOauthValue,
  safeEqual,
  unpackOauthCookie,
} from "@/lib/discord-oauth";
import { handleDiscordCallback } from "@/lib/discord-link-service";
import { expireHttpOnlyCookie } from "@/lib/cookie-policy";

// Thin shell over handleDiscordCallback (all guards + branches live there,
// integration-tested). Every exit clears the one-shot state cookie and lands
// on a fixed same-origin path — never anything derived from the query.
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  // Provider callbacks are small. Reject an oversized URL before session/DB
  // work and never reflect any of it into logs or a redirect.
  if (req.nextUrl.search.length > 4096) {
    return NextResponse.redirect(new URL("/me?discord=error", req.url));
  }

  const user = await getSessionUser();
  const states = q.getAll("state");
  const codes = q.getAll("code");
  const state =
    states.length === 1 && isDiscordOauthValue(states[0]!) ? states[0] : null;
  const code =
    codes.length === 1 && codes[0]!.length > 0 && codes[0]!.length <= 1024
      ? codes[0]
      : null;
  const cookie = req.cookies.get(DISCORD_OAUTH_COOKIE)?.value ?? null;
  const packed = unpackOauthCookie(cookie);
  const errors = q.getAll("error");
  const errorParam =
    errors.length === 1 && errors[0]!.length <= 128 ? errors[0] : null;

  // Only a callback that passed the cheap local session/state/user checks can
  // trigger outbound Discord work, so only that callback spends the shared-IP
  // budget. Forged callbacks and normal consent cancellation cannot exhaust a
  // household/NAT's ten real linking attempts.
  const flowBound =
    !!user &&
    !!state &&
    !!packed &&
    safeEqual(packed.state, state) &&
    safeEqual(packed.userId, user.id);
  const canReachDiscord = flowBound && !errorParam && !!code;
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
      expireHttpOnlyCookie(limited.cookies, DISCORD_OAUTH_COOKIE);
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
  // Consume the one-shot cookie only for a callback proven to belong to this
  // browser/user. An unsolicited or mismatched top-level GET must not cancel a
  // legitimate linking flow already open in another tab.
  if (flowBound) expireHttpOnlyCookie(res.cookies, DISCORD_OAUTH_COOKIE);
  return res;
}
