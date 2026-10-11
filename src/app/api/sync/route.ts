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
        // Vercel's CDN answers every tab in a region from one origin snapshot
        // for 30 seconds: a CDN hit is no function call, on a hosting budget
        // both leagues share. Parked tabs ping at most once a minute, so a
        // result reaches them within about a minute and a half.
        "cache-control": "public, max-age=0, must-revalidate",
        "vercel-cdn-cache-control":
          "public, max-age=30, stale-while-revalidate=30",
      },
    },
  );
}
