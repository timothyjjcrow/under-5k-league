// Pure match-night RSVP math: given a team's roster and the recorded
// availability rows, who's confirmed, who's out, and who hasn't answered.

import { MATCH_STATUS } from "./constants";
import { matchCheckinOpen, postAuctionWorkOpen } from "./league-lifecycle";

export const AVAILABILITY = {
  IN: "IN",
  OUT: "OUT",
} as const;

export type AvailabilityStatus = (typeof AVAILABILITY)[keyof typeof AVAILABILITY];

export type AvailabilityRow = { userId: string; status: string };

export type TeamAvailability = {
  confirmed: number;
  out: number;
  unanswered: number;
  outUserIds: string[];
  /** Roster members with no RSVP row at all — the people the week reminder
   *  pings by name, since they're precisely the ones not reading the channel. */
  unansweredUserIds: string[];
};

export type StandinLike = {
  standinUserId: string;
  replacingUserId: string | null;
};

/**
 * A side's MATCH-NIGHT roster: the team roster, minus players covered by a
 * standin (their old ✗ isn't a gap anymore), plus the assigned standins
 * (whose own ✓/✗ is the answer that matters). Feed this — never the raw
 * roster — to teamAvailability wherever standins can be assigned, or the
 * standin's RSVP is silently dropped and surfaces disagree.
 */
export function matchNightRoster(
  base: string[],
  assignments: StandinLike[],
): string[] {
  if (assignments.length === 0) return base;
  // Drop cover for somebody who is no longer on the roster. The swap is
  // "remove the covered player, add the standin", so a stale assignment made the
  // side come out ONE TOO LARGE — the filter removed nobody but the standin was
  // still appended, reporting six players in a 5v5 to /schedule, the dashboard
  // strip and the Discord week reminder. releasePlayer now cancels these at the
  // source; this keeps the arithmetic honest for rows any other path leaves
  // behind. A NULL replacingUserId is not stale — that is a standin filling an
  // empty seat on a short roster, and it adds a player without replacing one.
  const onRoster = new Set(base);
  const live = assignments.filter(
    (a) => a.replacingUserId == null || onRoster.has(a.replacingUserId),
  );
  if (live.length === 0) return base;
  const covered = new Set(live.map((a) => a.replacingUserId));
  return [
    ...base.filter((id) => !covered.has(id)),
    ...live.map((a) => a.standinUserId),
  ];
}

/**
 * The number a check-in count should be shown OUT OF.
 *
 * Always the season's side size — never the roster we happen to have. A team
 * that lost a player mid-season sits at 4 of 5, and rendering
 * `confirmed / roster.length` made that side read "4/4": complete, in success
 * green, on the dashboard This-week strip and in the Discord week reminder,
 * while the team was a player short and nobody had been told. Being a player
 * down is exactly the thing a check-in exists to surface, so the denominator
 * has to be what the league expects, not what it has.
 *
 * `Math.max` rather than a bare teamSize: a standin filling an EMPTY seat adds
 * a player without replacing one, so a roster can legitimately reach teamSize
 * from below, and anything above it should be shown rather than hidden.
 */
export function expectedSideSize(teamSize: number, rosterSize: number): number {
  return Math.max(teamSize, rosterSize);
}

/** Summarize one team's RSVPs. Rows from non-roster users are ignored. */
export function teamAvailability(
  rosterUserIds: string[],
  rows: AvailabilityRow[],
): TeamAvailability {
  const roster = new Set(rosterUserIds);
  const byUser = new Map(
    rows.filter((r) => roster.has(r.userId)).map((r) => [r.userId, r.status]),
  );
  const outUserIds = rosterUserIds.filter(
    (id) => byUser.get(id) === AVAILABILITY.OUT,
  );
  const confirmed = rosterUserIds.filter(
    (id) => byUser.get(id) === AVAILABILITY.IN,
  ).length;
  // The ids, not just the count: the week reminder pings exactly these people,
  // which is the difference between stating "3/5" into a channel and reaching
  // the two players who actually owe an answer.
  // Anything that isn't a valid IN or OUT is "no answer" — including a row
  // with an unrecognised status — so this list stays exactly the count the
  // rest of the app already shows.
  const unansweredUserIds = rosterUserIds.filter(
    (id) => byUser.get(id) !== AVAILABILITY.IN && byUser.get(id) !== AVAILABILITY.OUT,
  );
  return {
    confirmed,
    out: outUserIds.length,
    unanswered: unansweredUserIds.length,
    outUserIds,
    unansweredUserIds,
  };
}

