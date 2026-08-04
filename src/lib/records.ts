// All-time league record book: best single-game performances across every
// season, rolled up from imported box scores. Pure + DB-free — the /records
// page parses each Game's stored player JSON into RecordGames, this module
// decides who holds what. Ties keep the first achiever, so records must be
// fed in chronological order (a record is only *broken*, never shared).

import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";
import { heroById } from "./heroes";

export type RecordLine = {
  /** Mapped league user, or null for an unmapped account (skipped). */
  userId: string | null;
  heroId: number;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number | null;
  gpm: number | null;
  lastHits: number | null;
  isRadiant: boolean;
};

export type RecordGame = {
  matchId: string;
  seasonId: string;
  radiantWin: boolean;
  durationSecs: number;
  radiantScore: number;
  direScore: number;
  lines: RecordLine[];
};

/** A record held by a single player's game line. */
export type PlayerRecord = {
  key: string;
  title: string;
  emoji: string;
  value: number;
  userId: string;
  heroId: number;
  matchId: string;
  seasonId: string;
  /** Whether the holder's side won the game — flavor for the UI. */
  won: boolean;
};

/** A record held by a game as a whole. */
export type GameRecord = {
  key: string;
  title: string;
  emoji: string;
  value: number;
  matchId: string;
  seasonId: string;
  /** Final kill score, for display. */
  score: string;
};

type PlayerRecordSpec = {
  key: string;
  title: string;
  emoji: string;
  metric: (line: RecordLine) => number | null;
};

const PLAYER_RECORDS: PlayerRecordSpec[] = [
  { key: "kills", title: "Most kills", emoji: "🔪", metric: (l) => l.kills },
  {
    key: "assists",
    title: "Most assists",
    emoji: "🤝",
    metric: (l) => l.assists,
  },
  {
    key: "netWorth",
    title: "Richest game",
    emoji: "💰",
    metric: (l) => l.netWorth,
  },
  { key: "gpm", title: "Highest GPM", emoji: "⚡", metric: (l) => l.gpm },
  {
    key: "lastHits",
    title: "Most last hits",
    emoji: "🌾",
    metric: (l) => l.lastHits,
  },
  {
    key: "deaths",
    title: "Most deaths",
    emoji: "🪦",
    metric: (l) => l.deaths,
  },
];

type GameRecordSpec = {
  key: string;
  title: string;
  emoji: string;
  /** null = game doesn't qualify (e.g. missing duration). */
  metric: (game: RecordGame) => number | null;
  /** true when smaller values beat larger ones (e.g. fastest game). */
  ascending?: boolean;
};

const GAME_RECORDS: GameRecordSpec[] = [
  {
    key: "longest",
    title: "Longest game",
    emoji: "🕰️",
    metric: (g) => (g.durationSecs > 0 ? g.durationSecs : null),
  },
  {
    key: "shortest",
    title: "Fastest game",
    emoji: "🏃",
    metric: (g) => (g.durationSecs > 0 ? g.durationSecs : null),
    ascending: true,
  },
  {
    key: "bloodiest",
    title: "Bloodiest game",
    emoji: "🩸",
    // 0–0 means the score never got reported, not a bloodless game.
    metric: (g) =>
      g.radiantScore + g.direScore > 0 ? g.radiantScore + g.direScore : null,
  },
  {
    key: "stomp",
    title: "Biggest stomp",
    emoji: "🥾",
    metric: (g) =>
      g.radiantScore + g.direScore > 0
        ? Math.abs(g.radiantScore - g.direScore)
        : null,
  },
];

export type RecordBook = {
  players: PlayerRecord[];
  games: GameRecord[];
};

/** The stored-Game row shape the record book needs — a structural subset of
 *  what getAllGamesForRecords selects, so both /records and the profile page
 *  can share one mapping. */
export type StoredRecordGame = {
  matchId: string;
  radiantWin: boolean;
  durationSecs: number;
  radiantScore: number;
  direScore: number;
  /** The Game.players box-score JSON. */
  players: string;
  match: { seasonId: string };
};

const MAX_STORED_GAME_METRIC = 1_000_000;

function safeStoredGameMetric(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_STORED_GAME_METRIC
  );
}

/** Diagnostic boundary shared by the record mapper and its public page. */
export function recordGameMetricsValid(game: StoredRecordGame): boolean {
  return (
    safeStoredGameMetric(game.durationSecs) &&
    safeStoredGameMetric(game.radiantScore) &&
    safeStoredGameMetric(game.direScore)
  );
}

