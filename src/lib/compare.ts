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

export type AffinityRow = {
  userId: string;
  /** Shared games (same side for duo, opposite sides for nemesis). */
  games: number;
  /** SELF's wins across those games — a nemesis row reads "wins–losses against". */
  wins: number;
  losses: number;
};

export type Affinities = {
  /** The player SELF has faced most (self's record against them). */
  nemesis: AffinityRow | null;
  /** The player SELF has shared a side with most (their record together). */
  duo: AffinityRow | null;
};

/**
 * The profile page's rivalry math: fold SELF's games into per-other-player
 * same-side/opposite-side tallies and pick the most-met player on each side of
 * the ball. Classification is identical to `meetings` (side vs side, win =
 * self's side won); games where SELF has no mapped line are skipped, as are
 * unmapped (null-userId) lines. `minMeetings` keeps one shared game from
 * minting a "nemesis" — below the floor a slot is null, and callers render
 * nothing. Ties are deterministic: most games, then (nemesis) fewest self wins
 * — the rival who beats you is the story — / (duo) most wins together, then
 * userId as the last resort.
 */
export function topAffinities(
  games: MeetingGame[],
  selfId: string,
  minMeetings = 3,
): Affinities {
  const together = new Map<string, AffinityRow>();
  const against = new Map<string, AffinityRow>();

  for (const game of games) {
    const self = game.lines.find((l) => l.userId === selfId);
    if (!self) continue;
    const selfWon = self.isRadiant === game.radiantWin;
    // A userId can't legitimately appear twice in one game's lines, but a
    // hand-imported box score might — count each other player once per game.
    const seen = new Set<string>();
    for (const line of game.lines) {
      if (!line.userId || line.userId === selfId || seen.has(line.userId)) {
        continue;
      }
      seen.add(line.userId);
      const map = line.isRadiant === self.isRadiant ? together : against;
      const row = map.get(line.userId) ?? {
        userId: line.userId,
        games: 0,
        wins: 0,
        losses: 0,
      };
      row.games++;
      if (selfWon) row.wins++;
      else row.losses++;
      map.set(line.userId, row);
    }
  }

  const top = (
    map: Map<string, AffinityRow>,
    winTiebreak: (a: AffinityRow, b: AffinityRow) => number,
  ): AffinityRow | null => {
    const rows = [...map.values()].filter((r) => r.games >= minMeetings);
    rows.sort(
      (a, b) =>
        b.games - a.games || winTiebreak(a, b) || a.userId.localeCompare(b.userId),
    );
    return rows[0] ?? null;
  };

  return {
    nemesis: top(against, (a, b) => a.wins - b.wins),
    duo: top(together, (a, b) => b.wins - a.wins),
  };
}
