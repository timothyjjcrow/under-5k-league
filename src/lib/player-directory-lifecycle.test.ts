import { describe, expect, it } from "vitest";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";
import {
  playerDirectoryPresentation,
  poolSubtitle,
  profileWantsCaptain,
} from "./player-directory-lifecycle";

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
      });
    }
  });

  it("names standins in the live auction's title, since they can't be drafted", () => {
    for (const draftStatus of [
      DRAFT_STATUS.IN_PROGRESS,
      DRAFT_STATUS.PAUSED,
    ]) {
      expect(
        playerDirectoryPresentation(SEASON_STATUS.DRAFT, draftStatus, true)
          .poolTitle,
      ).toBe("Draft pool and standins");
    }
    // Every other stage's title already covers them.
    for (const [seasonStatus, draftStatus] of [
      [SEASON_STATUS.SIGNUPS, null],
      [SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE],
      [SEASON_STATUS.REGULAR_SEASON, DRAFT_STATUS.COMPLETE],
      [SEASON_STATUS.COMPLETE, DRAFT_STATUS.COMPLETE],
    ] as const) {
      expect(
        playerDirectoryPresentation(seasonStatus, draftStatus, true).poolTitle,
      ).toBe(playerDirectoryPresentation(seasonStatus, draftStatus).poolTitle);
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

describe("profileWantsCaptain", () => {
  const volunteer = {
    wantsCaptain: true,
    onTeam: false,
    standin: false,
  };

  it("shows while captains are being picked", () => {
    for (const [seasonStatus, draftStatus] of [
      [SEASON_STATUS.SIGNUPS, null],
      [SEASON_STATUS.DRAFT, DRAFT_STATUS.NOT_STARTED],
    ] as const) {
      expect(
        profileWantsCaptain({ ...volunteer, seasonStatus, draftStatus }),
      ).toBe(true);
    }
  });

  it("stops once the auction starts, as the /players badge does", () => {
    for (const [seasonStatus, draftStatus] of [
      [SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS],
      [SEASON_STATUS.DRAFT, DRAFT_STATUS.PAUSED],
      [SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE],
      [SEASON_STATUS.REGULAR_SEASON, DRAFT_STATUS.COMPLETE],
      [SEASON_STATUS.PLAYOFFS, DRAFT_STATUS.COMPLETE],
      [SEASON_STATUS.COMPLETE, DRAFT_STATUS.COMPLETE],
      [SEASON_STATUS.REGULAR_SEASON, null],
    ] as const) {
      expect(
        profileWantsCaptain({ ...volunteer, seasonStatus, draftStatus }),
        `${seasonStatus}/${draftStatus}`,
      ).toBe(false);
    }
  });

  it("is never shown for a rostered player, a standin or a non-volunteer", () => {
    const open = {
      seasonStatus: SEASON_STATUS.SIGNUPS,
      draftStatus: null,
    };
    expect(profileWantsCaptain({ ...volunteer, ...open, onTeam: true })).toBe(
      false,
    );
    expect(profileWantsCaptain({ ...volunteer, ...open, standin: true })).toBe(
      false,
    );
    expect(
      profileWantsCaptain({ ...volunteer, ...open, wantsCaptain: false }),
    ).toBe(false);
  });
});

describe("poolSubtitle", () => {
  it("says the season and the pool's shape in one line", () => {
    expect(
      poolSubtitle({
        seasonName: "Season 7",
        players: 37,
        standins: 3,
        averageMmr: 2580,
      }),
    ).toBe("Season 7 · 37 players and 3 standins · average 2,580 MMR");
  });
  it("counts in the singular, and leaves out standins and an unknown average", () => {
    expect(
      poolSubtitle({ seasonName: "S1", players: 1, standins: 0, averageMmr: 0 }),
    ).toBe("S1 · 1 player");
    expect(
      poolSubtitle({ seasonName: "S1", players: 0, standins: 1, averageMmr: 0 }),
    ).toBe("S1 · 0 players and 1 standin");
  });
});
