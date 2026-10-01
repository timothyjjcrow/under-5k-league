// All-time league record book: best single-game performances across every
// season, rolled up from imported box scores. Pure + DB-free — the /records
// page parses each Game's stored player JSON into RecordGames, this module
// decides who holds what. Ties keep the first achiever, so records must be
// fed in chronological order (a record is only *broken*, never shared).

import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";
import { heroById } from "./heroes";
import { formatNetWorth } from "./utils";

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
  xpm?: number | null;
  denies?: number | null;
  heroDamage?: number | null;
  towerDamage?: number | null;
  heroHealing?: number | null;
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
    key: "xpm",
    title: "Highest XPM",
    emoji: "✨",
    metric: (l) => l.xpm ?? null,
  },
  {
    key: "denies",
    title: "Most denies",
    emoji: "🛡️",
    metric: (l) => (l.denies != null && l.denies > 0 ? l.denies : null),
  },
  {
    key: "heroDamage",
    title: "Most hero damage",
    emoji: "💥",
    metric: (l) =>
      l.heroDamage != null && l.heroDamage > 0 ? l.heroDamage : null,
  },
  {
    key: "towerDamage",
    title: "Most tower damage",
    emoji: "🏰",
    metric: (l) =>
      l.towerDamage != null && l.towerDamage > 0 ? l.towerDamage : null,
  },
  {
    key: "heroHealing",
    title: "Most hero healing",
    emoji: "💚",
    metric: (l) =>
      l.heroHealing != null && l.heroHealing > 0 ? l.heroHealing : null,
  },
  // No "Most deaths" record on purpose: this is a league for learning the
  // game, and an all-time board that names someone for their worst outing
  // stays up for good. "Most kills in defeat" keeps the losing-side story
  // without naming anyone.
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
  {
    key: "closest",
    title: "Closest finish",
    emoji: "⚖️",
    metric: (g) =>
      g.radiantScore + g.direScore >= 20 &&
      g.radiantScore !== g.direScore
        ? Math.abs(g.radiantScore - g.direScore)
        : null,
    ascending: true,
  },
  {
    key: "losingKills",
    title: "Most kills in defeat",
    emoji: "🔥",
    metric: (g) => {
      const losingScore = g.radiantWin ? g.direScore : g.radiantScore;
      return g.radiantScore + g.direScore > 0 && losingScore > 0
        ? losingScore
        : null;
    },
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
        xpm: p.xpm ?? null,
        denies: p.denies ?? null,
        heroDamage: p.heroDamage ?? null,
        towerDamage: p.towerDamage ?? null,
        heroHealing: p.heroHealing ?? null,
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

/** Book order for stored games: OpenDota start time, unknown times last
 *  (never before dated games), id as the stable tiebreak. leagueRecords
 *  keeps the first achiever of a tie, so every reader must agree on this. */
export function compareRecordChronology(
  a: { startTime: number; id: string },
  b: { startTime: number; id: string },
): number {
  const aTime = a.startTime > 0 ? a.startTime : Number.MAX_SAFE_INTEGER;
  const bTime = b.startTime > 0 ? b.startTime : Number.MAX_SAFE_INTEGER;
  return aTime - bTime || a.id.localeCompare(b.id);
}

/** Complete games the book needs before a broken record is worth a line in
 *  a result post. A young league breaks most marks every game night, and
 *  "new league record" means nothing until there is a real base to beat. */
export const RECORD_ANNOUNCE_MIN_GAMES = 20;

export type BrokenRecord = {
  /** The new mark, set in the series. */
  record: PlayerRecord;
  /** The best mark from every other game, which it beat. */
  previous: PlayerRecord;
};

/**
 * The all-time player record a series just broke, for one line in its
 * result post. `games` is the whole book in chronological order (as
 * leagueRecords wants it) and must include the series' own games.
 *
 * Only a strict improvement counts: a mark equalled keeps its first holder,
 * and a first-ever mark (no previous value) broke nothing. Nothing is
 * reported until `minBaseGames` complete games stood outside the series.
 * When one series breaks several records, the first in book order wins
 * (kills first), because the post carries at most one line.
 */
export function brokenPlayerRecord(
  games: RecordGame[],
  matchId: string,
  minBaseGames = RECORD_ANNOUNCE_MIN_GAMES,
): BrokenRecord | null {
  const others = games.filter((game) => game.matchId !== matchId);
  if (others.length === games.length || others.length < minBaseGames) {
    return null;
  }
  const previousOf = new Map(
    leagueRecords(others).players.map((record) => [record.key, record]),
  );
  for (const record of leagueRecords(games).players) {
    if (record.matchId !== matchId) continue;
    const previous = previousOf.get(record.key);
    if (previous && record.value > previous.value) return { record, previous };
  }
  return null;
}

const MARK_UNIT: Record<string, string> = {
  kills: "kills",
  assists: "assists",
  netWorth: "net worth",
  gpm: "GPM",
  lastHits: "last hits",
  xpm: "XPM",
  denies: "denies",
  heroDamage: "hero damage",
  towerDamage: "tower damage",
  heroHealing: "hero healing",
};

/** "17 kills", "32.1k net worth", "812 GPM" — a player mark with its unit. */
export function formatRecordMark(key: string, value: number): string {
  const amount =
    key === "netWorth"
      ? formatNetWorth(value)
      : new Intl.NumberFormat("en-US").format(value);
  const unit = MARK_UNIT[key];
  return unit ? `${amount} ${unit}` : amount;
}

/** Complete games the book needs before record watch says anything. The
 *  same floor as a broken-record line, for the same reason: in a young book
 *  every mark is close, so "3 short of the record" would mean nothing. */
export const RECORD_WATCH_MIN_GAMES = 20;

/** How close a career best must be to make the watch: within this percent
 *  of the league record (inclusive). */
export const RECORD_WATCH_WITHIN_PERCENT = 15;

/** Lines a match preview lists at most, across both rosters. */
export const RECORD_WATCH_PER_MATCH = 3;

/**
 * Everything record watch reads, worked out once from the book's games:
 * the player records and every player's career best for each, both through
 * the book's own metrics (so a legacy box score can't give anyone a best the
 * book would never count).
 */
export type RecordWatchBook = {
  /** Complete games in the book. */
  games: number;
  /** The league's player records, in book order (kills first). */
  records: PlayerRecord[];
  /** userId → record key → that player's best single-game value. */
  bests: Map<string, Map<string, number>>;
};

/** `games` in chronological order, as `leagueRecords` wants them. */
export function recordWatchBook(games: RecordGame[]): RecordWatchBook {
  const bests = new Map<string, Map<string, number>>();
  for (const game of games) {
    for (const line of game.lines) {
      if (!line.userId) continue;
      for (const spec of PLAYER_RECORDS) {
        const value = spec.metric(line);
        if (value == null) continue;
        const mine = bests.get(line.userId) ?? new Map<string, number>();
        bests.set(line.userId, mine);
        if (value > (mine.get(spec.key) ?? -Infinity)) mine.set(spec.key, value);
      }
    }
  }
  return { games: games.length, records: leagueRecords(games).players, bests };
}

/** One player's distance from one league record: stored facts only. */
export type RecordWatchLine = {
  userId: string;
  key: string;
  title: string;
  emoji: string;
  /** Their best single game for this record. */
  best: number;
  /** The league record. */
  record: number;
  /** record − best; 0 means level (the first to reach a mark keeps it). */
  gap: number;
};

/** Closer to its record: compares gap / record without division. */
const closerThan = (a: RecordWatchLine, b: RecordWatchLine) =>
  a.gap * b.record - b.gap * a.record;

/**
 * The record a player is closest to breaking, or null. Only once the book has
 * RECORD_WATCH_MIN_GAMES complete games, only within
 * RECORD_WATCH_WITHIN_PERCENT of the record, and never a record they hold
 * themselves (the profile already lists those). One line per player: their
 * closest, by share of the record; a tie keeps book order (kills first).
 */
export function recordWatchFor(
  book: RecordWatchBook,
  userId: string,
): RecordWatchLine | null {
  if (book.games < RECORD_WATCH_MIN_GAMES) return null;
  const mine = book.bests.get(userId);
  if (!mine) return null;
  let closest: RecordWatchLine | null = null;
  for (const record of book.records) {
    if (record.userId === userId || record.value <= 0) continue;
    const best = mine.get(record.key);
    if (best == null) continue;
    const gap = record.value - best;
    if (gap < 0 || gap * 100 > record.value * RECORD_WATCH_WITHIN_PERCENT) {
      continue;
    }
    const line: RecordWatchLine = {
      userId,
      key: record.key,
      title: record.title,
      emoji: record.emoji,
      best,
      record: record.value,
      gap,
    };
    if (!closest || closerThan(line, closest) < 0) closest = line;
  }
  return closest;
}

/**
 * A match preview's record watch: each listed player's closest line, closest
 * first (then book order, then user id), at most `limit` in all.
 */
export function recordWatchLines(
  book: RecordWatchBook,
  userIds: readonly string[],
  limit = RECORD_WATCH_PER_MATCH,
): RecordWatchLine[] {
  const bookOrder = new Map(book.records.map((record, i) => [record.key, i]));
  return [...new Set(userIds)]
    .flatMap((userId) => recordWatchFor(book, userId) ?? [])
    .sort(
      (a, b) =>
        closerThan(a, b) ||
        (bookOrder.get(a.key) ?? 0) - (bookOrder.get(b.key) ?? 0) ||
        a.userId.localeCompare(b.userId),
    )
    .slice(0, limit);
}

/**
 * "Career best 18 kills · record 21, 3 short", or "Career best 21 kills ·
 * level with the record". Exact numbers (a rounded "32.1k" could print a
 * best and a record that look equal), and nothing but the stored marks: no
 * pace, no averages.
 */
export function recordWatchText(line: RecordWatchLine): string {
  const amount = (value: number) => new Intl.NumberFormat("en-US").format(value);
  const unit = MARK_UNIT[line.key];
  const best = unit ? `${amount(line.best)} ${unit}` : amount(line.best);
  return line.gap === 0
    ? `Career best ${best} · level with the record`
    : `Career best ${best} · record ${amount(line.record)}, ${amount(line.gap)} short`;
}

/** "43m 17s" — shared display format for duration records. */
export function formatGameDuration(secs: number): string {
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
