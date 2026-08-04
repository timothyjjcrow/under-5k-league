import { DEFAULTS } from "./constants";
import { draftSetupOpen } from "./draft-setup";
import { mmrWeightedBudgets } from "./draft";

export type DraftBudgetTeam = {
  id: string;
  captainId: string;
  budget: number;
};

export type DraftCaptainMmr = {
  userId: string;
  mmr: number;
};

type DraftBudgetsForDisplayInput = {
  seasonIsActive: boolean;
  seasonStatus: string;
  draftStatus: string | null | undefined;
  baseBudget: number;
  budgetMmrWeight: number;
  teamSize: number;
  teams: readonly DraftBudgetTeam[];
  /** Active PLAYER registrations only, matching the snapshot used by Start. */
  captainMmrs: readonly DraftCaptainMmr[];
};

export type DraftBudgetsForDisplay = {
  byTeam: Map<string, number>;
  isProjected: boolean;
};

/**
 * Budgets shown before Start must use the same MMR weighting as Start itself.
 * Team.budget still contains the flat setup value at that point. Once the
 * auction has started, Team.budget is authoritative remaining money and must
 * never be recomputed from mutable registration MMRs.
 */
export function draftBudgetsForDisplay({
  seasonIsActive,
  seasonStatus,
  draftStatus,
  baseBudget,
  budgetMmrWeight,
  teamSize,
  teams,
  captainMmrs,
}: DraftBudgetsForDisplayInput): DraftBudgetsForDisplay {
  const isProjected =
    seasonIsActive && draftSetupOpen(seasonStatus, draftStatus);

  if (!isProjected) {
    return {
      byTeam: new Map(teams.map((team) => [team.id, team.budget])),
      isProjected: false,
    };
  }

  const mmrByUser = new Map(
    captainMmrs.map((registration) => [
      registration.userId,
      // A stored 0 means unknown, matching the Start mutation.
      registration.mmr || null,
    ]),
  );

  return {
    byTeam: mmrWeightedBudgets(
      baseBudget,
      budgetMmrWeight,
      teams.map((team) => ({
        teamId: team.id,
        mmr: mmrByUser.get(team.captainId) ?? null,
      })),
      (teamSize - 1) * DEFAULTS.MIN_BID,
    ),
    isProjected: true,
  };
}
