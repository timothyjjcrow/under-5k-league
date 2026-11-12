// Pure filtering + sorting for the player-pool UI. Kept DB-free so it's
// unit-testable and reusable on client and server.
import { heroById, parseHeroList } from "./heroes";
import type { PubScout } from "./pub-scout";
import {
  pubCheckedAgo,
  pubLastPlayed,
  pubWinRate,
  type PubActivity,
} from "./pub-stats";
import { parseRoles, serializeRoles } from "./roles";
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
  /** How they play, from their last ≤100 games of every mode; null on a
   *  snapshot from before it was stored. */
  scout: PubScout | null;
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

/** "last played 4mo ago": shown only once the account has gone quiet
 *  (`PubActivity.quiet`), with PUB_QUIET_TITLE as its hover. */
export function pubQuietToken(activity: PubActivity): string {
  return `last played ${activity.label}`;
}

export const PUB_QUIET_TITLE =
  "No visible pub games in over two months — the listed MMR may describe who they used to be";

/** The "no Discord" marker's hover. Show the marker only to a viewer allowed
 *  the player's contact, never as a hidden handle's stand-in. */
export const NO_DISCORD_TITLE =
  "No Discord linked or entered — the league coordinates on Discord, so reaching this player takes extra work";

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

/** Hover text for a recent-hero icon: "Lion — 12 of their last 100 games,
 *  8–4". */
