import {
  DRAFT_STATUS,
  SEASON_STATUS,
  type DraftStatus,
  type SeasonStatus,
} from "./constants";
import { draftSetupOpen } from "./draft-setup";

export type PlayerDirectoryStage =
  | "CAPTAIN_SELECTION"
  | "AUCTION"
  | "DRAFT_COMPLETE"
  | "SEASON"
  | "FINAL";

export type PlayerDirectoryPresentation = {
  stage: PlayerDirectoryStage;
  captainSelectionOpen: boolean;
  showDraftStatus: boolean;
  poolTitle: string;
  poolAside?: string;
  emptyDescription: string;
  availabilityLabel: string;
  availabilityHint?: string;
};

/**
 * Lifecycle copy for /players.
 *
 * A designated captain creates a Team during signup, so neither team presence
 * nor the broad Season.status can say whether the auction has run. The shared
 * setup capability is the authority for captain selection; the Draft row then
 * distinguishes an active auction from its completed result.
 */
export function playerDirectoryPresentation(
  seasonStatus: SeasonStatus | string,
  draftStatus: DraftStatus | string | null | undefined,
): PlayerDirectoryPresentation {
  if (draftSetupOpen(seasonStatus, draftStatus)) {
    return {
      stage: "CAPTAIN_SELECTION",
      captainSelectionOpen: true,
      showDraftStatus: false,
      poolTitle: "Signed up to play",
      emptyDescription: "Player signups will appear here.",
      availabilityLabel: "Want to captain",
    };
  }

  if (
    seasonStatus === SEASON_STATUS.DRAFT &&
    (draftStatus === DRAFT_STATUS.IN_PROGRESS ||
      draftStatus === DRAFT_STATUS.PAUSED)
  ) {
    return {
      stage: "AUCTION",
      captainSelectionOpen: false,
      showDraftStatus: true,
      poolTitle: "Draft pool",
      poolAside: "· track drafted players and who remains",
      emptyDescription:
        "No active full-player registrations are available for this auction.",
      availabilityLabel: "Available to draft",
      availabilityHint: "in the auction pool",
    };
  }

  if (
    seasonStatus === SEASON_STATUS.DRAFT &&
    draftStatus === DRAFT_STATUS.COMPLETE
  ) {
    return {
      stage: "DRAFT_COMPLETE",
      captainSelectionOpen: false,
      showDraftStatus: true,
      poolTitle: "Player pool",
      poolAside: "· review rosters and remaining free agents",
      emptyDescription:
        "No active full-player registrations are on record for this season.",
      availabilityLabel: "Free agents",
      availabilityHint: "undrafted",
    };
  }

  if (seasonStatus === SEASON_STATUS.COMPLETE) {
    return {
      stage: "FINAL",
      captainSelectionOpen: false,
      showDraftStatus: true,
      poolTitle: "Final player field",
      poolAside: "· season rosters and undrafted registrations",
      emptyDescription:
        "No full-player registrations are on record for this completed season.",
      availabilityLabel: "Undrafted",
      availabilityHint: "not on a final roster",
    };
  }

  return {
    stage: "SEASON",
    captainSelectionOpen: false,
    showDraftStatus: true,
    poolTitle: "Player pool",
    poolAside: "· sort, filter and scout the field",
    emptyDescription:
      "No active full-player registrations are on record for this season.",
    availabilityLabel: "Free agents",
    availabilityHint: "undrafted",
  };
}
