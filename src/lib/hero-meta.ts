// League hero meta: pick rates, win rates, and signature players rolled up
// from imported box scores. Pure + DB-free — the /meta page parses each Game's
// stored player JSON into MetaGames, this module does the math.

import type { PlayerStat } from "./match-import";
import { trustedGamePlayers, type ParsedGamePlayers } from "./player-stats";

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
  killsPerPick: number;
  deathsPerPick: number;
  assistsPerPick: number;
  /** Distinct league accounts with a mapped appearance on this hero. */
  mappedPlayers: number;
  /** The league player with the most games on this hero (wins tiebreak). */
  topPlayer: HeroPlayerTally | null;
};

export type HeroMeta = {
  games: number;
  rows: HeroMetaRow[]; // most-picked first, then win rate, then heroId
};

/** A game is publishable in catalogue-based meta only when every pick is known. */
export function allHeroesKnown(
  lines: readonly Pick<MetaLine, "heroId">[],
  knownHeroIds: ReadonlySet<number>,
): boolean {
  return (
    lines.length > 0 && lines.every((line) => knownHeroIds.has(line.heroId))
  );
}

/**
 * The lines of one imported game that count toward the meta: a trusted,
 * complete 5v5 box score whose every hero is in the catalogue, else none (the
 * game is dropped whole, so coverage can't pass 100%). /meta and the hero
 * pages share it, so a hero page always counts the games its /meta row does.
 */
export function metaLines(
  decoded: ParsedGamePlayers,
  knownHeroIds: ReadonlySet<number>,
): PlayerStat[] {
  const trusted = trustedGamePlayers(decoded);
  return allHeroesKnown(trusted, knownHeroIds) ? trusted : [];
}

/** One game in the shape `heroMeta` reads. */
export function toMetaGame(
  radiantWin: boolean,
  lines: readonly PlayerStat[],
): MetaGame {
  return {
    radiantWin,
    lines: lines.map((line) => ({
      userId: line.userId,
      heroId: line.heroId,
      isRadiant: line.isRadiant,
      kills: line.kills,
      deaths: line.deaths,
      assists: line.assists,
    })),
  };
}

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
        (p.games === topPlayer.games && p.wins > topPlayer.wins) ||
        (p.games === topPlayer.games &&
          p.wins === topPlayer.wins &&
          userId.localeCompare(topPlayer.userId) < 0)
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
      killsPerPick: Math.round((agg.kills / agg.picks) * 10) / 10,
      deathsPerPick: Math.round((agg.deaths / agg.picks) * 10) / 10,
      assistsPerPick: Math.round((agg.assists / agg.picks) * 10) / 10,
      mappedPlayers: agg.players.size,
      topPlayer,
    };
  });

  rows.sort(
    (a, b) =>
      b.picks - a.picks || b.winRate - a.winRate || a.heroId - b.heroId,
  );
  return { games: total, rows };
}

/** Picks a hero needs before /meta will headline its win rate. Below this a
 *  5-for-5 run reads as "100% wins", which says more about luck than the
 *  hero. The table still lists every picked hero's record. */
export const META_HEADLINE_MIN_PICKS = 8;

export type MetaHeadlines = {
  /** The most-picked hero (the first row of heroMeta's ordering). */
  mostPicked: HeroMetaRow | null;
  /** Best win rate among heroes with at least `minPicks`; more picks break
   *  an equal rate. Null until some hero has the sample. */
  bestWinRate: HeroMetaRow | null;
};

export function metaHeadlines(
  rows: HeroMetaRow[],
  minPicks = META_HEADLINE_MIN_PICKS,
): MetaHeadlines {
  let bestWinRate: HeroMetaRow | null = null;
  for (const row of rows) {
    if (row.picks < minPicks) continue;
    // Compare wins/picks exactly (cross-multiplied), not the rounded percent.
    const diff = bestWinRate
      ? row.wins * bestWinRate.picks - bestWinRate.wins * row.picks
      : 1;
    if (diff > 0 || (diff === 0 && bestWinRate && row.picks > bestWinRate.picks)) {
      bestWinRate = row;
    }
  }
  return { mostPicked: rows[0] ?? null, bestWinRate };
}
