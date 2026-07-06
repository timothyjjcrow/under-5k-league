import { NextRequest, NextResponse } from "next/server";
import { buildSteamLoginUrl } from "@/lib/steam";

// Kicks off Steam sign-in by redirecting to Steam's OpenID endpoint.
export async function GET(req: NextRequest) {
  const base = process.env.APP_URL || req.nextUrl.origin;
  const returnTo = `${base}/api/auth/steam/callback`;
  return NextResponse.redirect(buildSteamLoginUrl(returnTo, base));
}
