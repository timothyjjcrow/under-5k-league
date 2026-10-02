import { cache } from "react";
import type { SessionUser } from "@/lib/auth";
import { getAllGamesForRecords } from "@/lib/cached-queries";
import { prisma } from "@/lib/prisma";
import { parseGamePlayers } from "@/lib/player-stats";
import { getSeasonDraftStatus } from "@/lib/queries";
import { recordWatchBook, toRecordGames } from "@/lib/records";

/**
 * The match page's shared reads. The page loads the match once, with its
 * teams, games, standin bookings and season, and passes it and the viewer to
 * every card; no card reads the season or the match again.
 *
 * The reads only some cards need (the draft status, both teams' rosters and
 * the OUT check-ins) are request-cached with React cache(): cards streaming
 * inside their own Suspense boundaries still share one query each, and a page
 * that renders none of those cards never runs them.
 */
export async function loadMatch(id: string) {
  return prisma.match.findUnique({
    where: { id },
    include: {
      homeTeam: true,
      awayTeam: true,
      games: { orderBy: { startTime: "asc" } },
      standins: { include: { standin: true, replaced: true } },
      season: {
        select: {
          isActive: true,
          status: true,
          name: true,
          championTeamId: true,
          dotaLeagueId: true,
          // The Standins card's open seats and the reschedule form's deadline.
          teamSize: true,
          firstMatchNight: true,
        },
      },
    },
  });
}

export type MatchPageMatch = NonNullable<Awaited<ReturnType<typeof loadMatch>>>;

/** The signed-in viewer (getSessionUser), or null when signed out. */
export type MatchViewer = SessionUser | null;

/** The match's games in play order, each with its box score decoded. */
export function parseMatchGames(match: MatchPageMatch) {
  return match.games.map((g) => ({
    ...g,
    parsed: parseGamePlayers(g.players),
  }));
}

export type MatchPageGame = ReturnType<typeof parseMatchGames>[number];

/**
 * The playoff bracket's fixtures, for the round label, the "what this series
 * decides" line and the champion badge. Only a playoff or final needs them.
 */
export async function loadPostseason(match: { seasonId: string; phase: string }) {
  if (match.phase !== "PLAYOFF" && match.phase !== "FINAL") return [];
  return prisma.match.findMany({
    where: {
      seasonId: match.seasonId,
      phase: { in: ["PLAYOFF", "FINAL"] },
    },
    select: {
      id: true,
      week: true,
      phase: true,
      bracketSlot: true,
      status: true,
      winnerTeamId: true,
      homeTeamId: true,
      awayTeamId: true,
      // Names for the playoff context line's next opponent.
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  });
}

export type MatchPostseason = Awaited<ReturnType<typeof loadPostseason>>;

/**
 * The record book as the Record watch card reads it: the same cached read
 * and mapping as /records and the profile, so the three always agree. The
 * page awaits it in its body, and only for an upcoming fixture of the active
 * season, never inside a card's Suspense, where the cached read once hung.
 */
export async function loadRecordWatchBook() {
  return recordWatchBook(toRecordGames(await getAllGamesForRecords()));
}

/** The season's auction status; null before its Draft row exists. */
export function loadDraftStatus(match: { seasonId: string }) {
  return getSeasonDraftStatus(match.seasonId);
}

const rosters = cache(async function rosters(
  seasonId: string,
  homeTeamId: string,
  awayTeamId: string,
) {
  return prisma.teamMember.findMany({
    where: { seasonId, teamId: { in: [homeTeamId, awayTeamId] } },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          avatar: true,
          rankTier: true,
          discordName: true,
          discordId: true,
          pubStats: true,
          pubStatsAt: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
});

/**
 * Both teams' roster rows, in signing order (the captain's cards list their
 * own side in that order; the Matchup card re-sorts by draft price).
 */
export function loadRosters(match: {
  seasonId: string;
  homeTeamId: string;
  awayTeamId: string;
}) {
  return rosters(match.seasonId, match.homeTeamId, match.awayTeamId);
}

export type MatchRosterMember = Awaited<ReturnType<typeof loadRosters>>[number];

const outUserIds = cache(async function outUserIds(
  matchId: string,
  scheduleRevision: number,
): Promise<ReadonlySet<string>> {
  const rows = await prisma.matchAvailability.findMany({
    where: { matchId, status: "OUT", scheduleRevision },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
});

/**
 * Who has said they can't make this match night (this schedule revision's
 * OUT check-ins). The captain's to-do line and the Standins card both need
 * it.
 */
export function loadOutUserIds(match: { id: string; scheduleRevision: number }) {
  return outUserIds(match.id, match.scheduleRevision);
}
