// Pure standin scheduling rules. DB work lives in standin-service.ts.

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
