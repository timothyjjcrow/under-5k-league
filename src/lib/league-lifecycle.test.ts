import { describe, expect, it } from "vitest";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "./constants";
import {
  matchCheckinOpen,
  matchCorrectionContext,
  matchLogisticsOpen,
  matchResultsOpen,
  isPlayoffPhase,
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

  it("allows a live series participant to check in for remaining games", () => {
    expect(
      matchCheckinOpen(
        SEASON_STATUS.REGULAR_SEASON,
        null,
        MATCH_STATUS.LIVE,
        new Date("2026-08-06T02:00:00Z"),
      ),
    ).toBe(true);
  });

  it.each([SEASON_STATUS.SIGNUPS, SEASON_STATUS.COMPLETE])("keeps LIVE check-in closed in %s", (status) => {
    expect(matchCheckinOpen(status, null, MATCH_STATUS.LIVE, new Date("2026-08-06T02:00:00Z"))).toBe(false);
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
    [SEASON_STATUS.REGULAR_SEASON, MATCH_PHASE.TIEBREAKER],
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
    [SEASON_STATUS.PLAYOFFS, MATCH_PHASE.TIEBREAKER],
    [SEASON_STATUS.COMPLETE, MATCH_PHASE.TIEBREAKER],
    [SEASON_STATUS.DRAFT, MATCH_PHASE.TIEBREAKER],
    [SEASON_STATUS.PLAYOFFS, "UNKNOWN"],
  ])("blocks %s results for %s fixtures", (season, match) => {
    expect(matchResultsOpen(season, match)).toBe(false);
  });
});


describe("isPlayoffPhase", () => {
  it("keeps pre-playoff tiebreakers outside bracket advancement", () => {
    expect(isPlayoffPhase(MATCH_PHASE.TIEBREAKER)).toBe(false);
    expect(isPlayoffPhase(MATCH_PHASE.REGULAR)).toBe(false);
    expect(isPlayoffPhase(MATCH_PHASE.PLAYOFF)).toBe(true);
    expect(isPlayoffPhase(MATCH_PHASE.FINAL)).toBe(true);
    expect(isPlayoffPhase("UNKNOWN")).toBe(false);
  });
});

describe("matchCorrectionContext", () => {
  const fixture = (
    id: string,
    phase: string,
    week: number,
    bracketSlot: string | null = null,
  ) => ({ id, phase, week, bracketSlot });
  const regular = [
    fixture("r1", MATCH_PHASE.REGULAR, 1),
    fixture("r2", MATCH_PHASE.REGULAR, 2),
  ];

  it("leaves a regular result open until a tiebreaker exists", () => {
    expect(matchCorrectionContext(regular[0], regular)).toEqual({
      correctionBlockedByLaterRound: false,
      isSoleLatestPlayoffSeries: false,
    });
    const withTiebreaker = [
      ...regular,
      fixture("t1", MATCH_PHASE.TIEBREAKER, 3),
    ];
    expect(
      matchCorrectionContext(regular[1], withTiebreaker)
        .correctionBlockedByLaterRound,
    ).toBe(true);
  });

  it("blocks a tiebreaker only once a later tiebreaker game exists", () => {
    const first = fixture("t1", MATCH_PHASE.TIEBREAKER, 3);
    expect(
      matchCorrectionContext(first, [...regular, first])
        .correctionBlockedByLaterRound,
    ).toBe(false);
    const later = fixture("t2", MATCH_PHASE.TIEBREAKER, 4);
    const all = [...regular, first, later];
    expect(matchCorrectionContext(first, all).correctionBlockedByLaterRound).toBe(
      true,
    );
    expect(matchCorrectionContext(later, all)).toEqual({
      correctionBlockedByLaterRound: false,
      isSoleLatestPlayoffSeries: false,
    });
  });

  it("blocks a playoff series once a later round exists, and finds the sole final", () => {
    const semis = [
      fixture("s1", MATCH_PHASE.PLAYOFF, 6, "R1M1"),
      fixture("s2", MATCH_PHASE.PLAYOFF, 6, "R1M2"),
    ];
    // Semifinals only: neither is blocked, and two series share the latest
    // round, so neither is "the" final.
    for (const semi of semis) {
      expect(matchCorrectionContext(semi, [...regular, ...semis])).toEqual({
        correctionBlockedByLaterRound: false,
        isSoleLatestPlayoffSeries: false,
      });
    }
    const final = fixture("f", MATCH_PHASE.FINAL, 7, "R2M1");
    const all = [...regular, ...semis, final];
    expect(matchCorrectionContext(semis[0], all)).toEqual({
      correctionBlockedByLaterRound: true,
      isSoleLatestPlayoffSeries: false,
    });
    expect(matchCorrectionContext(final, all)).toEqual({
      correctionBlockedByLaterRound: false,
      isSoleLatestPlayoffSeries: true,
    });
  });

  it("ignores regular and tiebreaker fixtures when judging the bracket", () => {
    const final = fixture("f", MATCH_PHASE.FINAL, 7, "R1M1");
    const all = [
      ...regular,
      fixture("t1", MATCH_PHASE.TIEBREAKER, 5),
      final,
    ];
    expect(matchCorrectionContext(final, all)).toEqual({
      correctionBlockedByLaterRound: false,
      isSoleLatestPlayoffSeries: true,
    });
  });
});
