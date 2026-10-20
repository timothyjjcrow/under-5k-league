// The stream overlay's reads (rules in stream-overlay.ts). /api/overlay
// calls this only when Vercel's CDN has no copy of the answer, so a cast night
// costs a handful of function calls however long the overlay stays open.

import { getSeasonGameLeaders } from "./cached-queries";
import { LEAGUE_CONFIG } from "./league-config";
import { formatLeagueMatchTime } from "./match-time";
import { prisma } from "./prisma";
import {
  buildStreamOverlay,
  type StreamOverlayPayload,
} from "./stream-overlay";

// Display fields only: the payload is public, so nothing else is read.
const USER_FIELDS = {
  id: true,
  name: true,
  avatar: true,
  rankTier: true,
  pubStats: true,
} as const;

const MATCH_FIELDS = {
  id: true,
  week: true,
  phase: true,
  bracketSlot: true,
  bestOf: true,
  status: true,
  homeScore: true,
  awayScore: true,
  winnerTeamId: true,
  forfeit: true,
  scheduledAt: true,
  homeTeamId: true,
  awayTeamId: true,
} as const;

/** One fixture's overlay, or null when there is no such match. */
export async function loadStreamOverlay(
  matchId: string,
): Promise<StreamOverlayPayload | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      ...MATCH_FIELDS,
      seasonId: true,
      homeTeam: { select: { name: true, logoUrl: true } },
      awayTeam: { select: { name: true, logoUrl: true } },
      season: { select: { name: true } },
      standins: {
        select: {
          teamId: true,
          standin: { select: USER_FIELDS },
          replaced: { select: { id: true, name: true } },
        },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!match) return null;

  const [teams, seasonMatches, roster, seasonGames] = await Promise.all([
    prisma.team.findMany({
      where: { seasonId: match.seasonId },
      select: { id: true, name: true, withdrawn: true, groupKey: true, createdAt: true },
    }),
    prisma.match.findMany({
      where: { seasonId: match.seasonId },
      select: MATCH_FIELDS,
    }),
    prisma.teamMember.findMany({
      where: {
        seasonId: match.seasonId,
        teamId: { in: [match.homeTeamId, match.awayTeamId] },
      },
      select: {
        teamId: true,
        isCaptain: true,
        price: true,
        user: { select: USER_FIELDS },
      },
      // Signing order, as the match page lists them; rosterOrder then puts
      // the captain first and sorts by price, keeping this order on a tie.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    // The season's box scores, from the games-tagged public snapshot every
    // stats page shares.
    getSeasonGameLeaders(match.seasonId),
  ]);

  const userIds = [
    ...roster.map((row) => row.user.id),
    ...match.standins.map((row) => row.standin.id),
  ];
  const registrations = userIds.length
    ? await prisma.registration.findMany({
        where: { seasonId: match.seasonId, userId: { in: userIds } },
        select: { userId: true, roles: true },
      })
    : [];

  const { homeTeam, awayTeam, season, standins, seasonId, ...fixture } = match;
  return buildStreamOverlay({
    leagueName: LEAGUE_CONFIG.name,
    seasonId,
    seasonName: season.name,
    match: { ...fixture, homeTeam, awayTeam },
    kickoffText: match.scheduledAt
      ? formatLeagueMatchTime(match.scheduledAt, "full")
      : null,
    teams: teams.map(({ createdAt, ...team }) => ({
      ...team,
      createdAtMs: createdAt.getTime(),
    })),
    seasonMatches,
    roster,
    standins,
    roles: new Map(registrations.map((row) => [row.userId, row.roles])),
    seasonGames,
  });
}
