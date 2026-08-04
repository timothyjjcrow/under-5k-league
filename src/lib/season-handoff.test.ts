import { describe, expect, it } from "vitest";
import { completedSeasonArchiveReadiness } from "./season";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "./constants";

type MatchInput = Parameters<typeof completedSeasonArchiveReadiness>[1][number];

function final(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    id: "final",
    phase: MATCH_PHASE.FINAL,
    bracketSlot: "R2M0",
    status: MATCH_STATUS.COMPLETED,
    winnerTeamId: "alpha",
    homeTeamId: "alpha",
    awayTeamId: "bravo",
    ...overrides,
  };
}

describe("completedSeasonArchiveReadiness", () => {
  it("requires completion rather than treating handoff as cancellation", () => {
    expect(
      completedSeasonArchiveReadiness(
        { status: SEASON_STATUS.PLAYOFFS, championTeamId: null },
        [final()],
        ["alpha", "bravo"],
      ),
    ).toMatchObject({ ready: false, code: "NOT_COMPLETE" });
  });

  it("requires the saved champion to agree with the completed grand final", () => {
    expect(
      completedSeasonArchiveReadiness(
        { status: SEASON_STATUS.COMPLETE, championTeamId: "bravo" },
        [final()],
        ["alpha", "bravo"],
      ),
    ).toMatchObject({ ready: false, code: "INCONSISTENT_CHAMPION" });
  });

  it("accepts an authoritative completed final", () => {
    expect(
      completedSeasonArchiveReadiness(
        { status: SEASON_STATUS.COMPLETE, championTeamId: "alpha" },
        [final()],
        ["alpha", "bravo"],
      ),
    ).toEqual({ ready: true, championTeamId: "alpha" });
  });

  it("keeps legacy champion-only archives but proves same-season ownership", () => {
    expect(
      completedSeasonArchiveReadiness(
        { status: SEASON_STATUS.COMPLETE, championTeamId: "alpha" },
        [],
        ["alpha"],
      ),
    ).toEqual({ ready: true, championTeamId: "alpha" });
    expect(
      completedSeasonArchiveReadiness(
        { status: SEASON_STATUS.COMPLETE, championTeamId: "other-season" },
        [],
        ["alpha"],
      ),
    ).toMatchObject({ ready: false, code: "UNKNOWN_CHAMPION" });
  });
});
