import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import { computeStandings, type MatchLike, type TeamStanding } from "./standings";
import { possibleSeriesScores } from "./series-outcomes";
import type { ScenarioReport, ScenarioMatch } from "./scenarios";

export type ScenarioResult = "win" | "draw" | "loss";
export type QualificationTie = { teamIds: string[]; spots: number };
/** Counts are scoreline combinations, never estimated probabilities. */
export type ScenarioOutlook = {
  total: number;
  qualified: number;
  qualificationTiebreaker: number;
  eliminated: number;
  seedingTiebreaker: number;
  bestRank: number;
  worstRank: number;
  qualificationTies: QualificationTie[];
};
export type ScenarioPaths = Record<ScenarioResult, ScenarioOutlook | null>;

/** A validated BO1 bracket fixes third place as soon as its third game ends. */
export function partialTiebreakerStandings(
  rows: TeamStanding[],
  groups: { key: string; teamIds: string[]; status: string; format: string; stage?: number }[],
  matches: MatchLike[],
): TeamStanding[] {
  const result = rows.map((row) => ({ ...row }));
  for (const group of groups) {
    if (group.format !== "BO1_DOUBLE_ELIMINATION" || group.stage !== 3 || group.status !== "resolved") continue;
    const indices = result.flatMap((row, index) => group.teamIds.includes(row.teamId) ? [index] : []);
    if (indices.length !== 3 || !indices.every((index) => result[index].idTieGroup)) continue;
    const match = matches.find((m) => m.phase === MATCH_PHASE.TIEBREAKER && m.bracketSlot === `${group.key}:0`);
    if (!match || !match.winnerTeamId) continue;
    const thirdId = match.winnerTeamId === match.homeTeamId ? match.awayTeamId : match.homeTeamId;
    const third = result.find((row) => row.teamId === thirdId)!;
    delete third.idTieGroup;
    delete third.idDecided;
    third.tiebreakerResolved = true;
    const ordered = [...indices.map((index) => result[index]).filter((row) => row.teamId !== thirdId), third];
    indices.forEach((index, i) => { result[index] = ordered[i]; });
  }
  return result;
}

function empty(): ScenarioOutlook {
  return { total: 0, qualified: 0, qualificationTiebreaker: 0, eliminated: 0,
    seedingTiebreaker: 0, bestRank: Infinity, worstRank: 0, qualificationTies: [] };
}

/** Only a fully unresolved eligible group may vary its displayed ID order. */
export function standingOutlooks(rows: TeamStanding[], cut: number): Map<string, ScenarioOutlook> {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (row.idTieGroup) groups.set(row.idTieGroup, [...(groups.get(row.idTieGroup) ?? []), index]);
  });
  return new Map(rows.map((row, index) => {
    const tied = row.idTieGroup ? groups.get(row.idTieGroup)! : [index];
    const bestRank = row.tiebreakerRankRange?.best ?? Math.min(...tied) + 1;
    const worstRank = row.tiebreakerRankRange?.worst ?? Math.max(...tied) + 1;
    const qualified = worstRank <= cut;
    const eliminated = bestRank > cut;
    const qualificationTiebreaker = !qualified && !eliminated;
    return [row.teamId, { total: 1, qualified: +qualified,
      eliminated: +eliminated, qualificationTiebreaker: +qualificationTiebreaker,
      seedingTiebreaker: +(qualified && bestRank !== worstRank), bestRank, worstRank,
      qualificationTies: qualificationTiebreaker
        ? [{ teamIds: tied.map((i) => rows[i].teamId).sort(), spots: cut - bestRank + 1 }] : [] }];
  }));
}

function add(into: ScenarioOutlook, leaf: ScenarioOutlook) {
  into.total += leaf.total;
  into.qualified += leaf.qualified;
  into.qualificationTiebreaker += leaf.qualificationTiebreaker;
  into.eliminated += leaf.eliminated;
  into.seedingTiebreaker += leaf.seedingTiebreaker;
  into.bestRank = Math.min(into.bestRank, leaf.bestRank);
  into.worstRank = Math.max(into.worstRank, leaf.worstRank);
  for (const tie of leaf.qualificationTies) {
    if (!into.qualificationTies.some((known) => known.spots === tie.spots &&
      JSON.stringify(known.teamIds) === JSON.stringify(tie.teamIds))) into.qualificationTies.push(tie);
  }
}

