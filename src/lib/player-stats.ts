// Summarize a player's Dota 2 games into league career stats. Pure + testable
// (no DB): the profile page parses each Game's stored player JSON into these
// lines, then this rolls them up.

export type PlayerGameLine = {
  isRadiant: boolean;
  radiantWin: boolean;
  kills: number;
  deaths: number;
  assists: number;
  heroId: number;
};

export type HeroTally = {
  heroId: number;
  games: number;
  wins: number;
};

export type PlayerSummary = {
  games: number;
  wins: number;
  losses: number;
  winRate: number; // whole-number percent, 0 when no games
  kills: number;
  deaths: number;
  assists: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  kda: number; // (kills + assists) / max(1, deaths), one decimal
  topHeroes: HeroTally[]; // most-played first, then most wins
};

/** True when this player's side won the game. */
export function wonGame(line: PlayerGameLine): boolean {
  return line.isRadiant === line.radiantWin;
}

// ---------- Leaderboards ----------

export type LeaderboardKey =
  | "wins"
  | "kda"
  | "winRate"
  | "kills"
  | "assists"
  | "games";

export type LeaderEntry = { id: string; summary: PlayerSummary };

export type LeaderRow = { id: string; value: number; summary: PlayerSummary };

const LEADER_VALUE: Record<LeaderboardKey, (s: PlayerSummary) => number> = {
  wins: (s) => s.wins,
  kda: (s) => s.kda,
  winRate: (s) => s.winRate,
  kills: (s) => s.kills,
  assists: (s) => s.assists,
  games: (s) => s.games,
};

/**
 * Rank players by a stat. Rate stats (kda, winRate) take a `minGames` floor so
 * a single lucky game can't top the board. Ties break on games played.
 */
export function topBy(
  entries: LeaderEntry[],
  key: LeaderboardKey,
  { minGames = 1, limit = 5 }: { minGames?: number; limit?: number } = {},
): LeaderRow[] {
  const value = LEADER_VALUE[key];
  return entries
    .filter((e) => e.summary.games >= minGames)
    .map((e) => ({ id: e.id, value: value(e.summary), summary: e.summary }))
    .filter((r) => r.value > 0)
    .sort(
      (a, b) =>
        b.value - a.value ||
        b.summary.games - a.summary.games ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function summarizePlayerGames(lines: PlayerGameLine[]): PlayerSummary {
  const games = lines.length;
  let wins = 0;
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  const heroes = new Map<number, HeroTally>();

  for (const line of lines) {
    const won = wonGame(line);
    if (won) wins++;
    kills += line.kills;
    deaths += line.deaths;
    assists += line.assists;

    const tally = heroes.get(line.heroId) ?? {
      heroId: line.heroId,
      games: 0,
      wins: 0,
    };
    tally.games++;
    if (won) tally.wins++;
    heroes.set(line.heroId, tally);
  }

  const topHeroes = [...heroes.values()].sort(
    (a, b) => b.games - a.games || b.wins - a.wins || a.heroId - b.heroId,
  );

  return {
    games,
    wins,
    losses: games - wins,
    winRate: games > 0 ? Math.round((wins / games) * 100) : 0,
    kills,
    deaths,
    assists,
    avgKills: games > 0 ? round1(kills / games) : 0,
    avgDeaths: games > 0 ? round1(deaths / games) : 0,
    avgAssists: games > 0 ? round1(assists / games) : 0,
    kda: round1((kills + assists) / Math.max(1, deaths)),
    topHeroes,
  };
}
