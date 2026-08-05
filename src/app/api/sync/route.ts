import { NextResponse } from "next/server";
import { getResultSyncSnapshot } from "@/lib/result-sync-status";

export const dynamic = "force-dynamic";

// Public clients only observe automation state. The authenticated scheduler is
// the sole worker trigger, so page traffic can neither mutate league data nor
// multiply third-party calls across tabs and visitors.
export async function GET() {
  const snapshot = await getResultSyncSnapshot();
  return NextResponse.json(
    {
      updated: false,
      watch: snapshot.watch,
      cursor: snapshot.cursor,
    },
    {
      headers: {
        // The payload is viewer-independent. Browsers always revalidate, while
        // Vercel collapses a burst of tabs into one origin snapshot for five
        // seconds. The worker cadence is one minute, so this cannot hide a
        // state transition longer than the clients already tolerate.
        "cache-control": "public, max-age=0, must-revalidate",
        "vercel-cdn-cache-control":
          "public, max-age=5, stale-while-revalidate=10",
      },
    },
  );
}
