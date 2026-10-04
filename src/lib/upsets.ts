// Upsets: a completed series won by the side the table, or the bracket's
// seeds, said should lose it. Pure + testable; Home's Recent results chip and
// its "Week N upset" line read it.
//
// Regular season: the winner had at least UPSET_MIN_POINTS_GAP fewer points
// than the loser going into the week (regularTableBeforeWeek), a full win
// more for every series the loser had played more (a bye or a postponed
// fixture leaves a team behind on points without being worse). Points, never
// places: teams level on points are split by game difference, series wins,
// head-to-head and finally team id, so a gap in places can mean nothing.
// An earlier week's result counts only if it kicked off before the series
// being judged, so a postponed result played later never changes a verdict
// after the fact.
// Playoffs: the higher seed NUMBER won, with seeds from the frozen first-round
// pairings (seedsFromFirstRound), never live standings. Draws, forfeits and
// tiebreaker matches are never upsets: a draw beat nobody, a forfeit is a
// ruling rather than a result, and a tiebreaker is a playoff for a place.

import { seedsFromFirstRound } from "./bracket-view";
import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import {
  regularTableBeforeWeek,
  regularWeeksWithResultsBefore,
  type MatchLike,
} from "./standings";

/**
 * How many points behind the winner must have been going into the week: a
 * full win. A team one draw behind is level in all but name. Each series the
 * loser had played more than the winner adds another full win to the bar.
 */
export const UPSET_MIN_POINTS_GAP = 3;

/**
 * Earlier weeks with results the table needs before it can call a result an
 * upset. After one week every team has 3, 1 or 0 points, so "the leader"
 * means "won its first series" (the movement arrows wait for the same
 * reason). With weeks numbered from 1, nothing is tagged before week 3.
 */
export const UPSET_MIN_PRIOR_WEEKS = 2;

export type UpsetMatch = MatchLike & {
  id: string;
  week: number;
  /** Its kickoff. An earlier week's result counts going into this series
   *  only if it kicked off before this one; untimed results always count. */
  scheduledAt: Date | null;
};

/** A team going into a series: its points and series played. */
export type UpsetTableRow = { points: number; played: number };

export type SeriesUpset = {
  matchId: string;
  winnerId: string;
  loserId: string;
  /** "points": the table going into the week; "seed": the bracket's seeds. */
  kind: "points" | "seed";
  /** Points the winner trailed by, or how many seed places apart they were. */
  gap: number;
  /** The winner's points going into the week, or its seed. */
  winner: number;
  /** The loser's points going into the week, or its seed. */
  loser: number;
};

/** What `seriesUpset` judges against; build it once per season's matches. */
export type UpsetContext = {
  /** Each team's points and series played going into `match`'s week, as
   *  they stood at its kickoff; null while the table has too few weeks
   *  behind it to mean anything. */
  tableBefore: (match: UpsetMatch) => ReadonlyMap<string, UpsetTableRow> | null;
  /** Playoff seeds from the frozen first round (seedsFromFirstRound). */
  seeds: ReadonlyMap<string, number>;
};

/**
 * The tables and seeds for one season's matches. `teamIds` is every team in
 * the season, withdrawn ones included: their banked points are real. Each
 * table is built once per week and kickoff, however many series it judges.
 */
export function upsetContext(
  teamIds: string[],
  matches: readonly UpsetMatch[],
): UpsetContext {
  const tables = new Map<string, ReadonlyMap<string, UpsetTableRow> | null>();
  const seeds = seedsFromFirstRound(
    matches
      .filter(
        (m) => m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL,
      )
      .map((m) => ({
        bracketSlot: m.bracketSlot ?? null,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
      })),
  );
  return {
    seeds,
    tableBefore(match) {
      const kickoff = match.scheduledAt?.getTime() ?? null;
      const key = JSON.stringify([match.week, kickoff]);
      if (!tables.has(key)) {
        // Only what was known when this series kicked off: a postponed
        // result from an earlier week, played after it, stays out.
        const known =
          kickoff === null
            ? matches
            : matches.filter(
                (m) => m.scheduledAt == null || m.scheduledAt.getTime() < kickoff,
              );
        tables.set(
          key,
          regularWeeksWithResultsBefore(known, match.week) >=
            UPSET_MIN_PRIOR_WEEKS
            ? new Map(
                regularTableBeforeWeek(teamIds, known, match.week).map(
                  (row) => [row.teamId, { points: row.points, played: row.played }],
                ),
              )
            : null,
        );
      }
      return tables.get(key) ?? null;
    },
  };
}

