import {
  DRAFT_STATUS,
  MATCH_PHASE,
  SEASON_STATUS,
  type SeasonStatus,
} from "./constants";

export type SeasonPhasePolicyInput = {
  current: string;
  target: SeasonStatus;
  draftStatus: string | null | undefined;
  matchCount: number;
  hasPlayedResult: boolean;
  hasImportedGame: boolean;
  postseasonMatchCount: number;
  postseasonBracketReady: boolean;
  hasChampion: boolean;
};

export type PostseasonBracketRow = {
  phase: string;
  bracketSlot: string | null;
};

export type SeasonPhasePolicyState =
  | {
      available: true;
      reason: null;
      confirmation: string;
      recovery: boolean;
    }
  | {
      available: false;
      reason: string;
      confirmation: null;
      recovery: false;
    };

const blocked = (reason: string): SeasonPhasePolicyState => ({
  available: false,
  reason,
  confirmation: null,
  recovery: false,
});

const allowed = (
  confirmation: string,
  recovery = false,
): SeasonPhasePolicyState => ({
  available: true,
  reason: null,
  confirmation,
  recovery,
});

const startPlayoffsReason =
  "Playoffs must begin with a seeded bracket. Use Start playoffs to seed the bracket and enter Playoffs together.";

/** Minimum structural proof needed before a phase-only recovery may adopt rows
 * as an existing bracket. Deeper seeding changes still belong to Reset. */
export function recoverablePostseasonBracket(
  matches: PostseasonBracketRow[],
): boolean {
  if (matches.length === 0) return false;
  const slots = new Set<string>();
  for (const match of matches) {
    if (
      (match.phase !== MATCH_PHASE.PLAYOFF &&
        match.phase !== MATCH_PHASE.FINAL) ||
      !match.bracketSlot?.match(/^R\d+M\d+$/) ||
      slots.has(match.bracketSlot)
    ) {
      return false;
    }
    slots.add(match.bracketSlot);
  }
  return true;
}

/**
 * The one policy used by both the admin UI and the phase mutation.
 *
 * Phase buttons are intentionally not a general-purpose state editor. The
 * commands that start/abort an auction, seed/remove a bracket, and crown a
 * champion also update related rows atomically, so those commands must own the
 * corresponding transitions. This policy permits the two non-destructive
 * forward moves and only the small set of recovery shapes where the related
 * state already proves what the intended phase is.
 */
