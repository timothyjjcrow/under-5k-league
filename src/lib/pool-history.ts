import { prisma } from "./prisma";
import { careersFromFacts, type AppearanceFacts } from "./appearance-careers";
import { resolveChampionPresentation } from "./champion-presentation";
import { getCareerFacts } from "./cached-queries";
import { buildPoolLastSeasons, type PoolLastSeason } from "./player-pool";

/**
 * The /players "last season" scouting token for every pool row: each
 * returning player's most recent earlier league season (team, series record,
 * price, title), from the same recorded appearances and roster rows the
 * profile's Seasons card reads.
 *
 * A first season costs one small query and returns {}: the appearances are
 * read only once an earlier season exists, from the small games-tagged
 * career facts the Hall of Fame keeps warm (cached-queries.ts), so a view
 * decodes no box score. Match outcomes and champions are this view's own
 * reads. `readFacts` is the test seam (integration tests run outside a Next
 * request, where the cache can't).
 */
export async function loadPoolLastSeasons(
  activeSeason: { id: string; createdAt: Date },
  userIds: readonly string[],
  readFacts: () => Promise<AppearanceFacts> = async () =>
    (await getCareerFacts()).appearances,
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
  const [facts, matches, memberships, teams] = await Promise.all([
    readFacts(),
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
  // Games from the active season are skipped inside careersFromFacts: only
  // earlier seasons' matches are passed in.
  const careers = careersFromFacts(
    facts,
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
