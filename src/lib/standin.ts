// Pure standin scheduling rules. DB work lives in standin-service.ts.

import { MATCH_STATUS } from "./constants";

/**
 * The assign-standin target <select> encoding: a bare userId covers that
 * player; `seat:<teamId>` fills an EMPTY seat on a short roster. Builders and
 * parsers must agree byte-for-byte — drift would silently turn an empty-seat
 * fill into a bogus player-cover — so both live here.
 */
export const SEAT_PREFIX = "seat:";

export function seatValue(teamId: string): string {
  return SEAT_PREFIX + teamId;
}

/** The teamId of a `seat:<teamId>` target, or null for a plain userId. */
export function parseSeatTarget(target: string): string | null {
  return target.startsWith(SEAT_PREFIX)
    ? target.slice(SEAT_PREFIX.length)
    : null;
}

/**
 * WHERE fragment: cover this standin still owes on unplayed matches this
 * season. Several callers deliberately run this twice — once at read time and
 * again INSIDE their Serializable transaction (the repo's concurrency rule 1)
 * — so this builder shares only the predicate, never the read. Do not hoist
 * the double reads.
 */
export function pendingCoverWhere(standinUserId: string, seasonId: string) {
  return {
    standinUserId,
    match: { seasonId, status: { not: MATCH_STATUS.COMPLETED } },
  };
}

/**
 * Two matches this close together are the same evening for a human. A standin
 * can't play both, whatever the roster tables say.
 *
 * Wide on purpose: a Bo3 runs well over an hour, lobbies start late, and the
 * cost of being wrong in each direction is asymmetric — a false conflict is an
 * admin clicking again after removing the other assignment, a missed one is a
 * team standing in an empty lobby on match night.
 */
export const STANDIN_CONFLICT_HOURS = 4;

export type StandinSlot = { scheduledAt: Date | null; week: number };

/**
 * Would covering `target` clash with cover the standin already owes on
 * `other`? Pure — unit-tested.
 *
 * The per-MATCH duplicate check in assignStandinGuarded never caught this: it
 * asks "is this standin already in THIS match", so the same person could be
 * signed up to two different fixtures kicking off at the same minute. The
 * league plays every team on one night, so that isn't a corner case — it's
 * what happens the first time a captain and an admin both go looking for cover.
 *
 * Falls back to the WEEK when either kickoff is unset: an unscheduled match has
 * no time to compare, and the league plays one round a week, so two fixtures in
 * the same week are the same night until someone says otherwise.
 */
export function standinConflict(target: StandinSlot, other: StandinSlot): boolean {
  if (target.scheduledAt && other.scheduledAt) {
    const gapMs = Math.abs(
      target.scheduledAt.getTime() - other.scheduledAt.getTime(),
    );
    return gapMs < STANDIN_CONFLICT_HOURS * 60 * 60 * 1000;
  }
  return target.week === other.week;
}

/**
 * Flag a standin whose MMR towers over the seat they're filling. ADVISORY,
 * never a block (the maxMmr house rule): amateur-league convention is
 * comparable-or-lower-MMR cover, but the league's only hard gate is
 * registration's ceiling, so the assigner just gets told what they're doing.
 */
export const STANDIN_MMR_FLAG_GAP = 500;

/**
 * The advisory line for an assign toast, or null when there's nothing to say.
 *
 * Named cover compares against the REPLACED player — that's the strength the
 * team was already fielding, so a small gap (or covering down) is silent even
 * in a capped season. An empty seat has no baseline, so the season's soft MMR
 * cap (0 = none) is the only yardstick. An unknown standin MMR (0) never
 * flags: "unknown" must not dress up as "fine" OR as "too strong".
 */
export function standinMmrNote(opts: {
  standinMmr: number;
  /** The replaced player's registration MMR; null/0 = empty seat or unknown. */
  replacedMmr: number | null;
  /** Season.maxMmr — 0 = no review threshold set. */
  maxMmr: number;
}): string | null {
  if (opts.standinMmr <= 0) return null;
  if (opts.replacedMmr && opts.replacedMmr > 0) {
    return opts.standinMmr - opts.replacedMmr >= STANDIN_MMR_FLAG_GAP
      ? `heads up: a ${opts.standinMmr} MMR standin is covering a ${opts.replacedMmr} MMR player — make sure the other captain is fine with it`
      : null;
  }
  return opts.maxMmr > 0 && opts.standinMmr > opts.maxMmr
    ? `heads up: ${opts.standinMmr} MMR is above this season's ${opts.maxMmr} MMR review threshold`
    : null;
}
