import type { Prisma } from "@prisma/client";
import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import { loadPlayoffRoundsBySeason } from "./playoff-rounds";
import { matchRoundLabel } from "./schedule";

// A team can't play two league fixtures inside this window. Same span as the
// standin and scrim clash rules: a Bo3 plus warm-up runs about three hours.
export const FIXTURE_CONFLICT_WINDOW_MS = 4 * 60 * 60 * 1000;

export type FixtureConflict = {
  id: string;
  /** "Week 3", "Tiebreaker", "Semifinal", … — `matchRoundLabel`. */
  label: string;
  homeName: string;
  awayName: string;
};

/**
 * Another unplayed league fixture of either team within four hours of
 * `scheduledAt`, or null. Captain reschedules only ever checked scrims, so
 * A-vs-B could be moved onto the night A already plays C.
 */
export async function findFixtureConflict(
  db: Pick<Prisma.TransactionClient, "match">,
  options: {
    seasonId: string;
    teamIds: string[];
    scheduledAt: Date;
    exceptMatchId: string;
  },
): Promise<FixtureConflict | null> {
  if (options.teamIds.length === 0) return null;
  const t = options.scheduledAt.getTime();
  const clash = await db.match.findFirst({
    where: {
      seasonId: options.seasonId,
      id: { not: options.exceptMatchId },
      status: { in: [MATCH_STATUS.SCHEDULED, MATCH_STATUS.LIVE] },
      scheduledAt: {
        gt: new Date(t - FIXTURE_CONFLICT_WINDOW_MS),
        lt: new Date(t + FIXTURE_CONFLICT_WINDOW_MS),
      },
      OR: [
        { homeTeamId: { in: options.teamIds } },
        { awayTeamId: { in: options.teamIds } },
      ],
    },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      week: true,
      phase: true,
      bracketSlot: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  });
  if (!clash) return null;
  // Name a playoff clash by its round, like the rest of the site. Read only on
  // this refusal path, never for a time that fits.
  const playoffRounds =
    clash.phase === MATCH_PHASE.PLAYOFF
      ? ((await loadPlayoffRoundsBySeason([options.seasonId], db)).get(
          options.seasonId,
        ) ?? 0)
      : 0;
  return {
    id: clash.id,
    label: matchRoundLabel(clash, playoffRounds),
    homeName: clash.homeTeam.name,
    awayName: clash.awayTeam.name,
  };
}
