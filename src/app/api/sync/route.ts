import { NextRequest, NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { runResultSync } from "@/lib/result-sync-service";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// The automatic-result-sync trigger, POSTed by the sitewide <ResultSyncPing>
// on page views (and slow-polled on match nights). A route handler — not a
// server-component ping like <WeekReminderPing> — because imported games must
// bust the unstable_cache "games" tag, and revalidateTag is only legal from a
// request scope (CLAUDE.md), never mid-render.
export async function POST(req: NextRequest) {
  // Unauthenticated + triggers outbound OpenDota calls — same per-IP speed
  // bump as the Steam callback. The service's atomic claims are the real
  // budget guard; this just stops one source hammering the endpoint.
  const ip = clientIp(req);
  if (
    !rateLimit(`sync:${ip}`, { limit: 30, windowMs: 60_000 }, Date.now())
      .allowed
  ) {
    return NextResponse.json(
      { updated: false, watch: false, cursor: null },
      { status: 429 },
    );
  }

  const out = await runResultSync();
  if (out.imported > 0) {
    // New games change every cached stat roll-up — mirror refreshGames().
    revalidateTag("games", "max");
    revalidatePath("/", "layout");
  }
  // `updated` = THIS request performed the import (its claim won). `cursor`
  // moves for every viewer whenever ANY path lands a result — the client
  // refreshes on either, so parked dashboards that lost the claim race (or
  // never raced) still repaint.
  return NextResponse.json({
    updated: out.imported > 0 || out.inhouse,
    watch: out.watch,
    cursor: out.cursor,
  });
}