/** Parse an untrusted status string; null when it isn't a valid RSVP. */
export function parseAvailabilityStatus(
  raw: string,
): AvailabilityStatus | null {
  return raw === AVAILABILITY.IN || raw === AVAILABILITY.OUT ? raw : null;
}

/**
 * The per-match, per-player claimThrottle key behind every OUT announcement.
 * One-match OUTs and "I'm away" ranges claim the SAME key, so saying it both
 * ways inside RSVP_OUT_PING_THROTTLE_SECONDS pings the captain once.
 */
export function outPingThrottleKey(matchId: string, userId: string): string {
  return `outPing:${matchId}:${userId}`;
}

/**
 * Why a player can't answer a fixture's check-in. setAvailability refuses with
 * the long message; the away-dates action reports a short label per fixture.
 * One list, so the two paths can never disagree about who may answer.
 */
export const CHECKIN_REFUSAL = {
  FINISHED: "FINISHED",
  PHASE: "PHASE",
  KICKOFF_PASSED: "KICKOFF_PASSED",
  NO_KICKOFF: "NO_KICKOFF",
  COVERED: "COVERED",
  NOT_PLAYING: "NOT_PLAYING",
  WITHDRAWN: "WITHDRAWN",
  INELIGIBLE: "INELIGIBLE",
} as const;

export type CheckinRefusal =
  (typeof CHECKIN_REFUSAL)[keyof typeof CHECKIN_REFUSAL];

/** setAvailability's refusal copy, byte-for-byte what it has always said. */
export const CHECKIN_REFUSAL_MESSAGE: Record<CheckinRefusal, string> = {
  FINISHED: "That match is already finished",
  PHASE: "Check-in is not open in this league phase",
  KICKOFF_PASSED:
    "Check-in is closed because that kickoff has passed — the result is still outstanding",
  NO_KICKOFF: "That match does not have a kickoff yet",
  COVERED:
    "A standin is covering your seat for this match, so you are not in its playing roster",
  NOT_PLAYING: "You're not playing in this match",
  WITHDRAWN: "A withdrawn team cannot check in for this match.",
  INELIGIBLE:
    "You're not playing in this match — the roster or cover assignment changed.",
};

/**
 * The fixture half of the check-in gate: null when `matchCheckinOpen` lets
 * this fixture be answered, otherwise the most specific reason it can't be.
 * The player half (roster seat, standin cover) needs the database — see
 * `resolveCheckinSeat` in availability-service.ts.
 */
export function checkinClosedReason(
  seasonStatus: string,
  draftStatus: string | null | undefined,
  match: { status: string; scheduledAt: Date | null },
  nowMs: number,
): CheckinRefusal | null {
  if (
    matchCheckinOpen(
      seasonStatus,
      draftStatus,
      match.status,
      match.scheduledAt,
      nowMs,
    )
  ) {
    return null;
  }
  if (match.status === MATCH_STATUS.COMPLETED) return CHECKIN_REFUSAL.FINISHED;
  if (!postAuctionWorkOpen(seasonStatus, draftStatus)) {
    return CHECKIN_REFUSAL.PHASE;
  }
  if (match.scheduledAt) return CHECKIN_REFUSAL.KICKOFF_PASSED;
  return CHECKIN_REFUSAL.NO_KICKOFF;
}
