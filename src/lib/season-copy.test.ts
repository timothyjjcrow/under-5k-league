import { describe, it, expect } from "vitest";
import {
  draftPhasePresentation,
  phaseSubtitle,
  scheduleDestinationLabel,
} from "./season-copy";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";

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

  it("describes each auction state inside the DRAFT phase honestly", () => {
    expect(
      phaseSubtitle(SEASON_STATUS.DRAFT, {
        draftStatus: DRAFT_STATUS.NOT_STARTED,
      }),
    ).toMatch(/being prepared/i);
    expect(
      phaseSubtitle(SEASON_STATUS.DRAFT, {
        draftStatus: DRAFT_STATUS.IN_PROGRESS,
      }),
    ).toMatch(/bidding/i);
    expect(
      phaseSubtitle(SEASON_STATUS.DRAFT, {
        draftStatus: DRAFT_STATUS.PAUSED,
      }),
    ).toMatch(/paused/i);
    expect(
      phaseSubtitle(SEASON_STATUS.DRAFT, {
        draftStatus: DRAFT_STATUS.COMPLETE,
      }),
    ).toMatch(/rosters are set/i);
  });

  it("does not congratulate a champion when COMPLETE has none", () => {
    const copy = phaseSubtitle(SEASON_STATUS.COMPLETE, {
      hasChampion: false,
    });
    expect(copy).toMatch(/no champion/i);
    expect(copy).not.toMatch(/congratulations/i);
  });
});

describe("draftPhasePresentation", () => {
  it("marks only an in-progress auction as live", () => {
    for (const status of Object.values(DRAFT_STATUS)) {
      expect(draftPhasePresentation(status).live).toBe(
        status === DRAFT_STATUS.IN_PROGRESS,
      );
    }
  });

  it("gives every auction state a useful badge and next action", () => {
    for (const status of Object.values(DRAFT_STATUS)) {
      const copy = draftPhasePresentation(status);
      expect(copy.badge).not.toBe("");
      expect(copy.action).toMatch(/→$/);
      expect(copy.teamLabel).not.toBe("");
      expect(copy.teamLabelSingular).not.toBe("");
    }
  });

  it("degrades missing or unknown rows to setup instead of claiming live play", () => {
    for (const status of [null, undefined, "BROKEN_STATE"]) {
      const copy = draftPhasePresentation(status);
      expect(copy.badge).toBe("Draft setup");
      expect(copy.live).toBe(false);
    }
  });
});

describe("scheduleDestinationLabel", () => {
  it("tracks the route's phase-specific purpose", () => {
    expect(scheduleDestinationLabel(SEASON_STATUS.DRAFT)).toBe("Schedule");
    expect(scheduleDestinationLabel(SEASON_STATUS.REGULAR_SEASON)).toBe(
      "Schedule",
    );
    expect(scheduleDestinationLabel(SEASON_STATUS.PLAYOFFS)).toBe("Playoffs");
    expect(scheduleDestinationLabel(SEASON_STATUS.COMPLETE)).toBe(
      "Season results",
    );
  });
});
