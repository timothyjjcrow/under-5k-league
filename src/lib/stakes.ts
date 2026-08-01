// Page-facing adapter over the scenario engine (scenarios.ts): shapes prisma
// Match rows into the engine's inputs and its report back into what the
// standings/schedule/team surfaces render. Pages stay thin.

import { MATCH_PHASE, MATCH_STATUS } from "./constants";
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
    (m) => m.phase === MATCH_PHASE.REGULAR && m.status !== MATCH_STATUS.COMPLETED,
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

// --- Scenario report memo -------------------------------------------------
// scenarioReport enumerates up to DEFAULT_CAP=200k leaves at O(teams²) each —
// 3^11 = 177,147 for a mid-season week with 11 open matches, measured at
// 55-85ms of BLOCKING synchronous CPU per call, on the four hottest pages
// (dashboard, /schedule, /matches/[id], /teams/[id]). 12 open matches exceeds
// the cap and degrades to the cheap layer-1 bounds, so 11 is the exact worst
// case — and a routine mid-season one.
//
// The cache is CONTENT-ADDRESSED: the key IS the engine's inputs, so a landed
// result (the match leaves `remaining` AND the points move) changes the key in
// the same render that reads it. No TTL, no tag, no cursor read — and so no
// window in which a cached report can contradict the standings table rendered
// from live rows beside it.
//
// Deliberately NOT unstable_cache/cached-queries.ts: that module caches
// expensive DB READS shared across viewers, its wrapper is documented to hang
// inside a nested Suspense boundary (fetchAllGamesForScouting — and the
// dashboard's SeasonView is exactly that shape), and a Map return value does
// not survive its serialization. This is CPU over rows the caller already
// holds, and an in-process memo keeps this module unit-testable under vitest.
const MEMO_MAX = 8;
const memo = new Map<string, ScenarioReport>();

function memoized(key: string, compute: () => ScenarioReport): ScenarioReport {
  const hit = memo.get(key);
  if (hit) return hit;
  const report = compute();
  // The report is shared across requests and viewers now, so freeze it: a
  // future caller that patches a status fails loudly here (ESM is strict
  // mode) instead of leaking one viewer's edit into another's page.
  for (const s of report.teams.values()) Object.freeze(s);
  Object.freeze(report);
  memo.set(key, report);
  if (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value; // insertion order = FIFO
    if (oldest !== undefined) memo.delete(oldest);
  }
  return report;
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
  const remaining = remainingRegular(matches);
  // Stringify the WHOLE input rather than a hand-picked projection of the
  // fields the engine happens to read today: adding a field to TeamStanding or
  // ScenarioMatch can then never silently stale the cache. Both are plain JSON
  // (remainingRegular strips scheduledAt), and ~8 rows + ~11 matches is
  // microseconds against a 60ms enumeration.
  const key = JSON.stringify([cut, teamCount, standings, remaining]);
  return memoized(key, () => scenarioReport(standings, remaining, cut));
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
