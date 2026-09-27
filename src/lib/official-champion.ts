import { prisma } from "./prisma";
import { MATCH_PHASE, SEASON_STATUS } from "./constants";
import { resolveChampionPresentation } from "./champion-presentation";

/**
 * Whether any season has a champion the public pages may show — the same
 * test the Hall of Fame uses to open. Links into the Hall of Fame key off
 * this so nobody is sent to a page that only says "No champion yet".
 *
 * Use this for EVERY Hall of Fame entry point (menus, footer, in-page links).
 * The cheaper "a COMPLETE season has championTeamId" check is not the same
 * rule: while a saved final disagrees with the stored champion (an admin
 * repair state) it says yes and the Hall of Fame says "No champion yet".
 */
export async function hasOfficialChampion(): Promise<boolean> {
  const seasons = await prisma.season.findMany({
    where: { status: SEASON_STATUS.COMPLETE, championTeamId: { not: null } },
    select: { id: true, status: true, championTeamId: true },
  });
  if (seasons.length === 0) return false;
  // The resolver only reads postseason fixtures.
  const matches = await prisma.match.findMany({
    where: {
      seasonId: { in: seasons.map((season) => season.id) },
      phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
    },
    select: {
      id: true, seasonId: true, phase: true, bracketSlot: true, status: true,
      winnerTeamId: true, homeTeamId: true, awayTeamId: true,
    },
  });
  return seasons.some(
    (season) =>
      resolveChampionPresentation(
        season,
        matches.filter((match) => match.seasonId === season.id),
      ).championTeamId != null,
  );
}
