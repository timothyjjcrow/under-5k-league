import { describe, expect, it } from "vitest";
import { completedSeasonArchiveReadiness } from "./season";
import {
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
  SOFT_MMR_LIMIT,
} from "./constants";
import {
  CARRIED_SEASON_SELECT,
  carriedSeasonSettings,
  carriedSettingsLine,
  nextSeasonName,
  type CarriedSeasonSettings,
} from "./season-handoff";

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

describe("the next season's name", () => {
  it("counts on from the previous season's number", () => {
    expect(nextSeasonName("Season 9")).toBe("Season 10");
    expect(nextSeasonName("  season 3 ")).toBe("season 4");
    expect(nextSeasonName("GGD2L Season #12")).toBe("GGD2L Season #13");
    // A suffix is left off rather than guessed at.
    expect(nextSeasonName("Season 9 (fixture)")).toBe("Season 10");
    // The number after "Season" wins over a later one.
    expect(nextSeasonName("Season 3 2026")).toBe("Season 4");
  });

  it("falls back to the last number, then to nothing", () => {
    expect(nextSeasonName("S9")).toBe("S10");
    expect(nextSeasonName("Spring 2026")).toBe("Spring 2027");
    expect(nextSeasonName("Winter league")).toBe("");
    expect(nextSeasonName("1234567")).toBe("");
  });

  it("names a league's first season", () => {
    expect(nextSeasonName(null)).toBe("Season 1");
  });

  it("never prefills more than the form accepts", () => {
    expect(nextSeasonName(`${"x".repeat(50)} Season 9`)).toBe(
      `${"x".repeat(50)} Season 10`,
    );
    expect(nextSeasonName(`${"x".repeat(51)} Season 9`)).toBe("");
  });
});

describe("carried season settings", () => {
  const customised: CarriedSeasonSettings = {
    teamSize: 6,
    minTeams: 5,
    draftBudget: 1200,
    budgetMmrWeight: 0,
    maxMmr: 0,
    regularBestOf: 3,
    playoffBestOf: 5,
    finalBestOf: 7,
    dotaLeagueId: " 17654 ",
  };

  it("copies every setting, series lengths and league id included", () => {
    expect(carriedSeasonSettings(customised)).toEqual({
      ...customised,
      dotaLeagueId: "17654",
    });
    expect(carriedSeasonSettings({ ...customised, dotaLeagueId: "  " }))
      .toMatchObject({ dotaLeagueId: null });
  });

  it("reads exactly the fields it carries", () => {
    expect(Object.keys(CARRIED_SEASON_SELECT).sort()).toEqual(
      Object.keys(carriedSeasonSettings(customised)).sort(),
    );
  });

  it("opens a league's first season on the defaults", () => {
    expect(carriedSeasonSettings(null)).toEqual({
      teamSize: 5,
      minTeams: 4,
      draftBudget: 100,
      budgetMmrWeight: 20,
      maxMmr: SOFT_MMR_LIMIT,
      regularBestOf: 2,
      playoffBestOf: 3,
      finalBestOf: 5,
      dotaLeagueId: null,
    });
  });

  it("states them in one line", () => {
    expect(carriedSettingsLine(carriedSeasonSettings(null))).toBe(
      "Teams of 5 · 4 teams to start · $100 budget · 20% MMR budget weighting · 4,500 soft MMR limit · Bo2 / Bo3 / Bo5 series · no league id",
    );
    expect(carriedSettingsLine(carriedSeasonSettings(customised))).toBe(
      "Teams of 6 · 5 teams to start · $1,200 budget · flat budgets · no soft MMR limit · Bo3 / Bo5 / Bo7 series · league id 17654",
    );
  });
});
