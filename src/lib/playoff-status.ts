// Where each team stands in the playoff bracket, in one line: "Semifinal vs
// X", "Out in the quarterfinal (lost 1–2 to Y)", "Champion". Pure + tested.
// The bracket rows are the truth (the same rows the bracket draws); only the
// champion comes from the season, through resolveChampionPresentation, so a
// title under review is never announced here either.

import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import { profileMatchState } from "./profile-match";
import {
  matchRoundLabel,
  nextPlayoffRoundName,
  playoffTotalRounds,
  slotRound,
} from "./schedule";

export type PlayoffStatusMatch = {
  id: string;
  week: number;
  phase: string;
  bracketSlot: string | null;
  status: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  winnerTeamId: string | null;
  scheduledAt: Date | null;
  forfeit?: boolean;
};

type Result = {
  opponentId: string;
  teamScore: number;
  opponentScore: number;
  forfeit: boolean;
};

export type TeamPlayoffStatus =
  | { kind: "champion" }
  | ({ kind: "runner-up" } & Result)
  | ({ kind: "out"; round: string; roundIndex: number } & Result)
  | {
      kind: "playing";
      round: string;
      roundIndex: number;
      matchId: string;
      opponentId: string;
      teamScore: number;
      opponentScore: number;
      scheduledAt: Date | null;
      /** live: a game is in; awaiting: kickoff has passed, no result yet. */
      when: "live" | "upcoming" | "awaiting" | "tbd";
    }
  | { kind: "through"; nextRound: string; roundIndex: number }
  | { kind: "missed"; withdrawn: boolean };

const isBracket = (m: { phase: string }) =>
  m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL;

/**
 * Every team's playoff status, or no entry for a team when there is nothing
 * true to say: no bracket yet, or a grand final whose champion isn't
 * confirmed (resolveChampionPresentation withholds it while the result is
 * under review, and so does this).
 */
export function playoffStatuses(
  teams: readonly { id: string; withdrawn?: boolean }[],
  matches: readonly PlayoffStatusMatch[],
  championTeamId: string | null,
  nowMs: number,
): Map<string, TeamPlayoffStatus> {
  const statuses = new Map<string, TeamPlayoffStatus>();
  const bracket = matches.filter(isBracket);
  if (bracket.length === 0) {
    // A season recorded without a saved bracket can still have a champion.
    if (championTeamId) statuses.set(championTeamId, { kind: "champion" });
    return statuses;
  }
  const totalRounds = playoffTotalRounds(bracket);
  for (const team of teams) {
    const status = statusFor(team, bracket, totalRounds, championTeamId, nowMs);
    if (status) statuses.set(team.id, status);
  }
  return statuses;
}

function statusFor(
  team: { id: string; withdrawn?: boolean },
  bracket: readonly PlayoffStatusMatch[],
  totalRounds: number,
  championTeamId: string | null,
  nowMs: number,
): TeamPlayoffStatus | null {
  const mine = bracket
    .filter((m) => m.homeTeamId === team.id || m.awayTeamId === team.id)
    .sort((a, b) => slotRound(a.bracketSlot) - slotRound(b.bracketSlot));
  const last = mine[mine.length - 1];
  if (!last) return { kind: "missed", withdrawn: !!team.withdrawn };
  const isHome = last.homeTeamId === team.id;
  const result: Result = {
    opponentId: isHome ? last.awayTeamId : last.homeTeamId,
    teamScore: isHome ? last.homeScore : last.awayScore,
    opponentScore: isHome ? last.awayScore : last.homeScore,
    forfeit: !!last.forfeit,
  };
  const roundIndex = slotRound(last.bracketSlot);
  const round = matchRoundLabel(last, totalRounds);
  const isFinal =
    last.phase === MATCH_PHASE.FINAL ||
    (totalRounds > 0 && roundIndex === totalRounds - 1);

  if (last.status !== MATCH_STATUS.COMPLETED) {
    const state = profileMatchState(last, nowMs);
    return {
      kind: "playing",
      round,
      roundIndex,
      matchId: last.id,
      opponentId: result.opponentId,
      teamScore: result.teamScore,
      opponentScore: result.opponentScore,
      scheduledAt: last.scheduledAt,
      when:
        last.status === MATCH_STATUS.LIVE
          ? "live"
          : state === "Awaiting result"
            ? "awaiting"
            : last.scheduledAt
              ? "upcoming"
              : "tbd",
    };
  }
  if (last.winnerTeamId === team.id) {
    if (isFinal) return championTeamId === team.id ? { kind: "champion" } : null;
    const nextRound = nextPlayoffRoundName(last, totalRounds);
    return nextRound ? { kind: "through", nextRound, roundIndex } : null;
  }
  if (last.winnerTeamId === result.opponentId) {
    if (isFinal) {
      return championTeamId === result.opponentId
        ? { kind: "runner-up", ...result }
        : null;
    }
    return { kind: "out", round, roundIndex, ...result };
  }
  // A completed series with no winner can't be placed in a knockout.
  return null;
}

