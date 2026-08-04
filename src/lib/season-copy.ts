// The dashboard hero's one-line description of the phase.
//
// Pulled out of page.tsx and given a test because the SIGNUPS line is the third
// place in one week that assumed a league still short of its minimum. Signups
// are UNCAPPED (see capacity.ts): `minTeams` is a floor, so a season spends
// most of signup week PAST it, and a static "we're still waiting for players"
// sentence spends that whole time contradicting the "Ready to draft" badge
// rendered directly beside it.

import { DRAFT_STATUS, SEASON_STATUS } from "./constants";

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
export const DRAFT_PASSED_LABEL = "start overdue";

export type PhaseCopyInput = {
  /** Has the player count reached `minTeams x teamSize`? SIGNUPS only. */
  canDraft?: boolean;
  /** The auction's state inside the broader DRAFT season phase. */
  draftStatus?: string | null;
  /** COMPLETE only: whether the authoritative grand final crowned a team. */
  hasChampion?: boolean;
};

export type DraftPhasePresentation = {
  badge: string;
  action: string;
  teamLabel: string;
  teamLabelSingular: string;
  live: boolean;
};

/**
 * Viewer-facing state inside the season's DRAFT phase.
 *
 * `Season.status === DRAFT` only says which league chapter is active. The
 * auction can still be waiting, live, paused, or finished while an admin
 * prepares the regular season. Keeping those states explicit prevents the
 * dashboard from claiming that captains are bidding when no bid can be made.
 */
export function draftPhasePresentation(
  status: string | null | undefined,
): DraftPhasePresentation {
  switch (status) {
    case DRAFT_STATUS.IN_PROGRESS:
      return {
        badge: "Draft live",
        action: "Enter the live draft →",
        teamLabel: "teams drafting",
        teamLabelSingular: "team drafting",
        live: true,
      };
    case DRAFT_STATUS.PAUSED:
      return {
        badge: "Draft paused",
        action: "Return to the draft room →",
        teamLabel: "teams in the draft",
        teamLabelSingular: "team in the draft",
        live: false,
      };
    case DRAFT_STATUS.COMPLETE:
      return {
        badge: "Draft complete",
        action: "Review the draft results →",
        teamLabel: "rosters completed",
        teamLabelSingular: "roster completed",
        live: false,
      };
    default:
      return {
        badge: "Draft setup",
        action: "View the draft room →",
        teamLabel: "teams ready",
        teamLabelSingular: "team ready",
        live: false,
      };
  }
}

/**
 * One sentence under the season name. Returns "" for an unknown status so a
 * future phase renders nothing rather than a stale line about another one.
 */
/**
 * Phase labels for the season-HISTORY surfaces (/seasons, /seasons/[id]) and
 * the ADMIN surfaces (panel + phase-move toast) — each pair was byte-identical
 * and is single-sourced here. The dashboard and the phase badges in the
 * header/footer keep deliberately different per-surface copy; do not unify
 * those into these history/admin labels. The schedule destination label below
 * is shared separately because it names the same link in both global navs.
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

/**
 * Name the current season's schedule destination in global navigation.
 *
 * The route stays `/schedule`, but its job changes after the regular season:
 * an active bracket is “Playoffs” and a completed bracket is read-only “Season
 * results”. Header and footer must not describe the same destination
 * differently, so this small piece of navigation copy is shared.
 */
export function scheduleDestinationLabel(status: string | null): string {
  if (status === SEASON_STATUS.PLAYOFFS) return "Playoffs";
  if (status === SEASON_STATUS.COMPLETE) return "Season results";
  return "Schedule";
}

export function phaseSubtitle(status: string, i: PhaseCopyInput = {}): string {
  switch (status) {
    case SEASON_STATUS.SIGNUPS:
      return i.canDraft
        ? "Enough players have joined to draft — and signups stay open until draft night, so every few more is another team."
        : "Sign up now — the draft begins once enough players have joined.";
    case SEASON_STATUS.DRAFT:
      switch (i.draftStatus) {
        case DRAFT_STATUS.IN_PROGRESS:
          return "Captains are bidding on players to build their rosters.";
        case DRAFT_STATUS.PAUSED:
          return "The live auction is paused. Bidding resumes when an administrator restarts it.";
        case DRAFT_STATUS.COMPLETE:
          return "The auction is complete. Rosters are set, and the regular-season schedule comes next.";
        default:
          return "The draft is being prepared. The live auction opens when the captains and teams are ready.";
      }
    case SEASON_STATUS.REGULAR_SEASON:
      return "Weekly round-robin matches are underway.";
    case SEASON_STATUS.PLAYOFFS:
      return "The top teams battle it out in the playoff bracket.";
    case SEASON_STATUS.COMPLETE:
      return i.hasChampion === false
        ? "This season is closed but no champion is recorded. League administrators are reviewing the final state."
        : "That's a wrap. Congratulations to our champions!";
    default:
      return "";
  }
}
