import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { buildCalendar } from "@/lib/ics";
import { matchPhaseLabel } from "@/lib/schedule";
import { resolveSiteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

function safeCalendarFilename(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
  return `ld2l-${slug || "league"}-schedule.ics`;
}

/**
 * iCalendar feed of the active season's scheduled matches. Subscribe from any
 * calendar app; `?team=<id>` narrows it to one team's matches.
 */
export async function GET(req: NextRequest) {
  const requestedTeamId = req.nextUrl.searchParams.get("team");
  if (requestedTeamId !== null && requestedTeamId.length > 128) {
    return new NextResponse("Team filter is too long", {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }

  const season = await getActiveSeason();
  if (!season) {
    return new NextResponse("No active season", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }

  const teamId = requestedTeamId?.trim() || null;
  const teams = await prisma.team.findMany({ where: { seasonId: season.id } });
  const selectedTeam = teamId ? teams.find((team) => team.id === teamId) : null;

  // An explicit filter must resolve inside this season. Silently returning an
  // empty, generically named feed makes a stale team link look valid forever.
  if (requestedTeamId !== null && !selectedTeam) {
    return new NextResponse("Team not found in the active season", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }

  const matches = await prisma.match.findMany({
    where: {
      seasonId: season.id,
      scheduledAt: { not: null },
      ...(teamId
        ? { OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] }
        : {}),
    },
    orderBy: { scheduledAt: "asc" },
  });

  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const site = resolveSiteUrl();
  const host = new URL(site).host;
  const calName = selectedTeam
    ? `${selectedTeam.name} — ${season.name}`
    : `${season.name} schedule`;

  const cal = buildCalendar(
    calName,
    matches.map((m) => ({
      uid: `${m.id}@${host}`,
      stamp: m.createdAt,
      start: m.scheduledAt as Date,
      // One rough hour per possible game, plus warm-up slack.
      durationMinutes: m.bestOf * 60 + 30,
      summary: `${matchPhaseLabel(m.phase, m.week)}: ${teamName.get(m.homeTeamId) ?? "?"} vs ${teamName.get(m.awayTeamId) ?? "?"}`,
      description: `${season.name} · best of ${m.bestOf}`,
      url: `${site}/matches/${m.id}`,
    })),
  );

  return new NextResponse(cal, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${safeCalendarFilename(
        selectedTeam?.name ?? season.name,
      )}"`,
      // This is a live public view of league state. Intermediaries may store a
      // copy, but every reuse must revalidate so a moved match is not served as
      // current without checking the application first.
      "cache-control": "public, max-age=0, must-revalidate",
      "vercel-cdn-cache-control":
        "public, max-age=30, stale-while-revalidate=30",
      "x-content-type-options": "nosniff",
    },
  });
}