export function seasonPhasePolicy({
  current,
  target,
  draftStatus,
  matchCount,
  hasPlayedResult,
  hasImportedGame,
  postseasonMatchCount,
  postseasonBracketReady,
  hasChampion,
}: SeasonPhasePolicyInput): SeasonPhasePolicyState {
  if (current === target) return blocked("Current phase");

  if (target === SEASON_STATUS.COMPLETE) {
    return blocked(
      "Complete is set automatically when the grand final crowns a champion.",
    );
  }

  if (hasChampion) {
    return blocked(
      "A crowned season cannot move backward with a phase button. Use the grand-final or playoff recovery controls to retract it safely.",
    );
  }

  const auctionOpen =
    draftStatus === DRAFT_STATUS.IN_PROGRESS ||
    draftStatus === DRAFT_STATUS.PAUSED;
  const auctionNotStarted =
    draftStatus == null || draftStatus === DRAFT_STATUS.NOT_STARTED;
  const hasCompetitiveArtifacts =
    matchCount > 0 || hasPlayedResult || hasImportedGame;

  // A live auction outside DRAFT is a stranded state. Moving it back changes
  // no auction data; it merely restores the page and engine that can finish or
  // abort it. Postseason/champion state must be recovered first if it exists.
  if (
    target === SEASON_STATUS.DRAFT &&
    auctionOpen &&
    postseasonMatchCount === 0 &&
    current !== SEASON_STATUS.DRAFT
  ) {
    return allowed(
      "Restore the Draft phase? The existing auction and every bid stay intact; draft controls reopen for everyone.",
      true,
    );
  }

  if (auctionOpen && target !== SEASON_STATUS.DRAFT) {
    return blocked(
      draftStatus === DRAFT_STATUS.PAUSED
        ? "The auction is paused, not finished. Resume and finish it, or use Abort draft, before leaving Draft."
        : "The auction is live. Finish it, or use Abort draft, before leaving Draft.",
    );
  }

  if (
    target === SEASON_STATUS.DRAFT &&
    !auctionOpen &&
    (hasPlayedResult || hasImportedGame)
  ) {
    return blocked(
      "Results are already recorded; the completed auction is locked. Use Roster moves for later roster changes.",
    );
  }

  if (current === SEASON_STATUS.SIGNUPS && target === SEASON_STATUS.DRAFT) {
    if (!auctionNotStarted) {
      return blocked(
        "Use the auction controls to resolve the existing draft before changing phases.",
      );
    }
    if (hasCompetitiveArtifacts || postseasonMatchCount > 0) {
      return blocked(
        "Match data already exists. Resolve that inconsistent season state before opening Draft.",
      );
    }
    return allowed(
      "Open the Draft phase? Registration closes and draft navigation opens. The auction does not start until you use Start draft.",
    );
  }

  if (current === SEASON_STATUS.DRAFT) {
    if (target === SEASON_STATUS.SIGNUPS) {
      if (auctionNotStarted && !hasCompetitiveArtifacts) {
        return allowed(
          "Return to Signups? Registration reopens. No auction or match data needs to be reset.",
          true,
        );
      }
      return blocked(
        "Use Abort draft to return players, budgets, and unplayed fixtures to a consistent Signups state.",
      );
    }

    if (target === SEASON_STATUS.REGULAR_SEASON) {
      if (draftStatus !== DRAFT_STATUS.COMPLETE) {
        return blocked(
          "Finish the auction before starting the Regular season.",
        );
      }
      if (postseasonMatchCount > 0) {
        return blocked(
          "Postseason data already exists. Recover or remove that bracket before starting the Regular season.",
        );
      }
      return allowed(
        "Start the Regular season? League navigation and match tools update immediately, and Discord receives a league-start announcement.",
      );
    }
  }

  if (current === SEASON_STATUS.REGULAR_SEASON) {
    if (target === SEASON_STATUS.DRAFT) {
      return blocked(
        hasPlayedResult || hasImportedGame
          ? "Results are already recorded; the completed auction is locked. Use Roster moves for later roster changes."
          : "Use Abort draft to rebuild the player pool and rosters safely; a phase button cannot reopen a completed auction.",
      );
    }
    if (target === SEASON_STATUS.PLAYOFFS) {
      if (postseasonMatchCount > 0 && postseasonBracketReady) {
        return allowed(
          "Restore Playoffs? The existing bracket stays intact and playoff tools reopen.",
          true,
        );
      }
      if (postseasonMatchCount > 0) {
        return blocked(
          "Postseason fixtures exist, but they are not a recoverable bracket. Use the playoff reset or return controls to reconcile them.",
        );
      }
      return blocked(startPlayoffsReason);
    }
  }

  if (
    current === SEASON_STATUS.PLAYOFFS &&
    target === SEASON_STATUS.REGULAR_SEASON
  ) {
    if (postseasonMatchCount === 0) {
      return allowed(
        "Recover the Regular season? No playoff bracket exists, so regular-season tools can reopen without deleting postseason data.",
        true,
      );
    }
    return blocked(
      "A playoff bracket already exists. Use Return to regular season so the existing bracket is removed safely.",
    );
  }

  if (current === SEASON_STATUS.COMPLETE) {
    if (
      target === SEASON_STATUS.PLAYOFFS &&
      postseasonMatchCount > 0 &&
      postseasonBracketReady
    ) {
      return allowed(
        "Restore Playoffs? The uncrowned bracket stays intact and playoff result controls reopen.",
        true,
      );
    }
    if (target === SEASON_STATUS.PLAYOFFS && postseasonMatchCount > 0) {
      return blocked(
        "Postseason fixtures exist, but they are not a recoverable bracket. Use the playoff reset or return controls to reconcile them.",
      );
    }
    if (target === SEASON_STATUS.REGULAR_SEASON && postseasonMatchCount === 0) {
      return allowed(
        "Recover the Regular season? This incomplete state has no champion or playoff bracket, so regular-season tools can reopen safely.",
        true,
      );
    }
  }

  if (
    (current === SEASON_STATUS.PLAYOFFS ||
      current === SEASON_STATUS.COMPLETE) &&
    postseasonMatchCount > 0
  ) {
    return blocked(
      "A playoff bracket already exists. Use Return to regular season so the existing bracket is removed safely.",
    );
  }

  if (target === SEASON_STATUS.PLAYOFFS) {
    return blocked(startPlayoffsReason);
  }

  return blocked(
    "This phase jump is unavailable. Advance one league stage at a time or use the dedicated recovery control for the data that must change.",
  );
}
