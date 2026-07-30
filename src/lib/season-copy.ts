// The dashboard hero's one-line description of the phase.
//
// Pulled out of page.tsx and given a test because the SIGNUPS line is the third
// place in one week that assumed a league still short of its minimum. Signups
// are UNCAPPED (see capacity.ts): `minTeams` is a floor, so a season spends
// most of signup week PAST it, and a static "we're still waiting for players"
// sentence spends that whole time contradicting the "Ready to draft" badge
// rendered directly beside it.

import { SEASON_STATUS } from "./constants";

/**
 * What a `<Countdown passedLabel>` says about a draft night that has been and
 * gone while the season is still taking signups.
 *
 * ONE constant because THREE surfaces print that date — the hero chip, the
 * signup card, and the signed-up player's hero panel — and the third was added
 * in the same change that fixed the first two, with no chip at all. Anything
 * rendering `season.draftAt` owns saying it has passed; sharing the string is
 * how that stays true.
 */
export const DRAFT_PASSED_LABEL = "hasn't started yet";

export type PhaseCopyInput = {
  /** Has the player count reached `minTeams x teamSize`? SIGNUPS only. */
  canDraft?: boolean;
};

/**
 * One sentence under the season name. Returns "" for an unknown status so a
 * future phase renders nothing rather than a stale line about another one.
 */
/**
 * Phase labels for the season-HISTORY surfaces (/seasons, /seasons/[id]) and
 * the ADMIN surfaces (panel + phase-move toast) — each pair was byte-identical
 * and is single-sourced here. The dashboard, header and footer keep their own
 * DELIBERATELY different per-surface maps; don't unify them into these.
 */
export const HISTORY_PHASE_LABEL: Record<string, string> = {
  SIGNUPS: "Signups open",
  DRAFT: "Drafting",
  REGULAR_SEASON: "In season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Complete",
};

export const ADMIN_PHASE_LABEL: Record<string, string> = {
  SIGNUPS: "Signups",
  DRAFT: "Draft",
  REGULAR_SEASON: "Regular season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Complete",
};

export function phaseSubtitle(status: string, i: PhaseCopyInput = {}): string {
  switch (status) {
    case SEASON_STATUS.SIGNUPS:
      return i.canDraft
        ? "Enough players have joined to draft — and signups stay open until draft night, so every few more is another team."
        : "Sign up now — the draft begins once enough players have joined.";
    case SEASON_STATUS.DRAFT:
      return "Captains are bidding on players to build their rosters.";
    case SEASON_STATUS.REGULAR_SEASON:
      return "Weekly round-robin matches are underway.";
    case SEASON_STATUS.PLAYOFFS:
      return "The top teams battle it out in the playoff bracket.";
    case SEASON_STATUS.COMPLETE:
      return "That's a wrap. Congratulations to our champions!";
    default:
      return "";
  }
}
