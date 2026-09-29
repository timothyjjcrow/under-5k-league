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
 *
 * Standins are listed in the same table (marked on each row). `hasStandins`
 * only changes the live auction's title: "Draft pool" alone would claim they
 * are up for bidding, and they can't be drafted.
 */
export function playerDirectoryPresentation(
  seasonStatus: SeasonStatus | string,
  draftStatus: DraftStatus | string | null | undefined,
  hasStandins = false,
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
      poolTitle: hasStandins ? "Draft pool and standins" : "Draft pool",
      poolAside: "Track drafted players and who remains",
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
      poolAside: "Review rosters and remaining free agents",
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
      poolAside: "Season rosters and undrafted registrations",
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
    poolAside: "Sort, filter and scout the field",
    emptyDescription:
      "No active full-player registrations are on record for this season.",
    availabilityLabel: "Free agents",
    availabilityHint: "undrafted",
  };
}

/**
 * Whether /players opens its rows with the scouting line (last season, pubs,
 * Discord) and the player's own words. Until the auction ends the pool is a
 * scouting board; after it the question is "who is where", one line a player.
 * The viewer's "Scouting details" toggle overrides this on their device.
 */
export function poolDetailsByDefault(stage: PlayerDirectoryStage): boolean {
  return stage === "CAPTAIN_SELECTION" || stage === "AUCTION";
}

/**
 * Whether a player's profile still shows "Wants to captain". It is news only
 * while captains are being picked, the same window the /players badge and
 * filter use, and only for a full player who isn't on a team yet (a
 * designated captain already has one).
 */
export function profileWantsCaptain(input: {
  wantsCaptain: boolean;
  onTeam: boolean;
  standin: boolean;
  seasonStatus: SeasonStatus | string;
  draftStatus: DraftStatus | string | null | undefined;
}): boolean {
  return (
    input.wantsCaptain &&
    !input.onTeam &&
    !input.standin &&
    playerDirectoryPresentation(input.seasonStatus, input.draftStatus)
      .captainSelectionOpen
  );
}
