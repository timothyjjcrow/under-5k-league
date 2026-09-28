// Pre-match scouting report: an opponent dossier — per-player comfort picks
// and a team-wide threat board — rolled up from stored box-score lines. Pure +
// DB-free: the match-preview page parses each Game's stored player JSON into
// ScoutGames, this does the math. (Declared-role coverage comes from
// pool-stats.ts's roleCoverage.)

import type { PubHero } from "./pub-stats";

export type ScoutLine = {
  /** Mapped league user, or null for an unmapped account. */
  userId: string | null;
  heroId: number;
  isRadiant: boolean;
  kills: number;
  deaths: number;
  assists: number;
};

export type ScoutGame = {
  radiantWin: boolean;
  durationSecs: number;
  startTime: number;
  lines: ScoutLine[];
};

export type HeroPoolRow = {
  heroId: number;
  games: number;
  wins: number;
  winRate: number; // whole-number percent of games that won
  kda: number; // (kills + assists) / max(1, deaths) across games, 1 decimal
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function wonLine(line: ScoutLine, game: ScoutGame): boolean {
  return line.isRadiant === game.radiantWin;
}

/**
 * One player's hero pool: every hero they've played across the given games,
 * rolled up. Most-played first, then win rate, then heroId.
 */
export function playerHeroPool(
  userId: string,
  games: ScoutGame[],
): HeroPoolRow[] {
  type Agg = {
    games: number;
    wins: number;
    kills: number;
    deaths: number;
    assists: number;
  };
  const byHero = new Map<number, Agg>();

  for (const game of games) {
    for (const line of game.lines) {
      if (line.userId !== userId) continue;
      let agg = byHero.get(line.heroId);
      if (!agg) {
        agg = { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 };
        byHero.set(line.heroId, agg);
      }
      agg.games++;
      if (wonLine(line, game)) agg.wins++;
      agg.kills += line.kills;
      agg.deaths += line.deaths;
      agg.assists += line.assists;
    }
  }

  const rows: HeroPoolRow[] = [...byHero.entries()].map(([heroId, agg]) => ({
    heroId,
    games: agg.games,
    wins: agg.wins,
    winRate: Math.round((agg.wins / agg.games) * 100),
    kda: round1((agg.kills + agg.assists) / Math.max(1, agg.deaths)),
  }));

  rows.sort(
    (a, b) => b.games - a.games || b.winRate - a.winRate || a.heroId - b.heroId,
  );
  return rows;
}

export type ThreatRow = {
  heroId: number;
  picks: number;
  wins: number;
  winRate: number; // whole-number percent
};

export type ThreatBoard = {
  /** The "ban list": heroes at/above the floor, best win rate first. */
  rows: ThreatRow[];
  /** Every hero the team has touched, most picked first. */
  contested: ThreatRow[];
  minPicks: number;
};

/**
 * Team-wide hero threat board over every line by any of `userIds`. Each line
 * is a pick (two teammates on one hero in a game would count as 2 — can't
 * happen side-split anyway). `minPicks` is an adaptive floor —
 * max(2, ceil(totalTeamPicks / 25)): a win rate needs a few picks behind it
 * before it's a threat signal.
 */
export function threatBoard(
  userIds: string[],
  games: ScoutGame[],
): ThreatBoard {
  const ids = new Set(userIds);
  type Agg = { picks: number; wins: number };
  const byHero = new Map<number, Agg>();
  let total = 0;

  for (const game of games) {
    for (const line of game.lines) {
      if (line.userId === null || !ids.has(line.userId)) continue;
      let agg = byHero.get(line.heroId);
      if (!agg) {
        agg = { picks: 0, wins: 0 };
        byHero.set(line.heroId, agg);
      }
      agg.picks++;
      total++;
      if (wonLine(line, game)) agg.wins++;
    }
  }

  const all: ThreatRow[] = [...byHero.entries()].map(([heroId, agg]) => ({
    heroId,
    picks: agg.picks,
    wins: agg.wins,
    winRate: Math.round((agg.wins / agg.picks) * 100),
  }));

  const minPicks = Math.max(2, Math.ceil(total / 25));
  const rows = all
    .filter((r) => r.picks >= minPicks)
    .sort(
      (a, b) => b.winRate - a.winRate || b.picks - a.picks || a.heroId - b.heroId,
    );
  const contested = [...all].sort(
    (a, b) => b.picks - a.picks || b.wins - a.wins || a.heroId - b.heroId,
  );
  return { rows, contested, minPicks };
}

/**
 * True when there is literally no game data behind the dossier — every hero
 * pool empty and no hero ever picked — so the UI can render a "they're a
 * mystery" empty state instead of blank cards.
 */
export function dossierEmpty(
  pool: HeroPoolRow[][],
  board: ThreatBoard,
): boolean {
  return pool.every((rows) => rows.length === 0) && board.contested.length === 0;
}

/**
 * Games a hero needs, from one player or across a team, before scouting shows
 * it. This league plays a handful of games per player a season, so a single
 * game is noise: "comfort picks" of ×1 ×1 ×1 for all ten players, and a
 * "most picked" list of one-offs.
 */
export const SCOUT_MIN_GAMES = 2;

export type ComfortPicks =
  | { source: "league"; heroes: HeroPoolRow[] }
  /** Most-played heroes in public games, from the stored OpenDota snapshot:
   *  shown only for a player with no hero at SCOUT_MIN_GAMES in league games. */
  | { source: "pubs"; heroes: PubHero[] };

/**
 * A player's comfort picks: their league heroes with at least SCOUT_MIN_GAMES
 * games, most played first. With none, their stored pub top heroes stand in,
 * labelled as pubs by the caller. Null when there is nothing to show.
 */
export function comfortPicks(
  pool: HeroPoolRow[],
  pubHeroes: PubHero[] | null | undefined,
  limit = 3,
): ComfortPicks | null {
  const league = pool.filter((row) => row.games >= SCOUT_MIN_GAMES);
  if (league.length > 0) {
    return { source: "league", heroes: league.slice(0, limit) };
  }
  const pubs = (pubHeroes ?? []).filter((hero) => hero.games > 0);
  return pubs.length > 0 ? { source: "pubs", heroes: pubs.slice(0, limit) } : null;
}

export type ScoutThreats = {
  /** True: the ban board (heroes they WIN on). False: plain most-picked. */
  ranked: boolean;
  rows: ThreatRow[];
};

/**
 * The team heroes a scouting card shows. Only heroes they actually win on
 * (50%+ at the board's floor) earn "ban board" framing: a 0-2 hero is not a
 * threat. With none, it falls back to their most-picked heroes, and only ones
 * picked at least SCOUT_MIN_GAMES times.
 */
export function threatList(board: ThreatBoard, limit = 5): ScoutThreats {
  const threats = board.rows.filter((row) => row.winRate >= 50);
  if (threats.length > 0) return { ranked: true, rows: threats.slice(0, limit) };
  return {
    ranked: false,
    rows: board.contested
      .filter((row) => row.picks >= SCOUT_MIN_GAMES)
      .slice(0, limit),
  };
}
