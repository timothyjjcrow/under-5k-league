import {
  DRAFT_STATUS,
  SEASON_STATUS,
} from "./constants";

/**
 * "What do I do next?" for the admin panel.
 *
 * The panel had exactly ONE next-step banner — draft-complete → Regular season —
 * added because that transition is silent and everything it gates (auto result
 * sync, match-night check-in, the weekly Discord reminder, the Schedule/Leaders
 * nav) fails QUIETLY when it is missed. But that is not the only silent
 * transition, it is just the first one anyone got burned by:
 *
 * - A generated schedule with no kickoff times disables auto-sync, week
 *   reminders and pick'em locks for the whole season, and says so only in a
 *   toast that has long since gone.
 * - Nothing whatsoever prompts "start the playoffs" once the last regular
 *   result lands, or "record the final" when the bracket is one match from a
 *   champion.
 * - COMPLETE is a dead end: the control that starts next season is inside a
 *   collapsed <details> at the bottom of the page.
 * - A season parked in COMPLETE with an unfinished bracket will never crown
 *   anyone, and every playoff result saves with a success toast regardless.
 *
 * Pure and tested so the wording of each step is checkable without rendering a
 * 3,200-line page. The panel renders exactly what this returns.
 */
export type AdminPhaseInput = {
  seasonStatus: string;
  /** null when the season has no Draft row at all (never started one). */
  draftStatus: string | null;
  playerCount: number;
  /** Signups needed before the draft can run (capacityInfo.minPlayers). */
  minPlayers: number;
  teamCount: number;
  regularMatchCount: number;
  /** Regular matches carrying a kickoff time. */
  scheduledRegularCount: number;
  pendingRegularResults: number;
  playoffMatchCount: number;
  unfinishedPlayoffCount: number;
  hasChampion: boolean;
};

export type AdminNextStep = {
  /** Imperative headline — the one thing to do now. */
  title: string;
  /** What it unlocks, or what stays broken until it happens. */
  detail: string;
  tone: "action" | "waiting" | "warning" | "done";
};

export function adminNextStep(i: AdminPhaseInput): AdminNextStep {
  const {
    seasonStatus,
    draftStatus,
    playerCount,
    minPlayers,
    teamCount,
    regularMatchCount,
    scheduledRegularCount,
    pendingRegularResults,
    playoffMatchCount,
    unfinishedPlayoffCount,
    hasChampion,
  } = i;

  if (seasonStatus === SEASON_STATUS.SIGNUPS) {
    if (playerCount < minPlayers) {
      return {
        title: `Waiting on signups — ${minPlayers - playerCount} more to go.`,
        detail: `${playerCount} of ${minPlayers} players registered. Share the signup link; you can designate captains at any time.`,
        tone: "waiting",
      };
    }
    if (teamCount < 2) {
      return {
        title: "Next step: designate captains.",
        detail:
          "Enough players have signed up. Use “make captain” in the Eligible players list below — each captain becomes a team.",
        tone: "action",
      };
    }
    return {
      title: "Next step: Start draft.",
      detail: `${teamCount} captain(s) ready. Set the draft night and randomize the order first if you want to — starting the auction locks captain changes until it finishes (Abort draft is the way back).`,
      tone: "action",
    };
  }

  if (seasonStatus === SEASON_STATUS.DRAFT) {
    if (draftStatus === DRAFT_STATUS.IN_PROGRESS) {
      return {
        title: "The auction is live.",
        detail:
          "Open the draft room to follow it. Pause parks the clocks if a dispute needs settling; Undo last sale reverts the most recent purchase.",
        tone: "waiting",
      };
    }
    if (draftStatus === DRAFT_STATUS.PAUSED) {
      return {
        title: "The auction is PAUSED — nothing can sell.",
        detail:
          "Clocks are parked and every captain is waiting. Press Resume when the dispute is settled.",
        tone: "warning",
      };
    }
    if (draftStatus === DRAFT_STATUS.COMPLETE) {
      return {
        title: "Next step: move the season to Regular season.",
        detail:
          "The auction is finished, but until you do, automatic result sync, match-night check-in, the weekly Discord reminder and the Schedule/Leaders nav links all stay switched off.",
        tone: "action",
      };
    }
    return {
      title: "Next step: Start draft.",
      detail:
        "The season is in the Draft phase but the auction hasn't been started yet — nothing happens until you press Start draft.",
      tone: "action",
    };
  }

  if (seasonStatus === SEASON_STATUS.REGULAR_SEASON) {
    if (regularMatchCount === 0) {
      return {
        title: "Next step: generate the schedule.",
        detail:
          "There are no fixtures yet, so there is nothing for players to check in to and nothing for results to attach to.",
        tone: "action",
      };
    }
    if (scheduledRegularCount === 0) {
      return {
        title: "Next step: set the match nights.",
        detail:
          "No fixture has a kickoff time, so automatic result sync never scans, no weekly Discord reminder goes out, and pick'em never locks. Use “Move a match night”, or regenerate with a first match night.",
        tone: "warning",
      };
    }
    if (pendingRegularResults > 0) {
      return {
        title: `Season running — ${pendingRegularResults} result(s) outstanding.`,
        detail:
          "Results import themselves from OpenDota; enter any that can't be found by hand in Schedule & results.",
        tone: "waiting",
      };
    }
    return {
      title: "Next step: Start playoffs.",
      detail:
        "Every regular-season result is in. Starting the playoffs seeds the bracket from the standings and moves the season to the Playoffs phase.",
      tone: "action",
    };
  }

  if (seasonStatus === SEASON_STATUS.PLAYOFFS) {
    if (playoffMatchCount === 0) {
      return {
        title: "Next step: seed the bracket.",
        detail:
          "The season is in the Playoffs phase but no bracket exists — press Start playoffs in the Playoffs card.",
        tone: "warning",
      };
    }
    if (unfinishedPlayoffCount > 0) {
      return {
        title: `Playoffs underway — ${unfinishedPlayoffCount} bracket match(es) left.`,
        detail:
          "Each result advances the bracket automatically, and the final crowns the champion and completes the season. Keep the season in Playoffs until then.",
        tone: "waiting",
      };
    }
    return {
      title: "The bracket is finished but no champion is recorded.",
      detail:
        "Re-save the final's result in Schedule & results to advance the bracket and crown the winner.",
      tone: "warning",
    };
  }

  if (seasonStatus === SEASON_STATUS.COMPLETE) {
    if (!hasChampion && unfinishedPlayoffCount > 0) {
      return {
        title: "This season ended without a champion.",
        detail:
          "The bracket still has unplayed matches, and in Complete no playoff result advances it. Move the season back to Playoffs to finish it — no bracket rebuild needed.",
        tone: "warning",
      };
    }
    return {
      title: "Season complete. Next step: create the next season.",
      // Name the control EXACTLY as the page labels it — this copy said "Start
      // next season", which is not what the section is called, and inventing a
      // control name is the same defect the audit found three times elsewhere.
      detail:
        "Open “Create a new season” at the bottom of this page. It archives this one (results, rosters and the champion are kept and stay browsable under History) and opens signups for the new one.",
      tone: "done",
    };
  }

  return {
    title: "Season in progress.",
    detail: "",
    tone: "waiting",
  };
}
