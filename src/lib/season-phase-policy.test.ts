import { describe, expect, it } from "vitest";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  SEASON_PHASE_ORDER,
  SEASON_STATUS,
  type SeasonStatus,
} from "./constants";
import {
  recoverablePostseasonBracket,
  seasonPhasePolicy,
  type SeasonPhasePolicyInput,
} from "./season-phase-policy";

const base = (
  overrides: Partial<SeasonPhasePolicyInput>,
): SeasonPhasePolicyInput => ({
  current: SEASON_STATUS.SIGNUPS,
  target: SEASON_STATUS.DRAFT,
  draftStatus: null,
  matchCount: 0,
  hasPlayedResult: false,
  hasImportedGame: false,
  postseasonMatchCount: 0,
  postseasonBracketReady: false,
  hasChampion: false,
  ...overrides,
});

describe("seasonPhasePolicy — normal lifecycle", () => {
  const rows: {
    current: SeasonStatus;
    draftStatus: string | null;
    postseasonMatchCount: number;
    hasChampion: boolean;
    allowed: SeasonStatus[];
  }[] = [
    {
      current: SEASON_STATUS.SIGNUPS,
      draftStatus: DRAFT_STATUS.NOT_STARTED,
      postseasonMatchCount: 0,
      hasChampion: false,
      allowed: [SEASON_STATUS.DRAFT],
    },
    {
      current: SEASON_STATUS.DRAFT,
      draftStatus: DRAFT_STATUS.COMPLETE,
      postseasonMatchCount: 0,
      hasChampion: false,
      allowed: [SEASON_STATUS.REGULAR_SEASON],
    },
    {
      current: SEASON_STATUS.REGULAR_SEASON,
      draftStatus: DRAFT_STATUS.COMPLETE,
      postseasonMatchCount: 0,
      hasChampion: false,
      allowed: [],
    },
    {
      current: SEASON_STATUS.PLAYOFFS,
      draftStatus: DRAFT_STATUS.COMPLETE,
      postseasonMatchCount: 3,
      hasChampion: false,
      allowed: [],
    },
    {
      current: SEASON_STATUS.COMPLETE,
      draftStatus: DRAFT_STATUS.COMPLETE,
      postseasonMatchCount: 3,
      hasChampion: true,
      allowed: [],
    },
  ];

  for (const row of rows) {
    for (const target of SEASON_PHASE_ORDER.filter(
      (phase) => phase !== row.current,
    )) {
      it(`${row.current} → ${target} is ${row.allowed.includes(target) ? "available" : "blocked"}`, () => {
        expect(
          seasonPhasePolicy(
            base({
              current: row.current,
              target,
              draftStatus: row.draftStatus,
              postseasonMatchCount: row.postseasonMatchCount,
              postseasonBracketReady: row.postseasonMatchCount > 0,
              hasChampion: row.hasChampion,
            }),
          ).available,
        ).toBe(row.allowed.includes(target));
      });
    }
  }

  it("requires a completed auction before Draft can advance", () => {
    const state = seasonPhasePolicy(
      base({
        current: SEASON_STATUS.DRAFT,
        target: SEASON_STATUS.REGULAR_SEASON,
        draftStatus: DRAFT_STATUS.NOT_STARTED,
      }),
    );
    expect(state.available).toBe(false);
    expect(state.reason).toMatch(/finish the auction/i);
  });

  it("does not open Draft over existing match data", () => {
    const state = seasonPhasePolicy(base({ matchCount: 1 }));
    expect(state.available).toBe(false);
    expect(state.reason).toMatch(/match data already exists/i);
  });
});

