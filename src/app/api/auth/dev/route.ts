import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/auth";
import { upsertLeagueUser } from "@/lib/users";
import { safeReturnPath } from "@/lib/return-path";

// Mock login for local development and automated tests. Disabled unless
// ALLOW_DEV_LOGIN=true, and hard-blocked in production regardless (defense in
// depth so a stray env var can never open this backdoor on the live site).
export async function GET(req: NextRequest) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ALLOW_DEV_LOGIN !== "true"
  ) {
    return NextResponse.json({ error: "dev login disabled" }, { status: 403 });
  }
  const p = req.nextUrl.searchParams;
  const name = p.get("name") || "Dev Player";
  const steamId =
    p.get("steamId") || "7656119" + Math.random().toString().slice(2, 12);
  const forceAdmin = p.get("admin") === "1" || p.get("admin") === "true";
  const redirectTo = safeReturnPath(p.get("redirect")) ?? "/";

  const user = await upsertLeagueUser(prisma, {
    steamId,
    name,
    avatar: null,
    profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
    forceAdmin,
  });
  await createSession(user.id);
  return NextResponse.redirect(new URL(redirectTo, req.url));
}
