import { createHash } from "node:crypto";
import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import type { MatchLike, TeamStanding } from "./standings";
import type { Pairing } from "./schedule";
import { parseSingleTiebreakerSlot } from "./tiebreaker-format";
import { singleEliminationPlan } from "./single-elimination";
export { parseTiebreakerStage, hasLaterTiebreakerStage } from "./tiebreaker-format";

export const TIEBREAKER_BEST_OF = 3;

export type TiebreakerGroup = {
  key: string;
  teamIds: string[];
  round: number;
  status: "needed" | "pending" | "resolved";
  pairings: Pairing[];
  format: "BO3_ROUND_ROBIN" | "BO1_DOUBLE_ELIMINATION" | "BO1_SINGLE_ELIMINATION";
  bestOf: 1 | 3;
  stage?: number;
  drawRequired?: boolean;
  byeTeamId?: string;
  blocked?: boolean;
  qualifyingPlaces?: number;
  singlePlan?: ReturnType<typeof singleEliminationPlan>;
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
  if (group.format === "BO1_SINGLE_ELIMINATION" && !group.drawRequired) return group.key;
  return `${group.key}:${index}`;
}

/**
 * New ties use capped BO1 knockouts. Published TB/TBD fixtures retain their
 * original BO3/BO1 double-elimination rules, including legacy continuation.
 * No tiebreaker contributes regular-season points.
 */
export function resolveTiebreakers(
  eligible: TeamStanding[],
  matches: MatchLike[],
  bracketSize: number,
  basis: string,
  format: "current" | "legacy" = "current",
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
      delete row.tiebreakerRankRange;
      row.tiebreakerResolved = true;
    }
    return ids;
  }

  function rankSingle(ids: string[], offset: number, round: number): string[] {
    const ordered = [...ids].sort();
    const root = `TBS:${basis}:${round}:${digest(ordered)}`;
    const fixtures = extra.filter((m) => m.bracketSlot?.startsWith(`${root}:`));
    for (const match of fixtures) visited.add(match);
    const places = Math.min(ids.length, bracketSize - offset);
    if (!fixtures.length) {
      state.groups.push({ key: root, teamIds: ordered, round, status: "needed", pairings: [],
        format: "BO1_SINGLE_ELIMINATION", bestOf: 1, drawRequired: true, qualifyingPlaces: places });
      state.needsMatches = true;
      state.resolved = false;
      return ids;
    }
    const metadata = parseSingleTiebreakerSlot(fixtures[0].bracketSlot);
    if (!metadata || metadata.draw.length !== ordered.length || fixtures.some((m) =>
      parseSingleTiebreakerSlot(m.bracketSlot)?.tournamentKey !== metadata.tournamentKey)) {
      state.error = "The published tiebreaker draw needs an administrator’s review. Reset the tiebreaker week before continuing.";
      state.resolved = false;
      return ids;
    }
    const plan = singleEliminationPlan(metadata.draw.map((i) => ordered[i]), places, metadata.tournamentKey, fixtures);
    const slots = new Set(plan.games.map((game) => game.key));
    if (fixtures.some((m) => !slots.has(m.bracketSlot!)) || new Set(fixtures.map((m) => m.bracketSlot)).size !== fixtures.length) {
      state.error = "The tiebreaker fixtures no longer match the published bracket. Reset the tiebreaker week before continuing.";
    }
    for (const game of plan.games) {
      const match = fixtures.find((m) => m.bracketSlot === game.key);
      const ready = !!game.home.teamId && !!game.away.teamId;
      const group: TiebreakerGroup = {
        key: game.key, teamIds: ordered, round,
        stage: game.stage, status: match ? match.status === MATCH_STATUS.COMPLETED ? "resolved" : "pending" : "needed",
        pairings: ready ? [{ home: game.home.teamId!, away: game.away.teamId! }] : [],
        format: "BO1_SINGLE_ELIMINATION", bestOf: 1, blocked: !ready,
        qualifyingPlaces: places, singlePlan: plan,
      };
      state.groups.push(group);
      if (match && (!ready || match.bestOf !== 1 || match.homeTeamId !== game.home.teamId ||
        match.awayTeamId !== game.away.teamId || (match.status === MATCH_STATUS.COMPLETED && !(
          match.homeScore === 1 && match.awayScore === 0 && match.winnerTeamId === match.homeTeamId ||
          match.homeScore === 0 && match.awayScore === 1 && match.winnerTeamId === match.awayTeamId)))) {
        state.error = "Every BO1 tiebreaker must match its feeder results and finish 1–0. Correct the result before continuing.";
      }
      if (group.status !== "resolved") state.resolved = false;
      if (group.status === "pending") state.pending = true;
      if (!match && ready) state.needsMatches = true;
    }
    if (state.error) { state.resolved = false; return ids; }
    if (plan.resolved) return settled(plan.order);
    const eliminated = new Set(plan.games.flatMap((g) => g.loser ? [g.loser] : []));
    const winners = new Set(plan.brackets.flatMap((b) => b.winner ? [b.winner] : []));
    for (const id of ids) {
      const otherTrees = plan.brackets.filter((b) => !b.teamIds.includes(id));
      const rank = plan.draw.indexOf(id);
      const contenders = otherTrees.map((b) => b.winner ? [b.winner] : b.teamIds.filter((team) => !eliminated.has(team)));
      byId.get(id)!.tiebreakerRankRange = {
        best: offset + (winners.has(id) ? 1 + contenders.filter((teams) => teams.every((team) => plan.draw.indexOf(team) < rank)).length
          : eliminated.has(id) ? plan.brackets.length + 1 : 1),
        worst: offset + (winners.has(id) ? 1 + contenders.filter((teams) => teams.some((team) => plan.draw.indexOf(team) < rank)).length : ids.length),
      };
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
    const legacy = extra.some((m) => m.bracketSlot?.startsWith(`${key}:`) ||
      m.bracketSlot?.startsWith(`${key.replace(/^TB:/, "TBD:")}:`));
    if (round === 1 && format === "current" && !legacy) return rankSingle(ids, offset, round);
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
