// Pure filtering + sorting for the player-pool UI. Kept DB-free so it's
// unit-testable and reusable on client and server.
import { heroById } from "./heroes";
import { pubCheckedAgo, pubLastPlayed, pubWinRate } from "./pub-stats";
import { parseRoles } from "./roles";
import { seriesRecordText } from "./team-matches";

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
  /** Epoch SECONDS of their newest visible pub game, or null. */
  lastPlayedAt: number | null;
  /** Epoch MS the snapshot was taken, or null when unknown. */
  checkedAt: number | null;
  /** Most-played heroes across their whole pub history, top 3 by games. */
  topHeroes: { heroId: number; games: number; wins: number }[];
};

/** Everything the pool row knows about a player BEYOND the frozen PoolPlayer
 *  shape — one parallel record keyed by userId (the PoolDraftInfo precedent),
 *  so PoolPlayer and the shared filter lib stay untouched. Entries are only
 *  present when there is something to show; a missing key renders nothing. */
/** A returning player's most recent earlier league season (see
 *  buildPoolLastSeasons). */
export type PoolLastSeason = {
  seasonName: string;
  teamName: string;
  /** Completed series this player appeared in for that team, the series
   *  record the profile's Seasons card shows; null when none were recorded. */
  record: { wins: number; losses: number; draws: number } | null;
  /** What that team paid for them at the auction; null for a captain, a $0
   *  free-agent signing, or someone who played for a team without a roster
   *  row there (a standin, or a player released later). */
  price: number | null;
  captain: boolean;
  /** That team won the season's title. */
  champion: boolean;
};