/** The upset a completed series was, or null when it was none. */
export function seriesUpset(
  match: UpsetMatch,
  context: UpsetContext,
): SeriesUpset | null {
  if (match.status !== MATCH_STATUS.COMPLETED || match.forfeit) return null;
  const winnerId = match.winnerTeamId;
  // A draw (no winner) beat nobody.
  if (winnerId !== match.homeTeamId && winnerId !== match.awayTeamId) {
    return null;
  }
  const loserId =
    winnerId === match.homeTeamId ? match.awayTeamId : match.homeTeamId;
  if (match.phase === MATCH_PHASE.REGULAR) {
    const table = context.tableBefore(match);
    const winner = table?.get(winnerId);
    const loser = table?.get(loserId);
    // A team missing from the table is unknown, never "0 points".
    if (winner == null || loser == null) return null;
    const gap = loser.points - winner.points;
    // A series in hand is worth a full win: a team that had a bye trails on
    // points without being any worse.
    const inHand = Math.max(0, loser.played - winner.played);
    return gap >= UPSET_MIN_POINTS_GAP * (1 + inHand)
      ? {
          matchId: match.id,
          winnerId,
          loserId,
          kind: "points",
          gap,
          winner: winner.points,
          loser: loser.points,
        }
      : null;
  }
  if (match.phase === MATCH_PHASE.PLAYOFF || match.phase === MATCH_PHASE.FINAL) {
    const winner = context.seeds.get(winnerId);
    const loser = context.seeds.get(loserId);
    // No seed (a team the first round didn't place): no tag.
    if (winner == null || loser == null) return null;
    const gap = winner - loser;
    return gap > 0
      ? { matchId: match.id, winnerId, loserId, kind: "seed", gap, winner, loser }
      : null;
  }
  return null;
}

/**
 * The upset of the latest week with a played series: the largest gap, then
 * the lowest match id, so a tie always picks the same one. Null when that
 * week had no upset; an older week's never stands in for it. Forfeits don't
 * make a week the latest: a withdrawal rules a team's later fixtures at once,
 * and those weeks hold no result anyone played yet.
 */
export function biggestUpset<M extends UpsetMatch>(
  matches: readonly M[],
  context: UpsetContext,
): { match: M; upset: SeriesUpset } | null {
  const played = matches.filter(
    (m) => m.status === MATCH_STATUS.COMPLETED && !m.forfeit,
  );
  if (played.length === 0) return null;
  const week = Math.max(...played.map((m) => m.week));
  let best: { match: M; upset: SeriesUpset } | null = null;
  for (const match of played) {
    if (match.week !== week) continue;
    const upset = seriesUpset(match, context);
    if (!upset) continue;
    if (
      !best ||
      upset.gap > best.upset.gap ||
      (upset.gap === best.upset.gap && match.id.localeCompare(best.match.id) < 0)
    ) {
      best = { match, upset };
    }
  }
  return best;
}

/**
 * Why a series counts as an upset, in the words Home prints after it:
 * "from 6 points behind going into the week", or "seed 4 over seed 1".
 * Stored facts only: the table it was judged against, or the seeds.
 */
export function upsetDetail(upset: SeriesUpset): string {
  if (upset.kind === "seed") {
    return `seed ${upset.winner} over seed ${upset.loser}`;
  }
  const points = upset.gap === 1 ? "point" : "points";
  return `from ${upset.gap} ${points} behind going into the week`;
}
