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

/**
 * Starting values for the Compare page's two selects. Whichever slot the URL
 * left empty is filled with the viewer, when the viewer has league games of
 * their own: "me vs them" is the comparison people come for, and a profile's
 * "Compare vs…" link arrives with only the other player set. A slot the URL
 * named, even with an unknown id, is never overridden, and the viewer never
 * fills both slots.
 */
export function compareDefaults(o: {
  /** Raw query values: undefined when the key was absent or blank. */
  aParam: string | undefined;
  bParam: string | undefined;
  /** The query values that resolved to a selectable player. */
  aId: string | undefined;
  bId: string | undefined;
  /** The viewer, only when they are selectable (have league games). */
  viewerId: string | null;
}): { a: string; b: string } {
  const me = o.viewerId;
  const a = o.aId ?? (!o.aParam && me && me !== o.bId ? me : "");
  const b = o.bId ?? (!o.bParam && me && a && me !== a ? me : "");
  return { a, b };
}
