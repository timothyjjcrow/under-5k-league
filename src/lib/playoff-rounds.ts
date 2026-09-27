import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { MATCH_PHASE } from "./constants";
import { playoffTotalRounds } from "./schedule";

/**
 * `playoffTotalRounds` for each season, from one read of their bracket rows.
 *
 * `matchRoundLabel` needs a season's bracket depth to call a playoff fixture
 * "Semifinal" instead of "Playoffs". A page that lists fixtures from several
 * seasons (a player's match history), or one fixture without its season's
 * other matches (a standin's booking, a reschedule clash), reads the depth
 * here. Seasons with no bracket rows map to 0, which `matchRoundLabel` reads
 * as "can't place it" and falls back to "Playoffs". No ids, no query.
 */
export async function loadPlayoffRoundsBySeason(
  seasonIds: Iterable<string>,
  db: Pick<Prisma.TransactionClient, "match"> = prisma,
): Promise<Map<string, number>> {
  const ids = [...new Set(seasonIds)];
  const rounds = new Map<string, number>();
  if (ids.length === 0) return rounds;
  const rows = await db.match.findMany({
    where: {
      seasonId: { in: ids },
      phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
    },
    select: { seasonId: true, phase: true, bracketSlot: true },
  });
  for (const id of ids) {
    rounds.set(
      id,
      playoffTotalRounds(rows.filter((row) => row.seasonId === id)),
    );
  }
  return rounds;
}
