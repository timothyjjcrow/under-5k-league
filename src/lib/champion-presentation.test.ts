import { describe, expect, it } from "vitest";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "./constants";
import { resolveChampionPresentation } from "./champion-presentation";

type MatchInput = Parameters<typeof resolveChampionPresentation>[1][number];

function match(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    id: "final",
    phase: MATCH_PHASE.FINAL,
    bracketSlot: "R2M0",
    status: MATCH_STATUS.COMPLETED,
    winnerTeamId: "alpha",
    homeTeamId: "alpha",
    awayTeamId: "beta",
    ...overrides,
  };
}

describe("resolveChampionPresentation", () => {
  it("preserves a completed legacy season with a champion but no saved postseason", () => {
    expect(
      resolveChampionPresentation(
        {
          status: SEASON_STATUS.COMPLETE,
          championTeamId: "alpha",
        },
        [match({ phase: MATCH_PHASE.REGULAR, bracketSlot: null })],
      ),
    ).toEqual({
      championTeamId: "alpha",
      hasPostseason: false,
      source: "legacy",
      authoritativeFinalId: null,
      issue: null,
    });
  });

  it("accepts the sole completed latest final when its participant won", () => {
    const result = resolveChampionPresentation(
      { status: SEASON_STATUS.COMPLETE, championTeamId: "alpha" },
      [
        match({
          phase: MATCH_PHASE.PLAYOFF,
          bracketSlot: "R1M0",
          winnerTeamId: "alpha",
        }),
        match({
          phase: MATCH_PHASE.PLAYOFF,
          bracketSlot: "R1M1",
          homeTeamId: "gamma",
          awayTeamId: "delta",
          winnerTeamId: "beta",
        }),
        match(),
      ],
    );

    expect(result).toEqual({
      championTeamId: "alpha",
      hasPostseason: true,
      source: "final",
      authoritativeFinalId: "final",
      issue: null,
    });
  });

  it("reports a missing champion in a completed season", () => {
    expect(
      resolveChampionPresentation(
        { status: SEASON_STATUS.COMPLETE, championTeamId: null },
        [match()],
      ),
    ).toEqual({
      championTeamId: null,
      hasPostseason: true,
      source: null,
      authoritativeFinalId: null,
      issue: "missing",
    });
  });

  it("hides a stale champion while the season is not complete", () => {
    expect(
      resolveChampionPresentation(
        { status: SEASON_STATUS.PLAYOFFS, championTeamId: "alpha" },
        [match()],
      ),
    ).toMatchObject({ championTeamId: null, issue: null });
  });

  it.each([
    ["the recorded champion lost the final", [match({ winnerTeamId: "beta" })]],
    [
      "the final is not complete",
      [
        match({
          status: MATCH_STATUS.LIVE,
          winnerTeamId: null,
        }),
      ],
    ],
    [
      "the recorded winner is not a final participant",
      [
        match({
          winnerTeamId: "alpha",
          homeTeamId: "beta",
          awayTeamId: "gamma",
        }),
      ],
    ],
    [
      "the sole latest series is not labelled as the final",
      [match({ phase: MATCH_PHASE.PLAYOFF })],
    ],
    [
      "more than one series occupies the latest round",
      [
        match(),
        match({
          phase: MATCH_PHASE.PLAYOFF,
          bracketSlot: "R2M1",
          homeTeamId: "gamma",
          awayTeamId: "delta",
          winnerTeamId: "gamma",
        }),
      ],
    ],
  ])("requires recovery when %s", (_label, matches) => {
    expect(
      resolveChampionPresentation(
        { status: SEASON_STATUS.COMPLETE, championTeamId: "alpha" },
        matches,
      ),
    ).toEqual({
      championTeamId: null,
      hasPostseason: true,
      source: null,
      authoritativeFinalId: null,
      issue: "inconsistent",
    });
  });
});
