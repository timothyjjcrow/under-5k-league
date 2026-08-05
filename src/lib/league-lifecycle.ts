import {
  AUTO_SYNC,
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "./constants";

/**
 * Can a roster-dependent, post-auction feature write yet?
 *
 * Later phases intentionally allow a missing Draft row for imported/manual
 * legacy seasons. During SIGNUPS or DRAFT, however, captain rows alone are not
 * a roster and a live/paused/not-started auction is never sufficient.
 */
export function postAuctionWorkOpen(
  seasonStatus: string,
  draftStatus: string | null | undefined,
): boolean {
  if (seasonStatus === SEASON_STATUS.SIGNUPS) return false;
  if (seasonStatus === SEASON_STATUS.DRAFT) {
    return draftStatus === DRAFT_STATUS.COMPLETE;
  }
  return seasonStatus !== SEASON_STATUS.COMPLETE;
}

/**
 * Can captains change scheduled-match logistics such as time and RSVP?
 *
 * A live match is already underway and a completed match is history. Keeping
 * that status rule beside the season/draft gate gives pages and mutations one
 * shared answer instead of each reconstructing a slightly different phase
 * check.
 */
export function matchLogisticsOpen(
  seasonStatus: string,
  draftStatus: string | null | undefined,
  matchStatus: string,
): boolean {
  return (
    postAuctionWorkOpen(seasonStatus, draftStatus) &&
    matchStatus === MATCH_STATUS.SCHEDULED
  );
}

/**
 * Can a captain/admin assign cover for the remaining games in this series?
 * Unlike rescheduling and RSVP, a LIVE series deliberately remains open: a
 * player can disconnect after game one and need a standin for game two. The
 * imported game keeps its original attribution; completed history is locked.
 */
export function standinAssignmentOpen(
  seasonStatus: string,
  draftStatus: string | null | undefined,
  matchStatus: string,
): boolean {
  return (
    postAuctionWorkOpen(seasonStatus, draftStatus) &&
    matchStatus !== MATCH_STATUS.COMPLETED
  );
}

/**
 * Can players answer the match-night check-in now?
 *
 * Rescheduling deliberately permits an unscheduled fixture to receive its
 * first proposed kickoff. An RSVP is different: without a published night,
 * IN/OUT has no concrete question to answer.
 */
export function matchCheckinOpen(
  seasonStatus: string,
  draftStatus: string | null | undefined,
  matchStatus: string,
  scheduledAt: Date | string | number | null | undefined,
  nowMs?: number,
): boolean {
  const kickoffMs =
    scheduledAt == null ? null : new Date(scheduledAt).getTime();
  return (
    matchLogisticsOpen(seasonStatus, draftStatus, matchStatus) &&
    kickoffMs != null &&
    Number.isFinite(kickoffMs) &&
    (nowMs == null || kickoffMs >= nowMs - AUTO_SYNC.WINDOW_HOURS * 3600_000)
  );
}

/**
 * Can this fixture's result change in the league's current phase?
 *
 * Keeping the season and match phase paired is load-bearing: changing a
 * regular-season result after the playoff bracket has been seeded rewrites the
 * standings without reseeding the bracket, while writing a playoff result
 * outside PLAYOFFS makes advancement a silent no-op. Archive amendments are a
 * separate, explicit admin workflow; ordinary result actions never mutate
 * inactive/off-phase history.
 */
export function matchResultsOpen(
  seasonStatus: string,
  matchPhase: string,
): boolean {
  return (
    (seasonStatus === SEASON_STATUS.REGULAR_SEASON &&
      matchPhase === MATCH_PHASE.REGULAR) ||
    (seasonStatus === SEASON_STATUS.PLAYOFFS &&
      matchPhase !== MATCH_PHASE.REGULAR)
  );
}
