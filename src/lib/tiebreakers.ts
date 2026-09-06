import { createHash } from "node:crypto";
import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import type { MatchLike, TeamStanding } from "./standings";
import type { Pairing } from "./schedule";
export { parseTiebreakerStage, hasLaterTiebreakerStage } from "./tiebreaker-format";

export const TIEBREAKER_BEST_OF = 3;

export type TiebreakerGroup = {
  key: string;
  teamIds: string[];
  round: number;
  status: "needed" | "pending" | "resolved";
  pairings: Pairing[];
  format: "BO3_ROUND_ROBIN" | "BO1_DOUBLE_ELIMINATION";
  bestOf: 1 | 3;
  stage?: number;
  drawRequired?: boolean;
  byeTeamId?: string;
};

export type TiebreakerState = {
  groups: TiebreakerGroup[];
  pending: boolean;
  needsMatches: boolean;
  resolved: boolean;
  error: string | null;
};

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Bind the extra week to the exact regular results and eligible teams. */
export function tiebreakerBasis(
  teams: { id: string; withdrawn?: boolean }[],
  matches: MatchLike[],
): string {
  return digest({
    teams: teams.map((t) => [t.id, !!t.withdrawn]).sort(),
    results: matches
      .filter((m) => m.phase === MATCH_PHASE.REGULAR)
      .map((m) => [m.homeTeamId, m.awayTeamId, m.status, m.homeScore,
        m.awayScore, m.winnerTeamId, !!m.forfeit])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
}

export function tiebreakerSlot(group: TiebreakerGroup, index: number): string {
  return `${group.key}:${index}`;
}

/**
 * Two teams play BO3; three teams play a 4–5 game BO1 double-elimination
 * bracket. Larger groups and existing round robins rank by series wins and
 * differential in that round. A still-tied subgroup plays another round;
 * groups entirely below the playoff cut need no extra fixtures. No game
 * contributes regular-season points and no ID ever settles a playoff tie.
 */
export function resolveTiebreakers(
  eligible: TeamStanding[],
  matches: MatchLike[],
  bracketSize: number,
  basis: string,
): { standings: TeamStanding[]; state: TiebreakerState } {
  const state: TiebreakerState = {
    groups: [], pending: false, needsMatches: false, resolved: true, error: null,
  };
  const extra = matches.filter((m) => m.phase === MATCH_PHASE.TIEBREAKER);
  const visited = new Set<MatchLike>();
  const byId = new Map(eligible.map((s) => [s.teamId, { ...s }]));

  function settled(ids: string[]): string[] {
    for (const id of ids) {
      const row = byId.get(id)!;
      delete row.idDecided;
      delete row.idTieGroup;
      row.tiebreakerResolved = true;
    }
    return ids;
  }

  function rankThree(ids: string[], round: number): string[] {
    const orderedIds = [...ids].sort();
    const base = `TBD:${basis}:${round}:${digest(orderedIds)}`;
    const stages = new Map<number, MatchLike>();
    let byeTeamId: string | undefined;
    const loser = (match: MatchLike) => match.homeTeamId === match.winnerTeamId
      ? match.awayTeamId : match.homeTeamId;
    for (let stage = 1; stage <= 5; stage++) {
      const key = `${base}:${stage}`;
      const fixtures = extra.filter((m) => m.bracketSlot?.startsWith(`${key}:`));
      for (const match of fixtures) visited.add(match);
      let pairing: Pairing | undefined;
      if (stage === 1 && fixtures.length === 1) {
        pairing = { home: fixtures[0].homeTeamId, away: fixtures[0].awayTeamId };
        byeTeamId = orderedIds.find((id) => id !== pairing!.home && id !== pairing!.away);
      } else if (stage === 2) {
        pairing = { home: stages.get(1)!.winnerTeamId!, away: byeTeamId! };
      } else if (stage === 3) {
        pairing = { home: loser(stages.get(1)!), away: loser(stages.get(2)!) };
      } else if (stage >= 4) {
        pairing = { home: stages.get(2)!.winnerTeamId!, away: stages.get(3)!.winnerTeamId! };
      }
      const group: TiebreakerGroup = {
        key, teamIds: orderedIds, round, stage, status: "needed",
        format: "BO1_DOUBLE_ELIMINATION", bestOf: 1,
        pairings: pairing ? [pairing] : [],
        ...(stage === 1 && fixtures.length === 0 ? { drawRequired: true } : {}),
        ...(byeTeamId ? { byeTeamId } : {}),
      };
      state.groups.push(group);
      if (fixtures.length === 0) {
        state.needsMatches = true;
        state.resolved = false;
        return ids;
      }
      const match = fixtures[0];
      if (fixtures.length !== 1 || !pairing ||
          match.bracketSlot !== tiebreakerSlot(group, 0) || match.bestOf !== 1 ||
          pairing.home === pairing.away || !orderedIds.includes(pairing.home) || !orderedIds.includes(pairing.away) ||
          match.homeTeamId !== pairing.home || match.awayTeamId !== pairing.away) {
        state.error = "The BO1 tiebreaker bracket no longer matches its preceding results. Reset the tiebreaker week before continuing.";
        state.resolved = false;
        return ids;
      }
      group.status = "pending";
      if (match.status !== MATCH_STATUS.COMPLETED) {
        state.pending = true;
        state.resolved = false;
        return ids;
      }
      const winner = match.homeScore === 1 && match.awayScore === 0 ? match.homeTeamId
        : match.homeScore === 0 && match.awayScore === 1 ? match.awayTeamId : null;
      if (!winner || match.winnerTeamId !== winner) {
        state.error = "Every best-of-one tiebreaker needs a decisive 1–0 result before the bracket can advance.";
        state.resolved = false;
        return ids;
      }
      group.status = "resolved";
      stages.set(stage, match);
      if (stage === 4 && winner === stages.get(2)!.winnerTeamId || stage === 5) {
        return settled([winner, loser(match), loser(stages.get(3)!)]);
      }
    }
    return ids;
  }

  function rankGroup(ids: string[], offset: number, round: number): string[] {
    if (ids.length < 2 || offset >= bracketSize) return ids;
    const orderedIds = [...ids].sort();
    const key = `TB:${basis}:${round}:${digest(orderedIds)}`;
    // Existing BO3 fixtures keep their published format. New three-team ties
    // use the bounded BO1 bracket, including subgroups of larger round robins.
    if (ids.length === 3 && !extra.some((m) => m.bracketSlot?.startsWith(`${key}:`))) {
      return rankThree(ids, round);
    }
    const pairings: Pairing[] = [];
    for (let i = 0; i < orderedIds.length; i++) {
      for (let j = i + 1; j < orderedIds.length; j++) {
        pairings.push({ home: orderedIds[i], away: orderedIds[j] });
      }
    }
    const group: TiebreakerGroup = {
      key, teamIds: orderedIds, round, status: "needed", pairings,
      format: "BO3_ROUND_ROBIN", bestOf: 3,
    };
    state.groups.push(group);
    const fixtures = extra.filter((m) => m.bracketSlot?.startsWith(`${key}:`));
    for (const match of fixtures) visited.add(match);
    if (fixtures.length === 0) {
      state.needsMatches = true;
      state.resolved = false;
      return ids;
    }
    group.status = "pending";
    const validFixtures = fixtures.length === pairings.length &&
      pairings.every((pair, index) => fixtures.filter((m) =>
        m.bracketSlot === tiebreakerSlot(group, index) &&
        m.homeTeamId === pair.home && m.awayTeamId === pair.away &&
        m.bestOf === TIEBREAKER_BEST_OF,
      ).length === 1);
    if (!validFixtures) {
      state.error = "The tiebreaker fixtures no longer match the tied teams. Reset the tiebreaker week and schedule it again.";
      state.resolved = false;
      return ids;
    }
    if (fixtures.some((m) => m.status !== MATCH_STATUS.COMPLETED)) {
      state.pending = true;
      state.resolved = false;
      return ids;
    }
    const records = new Map(ids.map((id) => [id, { wins: 0, diff: 0 }]));
    for (const match of fixtures) {
      const scoreWinner = match.homeScore > match.awayScore
        ? match.homeTeamId : match.awayScore > match.homeScore
          ? match.awayTeamId : null;
      if (!scoreWinner || scoreWinner !== match.winnerTeamId ||
          !Number.isInteger(match.homeScore) || !Number.isInteger(match.awayScore) ||
          Math.min(match.homeScore, match.awayScore) < 0 ||
          Math.max(match.homeScore, match.awayScore) > 2 ||
          (!match.forfeit && Math.max(match.homeScore, match.awayScore) !== 2)) {
        state.error = "Every best-of-three tiebreaker needs a decisive result. Correct the tiebreaker result before starting playoffs.";
        state.resolved = false;
        return ids;
      }
      records.get(scoreWinner)!.wins++;
      records.get(match.homeTeamId)!.diff += match.homeScore - match.awayScore;
      records.get(match.awayTeamId)!.diff += match.awayScore - match.homeScore;
    }
    group.status = "resolved";
    const sorted = [...ids].sort((a, b) =>
      records.get(b)!.wins - records.get(a)!.wins ||
      records.get(b)!.diff - records.get(a)!.diff || a.localeCompare(b),
    );
    const result: string[] = [];
    for (let i = 0; i < sorted.length;) {
      let j = i + 1;
      const first = records.get(sorted[i])!;
      while (j < sorted.length && records.get(sorted[j])!.wins === first.wins &&
        records.get(sorted[j])!.diff === first.diff) j++;
      const tied = sorted.slice(i, j);
      for (const id of tied) {
        const row = byId.get(id)!;
        delete row.idDecided;
        delete row.idTieGroup;
        row.tiebreakerResolved = true;
        if (tied.length > 1) {
          row.idDecided = true;
          row.idTieGroup = `${key}:${tied.slice().sort().join("|")}`;
          delete row.tiebreakerResolved;
        }
      }
      // A completed round may leave the same group tied. The next recursive
      // step terminates at its absent or pending fixtures, not an ID fallback.
      result.push(...rankGroup(tied, offset + i, round + 1));
      i = j;
    }
    return result;
  }

  const result: string[] = [];
  for (let i = 0; i < eligible.length;) {
    let j = i + 1;
    const key = eligible[i].idTieGroup;
    if (key) while (j < eligible.length && eligible[j].idTieGroup === key) j++;
    result.push(...rankGroup(eligible.slice(i, j).map((s) => s.teamId), i, 1));
    i = j;
  }
  // Fail closed on old regular-season snapshots, extra duplicates, malformed
  // metadata, or downstream rounds left behind by an earlier correction.
  if (extra.some((m) => !visited.has(m))) {
    state.error = "The tiebreaker week belongs to an earlier standings or result snapshot. Reset the tiebreaker week before continuing.";
    state.resolved = false;
  }
  return { standings: result.map((id) => byId.get(id)!), state };
}
