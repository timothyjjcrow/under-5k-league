// Pure filtering + sorting for the player-pool UI. Kept DB-free so it's
// unit-testable and reusable on client and server.
import { formatGamesCount, pubActivity, pubWinRate } from "./pub-stats";
import { parseRoles } from "./roles";

export type PoolPlayer = {
  userId: string;
  name: string;
  avatar: string | null;
  mmr: number;
  rankTier: number | null;
  roles: string;
  favoriteHeroes: string;
  captainNote: string;
  wantsCaptain: boolean;
  drafted: boolean;
  /** Resolved Dota account id for scouting links, or null if unavailable. */
  accountId: number | null;
  /** Discord handle — "" when unset or when the viewer isn't signed in. */
  discordName: string;
  /** True when the handle came from the OAuth link (proven), not typed. */
  discordVerified: boolean;
};

export type PoolSort = "mmr" | "rank" | "name";

/** One player's inhouse-ladder line, trimmed for the pool payload. */
export type PoolInhouseRecord = {
  /** Rounded personal Elo. */
  rating: number;
  /** Ladder position among established players; null = provisional
   *  (< PROVISIONAL_GAMES) — the rankInhouse rule: provisionals are never
   *  ranked, so the UI dims the rating and shows the games count instead. */
  rank: number | null;
  wins: number;
  losses: number;
  games: number;
};

/** One player's pub-scouting line (see pub-stats.ts `PoolPub`). */
export type PoolPubRecord = {
  recentWins: number;
  recentLosses: number;
  totalGames: number;
  /** Epoch SECONDS of their newest visible pub game, or null. */
  lastPlayedAt: number | null;
};

/** Everything the pool row knows about a player BEYOND the frozen PoolPlayer
 *  shape — one parallel record keyed by userId (the PoolDraftInfo precedent),
 *  so PoolPlayer and the shared filter lib stay untouched. Entries are only
 *  present when there is something to show; a missing key renders nothing. */
export type PoolScout = {
  inhouse?: PoolInhouseRecord;
  pub?: PoolPubRecord;
  /** Signup "goals" — the row's quote fallback when captainNote is empty
   *  (only sent when it will actually render; payload trimming). */
  statement?: string;
};
export type PoolScoutInfo = Record<string, PoolScout>;

/**
 * Trim a rankInhouse ladder to the pool payload: only the listed userIds,
 * only the five scalars — name/avatar/form/streak/peak/lastChange never cross
 * the wire. Ranked entries carry `rank = index + 1` (ladder order);
 * provisional entries carry `rank: null`.
 */
export function buildPoolInhouseInfo(
  ladder: {
    ranked: {
      userId: string;
      rating: number;
      wins: number;
      losses: number;
      games: number;
    }[];
    provisional: {
      userId: string;
      rating: number;
      wins: number;
      losses: number;
      games: number;
    }[];
  },
  userIds: Iterable<string>,
): Record<string, PoolInhouseRecord> {
  const want = new Set(userIds);
  const out: Record<string, PoolInhouseRecord> = {};
  ladder.ranked.forEach((r, i) => {
    if (!want.has(r.userId)) return;
    out[r.userId] = {
      rating: r.rating,
      rank: i + 1,
      wins: r.wins,
      losses: r.losses,
      games: r.games,
    };
  });
  for (const r of ladder.provisional) {
    if (!want.has(r.userId)) continue;
    out[r.userId] = {
      rating: r.rating,
      rank: null,
      wins: r.wins,
      losses: r.losses,
      games: r.games,
    };
  }
  return out;
}

// --- Scouting token/title text -----------------------------------------------
// One source for the strings the pool row, its lg column, and the captain-
// hopefuls cards all render — two hand-copies of a token is how the header
// starts lying about a column. Pure so both the client component and the
// server page can call them.

/** "Inhouse 1042 · 7–3" (ranked) / "Inhouse 2–0" (provisional — no rating:
 *  a 1-game Elo is noise, the same reason rankInhouse never ranks them). */
export function inhouseToken(ih: PoolInhouseRecord): string {
  return `Inhouse ${ih.rank != null ? `${ih.rating} · ` : ""}${ih.wins}–${ih.losses}`;
}

