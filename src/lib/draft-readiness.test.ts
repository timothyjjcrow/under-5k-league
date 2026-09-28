import { describe, expect, it } from "vitest";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";
import {
  DRAFT_READINESS,
  draftReadiness,
  draftReadinessCounts,
  owedDraftConfirmation,
  parseSeenDraftSchedule,
  seenScheduleIsCurrent,
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

describe("the draft schedule a form showed", () => {
  const at = new Date("2026-08-08T22:00:00.000Z");

  it("reads a whole revision and a positive epoch, trimmed", () => {
    expect(parseSeenDraftSchedule(" 3 ", ` ${at.getTime()} `)).toEqual({
      revision: 3,
      atMs: at.getTime(),
    });
    expect(parseSeenDraftSchedule("0", "1")).toEqual({ revision: 0, atMs: 1 });
  });

  it("refuses anything it would have to guess at", () => {
    for (const [revision, time] of [
      ["", String(at.getTime())],
      ["1", ""],
      ["-1", String(at.getTime())],
      ["1.5", String(at.getTime())],
      ["1", "0"],
      ["1", "12abc"],
      ["1e3", String(at.getTime())],
      ["1", "99999999999999999999"],
    ]) {
      expect(parseSeenDraftSchedule(revision, time)).toBeNull();
    }
  });

  it("is current only when both the revision and the time still match", () => {
    const seen = { revision: 2, atMs: at.getTime() };
    expect(seenScheduleIsCurrent(seen, { draftRevision: 2, draftAt: at })).toBe(
      true,
    );
    // Moved away and back: same time, newer revision.
    expect(seenScheduleIsCurrent(seen, { draftRevision: 3, draftAt: at })).toBe(
      false,
    );
    expect(
      seenScheduleIsCurrent(seen, {
        draftRevision: 2,
        draftAt: new Date(at.getTime() + 3_600_000),
      }),
    ).toBe(false);
    expect(seenScheduleIsCurrent(seen, { draftRevision: 2, draftAt: null })).toBe(
      false,
    );
  });
});

describe("owedDraftConfirmation", () => {
  const draftAt = new Date("2026-08-15T18:00:00Z");
  const confirmedAt = new Date("2026-08-03T20:00:00Z");
  const unconfirmed = {
    status: "ACTIVE",
    type: "PLAYER",
    draftConfirmedRevision: null,
    draftConfirmedAt: null,
  };
  const base = {
    seasonStatus: SEASON_STATUS.SIGNUPS,
    draftStatus: null,
    draftAt,
    draftRevision: 3,
    registration: unconfirmed,
  };

  it("asks a full player who has never confirmed", () => {
    expect(owedDraftConfirmation(base)).toBe(DRAFT_READINESS.AWAITING);
  });

  it("asks again once the time has moved since the confirmation", () => {
    expect(
      owedDraftConfirmation({
        ...base,
        registration: {
          ...unconfirmed,
          draftConfirmedRevision: 2,
          draftConfirmedAt: confirmedAt,
        },
      }),
    ).toBe(DRAFT_READINESS.STALE);
  });

  it("asks nothing of a player already confirmed for this time", () => {
    expect(
      owedDraftConfirmation({
        ...base,
        registration: {
          ...unconfirmed,
          draftConfirmedRevision: 3,
          draftConfirmedAt: confirmedAt,
        },
      }),
    ).toBeNull();
  });

  it("asks nothing before a draft time is set", () => {
    expect(owedDraftConfirmation({ ...base, draftAt: null })).toBeNull();
  });

  it("asks only an active full player", () => {
    expect(owedDraftConfirmation({ ...base, registration: null })).toBeNull();
    expect(
      owedDraftConfirmation({
        ...base,
        registration: { ...unconfirmed, type: "STANDIN" },
      }),
    ).toBeNull();
    for (const status of ["WITHDRAWN", "REMOVED"]) {
      expect(
        owedDraftConfirmation({
          ...base,
          registration: { ...unconfirmed, status },
        }),
      ).toBeNull();
    }
  });

  it("follows the window confirmDraftReadiness accepts", () => {
    // The Draft chapter before Start is still setup.
    expect(
      owedDraftConfirmation({
        ...base,
        seasonStatus: SEASON_STATUS.DRAFT,
        draftStatus: DRAFT_STATUS.NOT_STARTED,
      }),
    ).toBe(DRAFT_READINESS.AWAITING);
    for (const draftStatus of [
      DRAFT_STATUS.IN_PROGRESS,
      DRAFT_STATUS.PAUSED,
      DRAFT_STATUS.COMPLETE,
    ]) {
      expect(
        owedDraftConfirmation({
          ...base,
          seasonStatus: SEASON_STATUS.DRAFT,
          draftStatus,
        }),
      ).toBeNull();
    }
    expect(
      owedDraftConfirmation({
        ...base,
        seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      }),
    ).toBeNull();
  });
});
