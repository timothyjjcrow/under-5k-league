import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { MATCH_PHASE } from "./constants";
import {
  matchRoundLabel,
  playoffTotalRounds,
  type RoundLabelMatch,
} from "./schedule";

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

/**
 * `matchRoundLabel` for each fixture a Discord post names ("Semifinal"),
 * keyed by match id. Built for posts sent after their write has committed,
 * so it never throws: if the bracket read fails, playoff fixtures fall back
 * to "Playoffs", the phase-only name those posts used before they knew the
 * round. Only PLAYOFF fixtures need the depth; anything else costs no query.
 * Call it outside any transaction — a display label has no business in a
 * SERIALIZABLE read set.
 */
export async function roundLabelsForPost(
  matches: readonly (RoundLabelMatch & { id: string; seasonId: string })[],
): Promise<Map<string, string>> {
  let depth = new Map<string, number>();
  const playoff = matches.filter((m) => m.phase === MATCH_PHASE.PLAYOFF);
  if (playoff.length) {
    try {
      depth = await loadPlayoffRoundsBySeason(playoff.map((m) => m.seasonId));
    } catch {
      // Depth 0 reads as "can't place it" — the post still goes out.
    }
  }
  return new Map(
    matches.map((m) => [m.id, matchRoundLabel(m, depth.get(m.seasonId) ?? 0)]),
  );
}
