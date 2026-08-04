// Pick'em math — pure and unit-tested. Members predict match winners; picks
// lock at the scheduled start and grade against the recorded result.

import { MATCH_STATUS } from "./constants";

export type PredictionLike = {
  matchId: string;
  userId: string;
  pickedTeamId: string;
};

export type PickemMatchLike = {
  id: string;
  status: string;
  winnerTeamId: string | null;
  scheduledAt: Date | null;
};

export type PickemMatchBuckets<T extends PickemMatchLike> = {
  open: T[];
  /** Started/live but not decided yet. */
  locked: T[];
  /** Completed with a winner, so predictions are graded. */
  graded: T[];
  /** Completed draw/no-contest; predictions are void. */
  voided: T[];
};

/** Whether a match still accepts (new or changed) predictions. */
export function predictionOpen(m: PickemMatchLike, now = new Date()): boolean {
  if (m.status === MATCH_STATUS.COMPLETED) return false;
  // A LIVE series has games in the books — a mid-series reschedule can move
  // scheduledAt back into the future, but picks with game 1's result public
  // would corrupt the oracle board.
  if (m.status === MATCH_STATUS.LIVE) return false;
  if (m.scheduledAt && m.scheduledAt.getTime() <= now.getTime()) return false;
  return true;
}

/** Exhaustive lifecycle partition used by the page so locked-but-ungraded
 * picks never disappear between the open cards and the final results. */
export function partitionPickemMatches<T extends PickemMatchLike>(
  matches: T[],
  now = new Date(),
): PickemMatchBuckets<T> {
  const out: PickemMatchBuckets<T> = {
    open: [],
    locked: [],
    graded: [],
    voided: [],
  };
  for (const match of matches) {
    if (match.status === MATCH_STATUS.COMPLETED) {
      (match.winnerTeamId ? out.graded : out.voided).push(match);
    } else if (predictionOpen(match, now)) {
      out.open.push(match);
    } else {
      out.locked.push(match);
    }
  }
  return out;
}

/**
 * predictionOpen as a Match WHERE fragment, so the lock can be carried in the
 * write itself (the repo's concurrency rule 1: a read-time check is not a
 * guard — an auto-sync import can flip the match LIVE between the check and
 * the upsert, accepting a post-information pick). A unit sweep pins that this
 * and predictionOpen agree on every state — edit them together.
 */
export function predictionOpenWhere(now = new Date()) {
  return {
    status: { notIn: [MATCH_STATUS.COMPLETED, MATCH_STATUS.LIVE] },
    OR: [{ scheduledAt: null }, { scheduledAt: { gt: now } }],
  };
}

export type PickemStanding = {
  userId: string;
  correct: number;
  /** Predictions on decided matches (draws void and don't count). */
  graded: number;
  /** correct / graded, 0..1 (0 when nothing graded). */
  accuracy: number;
};

/** Grade every prediction against completed matches and rank the oracles. */
export function pickemStandings(
  predictions: PredictionLike[],
  matches: PickemMatchLike[],
): PickemStanding[] {
  const decided = new Map(
    matches
      .filter((m) => m.status === MATCH_STATUS.COMPLETED && m.winnerTeamId)
      .map((m) => [m.id, m.winnerTeamId as string]),
  );
  const byUser = new Map<string, PickemStanding>();
  for (const p of predictions) {
    const winner = decided.get(p.matchId);
    if (!winner) continue; // unplayed or drawn — nothing to grade
    const row = byUser.get(p.userId) ?? {
      userId: p.userId,
      correct: 0,
      graded: 0,
      accuracy: 0,
    };
    row.graded++;
    if (p.pickedTeamId === winner) row.correct++;
    byUser.set(p.userId, row);
  }
  const rows = [...byUser.values()];
  for (const r of rows) {
    r.accuracy = r.graded > 0 ? r.correct / r.graded : 0;
  }
  rows.sort(
    (a, b) =>
      b.correct - a.correct ||
      b.accuracy - a.accuracy ||
      a.userId.localeCompare(b.userId),
  );
  return rows;
}

/** Community pick split for one match: how many chose each side. */
export function pickSplit(
  predictions: PredictionLike[],
  matchId: string,
  homeTeamId: string,
): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const p of predictions) {
    if (p.matchId !== matchId) continue;
    if (p.pickedTeamId === homeTeamId) home++;
    else away++;
  }
  return { home, away };
}

/**
 * Group open matches by week (ascending), preserving in-week order. The
 * pick'em page renders the earliest week expanded with lock countdowns and
 * collapses the rest — a flat season-long grid buried "locks tonight" among
 * "locks in six weeks".
 */
export function groupOpenByWeek<
  T extends { week: number; scheduledAt: Date | null },
>(
  open: T[],
): { week: number; matches: T[] }[] {
  // Urgency beats the nominal round number: a week-6 fixture rescheduled to
  // tonight must lead a week-5 fixture still a week away. TBD kickoffs sort
  // last, then week provides a deterministic tie-break.
  const urgent = [...open].sort((a, b) => {
    const aAt = a.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bAt = b.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return aAt - bAt || a.week - b.week;
  });
  const byWeek = new Map<number, T[]>();
  for (const m of urgent) {
    const arr = byWeek.get(m.week) ?? [];
    arr.push(m);
    byWeek.set(m.week, arr);
  }
  return [...byWeek.entries()].map(([week, matches]) => ({ week, matches }));
}
