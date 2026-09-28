// What one knockout series decides, in one line for its match page: "The
// winner goes through to the grand final to play X; the loser is knocked
// out." Pure + tested. Read from the saved bracket slots alone: R{r}M{i}'s
// winner meets R{r}M{i^1}'s in R{r+1}M{floor(i/2)} (advancePlayoffBracket
// pairs each round's winners in slot order), so no guess about seeding.

import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import {
  nextPlayoffRoundName,
  playoffTotalRounds,
  slotIndex,
  slotRound,
} from "./schedule";

export type PlayoffContextMatch = {
  id: string;
  week: number;
  phase: string;
  bracketSlot: string | null;
  status: string;
  winnerTeamId: string | null;
  homeTeamId: string;
  awayTeamId: string;
};

/** Who the winner meets next: a team, the winner of a series, or unknown. */
export type NextOpponent =
  | { teamId: string }
  | { winnerOf: [string, string] }
  | null;

export type PlayoffMatchContext =
  /** An undecided grand final: the winner takes the title. */
  | { kind: "final" }
  /** An undecided knockout series. */
  | { kind: "ahead"; nextRound: string; opponent: NextOpponent }
  /** A finished knockout series. */
  | {
      kind: "decided";
      nextRound: string;
      winnerTeamId: string;
      loserTeamId: string;
      opponent: NextOpponent;
      /** The winner's next series, once the bracket has built it. */
      nextMatchId: string | null;
    };

/**
 * The context line for a PLAYOFF or FINAL fixture, or null when there is
 * nothing true to add: a decided grand final (the champion badge says it), a
 * tiebreaker or regular match, a legacy row without a bracket slot, or a
 * finished series with no winner.
 */
export function playoffMatchContext(
  match: PlayoffContextMatch,
  postseason: readonly PlayoffContextMatch[],
): PlayoffMatchContext | null {
  if (match.phase === MATCH_PHASE.FINAL) {
    return match.status === MATCH_STATUS.COMPLETED ? null : { kind: "final" };
  }
  if (match.phase !== MATCH_PHASE.PLAYOFF) return null;
  const nextRound = nextPlayoffRoundName(match, playoffTotalRounds(postseason));
  const index = slotIndex(match.bracketSlot);
  if (!nextRound || index === null) return null;
  const round = slotRound(match.bracketSlot);
  const inSlot = (slot: string) =>
    postseason.find((m) => m.id !== match.id && m.bracketSlot === slot);
  const next = inSlot(`R${round + 1}M${Math.floor(index / 2)}`);
  const sibling = inSlot(`R${round}M${index ^ 1}`);

  const siblingWinner = sibling ? seriesWinner(sibling) : null;
  const fromSibling: NextOpponent = !sibling
    ? null
    : sibling.status !== MATCH_STATUS.COMPLETED
      ? { winnerOf: [sibling.homeTeamId, sibling.awayTeamId] }
      : siblingWinner
        ? { teamId: siblingWinner }
        : null;

  if (match.status !== MATCH_STATUS.COMPLETED) {
    return { kind: "ahead", nextRound, opponent: fromSibling };
  }
  const winner = seriesWinner(match);
  if (!winner) return null;
  const loser = winner === match.homeTeamId ? match.awayTeamId : match.homeTeamId;
  const winnerNext =
    next && (next.homeTeamId === winner || next.awayTeamId === winner)
      ? next
      : null;
  return {
    kind: "decided",
    nextRound,
    winnerTeamId: winner,
    loserTeamId: loser,
    opponent: winnerNext
      ? {
          teamId:
            winnerNext.homeTeamId === winner
              ? winnerNext.awayTeamId
              : winnerNext.homeTeamId,
        }
      : fromSibling,
    nextMatchId: winnerNext?.id ?? null,
  };
}

/** A finished series' winner, when it is one of the two teams in it. */
function seriesWinner(match: PlayoffContextMatch): string | null {
  const winner = match.winnerTeamId;
  return match.status === MATCH_STATUS.COMPLETED &&
    (winner === match.homeTeamId || winner === match.awayTeamId)
    ? winner
    : null;
}

/** "the grand final", "the semifinals", "round 2". */
function roundPhrase(round: string): string {
  return /^Round /.test(round)
    ? round.toLowerCase()
    : `the ${round.toLowerCase()}`;
}

function versus(
  opponent: NextOpponent,
  teamName: (teamId: string) => string,
): string {
  if (!opponent) return "";
  if ("teamId" in opponent) return ` to play ${teamName(opponent.teamId)}`;
  const [a, b] = opponent.winnerOf;
  return ` to play the winner of ${teamName(a)} vs ${teamName(b)}`;
}

/** The context as one plain sentence, in the league's playoff wording. */
export function playoffMatchContextText(
  context: PlayoffMatchContext,
  teamName: (teamId: string) => string,
  leagueName: string,
): string {
  switch (context.kind) {
    case "final":
      return `The winner is crowned ${leagueName} champion.`;
    case "ahead":
      return `The winner goes through to ${roundPhrase(context.nextRound)}${versus(context.opponent, teamName)}; the loser is knocked out.`;
    case "decided":
      return `${teamName(context.winnerTeamId)} went through to ${roundPhrase(context.nextRound)}${versus(context.opponent, teamName)}; ${teamName(context.loserTeamId)} was knocked out.`;
  }
}
