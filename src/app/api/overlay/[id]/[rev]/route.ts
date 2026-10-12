import { NextResponse } from "next/server";
import {
  OVERLAY_DATA_HEADERS,
  OVERLAY_MATCH_ID,
  OVERLAY_MISSING_HEADERS,
  OVERLAY_REVISION,
} from "@/lib/stream-overlay-page";
import { loadStreamOverlay } from "@/lib/stream-overlay-service";

// The OBS overlay's data: one fixture's teams, score and player cards
// (stream-overlay.ts). Read-only and the same for every viewer. The version
// segment changes when a result does (or every ten minutes until the series
// is decided), so Vercel's CDN can keep each answer: an overlay open all
// night costs a handful of function calls, not one per poll.
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; rev: string }> },
) {
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
