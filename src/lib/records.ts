// All-time league record book: best single-game performances across every
// season, rolled up from imported box scores. Pure + DB-free — the /records
// page parses each Game's stored player JSON into RecordGames, this module
// decides who holds what. Ties keep the first achiever, so records must be
// fed in chronological order (a record is only *broken*, never shared).

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
