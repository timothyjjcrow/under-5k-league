import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { buildCalendar } from "@/lib/ics";
import { matchPhaseLabel } from "@/lib/schedule";
import { resolveSiteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

/**
 * iCalendar feed of the active season's scheduled matches. Subscribe from any
 * calendar app; `?team=<id>` narrows it to one team's matches.
 */
export async function GET(req: NextRequest) {
  const season = await getActiveSeason();
  if (!season) {
    return new NextResponse("No active season", { status: 404 });
  }

  const teamId = req.nextUrl.searchParams.get("team");
  const [matches, teams] = await Promise.all([
    prisma.match.findMany({
      where: {
        seasonId: season.id,
        scheduledAt: { not: null },
        status: { not: "COMPLETED" },
        ...(teamId
          ? { OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] }
          : {}),
      },
      orderBy: { scheduledAt: "asc" },
    }),
    prisma.team.findMany({ where: { seasonId: season.id } }),
  ]);

  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const site = resolveSiteUrl();
  const host = new URL(site).host;
  const calName = teamId
    ? `${teamName.get(teamId) ?? "Team"} — ${season.name}`
    : `${season.name} schedule`;

  const cal = buildCalendar(
    calName,
    matches.map((m) => ({
      uid: `${m.id}@${host}`,
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
      "content-disposition": 'attachment; filename="league-schedule.ics"',
    },
  });
}
