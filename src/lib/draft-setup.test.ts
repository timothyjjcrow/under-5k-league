import { describe, expect, it } from "vitest";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";
import {
  captainTransferOpen,
  draftSeatPlan,
  draftSetupLockedMessage,
  draftSetupOpen,
} from "./draft-setup";

describe("draftSetupOpen", () => {
  it("keeps setup open in signups and the pre-auction Draft waiting room", () => {
    expect(draftSetupOpen(SEASON_STATUS.SIGNUPS, null)).toBe(true);
    expect(draftSetupOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.NOT_STARTED)).toBe(
      true,
    );
  });

  it("locks every started-auction and later-phase state", () => {
    expect(draftSetupOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS)).toBe(
      false,
    );
    expect(draftSetupOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.PAUSED)).toBe(
      false,
    );
    expect(draftSetupOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE)).toBe(
      false,
    );
    expect(draftSetupOpen(SEASON_STATUS.REGULAR_SEASON, null)).toBe(false);
    expect(draftSetupOpen(SEASON_STATUS.COMPLETE, null)).toBe(false);
  });

  it("gives a phase-specific reason instead of a silent disabled control", () => {
    expect(draftSetupLockedMessage(SEASON_STATUS.REGULAR_SEASON, null)).toMatch(
      /regular season.*locked/i,
    );
    expect(draftSetupLockedMessage(SEASON_STATUS.COMPLETE, null)).toMatch(
      /historical.*read-only/i,
    );
  });
});

describe("captainTransferOpen", () => {
  it("allows operational handover after the auction and in later live phases", () => {
    expect(
      captainTransferOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE),
    ).toBe(true);
    expect(captainTransferOpen(SEASON_STATUS.REGULAR_SEASON, null)).toBe(true);
    expect(captainTransferOpen(SEASON_STATUS.PLAYOFFS, null)).toBe(true);
  });

  it("blocks a live/paused auction and immutable completion", () => {
    expect(
      captainTransferOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS),
    ).toBe(false);
    expect(captainTransferOpen(SEASON_STATUS.DRAFT, DRAFT_STATUS.PAUSED)).toBe(
      false,
    );
    expect(captainTransferOpen(SEASON_STATUS.COMPLETE, null)).toBe(false);
  });
});

describe("draftSeatPlan", () => {
  it("blocks too few captains and an empty player pool", () => {
    expect(draftSeatPlan(1, 5, 20)).toMatchObject({ canStart: false });
    expect(draftSeatPlan(2, 5, 0)).toMatchObject({
      canStart: false,
      openSeats: 8,
    });
  });

  it("reports exact, short, and overflow pool shapes", () => {
    expect(draftSeatPlan(2, 5, 8)).toMatchObject({
      canStart: true,
      shortfall: 0,
      overflow: 0,
    });
    expect(draftSeatPlan(2, 5, 5)).toMatchObject({ shortfall: 3 });
    expect(draftSeatPlan(2, 5, 11)).toMatchObject({ overflow: 3 });
  });
});
