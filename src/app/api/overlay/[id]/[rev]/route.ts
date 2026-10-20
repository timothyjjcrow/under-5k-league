import { NextResponse } from "next/server";
import {
  OVERLAY_DATA_HEADERS,
  OVERLAY_MATCH_ID,
  OVERLAY_MISSING_HEADERS,
  OVERLAY_REVISION,
} from "@/lib/stream-overlay-page";
import { limitPublicGet } from "@/lib/public-get-limit";
import { loadStreamOverlay } from "@/lib/stream-overlay-service";

// The OBS overlay's data: one fixture's teams, score and player cards
// (stream-overlay.ts). Read-only and the same for every viewer. The version
// segment changes when a result does (or every ten minutes until the series
// is decided), so an edge cache could keep each answer (Vercel's did): an
// overlay open all night asks a handful of times, not once per poll. On the
// box nothing caches it, and a version is whatever the caller types, so one
// address gets `PUBLIC_GET_LIMITS.overlay` before any database work. No memo:
// keyed by the version, a made-up version walks past it; keyed by the match
// alone, it could hand a new version the answer from before the result that
// moved it, and the overlay would show that for up to ten minutes.
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; rev: string }> },
) {
  const limited = limitPublicGet(request, "overlay", Date.now());
  if (limited) return limited;
  const { id, rev } = await params;
  const payload =
    OVERLAY_MATCH_ID.test(id) && OVERLAY_REVISION.test(rev)
      ? await loadStreamOverlay(id)
      : null;
  if (!payload) {
    return NextResponse.json(
      { error: "not-found" },
      { status: 404, headers: OVERLAY_MISSING_HEADERS },
    );
  }
  return NextResponse.json(payload, { headers: OVERLAY_DATA_HEADERS });
}