/** Hover detail for the inhouse cell/token — never the sole affordance
 *  (touch has no hover); everything here is also visible somewhere. */
export function inhouseTitle(ih: PoolInhouseRecord): string {
  return ih.rank != null
    ? `Inhouse: ${ih.wins}W–${ih.losses}L, rating ${ih.rating}, ranked #${ih.rank}`
    : `Provisional — ${ih.games} inhouse game${ih.games === 1 ? "" : "s"}`;
}

/** "Pubs 54% · 2.1k games" — recent-window win rate + lifetime volume, the
 *  two figures that say whether the listed MMR describes an active player. */
export function pubToken(pub: PoolPubRecord): string {
  const rate = pubWinRate(pub);
  const pct = rate != null ? `${Math.round(rate * 100)}% · ` : "";
  return `Pubs ${pct}${formatGamesCount(pub.totalGames)} games`;
}

export function pubTitle(pub: PoolPubRecord, nowMs: number): string {
  const window = pub.recentWins + pub.recentLosses;
  const activity = pubActivity(pub.lastPlayedAt, nowMs);
  return `Last ${window} pub games: ${pub.recentWins}W–${pub.recentLosses}L · ${pub.totalGames} lifetime · last played ${activity?.label ?? "unknown"}`;
}

/**
 * Re-sort for the pool's "Sort: Inhouse": established (ranked) players first
 * by rating, then provisionals by rating, then everyone with no inhouse games.
 * Ties and the no-games band keep the input order (the input arrives
 * MMR-sorted and Array.prototype.sort is stable), so the tail stays useful.
 * Never mutates the input — the lib's pinned convention.
 */
export function sortByInhouseRecord<T extends { userId: string }>(
  rows: T[],
  scout: PoolScoutInfo,
): T[] {
  const band = (r: T): number => {
    const ih = scout[r.userId]?.inhouse;
    return ih ? (ih.rank != null ? 2 : 1) : 0;
  };
  return [...rows].sort((a, b) => {
    const diff = band(b) - band(a);
    if (diff !== 0) return diff;
    const ia = scout[a.userId]?.inhouse;
    const ib = scout[b.userId]?.inhouse;
    // Inside the ranked band, ladder position IS the order — it encodes the
    // full ladder tiebreak (rating, wins, win rate), so a rating tie can't
    // render "#5" above "#4".
    if (ia?.rank != null && ib?.rank != null) return ia.rank - ib.rank;
    return (ib?.rating ?? 0) - (ia?.rating ?? 0);
  });
}

export type PoolFilter = {
  query?: string;
  /** Position key "1".."5", or null for all roles. */
  role?: string | null;
  sort?: PoolSort;
  captainOnly?: boolean;
  /** Draft-status filter; players without a `drafted` field always pass. */
  status?: "all" | "drafted" | "free";
};

/** The fields filtering/sorting actually reads — callers can pass any superset
 * (the full signup pool, the draft room's live "available" list, …). */
export type FilterablePlayer = {
  name: string;
  mmr: number;
  rankTier: number | null;
  roles: string;
  wantsCaptain?: boolean;
  drafted?: boolean;
};

/** Filter + sort a player list. Never mutates the input. */
export function filterAndSortPlayers<T extends FilterablePlayer>(
  players: T[],
  {
    query = "",
    role = null,
    sort = "mmr",
    captainOnly = false,
    status = "all",
  }: PoolFilter,
): T[] {
  const q = query.trim().toLowerCase();
  const filtered = players.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q)) return false;
    if (role && !parseRoles(p.roles).includes(role)) return false;
    if (captainOnly && !p.wantsCaptain) return false;
    if (status !== "all" && p.drafted !== undefined) {
      if (status === "drafted" && !p.drafted) return false;
      if (status === "free" && p.drafted) return false;
    }
    return true;
  });
  return [...filtered].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "rank") {
      // Highest medal first; unknown medals sink to the bottom, MMR breaks ties.
      return (b.rankTier ?? -1) - (a.rankTier ?? -1) || b.mmr - a.mmr;
    }
    return b.mmr - a.mmr;
  });
}
