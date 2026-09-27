import { describe, expect, it } from "vitest";
import {
  draftToolbarControls,
  hasToolbarControl,
  profileSyncAllowed,
  undoSaleConfirm,
  voidLotConfirm,
} from "./draft-admin";

const base = { seasonStatus: "DRAFT", hasSale: true };

describe("draftToolbarControls", () => {
  it("live lot: Pause only (Undo needs no open lot)", () => {
    expect(
      draftToolbarControls({ ...base, status: "IN_PROGRESS", lotLive: true }),
    ).toEqual({ pause: true, resume: false, voidLot: false, undo: false });
  });

  it("live, between lots: Pause and Undo", () => {
    expect(
      draftToolbarControls({ ...base, status: "IN_PROGRESS", lotLive: false }),
    ).toEqual({ pause: true, resume: false, voidLot: false, undo: true });
  });

  it("paused with a lot open: Resume and Void lot, no Undo", () => {
    expect(
      draftToolbarControls({ ...base, status: "PAUSED", lotLive: true }),
    ).toEqual({ pause: false, resume: true, voidLot: true, undo: false });
  });

  it("paused between lots: Resume and Undo", () => {
    expect(
      draftToolbarControls({ ...base, status: "PAUSED", lotLive: false }),
    ).toEqual({ pause: false, resume: true, voidLot: false, undo: true });
  });

  it("finished auction in the Draft phase: Undo only", () => {
    expect(
      draftToolbarControls({ ...base, status: "COMPLETE", lotLive: false }),
    ).toEqual({ pause: false, resume: false, voidLot: false, undo: true });
  });

  it("offers no Undo when nothing has sold", () => {
    const c = draftToolbarControls({
      ...base,
      hasSale: false,
      status: "COMPLETE",
      lotLive: false,
    });
    expect(c?.undo).toBe(false);
    expect(hasToolbarControl(c)).toBe(false);
  });

  it("has no bar before the auction starts or after the Draft phase", () => {
    expect(
      draftToolbarControls({ ...base, status: "NOT_STARTED", lotLive: false }),
    ).toBeNull();
    expect(
      draftToolbarControls({
        ...base,
        seasonStatus: "REGULAR_SEASON",
        status: "COMPLETE",
        lotLive: false,
      }),
    ).toBeNull();
    expect(hasToolbarControl(null)).toBe(false);
  });
});

describe("undoSaleConfirm", () => {
  const sale = { name: "Player 1", teamName: "Team 4", price: 12 };

  it("warns that undoing a finished auction reopens it on a live clock", () => {
    const text = undoSaleConfirm({ draftComplete: true, sale });
    expect(text).toContain("Player 1 → Team 4, $12");
    expect(text).toContain(
      "reopens the finished auction with a live 90-second nomination clock",
    );
    expect(text).toContain("the draft picks a player for them");
  });

  it("keeps the mid-auction confirm short", () => {
    const text = undoSaleConfirm({ draftComplete: false, sale });
    expect(text).toBe(
      "Undo the most recent sale (Player 1 → Team 4, $12)? The player goes back to the pool, and Team 4 gets the money back and nominates next.",
    );
    expect(text).not.toContain("reopens");
  });

  it("reads without a named sale", () => {
    expect(undoSaleConfirm({ draftComplete: true, sale: null })).toMatch(
      /^Undo the most recent auction sale\? This reopens/,
    );
    expect(undoSaleConfirm({ draftComplete: false, sale: null })).toContain(
      "The buying team gets the money back",
    );
  });
});

describe("voidLotConfirm", () => {
  it("names the player and the team that keeps the turn", () => {
    expect(
      voidLotConfirm({ playerName: "Pudge", nominatorName: "Team 2" }),
    ).toBe(
      "Void the paused lot for Pudge? Every bid on it is discarded, no sale is recorded, and Team 2 keeps the nomination turn.",
    );
  });

  it("reads without names", () => {
    expect(voidLotConfirm({ playerName: null, nominatorName: null })).toBe(
      "Void the paused lot? Every bid on it is discarded, no sale is recorded, and the same team keeps the nomination turn.",
    );
  });
});

describe("profileSyncAllowed", () => {
  it("is off while the auction is live or paused", () => {
    expect(profileSyncAllowed("IN_PROGRESS")).toBe(false);
    expect(profileSyncAllowed("PAUSED")).toBe(false);
  });

  it("is on before the auction, after it, and with no draft at all", () => {
    expect(profileSyncAllowed("NOT_STARTED")).toBe(true);
    expect(profileSyncAllowed("COMPLETE")).toBe(true);
    expect(profileSyncAllowed(null)).toBe(true);
    expect(profileSyncAllowed(undefined)).toBe(true);
  });
});
