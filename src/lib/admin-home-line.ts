import { adminNextStep } from "./admin-next-step";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "./constants";
import { projectPlayoffField } from "./playoff-field";
import type { MatchLike } from "./standings";

type LineMatch = MatchLike & { scheduledAt: Date | null };

export type AdminHomeInput = {
  seasonStatus: string;
  /** null when the season has no Draft row. */
  draftStatus: string | null;
  /** ACTIVE player signups (the snapshot's playerCount). */
  playerCount: number;
  /** capacityInfo's minPlayers. */
  minPlayers: number;
  teams: { id: string; withdrawn?: boolean }[];
  /** Every match of the season, any phase. */
  matches: LineMatch[];
  hasChampion: boolean;
  /** Open matches the admin panel's Needs attention card lists. */
  attentionCount: number;
};

export type AdminHomeLine = {
  /** The admin panel's next-step headline, word for word. */
  step: string;
  /** "2 matches need attention", or null when none do. */
  attention: string | null;
};

/**
 * The one line an admin sees under Home's hero: the admin panel's "what do I
 * do next" headline and how many open matches its Needs attention card lists,
 * so the panel's two answers are one tap away from where Tim lands on match
 * night. Built from the same helpers (adminNextStep, matchAttention's count)
 * with the counts the panel feeds them, from data Home can read without a
 * Discord call. The panel's longer detail lines (Discord links, captain MMR,
 * the league ticket) stay on the panel.
 */
export function adminHomeLine(i: AdminHomeInput): AdminHomeLine {
  const open = (match: LineMatch) => match.status !== MATCH_STATUS.COMPLETED;
  const regular = i.matches.filter(
    (match) => match.phase === MATCH_PHASE.REGULAR,
  );
  const tiebreakers = i.matches.filter(
    (match) => match.phase === MATCH_PHASE.TIEBREAKER,
  );
  const playoff = i.matches.filter(
    (match) =>
      match.phase === MATCH_PHASE.PLAYOFF || match.phase === MATCH_PHASE.FINAL,
  );
  const step = adminNextStep({
    seasonStatus: i.seasonStatus,
    draftStatus: i.draftStatus,
    playerCount: i.playerCount,
    minPlayers: i.minPlayers,
    teamCount: i.teams.length,
    regularMatchCount: regular.length,
    scheduledRegularCount: regular.filter((match) => match.scheduledAt).length,
    pendingRegularResults: regular.filter(open).length,
    pendingTiebreakerResults: tiebreakers.filter(open).length,
    existingTiebreakerCount: tiebreakers.length,
    // Only the regular season's steps read it, and it is the one costly input.
    unresolvedPlayoffTieCount:
      i.seasonStatus === SEASON_STATUS.REGULAR_SEASON
        ? projectPlayoffField(i.teams, i.matches).seedingDeadHeatTeamIds.length
        : 0,
    playoffMatchCount: playoff.length,
    unfinishedPlayoffCount: playoff.filter(open).length,
    hasChampion: i.hasChampion,
  });
  const n = i.attentionCount;
  return {
    step: step.title,
    attention:
      n > 0 ? `${n} match${n === 1 ? " needs" : "es need"} attention` : null,
  };
}
