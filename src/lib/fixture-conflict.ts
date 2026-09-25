import type { Prisma } from "@prisma/client";
import { MATCH_STATUS } from "./constants";
import { matchPhaseLabel } from "./schedule";

// A team can't play two league fixtures inside this window. Same span as the
// standin and scrim clash rules: a Bo3 plus warm-up runs about three hours.
export const FIXTURE_CONFLICT_WINDOW_MS = 4 * 60 * 60 * 1000;

export type FixtureConflict = {
  id: string;
  /** "Week 3", "Playoffs", … */
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
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  });
  return clash
    ? {
        id: clash.id,
        label: matchPhaseLabel(clash.phase, clash.week),
        homeName: clash.homeTeam.name,
        awayName: clash.awayTeam.name,
      }
    : null;
}
