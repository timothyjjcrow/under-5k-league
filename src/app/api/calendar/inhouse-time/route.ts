import { NextResponse, type NextRequest } from "next/server";
import { buildCalendar } from "@/lib/ics";
import { inhouseTimeCalendarEvent, parseInhouseTimeParam } from "@/lib/inhouse-times";
import { readInhouseTime } from "@/lib/inhouse-times-service";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { singleSearchParam } from "@/lib/search-params";
import { resolveSiteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

/**
 * A Play later time (`?at=`, inhouseTimeParam) as a one-event calendar file,
 * for "Apple or Outlook (.ics)" on /inhouse: the reminder the site gives in
 * place of a Discord ping. Only for a time that's on the list (someone is in
 * on it and it isn't over). Read-only, so a browser loading it as an image
 * changes nothing.
 */
export async function GET(request: NextRequest) {
  const nowMs = Date.now();
  const values = request.nextUrl.searchParams.getAll("at");
  // A repeated key names no one time (singleSearchParam's rule).
  const raw = singleSearchParam(values.length > 1 ? values : values[0]);
  const startsAtMs = typeof raw === "string" ? parseInhouseTimeParam(raw) : null;
  const time = startsAtMs === null ? null : await readInhouseTime(startsAtMs, nowMs);
  if (!time) {
    return new NextResponse("That inhouse time isn't on the list", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  const league = LEAGUE_CONFIG.name;
  const calendar = buildCalendar(`${league} inhouse`, [
    inhouseTimeCalendarEvent(time.startsAtMs, resolveSiteUrl(), league, nowMs),
  ]);
  const file = `${league.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "league"}-inhouse.ics`;
  return new NextResponse(calendar, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${file}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
