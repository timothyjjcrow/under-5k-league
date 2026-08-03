import { describe, expect, it } from "vitest";
import {
  DRAFT_READINESS,
  draftReadiness,
  draftReadinessCounts,
} from "./draft-readiness";

describe("draftReadiness", () => {
  it("does not treat a legacy revision-0 row as confirmed without a timestamp", () => {
    expect(
      draftReadiness({ draftConfirmedRevision: 0, draftConfirmedAt: null }, 0),
    ).toBe(DRAFT_READINESS.AWAITING);
  });

  it("is ready only when the confirmed and current revisions match", () => {
    const confirmedAt = new Date("2026-08-03T20:00:00Z");
    expect(
      draftReadiness(
        { draftConfirmedRevision: 4, draftConfirmedAt: confirmedAt },
        4,
      ),
    ).toBe(DRAFT_READINESS.READY);
    expect(
      draftReadiness(
        { draftConfirmedRevision: 4, draftConfirmedAt: confirmedAt },
        5,
      ),
    ).toBe(DRAFT_READINESS.STALE);
  });

  it("counts ready, awaiting, and stale registrations independently", () => {
    const confirmedAt = new Date("2026-08-03T20:00:00Z");
    expect(
      draftReadinessCounts(
        [
          { draftConfirmedRevision: 2, draftConfirmedAt: confirmedAt },
          { draftConfirmedRevision: null, draftConfirmedAt: null },
          { draftConfirmedRevision: 1, draftConfirmedAt: confirmedAt },
        ],
        2,
      ),
    ).toEqual({ ready: 1, awaiting: 1, stale: 1, total: 3 });
  });
});
