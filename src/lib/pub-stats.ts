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
 *  two OpenDota calls refreshing it, and how long "last played" is shown for
 *  it (pubLastPlayed). Login deliberately does NOT read this — it fills
 *  missing snapshots only (the ensureRankTier rule), so a login never pays a
 *  recurring OpenDota round trip. */
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

export type PubActivity = {
  /** "today" / "5d ago" / "3w ago" / "4mo ago" / "2y ago" */
  label: string;
  /** True once the account has been silent past PUB_QUIET_DAYS. */
  quiet: boolean;
};

/** "today" / "5d ago" / "3w ago" / "4mo ago" / "2y ago" for a whole-day span. */
function agoLabel(days: number): string {
  if (days < 1) return "today";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Relative recency of the last visible pub game; null when unknown. */
export function pubActivity(
  lastPlayedAtSecs: number | null,
  nowMs: number,
): PubActivity | null {
  if (!lastPlayedAtSecs || lastPlayedAtSecs <= 0) return null;
  const days = Math.floor((nowMs - lastPlayedAtSecs * 1000) / 86_400_000);
  return { label: agoLabel(days), quiet: days >= PUB_QUIET_DAYS };
}

/** How long ago a snapshot was taken ("3d ago"); null when unknown. The
 *  numbers are a snapshot, so every surface showing them says when. */
export function pubCheckedAgo(
  checkedAtMs: number | null,
  nowMs: number,
): string | null {
  if (checkedAtMs == null) return null;
  return agoLabel(Math.max(0, Math.floor((nowMs - checkedAtMs) / 86_400_000)));
}

/**
 * "Last played" for a snapshot, measured when the snapshot was TAKEN, and only
 * while it is inside the refresh window. Measuring a months-old snapshot's
 * last game against today made someone who plays daily read "last played 5mo
 * ago · MMR may be stale"; past the window we simply don't know.
 */
export function pubLastPlayed(
  pub: { lastPlayedAt: number | null; checkedAt: number | null },
  nowMs: number,
): PubActivity | null {
  if (pub.checkedAt == null) return null;
  if (!pubStatsFresh(new Date(pub.checkedAt), nowMs)) return null;
  return pubActivity(pub.lastPlayedAt, pub.checkedAt);
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

/**
 * Which stale accounts the automatic pass refreshes, in order: this season's
 * signups first (the pool, the draft room and the teams show their data),
 * then everyone else; within each, never-refreshed accounts first, then the
 * oldest snapshot, then id. The account whose fetch failed last pass goes
 * last, so one account OpenDota keeps refusing can't hold up the rest.
 * Pure — the player data refresh passes in what it read.
 */
export function pickStaleAccounts<
  T extends { id: string; pubStatsAt: Date | null },
>(
  candidates: readonly T[],
  opts: {
    signupIds: ReadonlySet<string>;
    lastFailedId: string | null;
    nowMs: number;
    limit: number;
  },
): T[] {
  const seen = new Set<string>();
  return candidates
    .filter((u) => {
      if (seen.has(u.id) || pubStatsFresh(u.pubStatsAt, opts.nowMs)) {
        return false;
      }
      seen.add(u.id);
      return true;
    })
    .sort((a, b) => {
      const failed =
        Number(a.id === opts.lastFailedId) - Number(b.id === opts.lastFailedId);
      if (failed !== 0) return failed;
      const signup =
        Number(opts.signupIds.has(b.id)) - Number(opts.signupIds.has(a.id));
      if (signup !== 0) return signup;
      const at = (a.pubStatsAt?.getTime() ?? -1) - (b.pubStatsAt?.getTime() ?? -1);
      if (at !== 0) return at;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, opts.limit);
}

/** What the player pool actually ships to the client: the recent-window W/L,
 *  the last-played stamp, and the top-3 most-played heroes. Deliberately NO
 *  lifetime games figure — a volume stat is the one number nobody should be
 *  judged (or farm a reputation) on. Null when there is nothing scoutable
 *  (no blob, garbage, or an account whose recent window is empty — private
 *  data or brand new). */
export type PoolPub = {
  recentWins: number;
  recentLosses: number;
  lastPlayedAt: number | null;
  /** Epoch MS the snapshot was taken (`User.pubStatsAt`), or null. */
  checkedAt: number | null;
  topHeroes: PubHero[];
};

export function poolPubRecord(
  raw: string | null | undefined,
  checkedAt: Date | null,
): PoolPub | null {
  const stats = parsePubStats(raw);
  if (!stats) return null;
  if (stats.recentWins + stats.recentLosses === 0) return null;
  return {
    recentWins: stats.recentWins,
    recentLosses: stats.recentLosses,
    lastPlayedAt: stats.lastPlayedAt,
    checkedAt: checkedAt?.getTime() ?? null,
    topHeroes: stats.topHeroes.slice(0, 3),
  };
}
