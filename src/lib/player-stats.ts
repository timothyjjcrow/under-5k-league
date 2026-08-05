// Summarize a player's Dota 2 games into league career stats. Pure + testable
// (no DB): the profile page parses each Game's stored player JSON into these
// lines, then this rolls them up.

import type { PlayerStat } from "./match-import";

export type ParsedGamePlayers = {
  players: PlayerStat[];
  /** Array members rejected because required fields or ids were unsafe. */
  invalidLines: number;
  /** Syntactically invalid JSON or a non-array top-level value. */
  malformed: boolean;
  /** Ten valid rows, five per side, with unique heroes and supplied identities. */
  completeRoster: boolean;
};

const MAX_HERO_ID = 10_000;
const MAX_COUNTING_STAT = 1_000_000;
const MAX_REPORTED_STAT = 10_000_000;
const MAX_ACCOUNT_ID = 0xffff_ffff;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableFinite(value: unknown): number | null {
  return finiteNumber(value) && value >= 0 && value <= MAX_REPORTED_STAT
    ? value
    : null;
}

function nullableAccountId(value: unknown): number | null {
  return finiteNumber(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_ACCOUNT_ID
    ? value
    : null;
}

function safeCountingStat(value: unknown): value is number {
  return (
    finiteNumber(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_COUNTING_STAT
  );
}

function normalizedBenchmarks(value: unknown): PlayerStat["benchmarks"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: NonNullable<PlayerStat["benchmarks"]> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      continue;
    const row = candidate as Record<string, unknown>;
    if (!finiteNumber(row.pct)) continue;
    out[key] = {
      raw: nullableFinite(row.raw),
      pct: Math.min(1, Math.max(0, row.pct)),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizedPlayerStat(value: unknown): PlayerStat | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const line = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(line.heroId) ||
    !finiteNumber(line.heroId) ||
    line.heroId <= 0 ||
    line.heroId > MAX_HERO_ID ||
    typeof line.isRadiant !== "boolean" ||
    !safeCountingStat(line.kills) ||
    !safeCountingStat(line.deaths) ||
    !safeCountingStat(line.assists)
  ) {
    return null;
  }
  for (const key of ["userId", "teamId"] as const) {
    const id = line[key];
    if (id != null && (typeof id !== "string" || id.trim().length === 0)) {
      return null;
    }
  }

  return {
    accountId: nullableAccountId(line.accountId),
    heroId: line.heroId,
    isRadiant: line.isRadiant,
    kills: line.kills,
    deaths: line.deaths,
    assists: line.assists,
    personaname: typeof line.personaname === "string" ? line.personaname : null,
    netWorth: nullableFinite(line.netWorth),
    gpm: nullableFinite(line.gpm),
    lastHits: nullableFinite(line.lastHits),
    xpm: nullableFinite(line.xpm),
    denies: nullableFinite(line.denies),
    level: nullableFinite(line.level),
    heroDamage: nullableFinite(line.heroDamage),
    towerDamage: nullableFinite(line.towerDamage),
    heroHealing: nullableFinite(line.heroHealing),
    benchmarks: normalizedBenchmarks(line.benchmarks),
    userId: typeof line.userId === "string" ? line.userId : null,
    teamId: typeof line.teamId === "string" ? line.teamId : null,
  };
}

/**
 * Decode the denormalized Game.players column at one runtime boundary. Valid
 * JSON is not automatically trusted: unsafe members are skipped so arithmetic
 * on public stat pages cannot turn strings/nulls into NaN or false records.
 */
export function decodeGamePlayers(json: string): ParsedGamePlayers {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return {
      players: [],
      invalidLines: 0,
      malformed: true,
      completeRoster: false,
    };
  }
  if (!Array.isArray(value)) {
    return {
      players: [],
      invalidLines: 0,
      malformed: true,
      completeRoster: false,
    };
  }
  const players: PlayerStat[] = [];
  let invalidLines = 0;
  for (const candidate of value) {
    const player = normalizedPlayerStat(candidate);
    if (player) players.push(player);
    else invalidLines += 1;
  }
  const radiant = players.filter((player) => player.isRadiant).length;
  // Missing identities are permitted for hero/game aggregates. When an id is
  // supplied, however, a duplicate means these cannot be ten distinct lines.
  // Actor-specific consumers (leaders) skip unmapped rows; honors applies its
  // stricter all-users/all-teams attribution rule separately.
  const unique = <T extends string | number>(values: (T | null)[]) => {
    const present = values.filter((value): value is T => value != null);
    return new Set(present).size === present.length;
  };
  const completeRoster =
    invalidLines === 0 &&
    players.length === 10 &&
    radiant === 5 &&
    unique(players.map((player) => player.heroId)) &&
    unique(players.map((player) => player.accountId)) &&
    unique(players.map((player) => player.userId));
  return { players, invalidLines, malformed: false, completeRoster };
}

/**
 * Public roll-ups must never turn a partial/duplicated box score into a league
 * record. Detail and repair surfaces can still inspect `decoded.players`.
 */
export function trustedGamePlayers(decoded: ParsedGamePlayers): PlayerStat[] {
  return decoded.completeRoster ? decoded.players : [];
}

/** Safe convenience form for callers that do not need diagnostics. */
export function parseGamePlayers(json: string): PlayerStat[] {
  return decodeGamePlayers(json).players;
}

export type PlayerGameLine = {
  isRadiant: boolean;
  radiantWin: boolean;
  kills: number;
  deaths: number;
  assists: number;
  heroId: number;
  netWorth?: number | null;
  gpm?: number | null;
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
  avgNetWorth: number | null; // averaged over games that reported it; null if none
  avgGpm: number | null;
  netWorthGames: number;
  gpmGames: number;
  topHeroes: HeroTally[]; // most-played first, then most wins
};

/** True when this player's side won the game. */
export function wonGame(line: PlayerGameLine): boolean {
  return line.isRadiant === line.radiantWin;
}

export type Streak = { type: "W" | "L" | null; count: number };

/**
 * Current win/loss streak from a newest-first list of games. Returns the run of
 * same-result games at the front. `{ type: null, count: 0 }` when there are none.
 */
export function currentStreak(linesNewestFirst: PlayerGameLine[]): Streak {
  if (linesNewestFirst.length === 0) return { type: null, count: 0 };
  const won = wonGame(linesNewestFirst[0]);
  let count = 0;
  for (const line of linesNewestFirst) {
    if (wonGame(line) !== won) break;
    count++;
  }
  return { type: won ? "W" : "L", count };
}

// ---------- Leaderboards ----------

export type LeaderboardKey =
  | "wins"
  | "kda"
  | "winRate"
  | "kills"
  | "assists"
  | "games"
  | "gpm"
  | "netWorth";

export type LeaderEntry = { id: string; summary: PlayerSummary };

export type LeaderRow = { id: string; value: number; summary: PlayerSummary };

const LEADER_VALUE: Record<LeaderboardKey, (s: PlayerSummary) => number> = {
  wins: (s) => s.wins,
  kda: (s) => s.kda,
  winRate: (s) => s.winRate,
  kills: (s) => s.kills,
  assists: (s) => s.assists,
  games: (s) => s.games,
  gpm: (s) => s.avgGpm ?? 0,
  netWorth: (s) => s.avgNetWorth ?? 0,
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
  const samples = (summary: PlayerSummary) =>
    key === "gpm"
      ? summary.gpmGames
      : key === "netWorth"
        ? summary.netWorthGames
        : summary.games;
  return entries
    .filter((e) => samples(e.summary) >= minGames)
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
  let netWorthSum = 0;
  let netWorthGames = 0;
  let gpmSum = 0;
  let gpmGames = 0;
  const heroes = new Map<number, HeroTally>();

  for (const line of lines) {
    const won = wonGame(line);
    if (won) wins++;
    kills += line.kills;
    deaths += line.deaths;
    assists += line.assists;
    if (line.netWorth != null) {
      netWorthSum += line.netWorth;
      netWorthGames++;
    }
    if (line.gpm != null) {
      gpmSum += line.gpm;
      gpmGames++;
    }

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
    avgNetWorth:
      netWorthGames > 0 ? Math.round(netWorthSum / netWorthGames) : null,
    avgGpm: gpmGames > 0 ? Math.round(gpmSum / gpmGames) : null,
    netWorthGames,
    gpmGames,
    topHeroes,
  };
}