function score(result: Result): string {
  return `${result.teamScore}–${result.opponentScore}`;
}

function lost(result: Result, opponent: string, what = ""): string {
  return `lost ${what}${score(result)} to ${opponent}${result.forfeit ? " by forfeit" : ""}`;
}

/** "Out in the semifinal", "Out in the playoffs", "Out in round 1". */
function outIn(round: string): string {
  return /^Round /.test(round)
    ? `Out in ${round.toLowerCase()}`
    : `Out in the ${round.toLowerCase()}`;
}

/**
 * The status as one plain sentence. A `playing` status's kickoff is left to
 * the caller, which renders it in the viewer's time zone.
 */
export function playoffStatusText(
  status: TeamPlayoffStatus,
  teamName: (teamId: string) => string,
): string {
  switch (status.kind) {
    case "champion":
      return "Champion";
    case "runner-up":
      return `Runner-up (${lost(status, teamName(status.opponentId), "the grand final ")})`;
    case "out":
      return `${outIn(status.round)} (${lost(status, teamName(status.opponentId))})`;
    case "playing": {
      const base = `${status.round} vs ${teamName(status.opponentId)}`;
      if (status.when === "live")
        return `${base} · live, ${status.teamScore}–${status.opponentScore}`;
      if (status.when === "awaiting") return `${base} · awaiting result`;
      if (status.when === "tbd") return `${base} · time TBD`;
      return base;
    }
    case "through":
      return `Through to the ${status.nextRound.toLowerCase()}`;
    case "missed":
      return status.withdrawn
        ? "Not in the playoffs (withdrew)"
        : "Missed the playoffs";
  }
}

/**
 * Team order for a playoff-time list: teams still alive first, by seed; then
 * teams that are out, the furthest run first (seed breaks a tie); then teams
 * that missed the bracket, in standings order. Before a bracket exists every
 * team is unplaced, so the standings order stands.
 */
export function orderByPlayoffRun(
  teamIds: readonly string[],
  statuses: Map<string, TeamPlayoffStatus>,
  seedByTeam: Map<string, number>,
  rankOf: Map<string, number>,
): string[] {
  const key = (teamId: string): [number, number, number, number] => {
    const status = statuses.get(teamId);
    const seed = seedByTeam.get(teamId) ?? Number.MAX_SAFE_INTEGER;
    const rank = rankOf.get(teamId) ?? Number.MAX_SAFE_INTEGER;
    switch (status?.kind) {
      case "champion":
      case "playing":
      case "through":
        return [0, 0, seed, rank];
      case "runner-up":
        return [1, -Number.MAX_SAFE_INTEGER, seed, rank];
      case "out":
        return [1, -status.roundIndex, seed, rank];
      default:
        // No line to show. A seeded team here played the grand final but its
        // title isn't confirmed yet, so it leads the teams that are out;
        // anyone else missed the bracket.
        return seedByTeam.has(teamId)
          ? [1, -Number.MAX_SAFE_INTEGER, seed, rank]
          : [2, 0, seed, rank];
    }
  };
  return [...teamIds].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return a.localeCompare(b);
  });
}
