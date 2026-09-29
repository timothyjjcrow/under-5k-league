// The viewer's own side in the match-night check-in banner (Home's panel,
// /schedule and the match page): who they are in this match (its captain, a
// booked standin or a player), what the prompt says to them, and how many of
// their side have answered. The names behind that count go only to the people
// allowed to see named answers (captains and admins: lib/visibility's
// canViewNamedMatchAvailability). Pure so every branch is tested;
// checkin-side-service.ts loads the rows.

import {
  AVAILABILITY,
  expectedSideSize,
  matchNightRoster,
  teamAvailability,
  type AvailabilityRow,
} from "./availability";

export type CheckinRole = "captain" | "standin" | "player";

export type CheckinSideCounts = {
  in: number;
  out: number;
  noReply: number;
  /** Seats nobody fills: the side is short and no standin takes the seat. */
  openSeats: number;
  /** What the count is out of: the season's side size (expectedSideSize). */
  of: number;
};

/** Who is behind each count. The viewer reads as "you". */
export type CheckinSideNames = {
  in: string[];
  /** Said they can't make it and nobody covers them yet. */
  out: string[];
  /** A roster player whose seat a standin has for this match. */
  covered: { name: string; by: string }[];
  noReply: string[];
};

export type CheckinSide = {
  teamName: string;
  role: CheckinRole;
  /** The side's captain, for everyone but the captain themself. */
  captainName: string | null;
  /** A standin's seat: the player they cover, or null for an open seat. */
  standinFor?: string | null;
  counts: CheckinSideCounts;
  /** Null unless the viewer may see named answers. */
  names: CheckinSideNames | null;
};

/** What the banner draws: the side, plus a standin's captain's handle. */
export type CheckinSideView = CheckinSide & {
  /** Set only for a standin, and only when the viewer may see league contact. */
  captainContact: { discordName: string; discordId: string | null } | null;
};

export type CheckinSideBooking = {
  standinUserId: string;
  standinName: string;
  replacingUserId: string | null;
  replacingName: string | null;
};

/**
 * The viewer's side for one match, or null when the viewer isn't on its
 * match-night roster (a covered player, or someone not playing). Counts come
 * from the same matchNightRoster + teamAvailability as /schedule's badges and
 * the Discord week reminder, so no two surfaces can disagree.
 */
export function checkinSide(input: {
  viewerId: string;
  teamName: string;
  captain: { id: string; name: string };
  /** The team's roster for the season, captain included. */
  roster: readonly { userId: string; name: string }[];
  /** This match's standin bookings for this side. */
  bookings: readonly CheckinSideBooking[];
  /** The match's current-revision check-ins (other sides' rows are ignored). */
  rows: readonly AvailabilityRow[];
  teamSize: number;
  showNames: boolean;
}): CheckinSide | null {
  const { viewerId, roster, bookings } = input;
  const night = matchNightRoster(
    roster.map((m) => m.userId),
    bookings.map((b) => ({
      standinUserId: b.standinUserId,
      replacingUserId: b.replacingUserId,
    })),
  );
  if (!night.includes(viewerId)) return null;

  const summary = teamAvailability(night, [...input.rows]);
  const of = expectedSideSize(input.teamSize, night.length);
  const counts: CheckinSideCounts = {
    in: summary.confirmed,
    out: summary.out,
    noReply: summary.unanswered,
    openSeats: of - night.length,
    of,
  };

  const standinIds = new Set(bookings.map((b) => b.standinUserId));
  const nameOf = new Map<string, string>(roster.map((m) => [m.userId, m.name]));
  for (const b of bookings) nameOf.set(b.standinUserId, b.standinName);
  const label = (id: string) =>
    id === viewerId
      ? "you"
      : `${nameOf.get(id) ?? "?"}${standinIds.has(id) ? " (standin)" : ""}`;

  const mine = bookings.find((b) => b.standinUserId === viewerId);
  const role: CheckinRole =
    viewerId === input.captain.id ? "captain" : mine ? "standin" : "player";

  let names: CheckinSideNames | null = null;
  if (input.showNames) {
    const status = new Map(input.rows.map((r) => [r.userId, r.status]));
    const onNight = new Set(night);
    names = {
      in: night.filter((id) => status.get(id) === AVAILABILITY.IN).map(label),
      out: summary.outUserIds.map(label),
      // Derived from the night roster itself, so a stale booking for someone
      // who left the roster (which matchNightRoster drops) never shows here.
      covered: roster
        .filter((m) => !onNight.has(m.userId))
        .map((m) => ({
          name: label(m.userId),
          by:
            bookings.find((b) => b.replacingUserId === m.userId)?.standinName ??
            "a standin",
        })),
      noReply: summary.unansweredUserIds.map(label),
    };
  }

  return {
    teamName: input.teamName,
    role,
    captainName: role === "captain" ? null : input.captain.name,
    ...(mine ? { standinFor: mine.replacingName ?? null } : {}),
    counts,
    names,
  };
}

/** "3 of 5 in · 1 out · 1 no reply"; zero parts are left out. */
export function checkinCountsText(
  counts: CheckinSideCounts,
  remainingGames = false,
): string {
  const parts = [`${counts.in} of ${counts.of} ${remainingGames ? "ready" : "in"}`];
  if (counts.out > 0) parts.push(`${counts.out} out`);
  if (counts.noReply > 0) parts.push(`${counts.noReply} no reply`);
  if (counts.openSeats > 0)
    parts.push(`${counts.openSeats} open seat${counts.openSeats === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Someone on the side needs cover: a player out with none, or an empty seat. */
export function sideNeedsCover(counts: CheckinSideCounts): boolean {
  return counts.out > 0 || counts.openSeats > 0;
}

/** A standin's seat, said to them: which player and which team. */
export function standinSeatText(
  teamName: string,
  standinFor: string | null,
): string {
  return standinFor
    ? `You're standing in for ${standinFor} on ${teamName}.`
    : `You're filling an open seat on ${teamName}.`;
}

/**
 * The line under the fixture: the viewer's own answer once they have given
 * one, otherwise a prompt worded for who they are here. A captain has nobody
 * above them to tell, so they are pointed at their side instead. Without a
 * `teamName` (a caller with no side to show) the captain keeps the short
 * "Let your team know."
 */
export function checkinPrompt(input: {
  myRsvp: string | null;
  remainingGames?: boolean;
  role: CheckinRole;
  teamName?: string | null;
  captainName?: string | null;
}): string {
  const { role, captainName, teamName } = input;
  const remaining = input.remainingGames ?? false;
  if (input.myRsvp === AVAILABILITY.IN) {
    return remaining
      ? "You're ready for the remaining games ✓ — change it here if plans shift."
      : "You're confirmed ✓ — change it here if plans shift.";
  }
  if (input.myRsvp === AVAILABILITY.OUT) {
    if (role === "captain")
      return "You're marked unavailable — line up a standin for your seat.";
    if (role === "standin")
      return "You're marked unavailable — your captain can line up someone else.";
    return "You're marked unavailable — a standin can be lined up.";
  }
  if (role === "captain") {
    if (!teamName) return "Can you make it? Let your team know.";
    return remaining
      ? `You're captaining ${teamName}. Say you're ready, then see who's missing.`
      : `You're captaining ${teamName}. Check in, then see who's missing.`;
  }
  if (!captainName) return "Can you make it? Let your captain know.";
  return role === "standin"
    ? `Can you make it? Let ${captainName} know.`
    : `Can you make it? Let your captain, ${captainName}, know.`;
}
