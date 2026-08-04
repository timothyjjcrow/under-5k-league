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
    { headers: { "cache-control": "no-store" } },
  );
}
