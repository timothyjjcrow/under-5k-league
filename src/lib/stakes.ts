// Page-facing adapter over the scenario engine (scenarios.ts): shapes prisma
// Match rows into the engine's inputs and its report back into what the
// standings/schedule/team surfaces render. Pure + testable — pages stay thin.

import { scenarioReport, type ScenarioMatch, type ScenarioReport } from "./scenarios";
import { pickBracketSize } from "./schedule";
import type { ClinchStatus, TeamStanding } from "./standings";

export type StakesMatchRow = {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  status: string;
  phase: string;
  bestOf: number;
  week: number;
};

/**
 * The remaining regular-season schedule in play order (week, then insertion
 * order) — the engine reads "a team's next match" as its first entry here.
 */
export function remainingRegular(matches: StakesMatchRow[]): ScenarioMatch[] {
  return matches
    .filter((m) => m.phase === "REGULAR" && m.status !== "COMPLETED")
    .sort((a, b) => a.week - b.week)
    .map((m) => ({
      id: m.id,
      homeTeamId: m.homeTeamId,
      awayTeamId: m.awayTeamId,
      bestOf: m.bestOf,
    }));
}

/**
 * Scenario report for the season as the playoff seeder will see it: cut from
 * pickBracketSize(teamCount), exactly like createPlayoffBracket. Null when the
 * cut wouldn't drop anyone (everyone makes the bracket — no race to narrate)
 * or when there are no teams yet.
 */
export function seasonScenarioReport(
  standings: TeamStanding[],
  matches: StakesMatchRow[],
  teamCount: number,
): ScenarioReport | null {
  if (teamCount === 0) return null;
  const cut = pickBracketSize(teamCount);
  if (cut >= teamCount) return null;
  return scenarioReport(standings, remainingRegular(matches), cut);
}

/**
 * The per-team clinch map the standings table renders, refined by the engine
 * when it ran. Same conservative semantics as clinchStatuses — exactness only
 * ever turns null into CLINCHED/ELIMINATED.
 */
export function clinchFromReport(
  report: ScenarioReport | null,
): Map<string, ClinchStatus> | undefined {
  if (!report) return undefined;
  return new Map(
    [...report.teams.entries()].map(([teamId, s]) => [teamId, s.status]),
  );
}
