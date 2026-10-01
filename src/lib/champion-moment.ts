// The facts the champion banner tells (Home and the champion's team page).
// Pure: the pages pass the season's resolved final.

type FinalMatch = {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  winnerTeamId: string | null;
  forfeit: boolean;
};

export type ChampionFinalLine = {
  /** From the champion's side: "2–1". */
  score: string;
  /** The beaten finalist. */
  opponentTeamId: string;
  /** The final was ruled a forfeit, not played. */
  forfeit: boolean;
};

/**
 * "Won the grand final 2–1 over X": the authoritative final read from the
 * champion's side. Null when there is no final to quote (a legacy archive
 * with no bracket) or when it doesn't name this team as its winner, so the
 * banner never prints a scoreline the resolver didn't stand behind.
 */
export function championFinalLine(
  final: FinalMatch | null | undefined,
  championTeamId: string,
): ChampionFinalLine | null {
  if (!final || final.winnerTeamId !== championTeamId) return null;
  const home = final.homeTeamId === championTeamId;
  if (!home && final.awayTeamId !== championTeamId) return null;
  const [won, lost] = home
    ? [final.homeScore, final.awayScore]
    : [final.awayScore, final.homeScore];
  return {
    score: `${won}–${lost}`,
    opponentTeamId: home ? final.awayTeamId : final.homeTeamId,
    forfeit: final.forfeit,
  };
}
