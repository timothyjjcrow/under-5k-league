import { describe, expect, it } from "vitest";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";
import { draftBudgetsForDisplay } from "./draft-budgets";

const teams = [
  { id: "low", captainId: "captain-low", budget: 100 },
  { id: "high", captainId: "captain-high", budget: 100 },
];

function displayBudgets(
  draftStatus: string | null,
  overrides: Partial<Parameters<typeof draftBudgetsForDisplay>[0]> = {},
) {
  return draftBudgetsForDisplay({
    seasonIsActive: true,
    seasonStatus: SEASON_STATUS.DRAFT,
    draftStatus,
    baseBudget: 100,
    budgetMmrWeight: 20,
    teamSize: 5,
    teams,
    captainMmrs: [
      { userId: "captain-low", mmr: 3000 },
      { userId: "captain-high", mmr: 4000 },
    ],
    ...overrides,
  });
}

describe("draftBudgetsForDisplay", () => {
  it("projects the exact weighted starting budgets while setup is open", () => {
    const result = displayBudgets(DRAFT_STATUS.NOT_STARTED);

    expect(result.isProjected).toBe(true);
    expect(Object.fromEntries(result.byTeam)).toEqual({ low: 120, high: 80 });
  });

  it("treats a captain MMR of zero as unknown", () => {
    const result = displayBudgets(null, {
      seasonStatus: SEASON_STATUS.SIGNUPS,
      captainMmrs: [
        { userId: "captain-low", mmr: 0 },
        { userId: "captain-high", mmr: 4000 },
      ],
    });

    expect(result.isProjected).toBe(true);
    expect(result.byTeam.get("low")).toBe(100);
    expect(result.byTeam.get("high")).toBe(100);
  });

  it.each([
    DRAFT_STATUS.IN_PROGRESS,
    DRAFT_STATUS.PAUSED,
    DRAFT_STATUS.COMPLETE,
  ])("keeps stored remaining budgets once status is %s", (draftStatus) => {
    const result = displayBudgets(draftStatus, {
      teams: [
        { ...teams[0], budget: 73 },
        { ...teams[1], budget: 41 },
      ],
    });

    expect(result.isProjected).toBe(false);
    expect(Object.fromEntries(result.byTeam)).toEqual({ low: 73, high: 41 });
  });

  it("keeps stored budgets for an archived setup-phase season", () => {
    const result = displayBudgets(DRAFT_STATUS.NOT_STARTED, {
      seasonIsActive: false,
      teams: [
        { ...teams[0], budget: 91 },
        { ...teams[1], budget: 109 },
      ],
    });

    expect(result.isProjected).toBe(false);
    expect(Object.fromEntries(result.byTeam)).toEqual({ low: 91, high: 109 });
  });
});
