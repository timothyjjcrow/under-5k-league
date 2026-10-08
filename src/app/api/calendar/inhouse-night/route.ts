import { NextResponse } from "next/server";
import { buildCalendar } from "@/lib/ics";
import { currentInhouseNight, inhouseNightCalendarEvent } from "@/lib/inhouse-night";
import { readInhouseNight } from "@/lib/inhouse-night-service";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { resolveSiteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

/**
 * The inhouse night as a one-event calendar file, for "Add to Apple or
 * Outlook calendar" on /inhouse. A download, not a feed: the UID and SEQUENCE
 * (the night's id and revision) let a calendar app that re-imports it update
 * its copy. Read-only, so a browser loading it as an image changes nothing.
 */
export async function GET() {
  const { night } = await readInhouseNight();
  const current = currentInhouseNight(night, Date.now());
  if (!current) {
    return new NextResponse("No inhouse night is planned", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  const league = LEAGUE_CONFIG.name;
  const calendar = buildCalendar(`${league} inhouse night`, [
    inhouseNightCalendarEvent(current, resolveSiteUrl(), league),
  ]);
  const file = `${league.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "league"}-inhouse-night.ics`;
  return new NextResponse(calendar, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${file}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
