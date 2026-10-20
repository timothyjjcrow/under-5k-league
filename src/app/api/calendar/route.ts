import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { buildCalendar } from "@/lib/ics";
import { MATCH_PHASE } from "@/lib/constants";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { limitPublicGet } from "@/lib/public-get-limit";
import { matchRoundLabel, playoffTotalRounds } from "@/lib/schedule";
import { seriesEstimateMinutes } from "@/lib/series-lengths";
import { createShortLivedMemo } from "@/lib/short-lived-memo";
import { resolveSiteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

/** A built feed: the calendar file and the name its filename is made from. */
type CalendarFeed = { cal: string; filenameBase: string };

// Each feed as built, for 30 seconds (what Vercel's CDN kept it for before
// the move to the box), keyed by the one parameter it is built from: the
// team filter. The feed reads no cookie, session or header, so one copy is
// right for every caller, and a calendar provider fetching it for many
// subscribers, or a client looping it, costs one build per feed per 30
// seconds. A team that doesn't exist (null) is never kept, so made-up ids
// can't fill it; the real ones are bounded by the league's teams.
const feeds = createShortLivedMemo<CalendarFeed | null>({
  ttlMs: 30_000,
  maxEntries: 200,
  keep: (feed) => feed !== null,
});

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
  const limited = limitPublicGet(req, "calendar", Date.now());
  if (limited) return limited;

  const requestedTeamId = req.nextUrl.searchParams.get("team");
  if (requestedTeamId !== null && requestedTeamId.length > 128) {
    return new NextResponse("Team filter is too long", {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }

  const teamId = requestedTeamId?.trim() || null;
  // An explicit filter must name a real team. Silently returning an empty,
  // generically named feed makes a mistyped link look valid forever.
  if (requestedTeamId !== null && !teamId) return teamNotFound();
  const key = teamId === null ? "league" : `team:${teamId}`;
  const feed = await feeds.get(key, Date.now(), () => buildFeed(teamId));
  if (!feed) return teamNotFound();
  return calendarResponse(feed.cal, feed.filenameBase);
}

function teamNotFound() {
  return new NextResponse("Team not found", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * The league's feed (`teamId` null) or one team's, or null when no team has
 * that id. Built from `teamId` alone: the memo above keys on it.
 */
async function buildFeed(teamId: string | null): Promise<CalendarFeed | null> {
  let selectedTeam: { id: string; name: string } | null = null;
  let season: { id: string; name: string } | null;
  if (teamId !== null) {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        name: true,
        season: { select: { id: true, name: true } },
      },
    });
    if (!team) return null;
    selectedTeam = { id: team.id, name: team.name };
    season = team.season;
  } else {
    season = await getActiveSeason();
  }

  if (!season) {
    // Between seasons the league feed is empty, not broken: a subscribed
    // calendar keeps syncing and fills again when the next season starts.
    return {
      cal: buildCalendar(`${LEAGUE_CONFIG.name} schedule`, []),
      filenameBase: "league",
    };
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
  const calName = selectedTeam
    ? `${selectedTeam.name} — ${season.name}`
    : `${season.name} schedule`;

  const cal = buildCalendar(
    calName,
    matches.map((m) => ({
      uid: `${m.id}@${LEAGUE_CONFIG.calendarUidHost}`,
      stamp: m.createdAt,
      // The UID format must never change: calendar apps key events on it, so
      // a new format would give every subscriber a duplicate of each match.
      // Its host is pinned (calendarUidHost), never the site's, so moving the
      // site to a new domain leaves every UID as it was.
      // Every retime path bumps scheduleRevision, so a subscribed calendar
      // replaces its copy instead of keeping the old kickoff.
      sequence: m.scheduleRevision,
      start: m.scheduledAt as Date,
      durationMinutes: seriesEstimateMinutes(m.bestOf),
      summary: `${matchRoundLabel(m, playoffRounds)}: ${teamName.get(m.homeTeamId) ?? "?"} vs ${teamName.get(m.awayTeamId) ?? "?"}`,
      description: `${season.name} · best of ${m.bestOf}`,
      url: `${site}/matches/${m.id}`,
    })),
  );

  return { cal, filenameBase: selectedTeam?.name ?? season.name };
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
