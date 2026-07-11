// League hero meta: pick rates, win rates, and signature players rolled up
// from imported box scores. Pure + DB-free — the /meta page parses each Game's
// stored player JSON into MetaGames, this module does the math.

export type MetaLine = {
  /** Mapped league user, or null for an unmapped account (still counts as a pick). */
  userId: string | null;
  heroId: number;
  isRadiant: boolean;
  kills: number;
  deaths: number;
  assists: number;
};

export type MetaGame = {
  radiantWin: boolean;
  lines: MetaLine[];
};

export type HeroPlayerTally = {
  userId: string;
  games: number;
  wins: number;
};

export type HeroMetaRow = {
  heroId: number;
  picks: number;
  wins: number;
  losses: number;
  winRate: number; // whole-number percent of picks that won
  pickRate: number; // whole-number percent of games featuring this hero
  kda: number; // (kills + assists) / max(1, deaths) across all picks, 1 decimal
  /** The league player with the most games on this hero (wins tiebreak). */
  topPlayer: HeroPlayerTally | null;
};

export type HeroMeta = {
  games: number;
  rows: HeroMetaRow[]; // most-picked first, then win rate, then heroId
};

/** Roll every game's lines up into per-hero meta rows. */
export function heroMeta(games: MetaGame[]): HeroMeta {
  type Agg = {
    picks: number;
    wins: number;
    gamesSeen: number;
    kills: number;
    deaths: number;
    assists: number;
    players: Map<string, { games: number; wins: number }>;
  };
  const byHero = new Map<number, Agg>();

  for (const game of games) {
    const seenThisGame = new Set<number>();
    for (const line of game.lines) {
      let agg = byHero.get(line.heroId);
      if (!agg) {
        agg = {
          picks: 0,
          wins: 0,
          gamesSeen: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
          players: new Map(),
        };
        byHero.set(line.heroId, agg);
      }
      const won = line.isRadiant === game.radiantWin;
      agg.picks++;
      if (won) agg.wins++;
      agg.kills += line.kills;
      agg.deaths += line.deaths;
      agg.assists += line.assists;
      if (!seenThisGame.has(line.heroId)) {
        seenThisGame.add(line.heroId);
        agg.gamesSeen++;
      }
      if (line.userId) {
        const p = agg.players.get(line.userId) ?? { games: 0, wins: 0 };
        p.games++;
        if (won) p.wins++;
        agg.players.set(line.userId, p);
      }
    }
  }

  const total = games.length;
  const rows: HeroMetaRow[] = [...byHero.entries()].map(([heroId, agg]) => {
    let topPlayer: HeroPlayerTally | null = null;
    for (const [userId, p] of agg.players) {
      if (
        !topPlayer ||
        p.games > topPlayer.games ||
        (p.games === topPlayer.games && p.wins > topPlayer.wins)
      ) {
        topPlayer = { userId, games: p.games, wins: p.wins };
      }
    }
    return {
      heroId,
      picks: agg.picks,
      wins: agg.wins,
      losses: agg.picks - agg.wins,
      winRate: Math.round((agg.wins / agg.picks) * 100),
      pickRate: total === 0 ? 0 : Math.round((agg.gamesSeen / total) * 100),
      kda:
        Math.round(((agg.kills + agg.assists) / Math.max(1, agg.deaths)) * 10) /
        10,
      topPlayer,
    };
  });

  rows.sort(
    (a, b) =>
      b.picks - a.picks || b.winRate - a.winRate || a.heroId - b.heroId,
  );
  return { games: total, rows };
}

/**
 * Adaptive floor for the "best win rate" board: heroes need a few picks before
 * their rate means anything, scaling up as the season accumulates games.
 */
export function metaMinPicks(totalGames: number): number {
  return Math.max(2, Math.ceil(totalGames / 10));
}

/** Heroes ranked by win rate among those with at least `minPicks` picks. */
export function bestWinRates(
  rows: HeroMetaRow[],
  minPicks: number,
): HeroMetaRow[] {
  return rows
    .filter((r) => r.picks >= minPicks)
    .sort(
      (a, b) =>
        b.winRate - a.winRate || b.picks - a.picks || a.heroId - b.heroId,
    );
}
