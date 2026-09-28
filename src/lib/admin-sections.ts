import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "./constants";
import { postAuctionWorkOpen } from "./league-lifecycle";

export type AdminSeasonCards = {
  schedule: boolean;
  playoffs: boolean;
  standins: boolean;
};

/**
 * Which season cards /admin shows. A card appears in the phases where it has
 * something to do, and whenever it holds data still worth reading or cleaning
 * up (fixtures, a bracket, a booking), so nothing that exists is ever hidden.
 *
 * During signups the page used to render Schedule ("unavailable"), Standins
 * ("no upcoming matches") and a Playoffs card whose tiebreaker rules ran to a
 * thousand pixels on a phone, all with nothing to press. The page AND its
 * jump bar read this one answer, so a jump link never points at a card that
 * isn't there.
 */
export function adminSeasonCards(input: {
  seasonStatus: string;
  draftStatus: string | null | undefined;
  matches: readonly { phase: string; status: string }[];
  /** Standin bookings on matches that aren't COMPLETED yet. */
  openBookings: number;
  /** Deleted postseason game ids saved for re-import (bracket resets). */
  archivedPostseasonGames: number;
}): AdminSeasonCards {
  const { seasonStatus, draftStatus, matches } = input;
  const afterAuction = postAuctionWorkOpen(seasonStatus, draftStatus);
  const leaguePlaying =
    seasonStatus === SEASON_STATUS.REGULAR_SEASON ||
    seasonStatus === SEASON_STATUS.PLAYOFFS ||
    seasonStatus === SEASON_STATUS.COMPLETE;
  return {
    schedule: matches.length > 0 || afterAuction,
    playoffs:
      leaguePlaying ||
      matches.some((m) => m.phase !== MATCH_PHASE.REGULAR) ||
      input.archivedPostseasonGames > 0,
    // Assigning opens after the auction; removing stays legal in every phase,
    // so a live booking keeps the card on screen wherever the league is.
    standins: afterAuction || input.openBookings > 0,
  };
}

/** Bookings whose match isn't played yet: the ones a card can still remove. */
export function openBookingCount(
  assignments: readonly { matchId: string }[],
  matches: readonly { id: string; status: string }[],
): number {
  const open = new Set(
    matches.filter((m) => m.status !== MATCH_STATUS.COMPLETED).map((m) => m.id),
  );
  return assignments.filter((a) => open.has(a.matchId)).length;
}

type CoverMatch = {
  id: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
};
type CoverBooking = {
  matchId: string;
  standinUserId: string;
  replacingUserId: string | null;
};
type CoverRsvp = { matchId: string; userId: string };
type CoverTeam = { id: string; members: readonly { userId: string }[] };

/**
 * One match's cover problems, as the admin Standins card shows them: roster
 * players who said they can't play with nobody booked in their place, and
 * booked standins who said they can't play themselves. Only current roster
 * members can need cover (a released player's old "can't make it" would
 * raise an alarm no booking can clear), and a booked standin's own "can't
 * make it" is the cover quitting, not a seat missing cover.
 */
export function matchCoverIssues<R extends CoverRsvp>(
  match: CoverMatch,
  teams: readonly CoverTeam[],
  bookings: readonly CoverBooking[],
  outRsvps: readonly R[],
): { uncovered: R[]; standinsOut: R[] } {
  const roster = new Set(
    teams
      .filter((t) => t.id === match.homeTeamId || t.id === match.awayTeamId)
      .flatMap((t) => t.members.map((m) => m.userId)),
  );
  const booked = bookings.filter((b) => b.matchId === match.id);
  const covered = new Set(booked.map((b) => b.replacingUserId));
  const standins = new Set(booked.map((b) => b.standinUserId));
  const out = outRsvps.filter((r) => r.matchId === match.id);
  return {
    uncovered: out.filter((r) => roster.has(r.userId) && !covered.has(r.userId)),
    standinsOut: out.filter((r) => standins.has(r.userId)),
  };
}

/**
 * The unplayed matches the Standins card opens on: a player out with no
 * cover, a booked standin who dropped out, or a standin booked on two
 * matches the same night. Everything else sits behind "Assign any match":
 * captains book almost all cover themselves from the match page, so a form
 * for every open match made this one of the longest cards on /admin for
 * the rare time the admin steps in.
 */
export function coverProblemMatchIds(input: {
  matches: readonly (CoverMatch & { status: string })[];
  teams: readonly CoverTeam[];
  bookings: readonly CoverBooking[];
  outRsvps: readonly CoverRsvp[];
  clashes: readonly { first: { id: string }; second: { id: string } }[];
}): Set<string> {
  const clashed = new Set(
    input.clashes.flatMap((c) => [c.first.id, c.second.id]),
  );
  const ids = new Set<string>();
  for (const match of input.matches) {
    if (match.status === MATCH_STATUS.COMPLETED) continue;
    const { uncovered, standinsOut } = matchCoverIssues(
      match,
      input.teams,
      input.bookings,
      input.outRsvps,
    );
    if (uncovered.length > 0 || standinsOut.length > 0 || clashed.has(match.id)) {
      ids.add(match.id);
    }
  }
  return ids;
}
