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
  /** The list's heading, above the rows. */
  poolTitle: string;
  emptyDescription: string;
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
      emptyDescription:
        "No active full-player registrations are available for this auction.",
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
      emptyDescription:
        "No active full-player registrations are on record for this season.",
    };
  }

  if (seasonStatus === SEASON_STATUS.COMPLETE) {
    return {
      stage: "FINAL",
      captainSelectionOpen: false,
      showDraftStatus: true,
      poolTitle: "Final player field",
      emptyDescription:
        "No full-player registrations are on record for this completed season.",
    };
  }

  return {
    stage: "SEASON",
    captainSelectionOpen: false,
    showDraftStatus: true,
    poolTitle: "Player pool",
    emptyDescription:
      "No active full-player registrations are on record for this season.",
  };
}

const COUNT = new Intl.NumberFormat("en-US");

/**
 * The page title's subtitle: the season and the shape of the pool in one
 * line ("Season 7 · 37 players and 3 standins · average 2,580 MMR"), so the
 * list starts high on a phone. An average with no known MMR is left out,
 * never "0".
 */
export function poolSubtitle(input: {
  seasonName: string;
  players: number;
  standins: number;
  averageMmr: number;
}): string {
  const count = (n: number, one: string, many: string) =>
    `${COUNT.format(n)} ${n === 1 ? one : many}`;
  const who =
    input.standins > 0
      ? `${count(input.players, "player", "players")} and ${count(input.standins, "standin", "standins")}`
      : count(input.players, "player", "players");
  return [
    input.seasonName,
    who,
    input.averageMmr > 0 ? `average ${COUNT.format(input.averageMmr)} MMR` : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
