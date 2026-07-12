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
  scheduledAt?: Date | null;
};

/**
 * The remaining regular-season schedule in play order — the engine reads "a
 * team's next match" as a team's first entry here. When every remaining match
 * has a scheduled time, actual kickoff order wins (a reschedule can push a
 * week-5 match past week 6's night); with any time missing, week order is the
 * only consistent signal.
 */
export function remainingRegular(matches: StakesMatchRow[]): ScenarioMatch[] {
  const open = matches.filter(
    (m) => m.phase === "REGULAR" && m.status !== "COMPLETED",
  );
  const byTime = open.every((m) => m.scheduledAt != null);
  open.sort((a, b) =>
    byTime
      ? a.scheduledAt!.getTime() - b.scheduledAt!.getTime() || a.week - b.week
      : a.week - b.week,
  );
  return open.map((m) => ({
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
