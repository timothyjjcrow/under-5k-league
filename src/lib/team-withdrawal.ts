import { SEASON_STATUS } from "./constants";

/**
 * Team withdrawal is a regular-season ruling, not a generic roster flag.
 * Before play, captain removal owns teardown; after seeding, the affected
 * playoff match owns advancement; once complete, the flag is historical.
 * Keeping one reason shared by the page and both actions prevents a stale or
 * direct Server Action request from discovering a different lifecycle policy
 * than the administrator was shown.
 */
export function teamWithdrawalLockedReason(
  seasonStatus: string,
): string | null {
  if (seasonStatus === SEASON_STATUS.REGULAR_SEASON) return null;
  if (seasonStatus === SEASON_STATUS.PLAYOFFS) {
    return "The playoff bracket is already seeded — rule the affected bracket match with Save as final instead so advancement stays explicit.";
  }
  if (seasonStatus === SEASON_STATUS.COMPLETE) {
    return "The season is complete — team withdrawal status is historical and read-only.";
  }
  if (seasonStatus === SEASON_STATUS.DRAFT) {
    return "Team withdrawal opens in the Regular season. During the auction, finish or abort the draft before changing a team’s season status.";
  }
  return "Team withdrawal opens in the Regular season. Before the season starts, remove the captain instead so the empty team is removed cleanly.";
}

/**
 * Games a withdrawn team's opponent is credited in each of the team's
 * unfinished regular-season series: the series clinch number (Bo1 1-0, Bo2
 * 2-0, Bo3 2-0, Bo5 3-0). Shared by the withdrawal action, which writes it,
 * and /rules, which quotes it, so the page can't drift from the ruling.
 */
export function withdrawalForfeitScore(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}
