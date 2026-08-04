import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { getDraftState } from "@/lib/draft-service";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { requireExpectedDraftSeason } from "@/lib/draft-http";
import { guardJsonMutation } from "@/lib/json-mutation";

export const dynamic = "force-dynamic";

// Polled by the draft room. Also lazily resolves any expired nomination so the
// auction advances even when nobody is actively clicking.
export async function POST(req: NextRequest) {
  const invalidRequest = guardJsonMutation(req);
  if (invalidRequest) return invalidRequest;

  // Unauthenticated + runs two resolver transactions per hit — same per-IP
  // speed bump as /api/sync and /api/inhouse. Generous: the room polls at
  // ~1.2s (≈50/min per tab) and captains may have a couple of tabs open.
  const ip = clientIp(req);
  if (
    !rateLimit(
      `draft:preflight:ip:${ip}`,
      { limit: 1200, windowMs: 60_000 },
      Date.now(),
    ).allowed
  ) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const [user, season, body] = await Promise.all([
    getSessionUser(),
    getActiveSeason(),
    req.json().catch(() => ({})),
  ]);
  if (
    user &&
    !rateLimit(
      `draft:user:${user.id}`,
      { limit: 300, windowMs: 60_000 },
      Date.now(),
    ).allowed
  ) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  if (!season) {
    return NextResponse.json({ error: "No active season" }, { status: 404 });
  }
  const expectedSeason = requireExpectedDraftSeason(body, season.id);
  if (!expectedSeason.ok) {
    return NextResponse.json({ error: expectedSeason.error }, { status: 409 });
  }
  const state = await getDraftState(season.id, user);
  return NextResponse.json(state, {
    headers: { "cache-control": "no-store" },
  });
}
