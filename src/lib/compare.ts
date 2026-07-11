// Player-vs-player comparison: pure head-to-head math over imported games.
// The /players/compare page parses each Game's stored player JSON into
// MeetingGames; career stat lines reuse summarizePlayerGames.

export type MeetingGame = {
  radiantWin: boolean;
  lines: { userId: string | null; isRadiant: boolean }[];
};

export type Meetings = {
  /** Games with A and B on opposite sides. */
  opposite: { games: number; aWins: number; bWins: number };
  /** Games with A and B on the same side. */
  together: { games: number; wins: number; losses: number };
};

/** How two players' games intersect: rivals or teammates, and who won. */
export function meetings(
  games: MeetingGame[],
  a: string,
  b: string,
): Meetings {
  const result: Meetings = {
    opposite: { games: 0, aWins: 0, bWins: 0 },
    together: { games: 0, wins: 0, losses: 0 },
  };
  for (const game of games) {
    const lineA = game.lines.find((l) => l.userId === a);
    const lineB = game.lines.find((l) => l.userId === b);
    if (!lineA || !lineB) continue;
    const aWon = lineA.isRadiant === game.radiantWin;
    if (lineA.isRadiant === lineB.isRadiant) {
      result.together.games++;
      if (aWon) result.together.wins++;
      else result.together.losses++;
    } else {
      result.opposite.games++;
      if (aWon) result.opposite.aWins++;
      else result.opposite.bWins++;
    }
  }
  return result;
}
