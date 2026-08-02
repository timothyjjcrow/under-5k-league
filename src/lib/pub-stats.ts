// Pure parsing/formatting for the stored OpenDota pub-scouting snapshot
// (`User.pubStats`, a JSON string — SQLite has no Json column type, the
// Game.players precedent). The fetch side lives in dota.ts (fetchPubStats);
// this file owns the shape, so a malformed or legacy blob degrades to null
// instead of crashing a page render. No DB here — testable.

export type PubHero = { heroId: number; games: number; wins: number };

export type PubStats = {
  /** W/L over the player's most recent ≤100 pub games (OpenDota /wl?limit=100).
   *  Both 0 = no visible games: brand-new account or match data private. */
  recentWins: number;
  recentLosses: number;
  /** All-time games across every hero (sum of /heroes `games`). */
  totalGames: number;
  /** Epoch SECONDS of the newest game OpenDota has seen, or null if unknown. */
  lastPlayedAt: number | null;
  /** Most-played heroes, games desc, at most 5. */
  topHeroes: PubHero[];
};

/** How long a stored snapshot stays fresh before the admin bulk sync spends
 *  two OpenDota calls refreshing it. Login deliberately does NOT read this —
 *  it fills missing snapshots only (the ensureRankTier rule), so a login
 *  never pays a recurring OpenDota round trip. */
export const PUB_STATS_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** Days without a pub game before the pool flags the account as quiet — a
 *  dormant account's MMR describes who the player USED to be, which is
 *  exactly what a bidding captain wants to know before draft night. */
export const PUB_QUIET_DAYS = 60;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** Parse a stored pubStats blob. Null for null/garbage/legacy shapes — never
 *  throws, so a bad row degrades to "no data" instead of a broken page. */
export function parsePubStats(raw: string | null | undefined): PubStats | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const recentWins = num(d.recentWins);
  const recentLosses = num(d.recentLosses);
  const totalGames = num(d.totalGames);
  if (recentWins === null || recentLosses === null || totalGames === null) {
    return null;
  }
  const last = num(d.lastPlayedAt);
  const topHeroes: PubHero[] = Array.isArray(d.topHeroes)
    ? d.topHeroes
        .map((h) => {
          const rec = h as Record<string, unknown>;
          const heroId = num(rec?.heroId);
          const games = num(rec?.games);
          const wins = num(rec?.wins);
          return heroId && games !== null && wins !== null
            ? { heroId, games, wins }
            : null;
        })
        .filter((h): h is PubHero => h !== null)
        .slice(0, 5)
    : [];
  return {
    recentWins,
    recentLosses,
    totalGames,
    lastPlayedAt: last && last > 0 ? last : null,
    topHeroes,
  };
}

/** Win rate 0..1 over the recent window, or null when it has no games. */
export function pubWinRate(s: {
  recentWins: number;
  recentLosses: number;
}): number | null {
  const total = s.recentWins + s.recentLosses;
  return total > 0 ? s.recentWins / total : null;
}

/** Compact games figure for a one-line token: 872 → "872", 2113 → "2.1k",
 *  15200 → "15k". */
export function formatGamesCount(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

export type PubActivity = {
  /** "today" / "5d ago" / "3w ago" / "4mo ago" / "2y ago" */
  label: string;
  /** True once the account has been silent past PUB_QUIET_DAYS. */
  quiet: boolean;
};

/** Relative recency of the last visible pub game; null when unknown. */
export function pubActivity(
  lastPlayedAtSecs: number | null,
  nowMs: number,
): PubActivity | null {
  if (!lastPlayedAtSecs || lastPlayedAtSecs <= 0) return null;
  const days = Math.floor((nowMs - lastPlayedAtSecs * 1000) / 86_400_000);
  const quiet = days >= PUB_QUIET_DAYS;
  if (days < 1) return { label: "today", quiet };
  if (days < 14) return { label: `${days}d ago`, quiet };
  if (days < 60) return { label: `${Math.floor(days / 7)}w ago`, quiet };
  if (days < 365) return { label: `${Math.floor(days / 30)}mo ago`, quiet };
  return { label: `${Math.floor(days / 365)}y ago`, quiet };
}

/** True while a stored snapshot is recent enough that the bulk sync should
 *  skip re-fetching it. A null `pubStatsAt` (never fetched) is always stale. */
export function pubStatsFresh(
  pubStatsAt: Date | null,
  nowMs: number,
): boolean {
  return (
    pubStatsAt !== null && nowMs - pubStatsAt.getTime() < PUB_STATS_REFRESH_MS
  );
}

/** What the player pool actually ships to the client — the five scalars, no
 *  hero list. Null when there is nothing scoutable (no blob, garbage, or an
 *  account whose recent window is empty — private data or brand new). */
export type PoolPub = {
  recentWins: number;
  recentLosses: number;
  totalGames: number;
  lastPlayedAt: number | null;
};

export function poolPubRecord(raw: string | null | undefined): PoolPub | null {
  const stats = parsePubStats(raw);
  if (!stats) return null;
  if (stats.recentWins + stats.recentLosses === 0) return null;
  return {
    recentWins: stats.recentWins,
    recentLosses: stats.recentLosses,
    totalGames: stats.totalGames,
    lastPlayedAt: stats.lastPlayedAt,
  };
}
