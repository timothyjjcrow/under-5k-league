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
