import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { buildCalendar } from "@/lib/ics";
import { MATCH_PHASE } from "@/lib/constants";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { matchRoundLabel, playoffTotalRounds } from "@/lib/schedule";
import { resolveSiteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
}

function safeCalendarFilename(value: string): string {
  // "ggd2l-…" for the US league, "ggd2l-europe-…" for Europe.
  const league = slugify(LEAGUE_CONFIG.name) || "league";
  return `${league}-${slugify(value) || "league"}-schedule.ics`;
}

/**
 * iCalendar feed of the league's scheduled matches. Subscribe from any
 * calendar app. With no filter it follows whichever season is active, so one
 * subscription carries into the next season; with none active it is a valid,
 * empty calendar rather than an error. `?team=<id>` narrows it to one team's
 * matches in that team's own season: teams are re-drafted every season, and a
 * past team's link keeps syncing its finished fixtures instead of failing.
 */
export async function GET(req: NextRequest) {
  const requestedTeamId = req.nextUrl.searchParams.get("team");
  if (requestedTeamId !== null && requestedTeamId.length > 128) {
    return new NextResponse("Team filter is too long", {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }

  const teamId = requestedTeamId?.trim() || null;
  let selectedTeam: { id: string; name: string } | null = null;
  let season: { id: string; name: string } | null;
  if (requestedTeamId !== null) {
    const team = teamId
      ? await prisma.team.findUnique({
          where: { id: teamId },
          select: {
            id: true,
            name: true,
            season: { select: { id: true, name: true } },
          },
        })
      : null;
    // An explicit filter must name a real team. Silently returning an empty,
    // generically named feed makes a mistyped link look valid forever.
    if (!team) {
      return new NextResponse("Team not found", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
    selectedTeam = { id: team.id, name: team.name };
    season = team.season;
  } else {
    season = await getActiveSeason();
  }

  if (!season) {
    // Between seasons the league feed is empty, not broken: a subscribed
    // calendar keeps syncing and fills again when the next season starts.
    return calendarResponse(
      buildCalendar(`${LEAGUE_CONFIG.name} schedule`, []),
      "league",
    );
  }

  const teams = await prisma.team.findMany({ where: { seasonId: season.id } });
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
  // A team feed doesn't hold the whole bracket, so read its depth from the
  // season's playoff rows — that is what lets an event say "Semifinal".
  const playoffRounds = matches.some(
    (m) => m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL,
  )
    ? playoffTotalRounds(
        await prisma.match.findMany({
          where: {
            seasonId: season.id,
            phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
          },
          select: { phase: true, bracketSlot: true },
        }),
      )
    : 0;

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
      // The UID format must never change: calendar apps key events on it, so
      // a new format would give every subscriber a duplicate of each match.
      // Every retime path bumps scheduleRevision, so a subscribed calendar
      // replaces its copy instead of keeping the old kickoff.
      sequence: m.scheduleRevision,
      start: m.scheduledAt as Date,
      // One rough hour per possible game, plus warm-up slack.
      durationMinutes: m.bestOf * 60 + 30,
      summary: `${matchRoundLabel(m, playoffRounds)}: ${teamName.get(m.homeTeamId) ?? "?"} vs ${teamName.get(m.awayTeamId) ?? "?"}`,
      description: `${season.name} · best of ${m.bestOf}`,
      url: `${site}/matches/${m.id}`,
    })),
  );

  return calendarResponse(cal, selectedTeam?.name ?? season.name);
}

function calendarResponse(cal: string, filenameBase: string) {
  return new NextResponse(cal, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${safeCalendarFilename(
        filenameBase,
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
