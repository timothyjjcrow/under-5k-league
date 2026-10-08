// One hero's league games for its hero page (/meta/<hero>): every game the
// hero was picked in, the player's line with the items they finished with,
// and the items most often built on it. Pure + DB-free: the page loads the
// season's cached game snapshot and hands it here.
//
// Only the games /meta counts are used (`metaLines`), and the headline
// numbers are /meta's own row (`heroMeta`), so the two pages never disagree.

import { decodeGamePlayers } from "./player-stats";
import { heroMeta, metaLines, toMetaGame, type HeroMetaRow } from "./hero-meta";
import { finishedItemIds } from "./player-items";
import { itemOrUnknown } from "./items";

export type HeroPageTeam = { id: string; name: string };

/** A season game with its fixture, as the hero page loads it. */
export type HeroPageGame = {
  id: string;
  matchId: string;
  /** Valve's start time in epoch seconds; 0 when unknown. */
  startTime: number;
  durationSecs: number;
  radiantWin: boolean;
  players: string;
  week: number;
  homeTeam: HeroPageTeam;
  awayTeam: HeroPageTeam;
};

export type HeroGameRow = {
  gameId: string;
  matchId: string;
  startTime: number;
  durationSecs: number;
  week: number;
  won: boolean;
  kills: number;
  deaths: number;
  assists: number;
  gpm: number | null;
  netWorth: number | null;
  lastHits: number | null;
  userId: string | null;
  /** The account's Steam name at import, for a line no league player owns. */
  personaname: string | null;
  /** The player's team at import time, and the team they played; null when
   *  the line was never attributed to one of the fixture's teams. */
  team: HeroPageTeam | null;
  opponent: HeroPageTeam | null;
  /** End-of-game items; null when this game's items aren't stored (yet). */
  items: number[] | null;
  backpack: number[] | null;
  neutral: number | null;
  neutralEnchantment: number | null;
};

export type HeroItemTally = {
  itemId: number;
  /** Games the item was finished with, and how many of those were won. */
  games: number;
  wins: number;
};

export type HeroPlayerTally = { userId: string; games: number; wins: number };

export type HeroPageView = {
  /** /meta's row for this hero (picks, record, win %, KDA), or null when it
   *  wasn't picked in a counted game. */
  meta: HeroMetaRow | null;
  /** Games /meta counted this season, the pick-rate denominator. */
  countedGames: number;
  /** The hero's games, newest first. */
  rows: HeroGameRow[];
  /** How many of `rows` carry items; tallies below cover only these. */
  itemGames: number;
  /** Shop items finished with, most often first. */
  items: HeroItemTally[];
  /** Neutral items worn, most often first. */
  neutrals: HeroItemTally[];
  /** League players on the hero, most games first. */
  players: HeroPlayerTally[];
};

function sides(game: HeroPageGame, teamId: string | null) {
  if (teamId === game.homeTeam.id) return { team: game.homeTeam, opponent: game.awayTeam };
  if (teamId === game.awayTeam.id) return { team: game.awayTeam, opponent: game.homeTeam };
  return { team: null, opponent: null };
}

/** Most often first, then most wins, then the lower id, so ties never shuffle. */
function sortedTallies(tally: Map<number, { games: number; wins: number }>) {
  return [...tally.entries()]
    .map(([itemId, row]) => ({ itemId, ...row }))
    .sort((a, b) => b.games - a.games || b.wins - a.wins || a.itemId - b.itemId);
}

function bump<K>(map: Map<K, { games: number; wins: number }>, key: K, won: boolean) {
  const row = map.get(key) ?? { games: 0, wins: 0 };
  row.games += 1;
  if (won) row.wins += 1;
  map.set(key, row);
}

export function heroPageView(
  heroId: number,
  games: readonly HeroPageGame[],
  knownHeroIds: ReadonlySet<number>,
): HeroPageView {
  const counted = games
    .map((game) => ({ game, lines: metaLines(decodeGamePlayers(game.players), knownHeroIds) }))
    .filter((row) => row.lines.length > 0);
  const meta = heroMeta(counted.map(({ game, lines }) => toMetaGame(game.radiantWin, lines)));

  const rows: HeroGameRow[] = [];
  for (const { game, lines } of counted) {
    // A complete box score has unique heroes, so at most one line matches.
    const line = lines.find((candidate) => candidate.heroId === heroId);
    if (!line) continue;
    rows.push({
      gameId: game.id,
      matchId: game.matchId,
      startTime: game.startTime,
      durationSecs: game.durationSecs,
      week: game.week,
      won: line.isRadiant === game.radiantWin,
      kills: line.kills,
      deaths: line.deaths,
      assists: line.assists,
      gpm: line.gpm,
      netWorth: line.netWorth,
      lastHits: line.lastHits,
      userId: line.userId,
      personaname: line.personaname,
      ...sides(game, line.teamId),
      items: line.items ?? null,
      backpack: line.backpack ?? null,
      neutral: line.neutral ?? null,
      neutralEnchantment: line.neutralEnchantment ?? null,
    });
  }
  // Newest first by Valve's start time; the game id breaks a tie.
  rows.sort((a, b) => b.startTime - a.startTime || a.gameId.localeCompare(b.gameId));

  const items = new Map<number, { games: number; wins: number }>();
  const neutrals = new Map<number, { games: number; wins: number }>();
  const players = new Map<string, { games: number; wins: number }>();
  let itemGames = 0;
  for (const row of rows) {
    if (row.userId) bump(players, row.userId, row.won);
    if (!row.items) continue;
    itemGames += 1;
    for (const id of finishedItemIds(row)) {
      // Consumables, recipes and the neutral slot are not the build.
      if (itemOrUnknown(id).kind === "item") bump(items, id, row.won);
    }
    if (row.neutral !== null && itemOrUnknown(row.neutral).kind !== "enchantment") {
      bump(neutrals, row.neutral, row.won);
    }
  }

  return {
    meta: meta.rows.find((row) => row.heroId === heroId) ?? null,
    countedGames: meta.games,
    rows,
    itemGames,
    items: sortedTallies(items),
    neutrals: sortedTallies(neutrals),
    players: [...players.entries()]
      .map(([userId, row]) => ({ userId, ...row }))
      .sort((a, b) => b.games - a.games || b.wins - a.wins || a.userId.localeCompare(b.userId)),
  };
}
