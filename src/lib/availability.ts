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
  const covered = new Set(assignments.map((a) => a.replacingUserId));
  return [
    ...base.filter((id) => !covered.has(id)),
    ...assignments.map((a) => a.standinUserId),
  ];
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
  return {
    confirmed,
    out: outUserIds.length,
    unanswered: rosterUserIds.length - confirmed - outUserIds.length,
    outUserIds,
  };
}

/** Parse an untrusted status string; null when it isn't a valid RSVP. */
export function parseAvailabilityStatus(
  raw: string,
): AvailabilityStatus | null {
  return raw === AVAILABILITY.IN || raw === AVAILABILITY.OUT ? raw : null;
}
