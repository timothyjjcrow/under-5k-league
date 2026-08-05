import { describe, expect, it } from "vitest";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";
import {
  featureAvailability,
  featuresClosingPresentation,
  type FeatureGate,
} from "./features-lifecycle";

describe("featureAvailability", () => {
  it("does not mistake the broad DRAFT phase for a completed auction", () => {
    for (const status of [
      null,
      DRAFT_STATUS.NOT_STARTED,
      DRAFT_STATUS.IN_PROGRESS,
      DRAFT_STATUS.PAUSED,
    ]) {
      const result = featureAvailability(
        "POST_AUCTION",
        SEASON_STATUS.DRAFT,
        status,
      );
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toMatch(/after the auction/i);
    }

    expect(
      featureAvailability(
        "POST_AUCTION",
        SEASON_STATUS.DRAFT,
        DRAFT_STATUS.COMPLETE,
      ).available,
    ).toBe(true);
  });

  it("opens the draft room only while bidding can be followed", () => {
    expect(
      featureAvailability(
        "DRAFT_ROOM",
        SEASON_STATUS.DRAFT,
        DRAFT_STATUS.IN_PROGRESS,
      ).available,
    ).toBe(true);
    expect(
      featureAvailability(
        "DRAFT_ROOM",
        SEASON_STATUS.DRAFT,
        DRAFT_STATUS.PAUSED,
      ).available,
    ).toBe(true);
    expect(
      featureAvailability(
        "DRAFT_ROOM",
        SEASON_STATUS.DRAFT,
        DRAFT_STATUS.NOT_STARTED,
      ).available,
    ).toBe(false);
    expect(
      featureAvailability(
        "DRAFT_ROOM",
        SEASON_STATUS.DRAFT,
        DRAFT_STATUS.COMPLETE,
      ).unavailableReason,
    ).toMatch(/recap/i);
  });

  it.each<[FeatureGate, string[], string[]]>([
    [
      "REGULAR_RESULTS",
      ["REGULAR_SEASON", "PLAYOFFS", "COMPLETE"],
      ["SIGNUPS", "DRAFT"],
    ],
    [
      "ACTIVE_SEASON",
      ["REGULAR_SEASON", "PLAYOFFS"],
      ["SIGNUPS", "DRAFT", "COMPLETE"],
    ],
    [
      "REGULAR_ONLY",
      ["REGULAR_SEASON"],
      ["SIGNUPS", "DRAFT", "PLAYOFFS", "COMPLETE"],
    ],
    [
      "PLAYOFF_RESULTS",
      ["PLAYOFFS", "COMPLETE"],
      ["SIGNUPS", "DRAFT", "REGULAR_SEASON"],
    ],
    [
      "COMPLETE",
      ["COMPLETE"],
      ["SIGNUPS", "DRAFT", "REGULAR_SEASON", "PLAYOFFS"],
    ],
  ])("gates %s to its useful phases", (gate, open, closed) => {
    for (const phase of open) {
      expect(featureAvailability(gate, phase, null).available).toBe(true);
    }
    for (const phase of closed) {
      const result = featureAvailability(gate, phase, null);
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toEqual(expect.any(String));
      expect(result.unavailableReason).not.toBe("");
    }
  });

  it("keeps evergreen destinations available without an active season", () => {
    expect(featureAvailability("ALWAYS", null, null)).toEqual({
      available: true,
    });
  });
});

describe("featuresClosingPresentation", () => {
  it("sends a signed-out signup visitor back to their profile after Steam login", () => {
    expect(
      featuresClosingPresentation(SEASON_STATUS.SIGNUPS, false, false),
    ).toMatchObject({
      title: "Signups are open",
      action: { href: "/login?next=/me", label: "Sign up with Steam →" },
    });
  });

  it("distinguishes a signed-up player from someone who still needs to finish", () => {
    expect(
      featuresClosingPresentation(SEASON_STATUS.SIGNUPS, true, true),
    ).toMatchObject({
      title: "You're signed up",
      action: { href: "/me", label: "Review your signup →" },
    });
    expect(
      featuresClosingPresentation(SEASON_STATUS.SIGNUPS, true, false),
    ).toMatchObject({
      title: "Finish your player signup",
      action: { href: "/me", label: "Complete your signup →" },
    });
  });

  it("does not claim a current signup window during other phases", () => {
    const result = featuresClosingPresentation(
      SEASON_STATUS.COMPLETE,
      true,
      true,
    );
    expect(result.title).toBe("Ready for next season?");
    expect(result.action).toBeUndefined();
  });
});
