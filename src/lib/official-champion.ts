import { prisma } from "./prisma";
import { MATCH_PHASE, SEASON_STATUS } from "./constants";
import { resolveChampionPresentation } from "./champion-presentation";

/**
 * Whether any season has a champion the public pages may show — the same
 * test the Hall of Fame uses to open. Links into the Hall of Fame key off
 * this so nobody is sent to a page that only says "No champion yet".
 *
 * Use this for EVERY Hall of Fame entry point (menus, footer, in-page links);
 * getPublicLeagueContent().hasChampion is this same test behind the shared
 * public snapshot. The cheaper "a COMPLETE season has championTeamId" check is
 * not the same rule: while a saved final disagrees with the stored champion
 * (an admin repair state) it says yes and the Hall of Fame says "No champion
 * yet".
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

export type DefendingChampion = {
  seasonId: string;
  seasonName: string;
  teamId: string;
  teamName: string;
  logoUrl: string | null;
};

/**
 * The title holders Home names while nobody has been crowned since: the
 * newest archived COMPLETE season's champion, as the shared resolver sees it.
 * Once a season is archived Home stopped naming its champion anywhere, in the
 * offseason and through the next season's signups and draft.
 *
 * Only the newest completed season counts. If its champion needs review this
 * is null, never an older title presented as current. A season archived
 * without finishing (cancelled) crowned nobody and doesn't end a reign.
 * `before` is the active season's creation time, so a season created after
 * it (an older season reactivated for corrections) is not "last season".
 */
export async function getDefendingChampion(
  before: Date | null,
): Promise<DefendingChampion | null> {
  const season = await prisma.season.findFirst({
    where: {
      isActive: false,
      status: SEASON_STATUS.COMPLETE,
      ...(before ? { createdAt: { lt: before } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      name: true,
      status: true,
      championTeamId: true,
      matches: {
        where: { phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] } },
        select: {
          id: true, phase: true, bracketSlot: true, status: true,
          winnerTeamId: true, homeTeamId: true, awayTeamId: true,
        },
      },
    },
  });
  if (!season) return null;
  const { championTeamId } = resolveChampionPresentation(season, season.matches);
  if (!championTeamId) return null;
  const team = await prisma.team.findFirst({
    where: { id: championTeamId, seasonId: season.id },
    select: { id: true, name: true, logoUrl: true },
  });
  if (!team) return null;
  return {
    seasonId: season.id,
    seasonName: season.name,
    teamId: team.id,
    teamName: team.name,
    logoUrl: team.logoUrl,
  };
}
