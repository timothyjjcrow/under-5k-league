import { DRAFT_STATUS, SEASON_STATUS } from "./constants";

export type FeatureGate =
  | "ALWAYS"
  | "DRAFT_ROOM"
  | "POST_AUCTION"
  | "REGULAR_RESULTS"
  | "ACTIVE_SEASON"
  | "REGULAR_ONLY"
  | "PLAYOFF_RESULTS"
  | "COMPLETE";

export type FeatureAvailability = {
  available: boolean;
  unavailableReason?: string;
};

/**
 * Whether a destination in the feature tour is useful in the current league
 * state. Season.DRAFT is deliberately not enough for roster-dependent pages:
 * the auction can still be waiting, live, or paused inside that broad phase.
 */
export function featureAvailability(
  gate: FeatureGate,
  seasonStatus: string | null | undefined,
  draftStatus: string | null | undefined,
): FeatureAvailability {
  if (gate === "ALWAYS") return { available: true };

  if (gate === "DRAFT_ROOM") {
    if (
      seasonStatus === SEASON_STATUS.DRAFT &&
      (draftStatus === DRAFT_STATUS.IN_PROGRESS ||
        draftStatus === DRAFT_STATUS.PAUSED)
    ) {
      return { available: true };
    }
    if (
      seasonStatus === SEASON_STATUS.DRAFT &&
      draftStatus === DRAFT_STATUS.COMPLETE
    ) {
      return {
        available: false,
        unavailableReason:
          "The auction is complete. Review the draft recap instead.",
      };
    }
    if (seasonStatus === SEASON_STATUS.DRAFT) {
      return {
        available: false,
        unavailableReason:
          "The auction is being prepared. The draft room opens when bidding starts.",
      };
    }
    if (
      seasonStatus === SEASON_STATUS.REGULAR_SEASON ||
      seasonStatus === SEASON_STATUS.PLAYOFFS ||
      seasonStatus === SEASON_STATUS.COMPLETE
    ) {
      return {
        available: false,
        unavailableReason:
          "Draft night has ended. Rosters and results remain in the draft recap.",
      };
    }
    return {
      available: false,
      unavailableReason: "Opens when the live auction begins.",
    };
  }

  if (gate === "POST_AUCTION") {
    const available =
      (seasonStatus === SEASON_STATUS.DRAFT &&
        draftStatus === DRAFT_STATUS.COMPLETE) ||
      seasonStatus === SEASON_STATUS.REGULAR_SEASON ||
      seasonStatus === SEASON_STATUS.PLAYOFFS ||
      seasonStatus === SEASON_STATUS.COMPLETE;
    return available
      ? { available: true }
      : {
          available: false,
          unavailableReason: "Opens after the auction is complete.",
        };
  }

  if (gate === "REGULAR_RESULTS") {
    const available =
      seasonStatus === SEASON_STATUS.REGULAR_SEASON ||
      seasonStatus === SEASON_STATUS.PLAYOFFS ||
      seasonStatus === SEASON_STATUS.COMPLETE;
    return available
      ? { available: true }
      : {
          available: false,
          unavailableReason: "Opens when regular-season results arrive.",
        };
  }

  if (gate === "ACTIVE_SEASON") {
    const available =
      seasonStatus === SEASON_STATUS.REGULAR_SEASON ||
      seasonStatus === SEASON_STATUS.PLAYOFFS;
    return available
      ? { available: true }
      : {
          available: false,
          unavailableReason:
            seasonStatus === SEASON_STATUS.COMPLETE
              ? "This live-season tool closes when the season ends."
              : "Opens when regular-season play begins.",
        };
  }

  if (gate === "REGULAR_ONLY") {
    return seasonStatus === SEASON_STATUS.REGULAR_SEASON
      ? { available: true }
      : {
          available: false,
          unavailableReason:
            seasonStatus === SEASON_STATUS.PLAYOFFS ||
            seasonStatus === SEASON_STATUS.COMPLETE
              ? "Available during the regular-season run-in; final standings are now locked."
              : "Opens during the regular-season run-in.",
        };
  }

  if (gate === "PLAYOFF_RESULTS") {
    const available =
      seasonStatus === SEASON_STATUS.PLAYOFFS ||
      seasonStatus === SEASON_STATUS.COMPLETE;
    return available
      ? { available: true }
      : {
          available: false,
          unavailableReason: "Opens when the playoff bracket is seeded.",
        };
  }

  return seasonStatus === SEASON_STATUS.COMPLETE
    ? { available: true }
    : {
        available: false,
        unavailableReason: "Opens after the season crowns a champion.",
      };
}

export type FeaturesClosingPresentation = {
  title: string;
  detail: string;
  action?: { href: string; label: string };
};

/** Viewer-aware closing copy for the feature tour's signup call to action. */
export function featuresClosingPresentation(
  seasonStatus: string | null | undefined,
  signedIn: boolean,
  hasActivePlayerSignup: boolean,
): FeaturesClosingPresentation {
  if (seasonStatus !== SEASON_STATUS.SIGNUPS) {
    return {
      title: "Ready for next season?",
      detail: "You'll hear it first in the Discord.",
    };
  }

  if (!signedIn) {
    return {
      title: "Signups are open",
      detail:
        "Sign in with Steam, then complete your player signup before draft night.",
      action: {
        href: "/login?next=/me",
        label: "Sign up with Steam →",
      },
    };
  }

  if (hasActivePlayerSignup) {
    return {
      title: "You're signed up",
      detail:
        "Review your roles, player note, and draft-night details whenever they change.",
      action: { href: "/me", label: "Review your signup →" },
    };
  }

  return {
    title: "Finish your player signup",
    detail:
      "You're signed in. Add your league roles and player details before draft night.",
    action: { href: "/me", label: "Complete your signup →" },
  };
}
