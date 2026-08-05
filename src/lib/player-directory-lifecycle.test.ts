import { describe, expect, it } from "vitest";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";
import { playerDirectoryPresentation } from "./player-directory-lifecycle";

describe("playerDirectoryPresentation", () => {
  it("keeps captain interest visible throughout the real setup window", () => {
    for (const [seasonStatus, draftStatus] of [
      [SEASON_STATUS.SIGNUPS, null],
      [SEASON_STATUS.DRAFT, DRAFT_STATUS.NOT_STARTED],
    ] as const) {
      expect(
        playerDirectoryPresentation(seasonStatus, draftStatus),
      ).toMatchObject({
        stage: "CAPTAIN_SELECTION",
        captainSelectionOpen: true,
        showDraftStatus: false,
        poolTitle: "Signed up to play",
        emptyDescription: "Player signups will appear here.",
        availabilityLabel: "Want to captain",
      });
    }
  });

  it("uses availability language while the auction is live or paused", () => {
    for (const draftStatus of [
      DRAFT_STATUS.IN_PROGRESS,
      DRAFT_STATUS.PAUSED,
    ]) {
      expect(
        playerDirectoryPresentation(SEASON_STATUS.DRAFT, draftStatus),
      ).toMatchObject({
        stage: "AUCTION",
        captainSelectionOpen: false,
        showDraftStatus: true,
        poolTitle: "Draft pool",
        emptyDescription:
          "No active full-player registrations are available for this auction.",
        availabilityLabel: "Available to draft",
      });
    }
  });

  it("distinguishes a completed auction from later season phases", () => {
    expect(
      playerDirectoryPresentation(
        SEASON_STATUS.DRAFT,
        DRAFT_STATUS.COMPLETE,
      ),
    ).toMatchObject({
      stage: "DRAFT_COMPLETE",
      poolTitle: "Player pool",
      availabilityLabel: "Free agents",
    });

    for (const seasonStatus of [
      SEASON_STATUS.REGULAR_SEASON,
      SEASON_STATUS.PLAYOFFS,
    ]) {
      expect(
        playerDirectoryPresentation(seasonStatus, DRAFT_STATUS.COMPLETE),
      ).toMatchObject({
        stage: "SEASON",
        captainSelectionOpen: false,
        poolTitle: "Player pool",
        availabilityLabel: "Free agents",
      });
    }

    expect(
      playerDirectoryPresentation(
        SEASON_STATUS.COMPLETE,
        DRAFT_STATUS.COMPLETE,
      ),
    ).toMatchObject({
      stage: "FINAL",
      poolTitle: "Final player field",
      availabilityLabel: "Undrafted",
    });
  });

  it("fails closed for a later phase with no Draft row", () => {
    expect(
      playerDirectoryPresentation(SEASON_STATUS.REGULAR_SEASON, null),
    ).toMatchObject({
      stage: "SEASON",
      captainSelectionOpen: false,
      showDraftStatus: true,
    });
  });
});
