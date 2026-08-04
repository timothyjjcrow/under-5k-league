import { MATCH_PHASE } from "./constants";
import { evaluateHonorWeeks } from "./honors-readiness";
import { prisma } from "./prisma";

/**
 * One authoritative DB shape shared by the public UI and Discord service.
 * Discord supplies a week so its pre-send recheck does not reload a season's
 * entire box-score history; public pages omit it to build the complete rollup.
 */
export async function getSeasonHonorReadiness(
  seasonId: string,
  week?: number,
) {
  const matches = await prisma.match.findMany({
    where: {
      seasonId,
      phase: MATCH_PHASE.REGULAR,
      ...(week == null ? {} : { week }),
    },
    select: {
      id: true,
      week: true,
      phase: true,
      status: true,
      homeTeamId: true,
      awayTeamId: true,
      homeScore: true,
      awayScore: true,
      forfeit: true,
      games: {
        select: {
          id: true,
          radiantWin: true,
          radiantTeamId: true,
          direTeamId: true,
          winnerTeamId: true,
          players: true,
        },
      },
    },
  });
  return evaluateHonorWeeks(matches);
}
