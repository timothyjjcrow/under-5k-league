import { describe, it, expect } from "vitest";
import { phaseSubtitle } from "./season-copy";
import { SEASON_STATUS } from "./constants";

describe("phaseSubtitle", () => {
  it("asks for players while the season is short of its minimum", () => {
    const s = phaseSubtitle(SEASON_STATUS.SIGNUPS, { canDraft: false });
    expect(s).toContain("Sign up now");
  });

  // The hero renders this directly beneath a "Ready to draft" badge. Claiming
  // the draft is still waiting on players, next to a badge saying it isn't, is
  // the same below-the-minimum assumption that had the progress bar reading
  // "sold out" — and this is the FIRST sentence a visitor reads.
  it("stops claiming the draft is waiting once the minimum is met", () => {
    const s = phaseSubtitle(SEASON_STATUS.SIGNUPS, { canDraft: true });
    expect(s).not.toMatch(/once enough players/i);
    expect(s).toMatch(/signups stay open/i);
  });

  it("says signups are open in BOTH signup states", () => {
    for (const canDraft of [true, false]) {
      expect(phaseSubtitle(SEASON_STATUS.SIGNUPS, { canDraft })).toMatch(
        /sign ?up/i,
      );
    }
  });

  it("covers every phase and nothing else", () => {
    for (const status of Object.values(SEASON_STATUS)) {
      expect(phaseSubtitle(status)).not.toBe("");
    }
    expect(phaseSubtitle("NOT_A_PHASE")).toBe("");
  });

  // canDraft is meaningless outside SIGNUPS; passing it must not leak into
  // another phase's copy.
  it("ignores canDraft in the other phases", () => {
    for (const status of Object.values(SEASON_STATUS)) {
      if (status === SEASON_STATUS.SIGNUPS) continue;
      expect(phaseSubtitle(status, { canDraft: true })).toBe(
        phaseSubtitle(status, { canDraft: false }),
      );
    }
  });
});
