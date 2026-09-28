import { MATCH_PHASE } from "./constants";
import { matchRoundLabel, type RoundLabelMatch } from "./schedule";

/**
 * A fixture named for the admin activity log: "Week 3: Alpha vs Bravo", or
 * "Playoffs (week 9): Alpha vs Bravo" off the regular season. The log has no
 * foreign keys on purpose (a row must outlive the match it describes), so the
 * names are written in at the time instead of an id nobody can read later.
 */
export function fixtureLogLabel(
  match: RoundLabelMatch & { homeName: string; awayName: string },
): string {
  const round = matchRoundLabel(match, 0);
  const when =
    match.phase === MATCH_PHASE.REGULAR ? round : `${round} (week ${match.week})`;
  return `${when}: ${match.homeName} vs ${match.awayName}`;
}
