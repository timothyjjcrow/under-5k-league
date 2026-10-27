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
 * How far above the seat a captain may bring in a standin on their own (Tim's
 * rule, 2026-10-21). Up to this many MMR above, a captain locks the standin
 * in; more than this, or with an MMR the site doesn't know, the booking waits
 * for the other captain to agree (a StandinRequest). An admin's booking from
 * /admin is the league's ruling and needs no one's OK.
 */
export const STANDIN_MMR_ALLOWANCE = 100;

/**
 * The MMR a cover is judged against, or null when the site doesn't know it.
 *
 * Named cover compares with the covered player's signup MMR: the strength the
 * team was already fielding. An empty seat has nobody behind it, so it counts
 * as covering the team's LOWEST-MMR player; a short side can't bring in a
 * stronger fifth than a full side covering its weakest seat could. 0 is an
 * unknown signup MMR and never counts as a number.
 */
export function coverBaselineMmr(
  cover:
    | { replacedMmr: number | null }
    | { rosterMmrs: readonly number[] },
): number | null {
  if ("replacedMmr" in cover) {
    return cover.replacedMmr && cover.replacedMmr > 0 ? cover.replacedMmr : null;
  }
  const known = cover.rosterMmrs.filter((mmr) => mmr > 0);
  return known.length > 0 ? Math.min(...known) : null;
}

/** A teammate whose MMR set a named cover's baseline instead of the named player. */
export type LowerOutPlayer = { userId: string; name: string; mmr: number };

/**
 * A NAMED cover's baseline: the covered player's signup MMR, or lower when a
 * teammate who said they can't make this match (OUT for its current kickoff)
 * has a lower known MMR and no booking covering them yet. Otherwise a captain
 * could name their strongest player as "covered" while the standin really
 * takes the weakest absentee's seat. A request waiting for the other captain
 * is not cover and doesn't count: asking for anyone for the absentee, booking
 * against the stronger MMR and withdrawing the ask would dodge the rule.
 * `lowerOut` is that teammate, so the copy can say whose MMR it was judged
 * against; null when the named player's own MMR is the baseline (a tie
 * included).
 *
 * Unknown (0) MMRs never lower it, and an unknown named player stays unknown:
 * the other captain decides, as `standinNeedsApproval` says. The empty-seat
 * baseline (`coverBaselineMmr` with the roster) is a different rule.
 */
export function namedCoverBaseline(opts: {
  replaced: { userId: string; mmr: number | null };
  /** The covered team's roster, with signup MMRs (0 = unknown). */
  teammates: readonly { userId: string; name: string; mmr: number }[];
  /** Who checked in OUT for this match's current scheduleRevision. */
  outUserIds: ReadonlySet<string>;
  /** Players in this match with a BOOKING covering them (never a request). */
  coveredUserIds: ReadonlySet<string>;
}): { baselineMmr: number | null; lowerOut: LowerOutPlayer | null } {
  const own = coverBaselineMmr({ replacedMmr: opts.replaced.mmr });
  if (own === null) return { baselineMmr: null, lowerOut: null };
  const lowest = opts.teammates
    .filter(
      (m) =>
        m.userId !== opts.replaced.userId &&
        m.mmr > 0 &&
        m.mmr < own &&
        opts.outUserIds.has(m.userId) &&
        !opts.coveredUserIds.has(m.userId),
    )
    // Exact stored keys, the id last: the same teammate every time.
    .sort((a, b) => a.mmr - b.mmr || a.userId.localeCompare(b.userId))[0];
  return lowest
    ? {
        baselineMmr: lowest.mmr,
        lowerOut: { userId: lowest.userId, name: lowest.name, mmr: lowest.mmr },
      }
    : { baselineMmr: own, lowerOut: null };
}

/**
 * Does this booking need the other captain's OK? Yes when the standin is more
 * than STANDIN_MMR_ALLOWANCE above the baseline (exactly the allowance is
 * fine), and whenever either MMR is unknown: an unknown must not pass as
 * "close enough", or leaving MMR blank would make anyone a free ringer. Asking
 * isn't a refusal; the other captain decides.
 */
export function standinNeedsApproval(
  standinMmr: number,
  baselineMmr: number | null,
): boolean {
  if (standinMmr <= 0 || baselineMmr === null || baselineMmr <= 0) return true;
  return standinMmr - baselineMmr > STANDIN_MMR_ALLOWANCE;
}

const MMR_NUMBER = new Intl.NumberFormat("en-US");

/**
 * Why a booking needs the other captain, as a clause that reads after
 * "since" in a toast, the match page and a Discord post ("…, since the
 * standin is 700 MMR above the player they cover"). Only call it when
 * `standinNeedsApproval` said yes.
 *
 * The only name it can carry is `lowerOutName`, the teammate a named cover
 * was judged against (`namedCoverBaseline`), passed in already formatted for
 * the surface: a Discord caller escapes it.
 */
