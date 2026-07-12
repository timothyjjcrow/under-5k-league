// Pre-match scouting report: an opponent dossier — per-player hero pools, a
// team-wide threat board, and a pace profile — rolled up from stored
// box-score lines. Pure + DB-free: the match-preview page parses each Game's
// stored player JSON into ScoutGames, this does the math. (Declared-role
// coverage comes from pool-stats.ts's roleCoverage.)

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
 * max(2, ceil(totalTeamPicks / 25)) — mirroring the metaMinPicks philosophy:
 * a win rate needs a few picks behind it before it's a threat signal.
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

export type PaceProfile = {
  games: number;
  winAvgMins: number | null;
  lossAvgMins: number | null;
  longestMins: number | null;
  shortestMins: number | null;
};

/**
 * How long this team's games run, split by result. Only games where at least
 * one of `userIds` has a line AND durationSecs > 0 qualify — an unreported
 * duration is not data (same rule as the record book). The team's side in a
 * game is the majority side of their lines (ties lean radiant); a win is that
 * side winning. Minutes are 1-decimal; a side with no games averages null.
 */
export function paceProfile(
  userIds: string[],
  games: ScoutGame[],
): PaceProfile {
  const ids = new Set(userIds);
  let count = 0;
  let winSecs = 0;
  let winGames = 0;
  let lossSecs = 0;
  let lossGames = 0;
  let longest: number | null = null;
  let shortest: number | null = null;

  for (const game of games) {
    if (game.durationSecs <= 0) continue;
    let radiant = 0;
    let dire = 0;
    for (const line of game.lines) {
      if (line.userId === null || !ids.has(line.userId)) continue;
      if (line.isRadiant) radiant++;
      else dire++;
    }
    if (radiant + dire === 0) continue;

    count++;
    const onRadiant = radiant >= dire;
    const won = onRadiant === game.radiantWin;
    if (won) {
      winSecs += game.durationSecs;
      winGames++;
    } else {
      lossSecs += game.durationSecs;
      lossGames++;
    }
    if (longest === null || game.durationSecs > longest)
      longest = game.durationSecs;
    if (shortest === null || game.durationSecs < shortest)
      shortest = game.durationSecs;
  }

  return {
    games: count,
    winAvgMins: winGames > 0 ? round1(winSecs / winGames / 60) : null,
    lossAvgMins: lossGames > 0 ? round1(lossSecs / lossGames / 60) : null,
    longestMins: longest === null ? null : round1(longest / 60),
    shortestMins: shortest === null ? null : round1(shortest / 60),
  };
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
