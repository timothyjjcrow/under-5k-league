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
