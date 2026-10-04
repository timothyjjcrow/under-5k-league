// The reads behind the admin page /admin/health: one season's signups,
// rosters, check-ins, standin bookings, Discord posts and new accounts, as
// counts, ids and timestamps. Never a name, a contact detail or a message
// body, never a network call, and never through the cached-queries tags:
// the page is for checking the league, so it reads the database as it is.
// The arithmetic is pure, in league-health.ts.

import { prisma } from "./prisma";
import {
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
} from "./constants";
import { LEAGUE_CONFIG } from "./league-config";
import { LEAGUE_ANNOUNCEMENT_STATUS } from "./league-announcement-outbox";
import {
  buildLeagueHealth,
  healthWindow,
  type HealthSeason,
  type LeagueHealth,
} from "./league-health";

export type HealthSeasonChoice = { id: string; name: string; isActive: boolean };

/**
 * League health for one season, plus every season (newest first) for the
 * page's picker. Two round trips: the season list, which also fixes the date
 * window (a season owns the undated records until the next one was
 * created), then every count in one Promise.all.
 */
export async function loadLeagueHealth(
  season: HealthSeason,
  {
    now = new Date(),
    timeZone = LEAGUE_CONFIG.timeZone,
  }: { now?: Date; timeZone?: string } = {},
): Promise<{ seasons: HealthSeasonChoice[]; health: LeagueHealth }> {
  // Oldest first, with the id as the tiebreak the other season lists use.
  const seasons = await prisma.season.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true, isActive: true, createdAt: true },
  });
  const at = seasons.findIndex((row) => row.id === season.id);
  const nextSeason = at >= 0 ? (seasons[at + 1] ?? null) : null;
  const range = healthWindow(season, nextSeason, now);
  const seasonId = season.id;
  const activePlayer = {
    seasonId,
    type: REGISTRATION_TYPE.PLAYER,
    status: REGISTRATION_STATUS.ACTIVE,
  };

  const [
    registrations,
    teams,
    draft,
    activePlayers,
    returningPlayers,
    tenures,
    roster,
    rosteredWithDiscord,
    accounts,
    matches,
    checkins,
    bookings,
    posts,
  ] = await Promise.all([
    prisma.registration.groupBy({
      by: ["type", "status"],
      where: { seasonId },
      _count: { _all: true },
    }),
    prisma.team.groupBy({
      by: ["withdrawn"],
      where: { seasonId },
      _count: { _all: true },
    }),
    prisma.draft.findUnique({ where: { seasonId }, select: { status: true } }),
    prisma.registration.findMany({ where: activePlayer, select: { userId: true } }),
    // Returning: signed up (as anything) for a season created before this
    // one, the same "earlier" the player pool's last-season token uses.
    prisma.registration.count({
      where: {
        ...activePlayer,
        user: {
          registrations: {
            some: {
              season: {
                id: { not: seasonId },
                createdAt: { lt: season.createdAt },
              },
            },
          },
        },
      },
    }),
    prisma.rosterTenure.findMany({
      where: { seasonId },
      select: { userId: true, teamId: true, endReason: true, acquisitionKind: true },
    }),
    prisma.teamMember.findMany({ where: { seasonId }, select: { userId: true } }),
    prisma.teamMember.count({
      where: { seasonId, user: { discordId: { not: null } } },
    }),
    prisma.user.findMany({
      where: { createdAt: { gte: range.start, lt: range.end } },
      select: { createdAt: true },
    }),
    prisma.match.findMany({
      where: { seasonId },
      select: { id: true, scheduledAt: true, scheduleRevision: true, forfeit: true },
    }),
    prisma.matchAvailability.groupBy({
      by: ["matchId", "scheduleRevision", "status"],
      where: { match: { seasonId } },
      _count: { _all: true },
    }),
    prisma.standinAssignment.findMany({
      where: { match: { seasonId } },
      select: { matchId: true, createdAt: true },
    }),
    // The outbox has no season column; the window stands in for one.
    prisma.leagueAnnouncement.findMany({
      where: {
        status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
        sentAt: { gte: range.start, lt: range.end },
      },
      select: { dedupeKey: true },
    }),
  ]);

  return {
    seasons: seasons
      .map(({ id, name, isActive }) => ({ id, name, isActive }))
      .reverse(),
    health: buildLeagueHealth(
      {
        season,
        nextSeason,
        now,
        registrations: registrations.map((row) => ({
          type: row.type,
          status: row.status,
          count: row._count._all,
        })),
        teams: teams.map((row) => ({
          withdrawn: row.withdrawn,
          count: row._count._all,
        })),
        draftStatus: draft?.status ?? null,
        activePlayerIds: activePlayers.map((row) => row.userId),
        returningPlayers,
        tenures,
        rosterUserIds: roster.map((row) => row.userId),
        rosteredWithDiscord,
        accountsCreatedAt: accounts.map((row) => row.createdAt),
        matches,
        checkins: checkins.map((row) => ({
          matchId: row.matchId,
          scheduleRevision: row.scheduleRevision,
          status: row.status,
          count: row._count._all,
        })),
        bookings,
        postKeys: posts.map((row) => row.dedupeKey),
      },
      timeZone,
    ),
  };
}
