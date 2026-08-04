import { NextRequest, NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { runResultSync } from "@/lib/result-sync-service";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { getActiveSeason } from "@/lib/season";
import { maybeAnnounceUpcomingWeek } from "@/lib/reminder-service";

export const dynamic = "force-dynamic";
// One roster scan is up to ~22 sequential OpenDota fetches; on a slow night
// that outruns the platform default and the request is killed mid-scan, which
// also makes an uptime monitor pointed at this endpoint page the admin about a
// perfectly healthy site. The scan has its own deadline (SCAN_BUDGET_MS in
// match-import.ts) — this just gives it room to finish and return cleanly.
export const maxDuration = 60;

// The sitewide automation trigger, POSTed by <ResultSyncPing> on page views
// (and polled faster while a match, inhouse lobby, or draft clock is live). A
// route handler — not a server-component ping like <WeekReminderPing> —
// because imported games must
// bust the unstable_cache "games" tag, and revalidateTag is only legal from a
// request scope (CLAUDE.md), never mid-render.
async function handleSync(req: NextRequest) {
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
    // Route Handlers cannot call updateTag. A zero-expiry profile gives the
    // next stats request a blocking fresh read instead of stale-while-refresh.
    revalidateTag("games", { expire: 0 });
    revalidatePath("/", "layout");
  }
  // The same endpoint external uptime monitors already ping is the durable
  // backstop for match-night reminders. Page-render triggers remain useful,
  // but attendance cannot depend on somebody visiting / or /schedule during a
  // narrow 24-hour window. This side effect is best-effort: a Discord/DB issue
  // must not turn a healthy result-sync heartbeat into a 500.
  try {
    const season = await getActiveSeason();
    if (season) await maybeAnnounceUpcomingWeek(season);
  } catch {
    // The reminder service retains/releases its own idempotency marker. A later
    // heartbeat or page render can retry without changing this route contract.
  }
  // `updated` = THIS request imported a result, recorded an inhouse result,
  // advanced a due draft clock, or repaired the playoff bracket/champion (its
  // claim won). `cursor` moves for every viewer whenever ANY result path lands
  // a result — the client refreshes on either, so parked dashboards that lost
  // a result claim race still repaint.
  return NextResponse.json(
    {
      updated: out.imported > 0 || out.inhouse || out.draft || out.playoff,
      watch: out.watch,
      cursor: out.cursor,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  return handleSync(req);
}

// GET exists for external pingers (a free 5-minute uptime monitor): the whole
// lazy automation layer otherwise only runs while a human has a page open —
// a match finishing at 1am with no visitors would wait until morning, and
// site downtime itself would alert no one. Same throttled sync, so pointing a
// monitor here buys a sync backstop AND downtime alerting in one move.
export async function GET(req: NextRequest) {
  return handleSync(req);
}