describe("seasonPhasePolicy — explicit recovery states", () => {
  it("can reopen Signups only before auction or match data exists", () => {
    expect(
      seasonPhasePolicy(
        base({
          current: SEASON_STATUS.DRAFT,
          target: SEASON_STATUS.SIGNUPS,
          draftStatus: DRAFT_STATUS.NOT_STARTED,
        }),
      ).available,
    ).toBe(true);
    expect(
      seasonPhasePolicy(
        base({
          current: SEASON_STATUS.DRAFT,
          target: SEASON_STATUS.SIGNUPS,
          draftStatus: DRAFT_STATUS.NOT_STARTED,
          matchCount: 1,
        }),
      ).available,
    ).toBe(false);
  });

  it.each([
    SEASON_STATUS.SIGNUPS,
    SEASON_STATUS.REGULAR_SEASON,
    SEASON_STATUS.PLAYOFFS,
    SEASON_STATUS.COMPLETE,
  ])(
    "restores a stranded auction from %s without discarding recorded results",
    (current) => {
      const state = seasonPhasePolicy(
        base({
          current,
          target: SEASON_STATUS.DRAFT,
          draftStatus: DRAFT_STATUS.PAUSED,
          matchCount: 2,
          hasPlayedResult: true,
          hasImportedGame: true,
        }),
      );
      expect(state.available).toBe(true);
      if (state.available) expect(state.recovery).toBe(true);
    },
  );

  it("does not restore an auction over a postseason bracket", () => {
    expect(
      seasonPhasePolicy(
        base({
          current: SEASON_STATUS.REGULAR_SEASON,
          target: SEASON_STATUS.DRAFT,
          draftStatus: DRAFT_STATUS.IN_PROGRESS,
          postseasonMatchCount: 1,
        }),
      ).available,
    ).toBe(false);
  });

  it("restores Playoffs only when Regular or uncrowned Complete already has a bracket", () => {
    for (const current of [
      SEASON_STATUS.REGULAR_SEASON,
      SEASON_STATUS.COMPLETE,
    ]) {
      expect(
        seasonPhasePolicy(
          base({
            current,
            target: SEASON_STATUS.PLAYOFFS,
            draftStatus: DRAFT_STATUS.COMPLETE,
            postseasonMatchCount: 1,
            postseasonBracketReady: true,
          }),
        ).available,
      ).toBe(true);
    }
    expect(
      seasonPhasePolicy(
        base({
          current: SEASON_STATUS.DRAFT,
          target: SEASON_STATUS.PLAYOFFS,
          draftStatus: DRAFT_STATUS.COMPLETE,
          postseasonMatchCount: 1,
        }),
      ).available,
    ).toBe(false);
  });

  it("refuses to adopt malformed or duplicate bracket slots", () => {
    expect(
      seasonPhasePolicy(
        base({
          current: SEASON_STATUS.REGULAR_SEASON,
          target: SEASON_STATUS.PLAYOFFS,
          postseasonMatchCount: 1,
          postseasonBracketReady: false,
        }),
      ).available,
    ).toBe(false);

    expect(
      recoverablePostseasonBracket([
        { phase: MATCH_PHASE.PLAYOFF, bracketSlot: "R0M0" },
        { phase: MATCH_PHASE.FINAL, bracketSlot: "R1M0" },
      ]),
    ).toBe(true);
    expect(
      recoverablePostseasonBracket([
        { phase: MATCH_PHASE.PLAYOFF, bracketSlot: "R0M0" },
        { phase: MATCH_PHASE.FINAL, bracketSlot: "R0M0" },
      ]),
    ).toBe(false);
    expect(
      recoverablePostseasonBracket([
        { phase: MATCH_PHASE.FINAL, bracketSlot: null },
      ]),
    ).toBe(false);
  });

  it("recovers Regular only when Playoffs/Complete has no bracket or champion", () => {
    for (const current of [SEASON_STATUS.PLAYOFFS, SEASON_STATUS.COMPLETE]) {
      expect(
        seasonPhasePolicy(
          base({
            current,
            target: SEASON_STATUS.REGULAR_SEASON,
            draftStatus: DRAFT_STATUS.COMPLETE,
          }),
        ).available,
      ).toBe(true);
    }
    expect(
      seasonPhasePolicy(
        base({
          current: SEASON_STATUS.COMPLETE,
          target: SEASON_STATUS.REGULAR_SEASON,
          hasChampion: true,
        }),
      ).available,
    ).toBe(false);
  });
});
