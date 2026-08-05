import { describe, expect, it } from "vitest";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "./constants";
import {
  matchCheckinOpen,
  matchLogisticsOpen,
  matchResultsOpen,
  postAuctionWorkOpen,
  standinAssignmentOpen,
} from "./league-lifecycle";

describe("postAuctionWorkOpen", () => {
  it.each([
    [SEASON_STATUS.SIGNUPS, null],
    [SEASON_STATUS.DRAFT, null],
    [SEASON_STATUS.DRAFT, DRAFT_STATUS.NOT_STARTED],
    [SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS],
    [SEASON_STATUS.DRAFT, DRAFT_STATUS.PAUSED],
    [SEASON_STATUS.COMPLETE, DRAFT_STATUS.COMPLETE],
  ])("blocks %s / %s", (season, draft) => {
    expect(postAuctionWorkOpen(season, draft)).toBe(false);
  });

  it.each([
    [SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE],
    [SEASON_STATUS.REGULAR_SEASON, null],
    [SEASON_STATUS.PLAYOFFS, DRAFT_STATUS.COMPLETE],
  ])("allows %s / %s", (season, draft) => {
    expect(postAuctionWorkOpen(season, draft)).toBe(true);
  });
});

describe("matchLogisticsOpen", () => {
  it.each([
    [SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE],
    [SEASON_STATUS.REGULAR_SEASON, null],
    [SEASON_STATUS.PLAYOFFS, null],
  ])("allows a scheduled match in %s / %s", (season, draft) => {
    expect(matchLogisticsOpen(season, draft, MATCH_STATUS.SCHEDULED)).toBe(
      true,
    );
  });

  it.each([MATCH_STATUS.LIVE, MATCH_STATUS.COMPLETED])(
    "blocks a %s match even in the regular season",
    (status) => {
      expect(
        matchLogisticsOpen(SEASON_STATUS.REGULAR_SEASON, null, status),
      ).toBe(false);
    },
  );

  it("blocks pre-draft and completed-season fixtures", () => {
    expect(
      matchLogisticsOpen(
        SEASON_STATUS.DRAFT,
        DRAFT_STATUS.IN_PROGRESS,
        MATCH_STATUS.SCHEDULED,
      ),
    ).toBe(false);
    expect(
      matchLogisticsOpen(
        SEASON_STATUS.COMPLETE,
        DRAFT_STATUS.COMPLETE,
        MATCH_STATUS.SCHEDULED,
      ),
    ).toBe(false);
  });
});

describe("matchCheckinOpen", () => {
  it("requires a published kickoff in addition to open logistics", () => {
    expect(
      matchCheckinOpen(
        SEASON_STATUS.REGULAR_SEASON,
        null,
        MATCH_STATUS.SCHEDULED,
        null,
      ),
    ).toBe(false);
    expect(
      matchCheckinOpen(
        SEASON_STATUS.REGULAR_SEASON,
        null,
        MATCH_STATUS.SCHEDULED,
        new Date("2026-08-06T02:00:00Z"),
      ),
    ).toBe(true);
  });

  it("still blocks a live match that has a kickoff", () => {
    expect(
      matchCheckinOpen(
        SEASON_STATUS.REGULAR_SEASON,
        null,
        MATCH_STATUS.LIVE,
        new Date("2026-08-06T02:00:00Z"),
      ),
    ).toBe(false);
  });

  it("treats a timed fixture outside the result-sync window as overdue, not check-in work", () => {
    const now = new Date("2026-08-06T12:00:00Z").getTime();
    expect(
      matchCheckinOpen(
        SEASON_STATUS.REGULAR_SEASON,
        null,
        MATCH_STATUS.SCHEDULED,
        new Date("2026-08-03T11:59:59Z"),
        now,
      ),
    ).toBe(false);
  });
});

describe("standinAssignmentOpen", () => {
  it("allows a between-games replacement while a series is live", () => {
    expect(
      standinAssignmentOpen(
        SEASON_STATUS.REGULAR_SEASON,
        null,
        MATCH_STATUS.LIVE,
      ),
    ).toBe(true);
  });

  it("blocks pre-draft, completed-season, and completed-match assignments", () => {
    expect(
      standinAssignmentOpen(
        SEASON_STATUS.DRAFT,
        DRAFT_STATUS.IN_PROGRESS,
        MATCH_STATUS.SCHEDULED,
      ),
    ).toBe(false);
    expect(
      standinAssignmentOpen(
        SEASON_STATUS.COMPLETE,
        DRAFT_STATUS.COMPLETE,
        MATCH_STATUS.SCHEDULED,
      ),
    ).toBe(false);
    expect(
      standinAssignmentOpen(
        SEASON_STATUS.REGULAR_SEASON,
        null,
        MATCH_STATUS.COMPLETED,
      ),
    ).toBe(false);
  });
});

describe("matchResultsOpen", () => {
  it.each([
    [SEASON_STATUS.REGULAR_SEASON, MATCH_PHASE.REGULAR],
    [SEASON_STATUS.PLAYOFFS, MATCH_PHASE.PLAYOFF],
    [SEASON_STATUS.PLAYOFFS, MATCH_PHASE.FINAL],
  ])("allows %s results for %s fixtures", (season, match) => {
    expect(matchResultsOpen(season, match)).toBe(true);
  });

  it.each([
    [SEASON_STATUS.SIGNUPS, MATCH_PHASE.REGULAR],
    [SEASON_STATUS.DRAFT, MATCH_PHASE.REGULAR],
    [SEASON_STATUS.PLAYOFFS, MATCH_PHASE.REGULAR],
    [SEASON_STATUS.REGULAR_SEASON, MATCH_PHASE.PLAYOFF],
    [SEASON_STATUS.COMPLETE, MATCH_PHASE.FINAL],
  ])("blocks %s results for %s fixtures", (season, match) => {
    expect(matchResultsOpen(season, match)).toBe(false);
  });
});