export type RecordGameDiagnostics = {
  invalidLines: number;
  malformedGames: number;
  unusableGames: number;
  unknownHeroLines: number;
  unmappedLines: number;
  invalidGameMetrics: number;
};

export type RecordGameAnalysis = {
  games: RecordGame[];
  diagnostics: RecordGameDiagnostics;
};

/**
 * Map stored Game rows (chronological — keep the caller's order) into
 * RecordGames. Extracted from the /records page so the profile's record-holder
 * chips can't drift from the record book's own parsing. A malformed, partial,
 * or duplicated box score omits the whole Game: its duration/kill score is not
 * allowed to become a league record while its player evidence is untrusted.
 * Optional economy fields normalize to null rather than 0 so a legacy import
 * can never hold an economy record with a fabricated value.
 */
export function analyzeRecordGames(
  rows: StoredRecordGame[],
): RecordGameAnalysis {
  const diagnostics: RecordGameDiagnostics = {
    invalidLines: 0,
    malformedGames: 0,
    unusableGames: 0,
    unknownHeroLines: 0,
    unmappedLines: 0,
    invalidGameMetrics: 0,
  };
  const games: RecordGame[] = [];
  for (const g of rows) {
    const decoded = decodeGamePlayers(g.players);
    diagnostics.invalidLines += decoded.invalidLines;
    if (decoded.malformed) diagnostics.malformedGames += 1;
    else if (!decoded.completeRoster) diagnostics.unusableGames += 1;
    diagnostics.unmappedLines += decoded.players.filter(
      (player) => !player.userId,
    ).length;
    const players = trustedGamePlayers(decoded);
    diagnostics.unknownHeroLines += players.filter(
      (player) => !heroById(player.heroId),
    ).length;
    if (!recordGameMetricsValid(g)) diagnostics.invalidGameMetrics += 1;
    if (players.length !== 10) continue;
    const durationSecs = safeStoredGameMetric(g.durationSecs)
      ? g.durationSecs
      : 0;
    const scoresValid =
      safeStoredGameMetric(g.radiantScore) &&
      safeStoredGameMetric(g.direScore);
    games.push({
      matchId: g.matchId,
      seasonId: g.match.seasonId,
      radiantWin: g.radiantWin,
      durationSecs,
      radiantScore: scoresValid ? g.radiantScore : 0,
      direScore: scoresValid ? g.direScore : 0,
      lines: players.map((p) => ({
        userId: p.userId ?? null,
        heroId: p.heroId,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        netWorth: p.netWorth ?? null,
        gpm: p.gpm ?? null,
        lastHits: p.lastHits ?? null,
        isRadiant: p.isRadiant,
      })),
    });
  }
  return { games, diagnostics };
}

export function toRecordGames(rows: StoredRecordGame[]): RecordGame[] {
  return analyzeRecordGames(rows).games;
}

/** Compute the record book. `games` must be in chronological order. */
export function leagueRecords(games: RecordGame[]): RecordBook {
  const players: PlayerRecord[] = [];
  for (const spec of PLAYER_RECORDS) {
    let best: PlayerRecord | null = null;
    for (const game of games) {
      for (const line of game.lines) {
        if (!line.userId) continue;
        const value = spec.metric(line);
        if (value == null) continue;
        if (!best || value > best.value) {
          best = {
            key: spec.key,
            title: spec.title,
            emoji: spec.emoji,
            value,
            userId: line.userId,
            heroId: line.heroId,
            matchId: game.matchId,
            seasonId: game.seasonId,
            won: line.isRadiant === game.radiantWin,
          };
        }
      }
    }
    if (best) players.push(best);
  }

  const gameRecords: GameRecord[] = [];
  for (const spec of GAME_RECORDS) {
    let best: GameRecord | null = null;
    for (const game of games) {
      const value = spec.metric(game);
      if (value == null) continue;
      if (!best || (spec.ascending ? value < best.value : value > best.value)) {
        best = {
          key: spec.key,
          title: spec.title,
          emoji: spec.emoji,
          value,
          matchId: game.matchId,
          seasonId: game.seasonId,
          score: `${game.radiantScore}–${game.direScore}`,
        };
      }
    }
    if (best) gameRecords.push(best);
  }

  return { players, games: gameRecords };
}

/** "43m 17s" — shared display format for duration records. */
export function formatGameDuration(secs: number): string {
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
