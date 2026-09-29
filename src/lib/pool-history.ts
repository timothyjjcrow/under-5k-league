import { prisma } from "./prisma";
import { appearanceCareers } from "./appearance-careers";
import { resolveChampionPresentation } from "./champion-presentation";
import { getPublicGameSnapshot } from "./public-game-snapshot";
import { buildPoolLastSeasons, type PoolLastSeason } from "./player-pool";

type GameFact = Parameters<typeof appearanceCareers>[0][number];

/**
 * The /players "last season" scouting token for every pool row: each
 * returning player's most recent earlier league season (team, series record,
 * price, title), from the same recorded appearances and roster rows the
 * profile's Seasons card reads.
 *
 * A first season costs one small query and returns {}: the all-games scan only
 * runs once an earlier season exists, and it reads the shared games-tagged
 * snapshot the stat pages already keep warm. `readGames` is the test seam
 * (integration tests run outside a Next request, where the cache can't).
 */
export async function loadPoolLastSeasons(
  activeSeason: { id: string; createdAt: Date },
  userIds: readonly string[],
  readGames: () => Promise<readonly GameFact[]> = () =>
    getPublicGameSnapshot(null),
): Promise<Record<string, PoolLastSeason>> {
  if (userIds.length === 0) return {};
  // Seasons created before this one (a reactivated older season must not
  // call a later one its "last season").
  const seasons = await prisma.season.findMany({
    where: { id: { not: activeSeason.id }, createdAt: { lt: activeSeason.createdAt } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, name: true, status: true, championTeamId: true },
  });
  if (seasons.length === 0) return {};
  const seasonIds = seasons.map((season) => season.id);
  const [games, matches, memberships, teams] = await Promise.all([
    readGames(),
    prisma.match.findMany({
      where: { seasonId: { in: seasonIds } },
      select: {
        id: true, seasonId: true, status: true, winnerTeamId: true,
        homeTeamId: true, awayTeamId: true, phase: true, bracketSlot: true,
      },
    }),
    prisma.teamMember.findMany({
      where: { seasonId: { in: seasonIds }, userId: { in: [...userIds] } },
      select: { userId: true, teamId: true, seasonId: true, price: true, isCaptain: true },
    }),
    prisma.team.findMany({
      where: { seasonId: { in: seasonIds } },
      select: { id: true, name: true },
    }),
  ]);
  const matchesBySeason = new Map<string, typeof matches>();
  for (const match of matches) {
    const list = matchesBySeason.get(match.seasonId) ?? [];
    list.push(match);
    matchesBySeason.set(match.seasonId, list);
  }
  const champions = new Map<string, string>();
  for (const season of seasons) {
    const teamId = resolveChampionPresentation(
      season,
      matchesBySeason.get(season.id) ?? [],
    ).championTeamId;
    if (teamId) champions.set(season.id, teamId);
  }
  // Games from the active season are skipped inside appearanceCareers: only
  // earlier seasons' matches are passed in.
  const careers = appearanceCareers(
    games,
    matches,
    [...champions].map(([seasonId, teamId]) => ({ seasonId, teamId })),
  );
  return buildPoolLastSeasons({
    userIds,
    seasons,
    appearances: careers.rows,
    memberships,
    teamNames: new Map(teams.map((team) => [team.id, team.name])),
    champions,
  });
}