export type PoolScout = {
  inhouse?: PoolInhouseRecord;
  pub?: PoolPubRecord;
  lastSeason?: PoolLastSeason;
  /** An older signup's "goals", shown joined with its captain note (only
   *  sent when it adds something; payload trimming). */
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
// One source for the strings the pool row and its lg column render — two
// hand-copies of a token is how the header starts lying about a column. Pure
// so both the client component and the server page can call them.

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

/** "Pubs 54% in last 100 · checked 3d ago" — the win rate NAMES its recent
 *  window, so nobody reads a hot (or cold) streak as a lifetime figure, and
 *  says when the snapshot was taken, so a months-old one never reads as
 *  current. The window is however many games OpenDota could see, so a
 *  37-game account honestly reads "in last 37". Deliberately no games-played
 *  volume figure. */
export function pubToken(pub: PoolPubRecord, nowMs: number): string {
  const rate = pubWinRate(pub);
  const window = pub.recentWins + pub.recentLosses;
  const checked = pubCheckedAgo(pub.checkedAt, nowMs);
  const suffix = checked ? ` · checked ${checked}` : "";
  // poolPubRecord filters empty windows, but stay honest if one slips in.
  if (rate == null) return `Pubs — no visible games${suffix}`;
  return `Pubs ${Math.round(rate * 100)}% in last ${window}${suffix}`;
}

export function pubTitle(pub: PoolPubRecord, nowMs: number): string {
  const window = pub.recentWins + pub.recentLosses;
  const checked = pubCheckedAgo(pub.checkedAt, nowMs);
  const activity = pubLastPlayed(pub, nowMs);
  return [
    `Last ${window} pub games: ${pub.recentWins}W–${pub.recentLosses}L`,
    activity ? `last played ${activity.label}` : null,
    `checked ${checked ?? "at an unknown time"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Hover text for a most-played-hero icon: "Pudge — 220 pub games, 55% won". */
export function pubHeroTitle(h: {
  heroId: number;
  games: number;
  wins: number;
}): string {
  const name = heroById(h.heroId)?.name ?? `Hero #${h.heroId}`;
  const pct = h.games > 0 ? `, ${Math.round((h.wins / h.games) * 100)}% won` : "";
  return `${name} — ${h.games} pub game${h.games === 1 ? "" : "s"}${pct}`;
}

/**
 * Each returning player's most recent EARLIER league season: the team they
 * played for, their series record there, their auction price and whether
 * that team won the title. The same facts as the profile's Seasons card
 * (recorded appearances first, then the season's final roster), boiled down
 * to one scouting token. Data-presence gated like every pool token: a player
 * with no earlier season gets no entry, so a first season renders unchanged.
 *
 * Within the chosen season the roster team wins when they also played for it;
 * otherwise the team they played the most games for (a standin, or a player
 * released mid-season); otherwise the roster team with no record (a season
 * with no imported games).
 */
export function buildPoolLastSeasons(input: {
  userIds: Iterable<string>;
  /** Earlier seasons, NEWEST FIRST. Anything not listed is ignored. */
  seasons: readonly { id: string; name: string }[];
  /** appearanceCareers rows (any users; filtered here). */
  appearances: readonly {
    userId: string;
    teamId: string;
    seasonId: string;
    games: number;
    seriesWins: number;
    seriesLosses: number;
    seriesDraws: number;
  }[];
  /** TeamMember rows in those seasons (at most one per user per season). */
  memberships: readonly {
    userId: string;
    teamId: string;
    seasonId: string;
    price: number;
    isCaptain: boolean;
  }[];
  teamNames: ReadonlyMap<string, string>;
  /** seasonId → champion teamId, for seasons with a resolved champion. */
  champions: ReadonlyMap<string, string>;
}): Record<string, PoolLastSeason> {
  const want = new Set(input.userIds);
  const order = new Map(input.seasons.map((season, i) => [season.id, i]));
  const byUser = new Map<
    string,
    {
      apps: (typeof input.appearances)[number][];
      rows: (typeof input.memberships)[number][];
    }
  >();
  const slot = (userId: string) => {
    let entry = byUser.get(userId);
    if (!entry) byUser.set(userId, (entry = { apps: [], rows: [] }));
    return entry;
  };
  for (const a of input.appearances) {
    if (want.has(a.userId) && order.has(a.seasonId) && a.games > 0) {
      slot(a.userId).apps.push(a);
    }
  }
  for (const m of input.memberships) {
    if (want.has(m.userId) && order.has(m.seasonId)) slot(m.userId).rows.push(m);
  }

  const out: Record<string, PoolLastSeason> = {};
  for (const [userId, { apps, rows }] of byUser) {
    const rank = (seasonId: string) => order.get(seasonId) ?? Infinity;
    const seasonId = [...apps, ...rows]
      .map((x) => x.seasonId)
      .sort((a, b) => rank(a) - rank(b))[0];
    const season = input.seasons[rank(seasonId)];
    const seasonApps = apps
      .filter((a) => a.seasonId === seasonId)
      .sort((a, b) => b.games - a.games || a.teamId.localeCompare(b.teamId));
    const roster = rows.find((m) => m.seasonId === seasonId);
    const teamId =
      roster && seasonApps.some((a) => a.teamId === roster.teamId)
        ? roster.teamId
        : (seasonApps[0]?.teamId ?? roster?.teamId);
    const teamName = teamId ? input.teamNames.get(teamId) : undefined;
    if (!season || !teamId || teamName === undefined) continue;
    const app = seasonApps.find((a) => a.teamId === teamId);
    const rostered = roster?.teamId === teamId ? roster : undefined;
    out[userId] = {
      seasonName: season.name,
      teamName,
      record:
        app && app.seriesWins + app.seriesLosses + app.seriesDraws > 0
          ? {
              wins: app.seriesWins,
              losses: app.seriesLosses,
              draws: app.seriesDraws,
            }
          : null,
      price:
        rostered && !rostered.isCaptain && rostered.price > 0
          ? rostered.price
          : null,
      captain: !!rostered?.isCaptain,
      champion: input.champions.get(seasonId) === teamId,
    };
  }
  return out;
}

/**
 * "Season 3: Dire Straits · 4W 0D 3L series · $12 · 🏆 champion". The record
 * reads the way the standings and team pages write it (seriesRecordText).
 */
export function lastSeasonToken(ls: PoolLastSeason): string {
  const parts = [
    `${ls.seasonName}: ${ls.teamName}${ls.captain ? " (captain)" : ""}`,
  ];
  if (ls.record) parts.push(`${seriesRecordText(ls.record)} series`);
  if (ls.price != null) parts.push(`$${ls.price}`);
  if (ls.champion) parts.push("🏆 champion");
  return parts.join(" · ");
}

/** Hover detail for the token, spelled out. */
export function lastSeasonTitle(ls: PoolLastSeason): string {
  const parts = [
    `${ls.seasonName}: played for ${ls.teamName}${ls.captain ? " as captain" : ""}`,
  ];
  if (ls.record) {
    const { wins, losses, draws } = ls.record;
    parts.push(
      `series they played in: ${wins} won, ${losses} lost${draws > 0 ? `, ${draws} drawn` : ""}`,
    );
  }
  if (ls.price != null) parts.push(`drafted for $${ls.price}`);
  if (ls.champion) parts.push("won the title");
  return parts.join(" · ");
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

/** The /players status chips: the lib's draft-status filter plus "standin". */
export type PoolStatusFilter = "all" | "drafted" | "free" | "standin";

/**
 * The /players pool's filter. Standins sit in the same table as full players,
 * so search, roles and sort work for everyone, but registration type is a
 * pool-only fact: `filterAndSortPlayers` is shared with the draft room, which
 * must never list a standin, so neither PoolPlayer nor PoolFilter learns about
 * it. The type narrowing happens here, then the shared lib does the rest.
 *
 * "drafted" and "free" are about FULL players: a standin is never rostered,
 * so the lib alone would count every standin as a free agent, and a free agent
 * is someone a captain can sign (signFreeAgent refuses standins).
 * Never mutates the input.
 */
export function filterPoolRows<
  T extends FilterablePlayer & { userId: string },
>(
  rows: T[],
  filter: Omit<PoolFilter, "status"> & { status?: PoolStatusFilter },
  standinIds: ReadonlySet<string>,
): T[] {
  const { status = "all", ...rest } = filter;
  const typed =
    status === "all"
      ? rows
      : rows.filter((r) => standinIds.has(r.userId) === (status === "standin"));
  return filterAndSortPlayers(typed, {
    ...rest,
    status: status === "standin" ? "all" : status,
  });
}

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
