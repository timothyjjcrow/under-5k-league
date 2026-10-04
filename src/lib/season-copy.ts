// The dashboard hero's one-line description of the phase.
//
// Pulled out of page.tsx and given a test because the SIGNUPS line is the third
// place in one week that assumed a league still short of its minimum. Signups
// are UNCAPPED (see capacity.ts): `minTeams` is a floor, so a season spends
// most of signup week PAST it, and a static "we're still waiting for players"
// sentence spends that whole time contradicting the "Ready to draft" badge
// rendered directly beside it.

import { DRAFT_STATUS, HARD_MMR_CEILING, SEASON_STATUS } from "./constants";
import { LEAGUE_CONFIG } from "./league-config";

/**
 * What a `<Countdown passedLabel>` says about a draft night that has been and
 * gone while the season is still taking signups.
 *
 * ONE constant because several surfaces print that date (the dashboard
 * hero's chip, its draft-night confirmation and captain line, /me, the draft
 * room and a team page), and one was once added in the same change that fixed
 * the others, with no chip at all. Anything rendering `season.draftAt` owns
 * saying it has passed; sharing the string is how that stays true.
 */
export const DRAFT_PASSED_LABEL = "start overdue";

/**
 * The same chip for the next season's signup date on Home's Season complete
 * hero (an admin sets it on /admin's Season handoff card). Home only shows
 * that date while the league is still in Season complete, so a passed date
 * means signups haven't opened when they were meant to.
 */
export const NEXT_SEASON_PASSED_LABEL = "running late";

export type PhaseCopyInput = {
  /** Has the player count reached `minTeams x teamSize`? SIGNUPS only. */
  canDraft?: boolean;
  /** The viewer already has an active signup. SIGNUPS only: they aren't
   *  asked to sign up again. */
  signedUp?: boolean;
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
 * The ONE name for the league's current phase, used by every phase chip: the
 * header chip, the footer and the dashboard hero. They
 * used to keep three hand-copied maps with different
 * wording, and the footer's said "Draft in progress" for an auction that had
 * not started (or had already finished), because a season-phase map cannot
 * see the auction. Inside DRAFT the label comes from `draftPhasePresentation`,
 * so "Draft setup" / "Draft live" / "Draft paused" / "Draft complete" say what
 * a visitor can actually do.
 *
 * Every chip sits beside the season's name, so the label never repeats the
 * word "Season" ("Season 7 · Complete", not "Season 7 · Season complete").
 * `null` is the offseason; an unknown status renders as itself.
 */
export function seasonPhaseLabel(
  status: string | null | undefined,
  draftStatus?: string | null,
): string {
  switch (status) {
    case SEASON_STATUS.SIGNUPS:
      return "Signups open";
    case SEASON_STATUS.DRAFT:
      return draftPhasePresentation(draftStatus).badge;
    case SEASON_STATUS.REGULAR_SEASON:
      return "Regular season";
    case SEASON_STATUS.PLAYOFFS:
      return "Playoffs";
    case SEASON_STATUS.COMPLETE:
      return "Complete";
    case null:
    case undefined:
      return "Between seasons";
    default:
      return status;
  }
}

export type PhaseTone = "brand" | "accent" | "success" | "info" | "neutral";

/** The badge colour that goes with `seasonPhaseLabel`, shared the same way. */
export function seasonPhaseTone(status: string | null | undefined): PhaseTone {
  switch (status) {
    case SEASON_STATUS.SIGNUPS:
      return "info";
    case SEASON_STATUS.DRAFT:
    case SEASON_STATUS.PLAYOFFS:
      return "accent";
    case SEASON_STATUS.REGULAR_SEASON:
      return "success";
    case SEASON_STATUS.COMPLETE:
      // Gold, like the trophy: red reads as an error, and a finished season
      // is the league's good news.
      return "accent";
    default:
      return "neutral";
  }
}

/**
 * Phase labels for the season-HISTORY surfaces (/seasons, /seasons/[id]) and
 * the ADMIN surfaces (panel + phase-move toast) — each pair was byte-identical
 * and is single-sourced here. They name a phase as a STEP ("In season",
 * "Draft") rather than describing the live league, so they stay separate from
 * `seasonPhaseLabel` above, which every current-phase chip uses.
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
 * How long player signups stay open, said the same way on Home and in the
 * draft-night reminder. Nothing closes them on a clock: an admin does, with
 * Close signups (SIGNUPS → DRAFT) or Start draft, and Close signups can come
 * days before draft night.
 */
export const PLAYER_SIGNUPS_OPEN_UNTIL =
  "until an admin closes them for the draft";

/**
 * One sentence under the season name. Returns "" for an unknown status so a
 * future phase renders nothing rather than a stale line about another one.
 */
export function phaseSubtitle(status: string, i: PhaseCopyInput = {}): string {
  switch (status) {
    case SEASON_STATUS.SIGNUPS:
      if (i.canDraft)
        return `Enough players have joined to draft — and signups stay open ${PLAYER_SIGNUPS_OPEN_UNTIL}, so every few more is another team.`;
      return i.signedUp
        ? "The draft begins once enough players have joined."
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

/**
 * The admin-typed match night (`Season.matchSchedule`), ready to quote in a
 * sentence: trimmed, and without a trailing full stop, because every surface
 * that quotes it ends the sentence itself ("Wednesdays, 8pm ET.. Games are
 * on…" otherwise). Null when the admin hasn't set one.
 */
export function matchNightText(raw: string | null | undefined): string | null {
  return raw?.trim().replace(/[.\s]+$/, "") || null;
}

/**
 * What the league is, in one sentence, for a visitor who has never heard of
 * it. Home's hero otherwise went straight from a season name and team-count
 * maths to "Sign in with Steam to join"; the only description lived in link
 * previews. Deliberately says nothing about cost or dates, which vary. Home,
 * How it works and the site-wide link preview all open with this sentence.
 */
export function leaguePitch(name: string = LEAGUE_CONFIG.name): string {
  return `${name} is an amateur Dota 2 league: captains draft players in a live auction, then teams play weekly matches and playoffs.`;
}

/**
 * The one hard MMR limit, worded the same everywhere the league describes who
 * can join (Home, How it works, link previews): "up to 5,000 MMR". It is the
 * limit the signup form enforces (HARD_MMR_CEILING), never a season's soft
 * review threshold.
 */
export function mmrCeilingPhrase(): string {
  return `up to ${HARD_MMR_CEILING.toLocaleString("en-US")} MMR`;
}

/**
 * Who can join and when games are, beside the pitch. The MMR figure is the
 * one hard limit the signup form enforces (HARD_MMR_CEILING), not a season's
 * soft review threshold, which never turns anyone away. The match night is
 * the announced one (announcedMatchNight), never a hardcoded time, so each
 * region prints its own; null says it is still to be announced.
 */
export function leagueEligibilityLine(matchNight: string | null): string {
  const mmr = `Open to players ${mmrCeilingPhrase()}`;
  return matchNight
    ? `${mmr} · Match night: ${matchNight}`
    : `${mmr} · Match night to be announced`;
}