export function standinApprovalReason(opts: {
  standinMmr: number;
  baselineMmr: number | null;
  /** An empty seat, judged against the team's lowest MMR. */
  emptySeat: boolean;
  /** Set when a lower teammate who said they're out set the baseline. */
  lowerOutName?: string | null;
}): string {
  if (opts.standinMmr <= 0) return "the standin's MMR is unknown";
  if (opts.baselineMmr === null || opts.baselineMmr <= 0) {
    return opts.emptySeat
      ? "nobody on the team has a known MMR to compare with"
      : "the covered player's MMR is unknown";
  }
  const gap = MMR_NUMBER.format(opts.standinMmr - opts.baselineMmr);
  if (opts.emptySeat)
    return `the standin is ${gap} MMR above the team's lowest-MMR player`;
  return opts.lowerOutName
    ? `the standin is ${gap} MMR above ${opts.lowerOutName} (${MMR_NUMBER.format(
        opts.baselineMmr,
      )}), who said they can't make it`
    : `the standin is ${gap} MMR above the player they cover`;
}

/**
 * The approver's refusal when a request no longer passes the booking checks
 * (the seat, the signup or the night moved since it was asked). The check's
 * own advice is for whoever books, so only its reason is kept ("X is already
 * covered by Y — remove that assignment first" → "X is already covered by
 * Y"), and the approver is told what they can still do: decline it.
 *
 * The reason keeps its own case: it may open with a name ("The Rock is
 * already covering…"), and no rule can tell a name from a sentence's first
 * word.
 */
export function agreeTooLateError(reason: string, teamName: string): string {
  const clause = reason.split(" — ")[0].replace(/\.$/, "");
  return `This can't be agreed to any more: ${clause} — decline it so ${teamName} can line up someone else`;
}

/**
 * This standin was already declined for this team in this match: the team's
 * captain can't book or ask for them again there (an admin can still book
 * them from the panel). It names nobody as the decider, since an admin may
 * have declined in the other captain's place.
 */
export function standinDeclinedError(
  standinName: string,
  teamName: string,
): string {
  return `${standinName} was already declined for ${teamName} in this match — pick someone else, or ask an admin`;
}

/** "3,100 MMR", or "MMR unknown" for a 0. A fixed locale: see CLAUDE.md. */
export function standinMmrLabel(mmr: number | null): string {
  return mmr && mmr > 0 ? `${MMR_NUMBER.format(mmr)} MMR` : "MMR unknown";
}

/** One unplayed-fixture booking the captain's standin picker checks. */
export type StandinBooking = StandinSlot & {
  standinUserId: string;
  matchId: string;
  /** The covered player's name; null = an empty-seat fill. */
  replacedName: string | null;
  homeName: string;
  awayName: string;
  /** A request still waiting for the other captain, not a booking. */
  pending?: boolean;
  /**
   * A request for the picker's own team that the other team's captain
   * declined (their team's name): not a booking, but the captain can't book
   * or ask for this standin again in this match.
   */
  declinedBy?: string;
};

/**
 * Why the assign form should not offer this standin, or null when it may.
 *
 * It mirrors the refusals assignStandinGuarded gives most often, so the
 * picker stops offering a choice that can only come back as a toast: the
 * standin already has a booking or a request waiting for the other captain
 * anywhere in THIS match, they were declined for this team in this match
 * (the captain's card refuses them for every seat, booked or asked for,
 * whatever their MMR), or covers another unplayed fixture the same night
 * (`standinConflict`, with the same target the server uses). `bookings` are
 * the season's unplayed-fixture bookings, this match's included, plus this
 * match's pending requests and the captain's own declined ones. The server
 * still checks all of it at submit.
 */
export function standinPickerBlock(
  standinUserId: string,
  target: StandinSlot & { matchId: string },
  bookings: readonly StandinBooking[],
): string | null {
  const theirs = bookings.filter((b) => b.standinUserId === standinUserId);
  const inThisMatch = theirs.filter((b) => b.matchId === target.matchId);
  const here = inThisMatch.find((b) => !b.declinedBy);
  if (here) {
    if (here.pending) return "waiting for the other captain's OK in this match";
    return here.replacedName
      ? `covering ${here.replacedName} in this match`
      : "filling an open seat in this match";
  }
  const declined = inThisMatch.find((b) => b.declinedBy);
  if (declined) {
    // Not attributed to a captain: an admin may have declined in their place.
    return "already declined for your team in this match";
  }
  // A request elsewhere isn't a booking yet: agreeing to it re-checks the
  // night, so it doesn't hide the standin here.
  const clash = theirs.find(
    (b) => !b.pending && !b.declinedBy && standinConflict(target, b),
  );
  return clash
    ? `booked for ${clash.homeName} vs ${clash.awayName} that night`
    : null;
}

/**
 * The captain's "Covers…" list: players who said they can't make it and have
 * no cover yet come first, then the rest of the roster in its own order.
 * Covered players are left out (one seat, one standin). `preselect` is set
 * only when exactly one player is out, so the form never guesses between two.
 */
export function coverChoices<T extends { userId: string }>(
  roster: readonly T[],
  outUserIds: ReadonlySet<string>,
  coveredUserIds: ReadonlySet<string>,
): { choices: { member: T; out: boolean }[]; preselect: string | null } {
  const open = roster.filter((m) => !coveredUserIds.has(m.userId));
  const out = open.filter((m) => outUserIds.has(m.userId));
  const rest = open.filter((m) => !outUserIds.has(m.userId));
  return {
    choices: [
      ...out.map((member) => ({ member, out: true })),
      ...rest.map((member) => ({ member, out: false })),
    ],
    preselect: out.length === 1 ? out[0].userId : null,
  };
}