/** Final actual ordering is authoritative, including completed extra-week games. */
export function applyFinalOutlook(report: ScenarioReport, rows: TeamStanding[]): void {
  report.forecast = { basis: "final", total: 1 };
  for (const [id, outlook] of standingOutlooks(rows, report.cut)) {
    const team = report.teams.get(id)!;
    Object.assign(team, { outlook, paths: { win: null, draw: null, loss: null },
      status: outlook.qualified ? "CLINCHED" : outlook.eliminated ? "ELIMINATED" : null,
      bestRank: outlook.bestRank, worstRank: outlook.worstRank,
      winAndIn: false, loseAndOut: false, nextMatchId: null,
      magicNumber: outlook.qualified ? 0 : null,
      eliminationLosses: outlook.eliminated ? 0 : null,
      exact: true, madeCount: outlook.qualified, leafCount: 1 });
  }
  report.exact = true;
}

export const NORMAL_FORECAST_CAP = 4096;

/**
 * Forecast normally completed series using official differential/wins/H2H rules.
 * Keep this distinct from the broader guarantees that include administrative
 * partial results. Existing tiebreaker fixtures never predict future standings.
 */
export function applyNormalOutlook(
  report: ScenarioReport,
  allTeamIds: string[],
  matches: MatchLike[],
  remaining: ScenarioMatch[],
  cap = NORMAL_FORECAST_CAP,
): void {
  const eligible = new Set(report.teams.keys());
  const known = new Set(allTeamIds);
  if (remaining.some((m) => !known.has(m.homeTeamId) || !known.has(m.awayTeamId))) return;
  const options = remaining.map((match) => possibleSeriesScores(match, true));
  let total = 1;
  for (const scores of options) {
    if (!scores || total * scores.length > cap) return;
    total *= scores.length;
  }
  const completed = matches.filter((m) => m.phase === MATCH_PHASE.REGULAR && m.status === MATCH_STATUS.COMPLETED);
  const projected = remaining.map((m) => ({ ...m, phase: MATCH_PHASE.REGULAR,
    status: MATCH_STATUS.COMPLETED, homeScore: 0, awayScore: 0, winnerTeamId: null as string | null }));
  const accumulated = new Map([...eligible].map((id) => [id, empty()]));
  const paths = new Map([...eligible].map((id) => [id, { win: null, draw: null, loss: null } as ScenarioPaths]));
  const next = new Map([...report.teams].map(([id, team]) => [id, remaining.findIndex((m) => m.id === team.nextMatchId)]));
  const visit = (index: number) => {
    if (index < remaining.length) {
      const match = projected[index];
      for (const score of options[index]!) {
        Object.assign(match, score);
        match.winnerTeamId = score.homeScore > score.awayScore ? match.homeTeamId
          : score.homeScore < score.awayScore ? match.awayTeamId : null;
        visit(index + 1);
      }
      return;
    }
    const rows = computeStandings(allTeamIds, [...completed, ...projected]).filter((row) => eligible.has(row.teamId));
    for (const [id, leaf] of standingOutlooks(rows, report.cut)) {
      add(accumulated.get(id)!, leaf);
      const match = projected[next.get(id)!];
      if (!match) continue;
      const result: ScenarioResult = match.winnerTeamId === null ? "draw"
        : match.winnerTeamId === id ? "win" : "loss";
      const teamPaths = paths.get(id)!;
      add(teamPaths[result] ??= empty(), leaf);
    }
  };
  visit(0);
  report.forecast = { basis: "normal_series", total };
  for (const [id, outlook] of accumulated) {
    const team = report.teams.get(id)!;
    team.outlook = outlook;
    team.paths = paths.get(id)!;
  }
}
