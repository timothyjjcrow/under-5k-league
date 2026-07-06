import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/auth";
import { upsertLeagueUser } from "@/lib/users";

// Mock login for local development and automated tests. Disabled unless
// ALLOW_DEV_LOGIN=true. Never enable in production.
export async function GET(req: NextRequest) {
  if (process.env.ALLOW_DEV_LOGIN !== "true") {
    return NextResponse.json({ error: "dev login disabled" }, { status: 403 });
  }
  const p = req.nextUrl.searchParams;
  const name = p.get("name") || "Dev Player";
  const steamId =
    p.get("steamId") || "7656119" + Math.random().toString().slice(2, 12);
  const forceAdmin = p.get("admin") === "1" || p.get("admin") === "true";
  const redirectTo = p.get("redirect") || "/";

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
