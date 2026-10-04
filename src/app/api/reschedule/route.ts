import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit, retryAfterSeconds } from "@/lib/rate-limit";
import { loadReadyCheckViewById } from "@/lib/reschedule-ready-check-service";

export const dynamic = "force-dynamic";

const RATE_WINDOW_MS = 60_000;
// The card polls every 15s while its tab is visible; ten players behind one
// venue NAT stay far under this.
const RATE_LIMIT = 240;

/**
 * GET /api/reschedule?match=<id> — the open reschedule ready check on one
 * match, as the signed-in viewer may see it (`{ view: null }` when there is
 * none). The match page's ready-check card polls it so answers fill in live.
 * Read-only and harmless if a browser loads it as an image: it never writes,
 * advances state or calls Discord.
 */
export async function GET(req: NextRequest) {
  const allowance = rateLimit(
    `reschedule:state:ip:${clientIp(req)}`,
    { limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS },
    Date.now(),
  );
  if (!allowance.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "retry-after": retryAfterSeconds(allowance) } },
    );
  }
  // One match: a repeated key is malformed, never "the first one".
  const ids = req.nextUrl.searchParams.getAll("match");
  const matchId = ids.length === 1 ? ids[0].trim() : "";
  if (!matchId) {
    return NextResponse.json({ error: "One match id is required" }, { status: 400 });
  }
  const viewer = await getSessionUser();
  const view = await loadReadyCheckViewById(matchId, viewer, Date.now());
  return NextResponse.json(
    { view },
    // Viewer-tailored (names for captains and admins only): never shared.
    { headers: { "cache-control": "private, no-store" } },
  );
}