export function recentHeroTitle(
  h: { heroId: number; games: number; wins: number },
  window: number,
): string {
  const name = heroById(h.heroId)?.name ?? `Hero #${h.heroId}`;
  return `${name} — ${h.games} of their last ${window} games, ${h.wins}–${h.games - h.wins}`;
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

/** The /players status chips: the lib's draft-status filter plus the two
 *  registration types, "player" (full players only) and "standin". */
export type PoolStatusFilter = "all" | "drafted" | "free" | "player" | "standin";

// --- The /players page's filters ----------------------------------------------
// Everything below is /players only. `filterAndSortPlayers` (further down) is
// shared with the draft room, which never lists a standin and has its own
// controls, so neither it, PoolPlayer, PoolFilter nor PoolSort learns about
// anything here: the page narrows its rows with these, then sorts through the
// shared lib.

/** League history: everyone, players who played an earlier league season,
 *  or players who never have. */
export type PoolHistoryFilter = "any" | "returning" | "new";

/** An MMR range with open ends. */
export type MmrRange = { min: number | null; max: number | null };

export const NO_MMR_RANGE: MmrRange = { min: null, max: null };

/** The MMR histogram's bands, inclusive, open at both ends of the scale. */
export const POOL_MMR_BANDS: readonly (MmrRange & { label: string })[] = [
  { min: null, max: 1999, label: "Under 2,000" },
  { min: 2000, max: 2999, label: "2,000–2,999" },
  { min: 3000, max: 3999, label: "3,000–3,999" },
  { min: 4000, max: 4999, label: "4,000–4,999" },
  { min: 5000, max: null, label: "5,000+" },
];

/** Everything the /players filters can say. Sort is not a filter. */
export type PoolPageFilter = {
  /** Matches player names, and heroes they play (`heroesForPlayerSearch`). */
  query: string;
  /** Positions "1".."5"; a row matches when it lists ANY of them. Empty = all. */
  roles: readonly string[];
  status: PoolStatusFilter;
  captainOnly: boolean;
  mmr: MmrRange;
  history: PoolHistoryFilter;
  inhouseOnly: boolean;
  /** Only players with a Discord handle on file (offered only to viewers
   *  who may see handles: for anyone else every handle is blank). */
  discordOnly: boolean;
  /** Hide players whose pub snapshot says they have gone quiet. A player
   *  with no snapshot is unknown, never inactive, so they stay. */
  hideInactive: boolean;
};

export const EMPTY_POOL_FILTER: PoolPageFilter = {
  query: "",
  roles: [],
  status: "all",
  captainOnly: false,
  mmr: NO_MMR_RANGE,
  history: "any",
  inhouseOnly: false,
  discordOnly: false,
  hideInactive: false,
};

/** The facts the filters read that are not on PoolPlayer, worked out once
 *  per row (`poolRowFacts`) rather than per keystroke. */
export type PoolRowFacts = {
  standin: boolean;
  /** Played on a league team in an earlier season (`lastSeason`). */
  returning: boolean;
  inhouse: boolean;
  /** Their pub snapshot is fresh and says they have gone quiet. */
  inactive: boolean;
  /** Favorite heroes, recent pub heroes and all-time pub heroes. */
  heroIds: ReadonlySet<number>;
};

export function poolRowFacts(
  player: { userId: string; favoriteHeroes: string },
  scout: PoolScout | undefined,
  standinIds: ReadonlySet<string>,
  nowMs: number,
): PoolRowFacts {
  const heroIds = new Set<number>(
    parseHeroList(player.favoriteHeroes).matched.map((h) => h.id),
  );
  for (const h of scout?.pub?.scout?.heroes ?? []) heroIds.add(h.heroId);
  for (const h of scout?.pub?.topHeroes ?? []) heroIds.add(h.heroId);
  const activity = scout?.pub ? pubLastPlayed(scout.pub, nowMs) : null;
  return {
    standin: standinIds.has(player.userId),
    returning: !!scout?.lastSeason,
    inhouse: !!scout?.inhouse,
    inactive: !!activity?.quiet,
    heroIds,
  };
}

/** Each filter that can be left out to count its own options. */
type PoolFacet =
  | "query"
  | "roles"
  | "status"
  | "captain"
  | "mmr"
  | "history"
  | "inhouse"
  | "discord"
  | "inactive";

/** An unknown MMR (0) never falls inside a range: unknown is not low. */
export function mmrInRange(mmr: number, range: MmrRange): boolean {
  const { min, max } = normalizeMmrRange(range);
  if (min == null && max == null) return true;
  if (mmr <= 0) return false;
  return (min == null || mmr >= min) && (max == null || mmr <= max);
}

/** A reversed range ("4000 to 3000") still means the span between them. */
export function normalizeMmrRange(range: MmrRange): MmrRange {
  const { min, max } = range;
  return min != null && max != null && min > max
    ? { min: max, max: min }
    : range;
}

/** A typed MMR box: digits only, up to five; anything else is no bound. */
export function parseMmrInput(text: string): number | null {
  const digits = text.trim();
  return /^\d{1,5}$/.test(digits) ? Number(digits) : null;
}

/** `?mmr=3000-3500`, `3000-` (from) or `-3300` (up to). */
export function parseMmrRange(raw: string | null | undefined): MmrRange {
  const m = /^(\d{1,5})?-(\d{1,5})?$/.exec((raw ?? "").trim());
  if (!m || (!m[1] && !m[2])) return NO_MMR_RANGE;
  return normalizeMmrRange({
    min: m[1] ? Number(m[1]) : null,
    max: m[2] ? Number(m[2]) : null,
  });
}

function mmrRangeParam(range: MmrRange): string | null {
  const { min, max } = normalizeMmrRange(range);
  return min == null && max == null ? null : `${min ?? ""}-${max ?? ""}`;
}

/** "3,000–3,999", "From 3,000", "Up to 3,300". */
export function mmrRangeLabel(range: MmrRange): string | null {
  const { min, max } = normalizeMmrRange(range);
  const fmt = (n: number) => MMR_FORMAT.format(n);
  if (min != null && max != null) return `${fmt(min)}–${fmt(max)}`;
  if (min != null) return `From ${fmt(min)}`;
  if (max != null) return `Up to ${fmt(max)}`;
  return null;
}

const MMR_FORMAT = new Intl.NumberFormat("en-US");

/** Whether one row passes the filter, leaving out `skip` (to count that
 *  facet's own options). `heroIds` is the query's heroes, computed once. */
function poolRowMatches(
  row: FilterablePlayer & { discordName?: string },
  facts: PoolRowFacts,
  filter: PoolPageFilter,
  heroIds: ReadonlySet<number>,
  skip?: PoolFacet,
): boolean {
  const q = filter.query.trim().toLowerCase();
  if (skip !== "query" && q) {
    const byName = row.name.toLowerCase().includes(q);
    if (!byName && ![...heroIds].some((id) => facts.heroIds.has(id))) {
      return false;
    }
  }
  if (skip !== "roles" && filter.roles.length > 0) {
    const listed = parseRoles(row.roles);
    if (!filter.roles.some((r) => listed.includes(r))) return false;
  }
  if (skip !== "status" && filter.status !== "all") {
    // A standin is never rostered, so "drafted" and "free" are about full
    // players: a free agent is someone a captain can sign, and
    // signFreeAgent refuses standins.
    if (filter.status === "standin" && !facts.standin) return false;
    if (filter.status !== "standin" && facts.standin) return false;
    if (filter.status === "drafted" && !row.drafted) return false;
    if (filter.status === "free" && row.drafted) return false;
  }
  if (skip !== "captain" && filter.captainOnly && !row.wantsCaptain) {
    return false;
  }
  if (skip !== "mmr" && !mmrInRange(row.mmr, filter.mmr)) return false;
  if (skip !== "history" && filter.history !== "any") {
    if (facts.returning !== (filter.history === "returning")) return false;
  }
  if (skip !== "inhouse" && filter.inhouseOnly && !facts.inhouse) return false;
  if (skip !== "discord" && filter.discordOnly && !row.discordName) {
    return false;
  }
  if (skip !== "inactive" && filter.hideInactive && facts.inactive) {
    return false;
  }
  return true;
}

/** The rows the filter keeps, in their input order. Never mutates. */
export function filterPoolPage<T extends FilterablePlayer & { userId: string }>(
  rows: readonly T[],
  facts: ReadonlyMap<string, PoolRowFacts>,
  filter: PoolPageFilter,
  heroIds: ReadonlySet<number>,
): T[] {
  return rows.filter((r) => {
    const f = facts.get(r.userId);
    return !!f && poolRowMatches(r, f, filter, heroIds);
  });
}

/** How many rows each option would show, given every OTHER filter: the
 *  counts beside the chips and the MMR histogram's bars. */
export type PoolFacetCounts = {
  roles: Record<string, number>;
  mmrBands: number[];
  status: { player: number; standin: number; drafted: number; free: number };
  captain: number;
  history: { returning: number; new: number };
  inhouse: number;
  discord: number;
  /** Rows "Hide inactive" would take out. */
  inactive: number;
};

export function poolFacetCounts<
  T extends FilterablePlayer & { userId: string; discordName?: string },
>(
  rows: readonly T[],
  facts: ReadonlyMap<string, PoolRowFacts>,
  filter: PoolPageFilter,
  heroIds: ReadonlySet<number>,
): PoolFacetCounts {
  const without = (skip: PoolFacet) =>
    rows.flatMap((r) => {
      const f = facts.get(r.userId);
      return f && poolRowMatches(r, f, filter, heroIds, skip)
        ? [{ row: r, facts: f }]
        : [];
    });
  const roles: Record<string, number> = {};
  for (const key of ["1", "2", "3", "4", "5"]) roles[key] = 0;
  for (const { row } of without("roles")) {
    for (const key of parseRoles(row.roles)) roles[key] += 1;
  }
  const mmrRows = without("mmr");
  const status = without("status");
  const history = without("history");
  return {
    roles,
    mmrBands: POOL_MMR_BANDS.map(
      (band) => mmrRows.filter(({ row }) => mmrInRange(row.mmr, band)).length,
    ),
    status: {
      player: status.filter((x) => !x.facts.standin).length,
      standin: status.filter((x) => x.facts.standin).length,
      drafted: status.filter((x) => !x.facts.standin && x.row.drafted).length,
      free: status.filter((x) => !x.facts.standin && !x.row.drafted).length,
    },
    captain: without("captain").filter((x) => x.row.wantsCaptain).length,
    history: {
      returning: history.filter((x) => x.facts.returning).length,
      new: history.filter((x) => !x.facts.returning).length,
    },
    inhouse: without("inhouse").filter((x) => x.facts.inhouse).length,
    discord: without("discord").filter((x) => !!x.row.discordName).length,
    inactive: without("inactive").filter((x) => x.facts.inactive).length,
  };
}

/** True when anything narrows the list (sort never does). */
export function poolFilterActive(filter: PoolPageFilter): boolean {
  return (
    filter.query.trim() !== "" ||
    filter.roles.length > 0 ||
    filter.status !== "all" ||
    filter.captainOnly ||
    filter.mmr.min != null ||
    filter.mmr.max != null ||
    filter.history !== "any" ||
    filter.inhouseOnly ||
    filter.discordOnly ||
    filter.hideInactive
  );
}

/** How many of the Filters panel's own filters are on: the count on the
 *  button that opens it, where the panel is folded away. */
export function poolPanelFilterCount(filter: PoolPageFilter): number {
  return [
    filter.mmr.min != null || filter.mmr.max != null,
    filter.history !== "any",
    filter.inhouseOnly,
    filter.discordOnly,
    filter.hideInactive,
  ].filter(Boolean).length;
}

/** The /players sorts: the shared three, plus two the draft room never has. */
export type PoolPageSort = PoolSort | "inhouse" | "newest";

/**
 * Order the kept rows. MMR, medal and name go through the shared lib;
 * "inhouse" bands the MMR order by ladder record; "newest" puts the latest
 * signups first (ties keep the MMR order). Never mutates.
 */
export function sortPoolPage<T extends FilterablePlayer & { userId: string }>(
  rows: readonly T[],
  sort: PoolPageSort,
  ctx: { scout: PoolScoutInfo; signedUpAt: Readonly<Record<string, number>> },
): T[] {
  const base = filterAndSortPlayers([...rows], {
    sort: sort === "inhouse" || sort === "newest" ? "mmr" : sort,
  });
  if (sort === "inhouse") return sortByInhouseRecord(base, ctx.scout);
  if (sort === "newest") {
    return [...base].sort(
      (a, b) => (ctx.signedUpAt[b.userId] ?? 0) - (ctx.signedUpAt[a.userId] ?? 0),
    );
  }
  return base;
}

/** What /players can offer right now. A control renders only where it does
 *  something, and a stale link never filters by a control that isn't there. */
export type PoolFilterGates = {
  captainSelectionOpen: boolean;
  /** The draft has rostered someone, and the phase shows draft status. */
  draftStatus: boolean;
  anyStandin: boolean;
  anyInhouse: boolean;
  anyReturning: boolean;
  anyInactive: boolean;
  showContact: boolean;
};

const SORT_PARAMS: readonly PoolPageSort[] = [
  "mmr",
  "rank",
  "name",
  "inhouse",
  "newest",
];

/**
 * Read the filters and sort from the address bar, so a shared link (or a
 * trip to a profile and back) shows what the sender saw. Anything with no
 * control to show it degrades to its default rather than filtering
 * invisibly: `?status=standin` with no standins, `?cap=1` once captains are
 * chosen, `?sort=inhouse` with no ladder, and so on.
 */
export function readPoolParams(
  params: { get(name: string): string | null },
  gates: PoolFilterGates,
): { filter: PoolPageFilter; sort: PoolPageSort } {
  const status = params.get("status");
  const sortRaw = params.get("sort");
  const sort: PoolPageSort =
    sortRaw === "inhouse"
      ? gates.anyInhouse
        ? "inhouse"
        : "mmr"
      : SORT_PARAMS.includes(sortRaw as PoolPageSort)
        ? (sortRaw as PoolPageSort)
        : "mmr";
  const history = params.get("history");
  return {
    filter: {
      query: params.get("q") ?? "",
      roles: parseRoles(params.get("pos")),
      status:
        status === "standin" || status === "player"
          ? gates.anyStandin
            ? status
            : "all"
          : status === "drafted" || status === "free"
            ? gates.draftStatus
              ? status
              : "all"
            : "all",
      captainOnly: gates.captainSelectionOpen && params.get("cap") === "1",
      mmr: parseMmrRange(params.get("mmr")),
      history:
        gates.anyReturning && (history === "returning" || history === "new")
          ? history
          : "any",
      inhouseOnly: gates.anyInhouse && params.get("inhouse") === "1",
      discordOnly: gates.showContact && params.get("discord") === "1",
      hideInactive: gates.anyInactive && params.get("active") === "1",
    },
    sort,
  };
}

/** The address bar's query for a filter and sort; defaults are left out, so
 *  an unfiltered pool is a bare /players. */
export function poolParamsQuery(
  filter: PoolPageFilter,
  sort: PoolPageSort,
): string {
  const sp = new URLSearchParams();
  if (filter.query) sp.set("q", filter.query);
  if (filter.roles.length > 0) sp.set("pos", serializeRoles([...filter.roles]));
  if (sort !== "mmr") sp.set("sort", sort);
  if (filter.captainOnly) sp.set("cap", "1");
  if (filter.status !== "all") sp.set("status", filter.status);
  const mmr = mmrRangeParam(filter.mmr);
  if (mmr) sp.set("mmr", mmr);
  if (filter.history !== "any") sp.set("history", filter.history);
  if (filter.inhouseOnly) sp.set("inhouse", "1");
  if (filter.discordOnly) sp.set("discord", "1");
  if (filter.hideInactive) sp.set("active", "1");
  // "pos=4,5" reads better in a shared link than "pos=4%2C5", and a comma
  // is legal in a query; URLSearchParams reads it back either way.
  return sp.toString().replace(/%2C/gi, ",");
}

/** A row the search kept for a hero rather than its name: which heroes, and
 *  where each comes from, for the hint under the name. Empty when the name
 *  matched or the query names no hero. */
export function poolHeroMatches(
  player: { name: string; favoriteHeroes: string },
  scout: PoolScout | undefined,
  query: string,
  heroes: readonly { id: number; name: string }[],
): { heroId: number; text: string }[] {
  const q = query.trim().toLowerCase();
  if (!q || heroes.length === 0 || player.name.toLowerCase().includes(q)) {
    return [];
  }
  const favorites = new Set(
    parseHeroList(player.favoriteHeroes).matched.map((h) => h.id),
  );
  const recent = scout?.pub?.scout;
  const out: { heroId: number; text: string }[] = [];
  for (const hero of heroes) {
    const where: string[] = [];
    if (favorites.has(hero.id)) where.push("a favorite");
    const inWindow = recent?.heroes.find((h) => h.heroId === hero.id);
    if (inWindow && recent) {
      where.push(`${inWindow.games} of their last ${recent.games} pubs`);
    } else if (scout?.pub?.topHeroes.some((h) => h.heroId === hero.id)) {
      where.push("among their most played in pubs");
    }
    if (where.length > 0) {
      out.push({ heroId: hero.id, text: `${hero.name}: ${where.join(", ")}` });
    }
  }
  return out;
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
