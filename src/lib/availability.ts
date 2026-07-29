// Pure match-night RSVP math: given a team's roster and the recorded
// availability rows, who's confirmed, who's out, and who hasn't answered.

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
