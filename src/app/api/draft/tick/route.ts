import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { getDraftState } from "@/lib/draft-service";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Polled by the draft room. Also lazily resolves any expired nomination so the
// auction advances even when nobody is actively clicking.
export async function POST(req: NextRequest) {
  // Unauthenticated + runs two resolver transactions per hit — same per-IP
  // speed bump as /api/sync and /api/inhouse. Generous: the room polls at
  // ~1.2s (≈50/min per tab) and captains may have a couple of tabs open.
  const ip = clientIp(req);
  if (
    !rateLimit(`draft:${ip}`, { limit: 300, windowMs: 60_000 }, Date.now())
      .allowed
  ) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const [user, season] = await Promise.all([
    getSessionUser(),
    getActiveSeason(),
  ]);
  if (!season) {
    return NextResponse.json({ error: "No active season" }, { status: 404 });
  }
  const state = await getDraftState(season.id, user);
  return NextResponse.json(state);
}
