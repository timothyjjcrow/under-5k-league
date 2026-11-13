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

export type SharedSeries = {
  matchId: string;
  /** Epoch seconds of the earliest dated game they shared there; 0 = unknown. */
  startTime: number;
  meetings: Meetings;
};

/**
 * Every series A and B both played in, newest first, with how they met in it
 * (the same side/opposite side rule as `meetings`). Feeds the head-to-head
 * card's links to each match page. Games without both players are ignored.
 */
export function sharedSeries(
  games: (MeetingGame & { matchId: string; startTime: number })[],
  a: string,
  b: string,
): SharedSeries[] {
  const byMatch = new Map<string, typeof games>();
  for (const game of games) {
    const hasA = game.lines.some((l) => l.userId === a);
    const hasB = game.lines.some((l) => l.userId === b);
    if (!hasA || !hasB) continue;
    byMatch.set(game.matchId, [...(byMatch.get(game.matchId) ?? []), game]);
  }
  return [...byMatch]
    .map(([matchId, series]) => {
      const dated = series.map((g) => g.startTime).filter((t) => t > 0);
      return {
        matchId,
        startTime: dated.length ? Math.min(...dated) : 0,
        meetings: meetings(series, a, b),
      };
    })
    .sort(
      (x, y) => y.startTime - x.startTime || x.matchId.localeCompare(y.matchId),
    );
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

/** One line of the comparison's tape: both figures, who has the edge, and
 *  how long each side's bar is. */
export type TapeRow = {
  label: string;
  a: string;
  b: string;
  /** 1 = A better, -1 = B better, 0 = level or not a contest. */
  edge: number;
  /** Each side's bar as a share (0–1) of the larger figure; 0 without one. */
  aShare: number;
  bShare: number;
};

/**
 * A tape line from two figures. `contested: false` (one side has no games,
 * or the line is context such as games played) and a missing figure both
 * show the numbers with no edge: a player with no games isn't "better" at
 * anything, and left unguarded 0 avg deaths read as the winning side.
 * The bars always show size, so on a lower-is-better line the SHORTER bar
 * has the edge; the highlight, not the length, says who leads.
 */
export function tapeRow(
  label: string,
  a: number | null,
  b: number | null,
  opts: {
    lowerBetter?: boolean;
    format?: (value: number) => string;
    contested?: boolean;
  } = {},
): TapeRow {
  const format = opts.format ?? ((value: number) => String(value));
  const top = Math.max(a ?? 0, b ?? 0);
  const share = (value: number | null) =>
    value != null && top > 0 ? Math.max(0, value) / top : 0;
  return {
    label,
    a: a == null ? "—" : format(a),
    b: b == null ? "—" : format(b),
    edge:
      opts.contested === false || a == null || b == null
        ? 0
        : Math.sign(a - b) * (opts.lowerBetter ? -1 : 1),
    aShare: share(a),
    bShare: share(b),
  };
}

/** How many tape lines each side leads: the "5–3" over the numbers. */
export function tapeTally(rows: readonly TapeRow[]): { a: number; b: number } {
  return {
    a: rows.filter((row) => row.edge > 0).length,
    b: rows.filter((row) => row.edge < 0).length,
  };
}
