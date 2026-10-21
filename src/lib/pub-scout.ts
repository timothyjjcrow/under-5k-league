// What a player's recent public games say about them, for the captains
// bidding on them: the role and lanes they play (set against their signup),
// the level of the games they play in, their recent heroes, form and habits
// (ranked or Turbo, solo or party, which servers, how often they leave
// early). Folded at fetch time from OpenDota's /players/{id}/matches rows
// (`summarizePubMatches`) and stored inside the pub snapshot as small counts,
// so a page never reads raw match rows. Pure and client-safe: the pool row
// and the profile both read it.
import {
  approxRankTierFromMmr,
  DIVINE_STAR_MMR,
  rankMedalName,
  rankMedalTier,
  rankStars,
  rankTierExactMinMmr,
  STAR_MMR,
} from "./rank";
import { DOTA_ROLES, parseRoles } from "./roles";

/** Bumped when the stored shape changes; an older snapshot reads as not yet
 *  known and is refreshed early (`PUB_SCOUT_MARKER` in pub-stats.ts). */
export const PUB_SCOUT_VERSION = 2;

/** A hero in the window: games, wins and summed kills, deaths and assists. */
export type PubHeroLine = {
  heroId: number;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
};

/** Averages over the games judged as one role. */
export type PubRoleAverages = {
  games: number;
  gpm: number;
  /** Last hits a minute, one decimal. */
  lastHitsPerMin: number;
  /** Kills, deaths and assists a game, one decimal each. */
  kills: number;
  deaths: number;
  assists: number;
};

/** The stored counts. Every read below is computed from these. */
export type PubScout = {
  v: typeof PUB_SCOUT_VERSION;
  /** Rows in the window: their last ≤100 public games of every mode. */
  games: number;
  /** Epoch SECONDS of the oldest and newest game in the window. */
  firstAt: number | null;
  lastAt: number | null;
  /** Ranked matchmaking (lobby 7) in a regular mode. */
  ranked: number;
  /** Normal (unranked) matchmaking in a regular mode. */
  unranked: number;
  /** Turbo (game mode 23). The rest of `games` is other modes and lobbies. */
  turbo: number;
  /** Results of their newest ≤20 matchmaking games. */
  recentWins: number;
  recentLosses: number;
  /** Their newest ≤10 matchmaking results, newest first: "WLLW…". */
  form: string;
  /** Matchmaking games of 10+ minutes judged core or support by last hits a
   *  minute; games in between count as neither. */
  core: number;
  support: number;
  coreAverages: PubRoleAverages | null;
  supportAverages: PubRoleAverages | null;
  /** Games at each position 1–5, from judged games whose lane OpenDota
   *  parsed: a core's lane names 1, 2 or 3, a support's 4 or 5. */
  positions: number[];
  /** Games with a known party size, and those played in a party. */
  partyKnown: number;
  party: number;
  /** Games they left early (OpenDota leaver status 2 or more). */
  abandons: number;
  /** Mean lobby MMR (each game's average medal, as MMR) over `lobbyGames`
   *  games: ranked games when there are enough, else every matchmaking game
   *  (`lobbyRanked` says which). Null when none carried an average medal. */
  lobbyMmr: number | null;
  lobbyGames: number;
  lobbyRanked: boolean;
  /** Server regions by matchmaking games, most first, at most 3. */
  regions: { region: number; games: number }[];
  regionGames: number;
  /** Their most-played heroes in the window, most first, at most 8. */
  heroes: PubHeroLine[];
  /** Different heroes played in the window. */
  heroCount: number;
};

/** The `project` fields the fetch asks for, so the payload stays small. */
export const PUB_MATCH_FIELDS = [
  "hero_id",
  "player_slot",
  "radiant_win",
  "kills",
  "deaths",
  "assists",
  "gold_per_min",
  "last_hits",
  "duration",
  "game_mode",
  "lobby_type",
  "party_size",
  "average_rank",
  "cluster",
  "leaver_status",
  "start_time",
  "lane_role",
  "is_roaming",
] as const;

const TURBO_MODE = 23;
const RANKED_LOBBY = 7;
const NORMAL_LOBBY = 0;
/** All Pick, Captains Mode, Random Draft, Single Draft, All Random, Captains
 *  Draft, Ranked All Pick: the modes whose laning and farm read like a league
 *  game. Ability Draft, events and custom games are none of them. */
const REGULAR_MODES = new Set([1, 2, 3, 4, 5, 16, 22]);
/** Shorter games are abandons and stomps: their last hits say nothing. */
const MIN_JUDGED_SECONDS = 10 * 60;
/** Last hits a minute at or above which a game was played as a core, and
 *  below which as a support. A carry farms 6+, a mid 5+, an offlaner 4+, a
 *  soft support 1–3 and a hard support 0.5–2; between the two is neither. */
export const CORE_LH_PER_MIN = 3.5;
export const SUPPORT_LH_PER_MIN = 2.5;
const RECENT_GAMES = 20;
const FORM_GAMES = 10;
const TOP_HEROES = 8;

/** One row of OpenDota's /players/{id}/matches, read field by field: the
 *  provider's shapes drift, and one bad row must never sink the snapshot. */
type PubMatchRow = {
  heroId: number | null;
  won: boolean | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  gpm: number | null;
  lastHits: number | null;
  duration: number | null;
  gameMode: number | null;
  lobbyType: number | null;
  partySize: number | null;
  averageRank: number | null;
  cluster: number | null;
  leaverStatus: number | null;
  startTime: number | null;
  laneRole: number | null;
  roaming: boolean;
};

const field = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function toRow(raw: unknown): PubMatchRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  const slot = field(d.player_slot);
  return {
    heroId: field(d.hero_id),
    won:
      slot != null && typeof d.radiant_win === "boolean"
        ? slot < 128 === d.radiant_win
        : null,
    kills: field(d.kills),
    deaths: field(d.deaths),
    assists: field(d.assists),
    gpm: field(d.gold_per_min),
    lastHits: field(d.last_hits),
    duration: field(d.duration),
    gameMode: field(d.game_mode),
    lobbyType: field(d.lobby_type),
    partySize: field(d.party_size),
    averageRank: field(d.average_rank),
    cluster: field(d.cluster),
    leaverStatus: field(d.leaver_status),
    startTime: field(d.start_time),
    laneRole: field(d.lane_role),
    roaming: d.is_roaming === true,
  };
}

function isMatchmaking(row: PubMatchRow): boolean {
  return (
    (row.lobbyType === RANKED_LOBBY || row.lobbyType === NORMAL_LOBBY) &&
    row.gameMode != null &&
    REGULAR_MODES.has(row.gameMode)
  );
}

/**
 * Valve's server clusters are numbered by region in tens (111–118 US West,
 * 121–129 US East, 131–138 Europe West…), so a cluster maps through its
 * tens. A cluster outside every known decade is unknown and never counted.
 * Region ids are OpenDota's (`/constants/region`), the ids
 * `LEAGUE_CONFIG.gameServerRegionId` uses.
 */
const REGION_BY_CLUSTER_DECADE: Record<number, number> = {
  11: 1,
  12: 2,
  13: 3,
  14: 19,
  15: 5,
  16: 6,
  17: 7,
  18: 8,
  19: 9,
  20: 10,
  21: 11,
  22: 12,
  23: 13,
  24: 14,
  25: 15,
  26: 16,
  27: 3,
  34: 38,
};

const REGION_NAMES: Record<number, string> = {
  1: "US West",
  2: "US East",
  3: "Europe West",
  5: "SE Asia",
  6: "Dubai",
  7: "Australia",
  8: "Stockholm",
  9: "Europe East",
  10: "South America",
  11: "South Africa",
  12: "China",
  13: "China",
  14: "Chile",
  15: "Peru",
  16: "India",
  19: "Japan",
  38: "Argentina",
};

/** The regions a league's players reach with a good ping. */
const HOME_REGIONS: Record<"us" | "eu", ReadonlySet<number>> = {
  us: new Set([1, 2]),
  eu: new Set([3, 8, 9]),
};

export function regionForCluster(
  cluster: number | null | undefined,
): number | null {
  if (typeof cluster !== "number" || !Number.isInteger(cluster)) return null;
  return REGION_BY_CLUSTER_DECADE[Math.floor(cluster / 10)] ?? null;
}

export function regionName(region: number): string {
  return REGION_NAMES[region] ?? "Other";
}

/** The middle of a medal's star band as MMR (Immortal: its floor plus half a
 *  Divine star), or null for no medal. */
export function medalMidMmr(
  rankTier: number | null | undefined,
): number | null {
  const floor = rankTierExactMinMmr(rankTier);
  if (floor == null) return null;
  const medal = rankMedalTier(rankTier);
  if (medal === 8 || !rankStars(rankTier)) return floor + DIVINE_STAR_MMR / 2;
  return floor + (medal === 7 ? DIVINE_STAR_MMR : STAR_MMR) / 2;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function roleAverages(rows: PubMatchRow[]): PubRoleAverages | null {
  if (rows.length === 0) return null;
  const mean = (pick: (r: PubMatchRow) => number | null) => {
    const values = rows.map(pick).filter((v): v is number => v != null);
    return values.length
      ? values.reduce((s, v) => s + v, 0) / values.length
      : 0;
  };
  return {
    games: rows.length,
    gpm: Math.round(mean((r) => r.gpm)),
    lastHitsPerMin: round1(
      mean((r) =>
        r.lastHits != null && r.duration
          ? r.lastHits / (r.duration / 60)
          : null,
      ),
    ),
    kills: round1(mean((r) => r.kills)),
    deaths: round1(mean((r) => r.deaths)),
    assists: round1(mean((r) => r.assists)),
  };
}

/** Which position a judged game with a parsed lane was, or null. */
function positionOf(row: PubMatchRow, role: "core" | "support"): number | null {
  if (role === "core") {
    return row.laneRole === 1 || row.laneRole === 2 || row.laneRole === 3
      ? row.laneRole
      : null;
  }
  // A support lanes with a core: the safe lane's is the hard support (5),
  // the offlane's or a roamer the soft support (4).
  if (row.roaming || row.laneRole === 3 || row.laneRole === 2) return 4;
  if (row.laneRole === 1) return 5;
  return null;
}

/** Fold OpenDota match rows (newest first, every mode) into the counts.
 *  `games` counts every row OpenDota sent; a row that isn't an object counts
 *  toward it and nothing else. */
export function summarizePubMatches(raw: readonly unknown[]): PubScout {
  const rows = raw.map(toRow).filter((r): r is PubMatchRow => r !== null);
  const matchmaking = rows.filter(isMatchmaking);
  const times = rows
    .map((r) => r.startTime)
    .filter((t): t is number => t != null && t > 0);

  const coreRows: PubMatchRow[] = [];
  const supportRows: PubMatchRow[] = [];
  const positions = [0, 0, 0, 0, 0];
  for (const row of matchmaking) {
    const seconds = row.duration ?? 0;
    if (seconds < MIN_JUDGED_SECONDS || row.lastHits == null) continue;
    const perMin = row.lastHits / (seconds / 60);
    const role =
      perMin >= CORE_LH_PER_MIN
        ? "core"
        : perMin < SUPPORT_LH_PER_MIN
          ? "support"
          : null;
    if (!role) continue;
    (role === "core" ? coreRows : supportRows).push(row);
    const position = positionOf(row, role);
    if (position) positions[position - 1]++;
  }

  const decided = matchmaking.filter((r) => r.won != null);
  const recent = decided.slice(0, RECENT_GAMES);

  const rankedLobbies = matchmaking.filter(
    (r) => r.lobbyType === RANKED_LOBBY && medalMidMmr(r.averageRank) != null,
  );
  const allLobbies = matchmaking.filter(
    (r) => medalMidMmr(r.averageRank) != null,
  );
  const lobbyRanked = rankedLobbies.length >= PUB_READ_MIN_GAMES;
  const lobbies = lobbyRanked ? rankedLobbies : allLobbies;

  const regionCounts = new Map<number, number>();
  let regionGames = 0;
  for (const row of matchmaking) {
    const region = regionForCluster(row.cluster);
    if (region == null) continue;
    regionGames++;
    regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
  }

  const heroLines = new Map<number, PubHeroLine>();
  for (const row of rows) {
    if (!row.heroId || row.heroId <= 0) continue;
    if (
      row.gameMode == null ||
      !(REGULAR_MODES.has(row.gameMode) || row.gameMode === TURBO_MODE)
    ) {
      continue;
    }
    const line = heroLines.get(row.heroId) ?? {
      heroId: row.heroId,
      games: 0,
      wins: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
    };
    line.games++;
    if (row.won) line.wins++;
    line.kills += row.kills ?? 0;
    line.deaths += row.deaths ?? 0;
    line.assists += row.assists ?? 0;
    heroLines.set(row.heroId, line);
  }

  const partyRows = rows.filter((r) => r.partySize != null && r.partySize > 0);

  return {
    v: PUB_SCOUT_VERSION,
    games: raw.length,
    firstAt: times.length ? Math.min(...times) : null,
    lastAt: times.length ? Math.max(...times) : null,
    ranked: matchmaking.filter((r) => r.lobbyType === RANKED_LOBBY).length,
    unranked: matchmaking.filter((r) => r.lobbyType === NORMAL_LOBBY).length,
    turbo: rows.filter((r) => r.gameMode === TURBO_MODE).length,
    recentWins: recent.filter((r) => r.won).length,
    recentLosses: recent.filter((r) => r.won === false).length,
    form: decided
      .slice(0, FORM_GAMES)
      .map((r) => (r.won ? "W" : "L"))
      .join(""),
    core: coreRows.length,
    support: supportRows.length,
    coreAverages: roleAverages(coreRows),
    supportAverages: roleAverages(supportRows),
    positions,
    partyKnown: partyRows.length,
    party: partyRows.filter((r) => (r.partySize ?? 0) > 1).length,
    abandons: rows.filter((r) => (r.leaverStatus ?? 0) >= 2).length,
    lobbyMmr: lobbies.length
      ? Math.round(
          lobbies.reduce((s, r) => s + (medalMidMmr(r.averageRank) ?? 0), 0) /
            lobbies.length,
        )
      : null,
    lobbyGames: lobbies.length,
    lobbyRanked,
    regions: [...regionCounts]
      .map(([region, games]) => ({ region, games }))
      .sort((a, b) => b.games - a.games || a.region - b.region)
      .slice(0, 3),
    regionGames,
    heroes: [...heroLines.values()]
      .sort(
        (a, b) => b.games - a.games || b.wins - a.wins || a.heroId - b.heroId,
      )
      .slice(0, TOP_HEROES),
    heroCount: heroLines.size,
  };
}

// --- Parsing -----------------------------------------------------------------

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
const decimal = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? round1(v) : 0;

function parseAverages(raw: unknown): PubRoleAverages | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  const games = count(d.games);
  if (games === 0) return null;
  return {
    games,
    gpm: count(d.gpm),
    lastHitsPerMin: decimal(d.lastHitsPerMin),
    kills: decimal(d.kills),
    deaths: decimal(d.deaths),
    assists: decimal(d.assists),
  };
}

/** Parse the stored counts. Null for a missing, malformed or older-version
 *  blob, so a snapshot from before this shape reads as "not yet known". */
export function parsePubScout(raw: unknown): PubScout | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (d.v !== PUB_SCOUT_VERSION || typeof d.games !== "number") return null;
  const lobbyMmr =
    typeof d.lobbyMmr === "number" &&
    Number.isFinite(d.lobbyMmr) &&
    d.lobbyMmr > 0
      ? Math.round(d.lobbyMmr)
      : null;
  const time = (v: unknown) => (count(v) > 0 ? count(v) : null);
  const positions = Array.isArray(d.positions)
    ? [0, 1, 2, 3, 4].map((i) => count((d.positions as unknown[])[i]))
    : [0, 0, 0, 0, 0];
  const regions = Array.isArray(d.regions)
    ? d.regions
        .map((r) => {
          const rec = r as Record<string, unknown>;
          const region = count(rec?.region);
          const games = count(rec?.games);
          return region > 0 && games > 0 ? { region, games } : null;
        })
        .filter((r): r is { region: number; games: number } => r !== null)
        .slice(0, 3)
    : [];
  const heroes = Array.isArray(d.heroes)
    ? d.heroes
        .map((h) => {
          const rec = h as Record<string, unknown>;
          const heroId = count(rec?.heroId);
          const games = count(rec?.games);
          return heroId > 0 && games > 0
            ? {
                heroId,
                games,
                wins: Math.min(games, count(rec?.wins)),
                kills: count(rec?.kills),
                deaths: count(rec?.deaths),
                assists: count(rec?.assists),
              }
            : null;
        })
        .filter((h): h is PubHeroLine => h !== null)
        .slice(0, TOP_HEROES)
    : [];
  const form =
    typeof d.form === "string"
      ? d.form.replace(/[^WL]/g, "").slice(0, FORM_GAMES)
      : "";
  return {
    v: PUB_SCOUT_VERSION,
    games: count(d.games),
    firstAt: time(d.firstAt),
    lastAt: time(d.lastAt),
    ranked: count(d.ranked),
    unranked: count(d.unranked),
    turbo: count(d.turbo),
    recentWins: count(d.recentWins),
    recentLosses: count(d.recentLosses),
    form,
    core: count(d.core),
    support: count(d.support),
    coreAverages: parseAverages(d.coreAverages),
    supportAverages: parseAverages(d.supportAverages),
    positions,
    partyKnown: count(d.partyKnown),
    party: Math.min(count(d.party), count(d.partyKnown)),
    abandons: count(d.abandons),
    lobbyMmr,
    lobbyGames: lobbyMmr == null ? 0 : count(d.lobbyGames),
    lobbyRanked: d.lobbyRanked === true,
    regions,
    regionGames: count(d.regionGames),
    heroes,
    heroCount: Math.max(count(d.heroCount), heroes.length),
  };
}

// --- Reads -------------------------------------------------------------------
// Each read needs enough games to mean something and returns null below it,
// so a thin window renders nothing rather than a confident-looking share.

/** Games a share needs before it is shown. */
export const PUB_READ_MIN_GAMES = 10;
/** Positions need fewer: only about a fifth of pubs have a parsed lane. */
export const PUB_POSITION_MIN_GAMES = 5;

const groupedNumber = new Intl.NumberFormat("en-US");
const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

export type RoleLean = "core" | "support" | "both";

export type PubRoleRead = {
  lean: RoleLean;
  core: number;
  support: number;
  /** Share (0–100) of judged games on the side it leans; for "both", the
   *  support share. */
  percent: number;
};

/** A side needs this share of judged games to be what they "mostly" play. */
const LEAN_SHARE = 0.7;

export function pubRoleRead(scout: PubScout): PubRoleRead | null {
  const judged = scout.core + scout.support;
  if (judged < PUB_READ_MIN_GAMES) return null;
  const supportShare = scout.support / judged;
  const base = { core: scout.core, support: scout.support };
  if (supportShare >= LEAN_SHARE) {
    return { ...base, lean: "support", percent: pct(scout.support, judged) };
  }
  if (1 - supportShare >= LEAN_SHARE) {
    return { ...base, lean: "core", percent: pct(scout.core, judged) };
  }
  return { ...base, lean: "both", percent: pct(scout.support, judged) };
}

/** Positions 1–5 with games, most first; null below the minimum. */
export function pubPositionRead(
  scout: PubScout,
): { position: number; games: number }[] | null {
  const total = scout.positions.reduce((s, n) => s + n, 0);
  if (total < PUB_POSITION_MIN_GAMES) return null;
  return scout.positions
    .map((games, i) => ({ position: i + 1, games }))
    .filter((p) => p.games > 0)
    .sort((a, b) => b.games - a.games || a.position - b.position);
}

/** Which side the positions on a signup claim: 1–3 core, 4–5 support. */
export function claimedRoleLean(roleKeys: readonly string[]): RoleLean | null {
  const cores = roleKeys.filter((k) => k === "1" || k === "2" || k === "3");
  const supports = roleKeys.filter((k) => k === "4" || k === "5");
  if (cores.length === 0 && supports.length === 0) return null;
  if (supports.length === 0) return "core";
  if (cores.length === 0) return "support";
  return "both";
}

/** True when the signup claims only one side and their pubs mostly show the
 *  other: worth a captain's second look, never a verdict. */
export function roleClaimDiffers(
  claimed: RoleLean | null,
  played: PubRoleRead | null,
): boolean {
  if (!claimed || !played || claimed === "both" || played.lean === "both") {
    return false;
  }
  return claimed !== played.lean;
}

export type PubLobbyRead = {
  /** Rounded to the nearest 50: a mean of medals is no finer than that. */
  mmr: number;
  /** The medal that MMR sits in. */
  rankTier: number;
  games: number;
  /** True when it averages ranked games only. */
  ranked: boolean;
};

export function pubLobbyRead(scout: PubScout): PubLobbyRead | null {
  if (scout.lobbyMmr == null || scout.lobbyGames < PUB_READ_MIN_GAMES) {
    return null;
  }
  const mmr = Math.round(scout.lobbyMmr / 50) * 50;
  return {
    mmr,
    rankTier: approxRankTierFromMmr(mmr),
    games: scout.lobbyGames,
    ranked: scout.lobbyRanked,
  };
}

export type PubModeShare = {
  key: "ranked" | "unranked" | "turbo" | "other";
  label: string;
  games: number;
  percent: number;
};

/** Every mode bucket with games, largest first (ties in ladder order). */
export function pubModeRead(scout: PubScout): PubModeShare[] | null {
  if (scout.games < PUB_READ_MIN_GAMES) return null;
  const other = Math.max(
    0,
    scout.games - scout.ranked - scout.unranked - scout.turbo,
  );
  const buckets: Omit<PubModeShare, "percent">[] = [
    { key: "ranked", label: "ranked", games: scout.ranked },
    { key: "unranked", label: "unranked", games: scout.unranked },
    { key: "turbo", label: "Turbo", games: scout.turbo },
    { key: "other", label: "other modes", games: other },
  ];
  return buckets
    .filter((b) => b.games > 0)
    .map((b) => ({ ...b, percent: pct(b.games, scout.games) }))
    .sort((a, b) => b.games - a.games);
}

export type PubRegionShare = {
  region: number;
  name: string;
  percent: number;
};

/** Their main server region, plus any other with at least a fifth of games. */
export function pubRegionRead(scout: PubScout): PubRegionShare[] | null {
  if (scout.regionGames < PUB_READ_MIN_GAMES || scout.regions.length === 0) {
    return null;
  }
  return scout.regions
    .map((r) => ({
      region: r.region,
      name: regionName(r.region),
      percent: pct(r.games, scout.regionGames),
    }))
    .filter((r, i) => i === 0 || r.percent >= 20);
}

/** Recent heroes in the hero pool's shape, with a KDA ratio. */
export function pubHeroRows(scout: PubScout) {
  return scout.heroes.map((h) => ({
    heroId: h.heroId,
    games: h.games,
    wins: h.wins,
    kda: round1((h.kills + h.assists) / Math.max(1, h.deaths)),
  }));
}

/** True when any read has enough games to show. */
export function pubScoutHasReads(scout: PubScout | null | undefined): boolean {
  if (!scout) return false;
  return (
    pubRoleRead(scout) != null ||
    pubLobbyRead(scout) != null ||
    pubModeRead(scout) != null ||
    pubRegionRead(scout) != null ||
    scout.heroes.length > 0
  );
}

// --- The scouting report ------------------------------------------------------
// Plain sentences a captain can read at a glance, each with a tone: "good"
// agrees with what the signup says, "warn" is worth a second look, "info"
// is context. Shared by the profile's report and the pool row's hover.

export type ScoutTone = "good" | "warn" | "info";

export type ScoutFact = {
  key:
    | "role"
    | "positions"
    | "level"
    | "modes"
    | "queue"
    | "server"
    | "form"
    | "activity"
    | "leaves";
  label: string;
  /** The finding, one short phrase. */
  lead: string;
  /** What it rests on, or what it is set against. */
  detail: string | null;
  tone: ScoutTone;
};

export type ScoutContext = {
  /** The signup's stored roles string. */
  roles: string | null | undefined;
  /** The signup's MMR; 0 or null when none. */
  signupMmr: number | null | undefined;
  /** Their medal (`rank_tier`), or null. */
  rankTier: number | null | undefined;
  /** The league whose servers count as home. */
  league: "us" | "eu";
};

/** Lobbies this far from the signup MMR are worth naming. */
export const LOBBY_GAP_MMR = 500;
/** Turbo this share of the window or more: the other numbers rest on few
 *  real games. */
const TURBO_WARN_PERCENT = 30;
/** Leaving this many of the window early is worth naming. */
const ABANDON_WARN = 2;

const positionName = (p: number) => DOTA_ROLES[p - 1]?.short ?? `Pos ${p}`;

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** How often they play over the window, as a pace: "About 3 games a day",
 *  "About 4 games a week". A pace, never a total. */
function activityPhrase(scout: PubScout): string | null {
  if (scout.firstAt == null || scout.lastAt == null || scout.games < 2) {
    return null;
  }
  const days = Math.max(1, (scout.lastAt - scout.firstAt) / 86_400);
  const perDay = scout.games / days;
  if (perDay >= 1.5) return `About ${Math.round(perDay)} games a day`;
  if (perDay >= 0.8) return "About a game a day";
  const perWeek = Math.round(perDay * 7);
  return perWeek >= 2
    ? `About ${perWeek} games a week`
    : "About a game a week or less";
}

export function scoutingFacts(scout: PubScout, ctx: ScoutContext): ScoutFact[] {
  const facts: ScoutFact[] = [];
  const claimed = parseRoles(ctx.roles);
  const role = pubRoleRead(scout);
  if (role) {
    const judged = role.core + role.support;
    const lead =
      role.lean === "both"
        ? `Core in ${role.core}, support in ${role.support} of ${judged} games`
        : role.lean === "core"
          ? `Core in ${role.core} of ${judged} games`
          : `Support in ${role.support} of ${judged} games`;
    const claim = claimedRoleLean(claimed);
    const differs = roleClaimDiffers(claim, role);
    const claimText = claimed.length
      ? `Signed up for ${joinNames(claimed.map((k) => positionName(Number(k))))}`
      : null;
    facts.push({
      key: "role",
      label: "Role",
      lead,
      detail: claimText
        ? differs
          ? `${claimText}: the other side`
          : claim && role.lean !== "both" && claim === role.lean
            ? `${claimText}: matches`
            : claimText
        : null,
      tone: differs ? "warn" : claim && claim === role.lean ? "good" : "info",
    });
  }
  const positions = pubPositionRead(scout);
  if (positions) {
    const total = positions.reduce((s, p) => s + p.games, 0);
    const [top] = positions;
    facts.push({
      key: "positions",
      label: "Lanes",
      lead:
        top.games === total
          ? `${positionName(top.position)} in all ${total} games with a known lane`
          : `Mostly ${positionName(top.position)}: ${top.games} of ${total} games with a known lane`,
      detail:
        positions.length > 1
          ? positions
              .map((p) => `${positionName(p.position)} ×${p.games}`)
              .join(" · ")
          : null,
      tone: "info",
    });
  }
  const lobby = pubLobbyRead(scout);
  if (lobby) {
    const basis = lobby.ranked
      ? `average medal of their last ${lobby.games} ranked games`
      : `average medal of their last ${lobby.games} games`;
    const signup = ctx.signupMmr && ctx.signupMmr > 0 ? ctx.signupMmr : null;
    const gap = signup != null ? lobby.mmr - signup : 0;
    const medal = medalMidMmr(ctx.rankTier);
    const staleMedal = medal != null && lobby.mmr - medal >= 770;
    let detail = basis;
    let tone: ScoutTone = "info";
    if (signup != null && Math.abs(gap) >= LOBBY_GAP_MMR) {
      detail = `${basis}; about ${groupedNumber.format(Math.abs(Math.round(gap / 50) * 50))} ${gap > 0 ? "above" : "below"} their ${groupedNumber.format(signup)} signup MMR`;
      tone = "warn";
    } else if (signup != null) {
      detail = `${basis}; close to their ${groupedNumber.format(signup)} signup MMR`;
      tone = "good";
    }
    if (staleMedal) {
      detail = `${detail}. Well above their ${rankMedalName(ctx.rankTier)} medal, which may be out of date`;
      tone = "warn";
    }
    facts.push({
      key: "level",
      label: "Plays at",
      lead: `${rankMedalName(lobby.rankTier)} games (≈${groupedNumber.format(lobby.mmr)})`,
      detail,
      tone,
    });
  }
  const modes = pubModeRead(scout);
  if (modes && modes.length > 0) {
    const [top] = modes;
    const turbo = modes.find((m) => m.key === "turbo");
    facts.push({
      key: "modes",
      label: "Modes",
      lead:
        top.percent >= 60
          ? `Mostly ${top.label} (${top.percent}%)`
          : modes
              .slice(0, 2)
              .map((m) => `${m.percent}% ${m.label}`)
              .join(", "),
      detail: modes.map((m) => `${m.games} ${m.label}`).join(" · "),
      tone: turbo && turbo.percent >= TURBO_WARN_PERCENT ? "warn" : "info",
    });
  }
  if (scout.partyKnown >= PUB_READ_MIN_GAMES) {
    const share = pct(scout.party, scout.partyKnown);
    facts.push({
      key: "queue",
      label: "Queues",
      lead:
        share <= 20
          ? "Solo"
          : share >= 60
            ? "With a party"
            : "Solo and with a party",
      detail: `in a party for ${scout.party} of ${scout.partyKnown} games`,
      tone: "info",
    });
  }
  const regions = pubRegionRead(scout);
  if (regions) {
    const [main] = regions;
    const home = HOME_REGIONS[ctx.league];
    const away = !home.has(main.region);
    facts.push({
      key: "server",
      label: "Server",
      lead: `${main.name} (${main.percent}%)`,
      detail:
        [
          regions.length > 1
            ? `also ${regions
                .slice(1)
                .map((r) => `${r.name} ${r.percent}%`)
                .join(", ")}`
            : null,
          away ? "far from the league's servers: ask about ping" : null,
        ]
          .filter(Boolean)
          .join("; ") || null,
      tone: away ? "warn" : "info",
    });
  }
  const decided = scout.recentWins + scout.recentLosses;
  if (decided >= PUB_READ_MIN_GAMES) {
    facts.push({
      key: "form",
      label: "Form",
      lead: `Won ${scout.recentWins} of their last ${decided}`,
      detail: null,
      tone: "info",
    });
  }
  const activity = activityPhrase(scout);
  if (activity && scout.games >= PUB_READ_MIN_GAMES) {
    facts.push({
      key: "activity",
      label: "Activity",
      lead: activity,
      detail: `${scout.games} games in ${Math.max(1, Math.round(((scout.lastAt ?? 0) - (scout.firstAt ?? 0)) / 86_400))} days`,
      tone: "info",
    });
  }
  if (scout.abandons >= ABANDON_WARN) {
    facts.push({
      key: "leaves",
      label: "Left early",
      lead: `${scout.abandons} of their last ${scout.games} games`,
      detail: "abandoned or disconnected for good",
      tone: "warn",
    });
  }
  return facts;
}

/** One fact of the pool row's short line; `warn` tints it. */
export type ScoutPart = { key: string; text: string; warn: boolean };

/**
 * The pool row's line: "plays Pos 3 · in Ancient 5 games · solo · US East", each
 * fact once it has enough games. The role names a position when lanes
 * settle one, else core or support with its share. Turbo joins when it is a
 * big share, early leaves when there are two or more; what is worth a
 * second look is tinted.
 */
export function scoutingRowParts(
  scout: PubScout,
  ctx: ScoutContext,
): ScoutPart[] {
  const facts = new Map(scoutingFacts(scout, ctx).map((f) => [f.key, f]));
  const parts: ScoutPart[] = [];
  const role = pubRoleRead(scout);
  const positions = pubPositionRead(scout);
  if (role) {
    const total = positions?.reduce((s, p) => s + p.games, 0) ?? 0;
    const top = positions?.[0];
    const text =
      top && top.games / total >= 0.6
        ? `plays ${positionName(top.position)}`
        : role.lean === "both"
          ? "plays core & support"
          : `plays ${role.lean} (${role.percent}%)`;
    parts.push({ key: "role", text, warn: facts.get("role")?.tone === "warn" });
  }
  const lobby = pubLobbyRead(scout);
  if (lobby) {
    parts.push({
      key: "level",
      text: `in ${rankMedalName(lobby.rankTier)} games`,
      warn: facts.get("level")?.tone === "warn",
    });
  }
  const queue = facts.get("queue");
  if (queue && queue.lead !== "Solo and with a party") {
    parts.push({
      key: "queue",
      text: queue.lead === "Solo" ? "solo" : "party",
      warn: false,
    });
  }
  const turbo = pubModeRead(scout)?.find((m) => m.key === "turbo");
  if (turbo && turbo.percent >= TURBO_WARN_PERCENT) {
    parts.push({ key: "turbo", text: `${turbo.percent}% Turbo`, warn: true });
  }
  const server = facts.get("server");
  const regions = pubRegionRead(scout);
  if (server && regions) {
    parts.push({
      key: "server",
      text: regions[0].name,
      warn: server.tone === "warn",
    });
  }
  if (facts.has("leaves")) {
    parts.push({
      key: "leaves",
      text: `left ${scout.abandons} early`,
      warn: true,
    });
  }
  return parts;
}

/** The row's hover: every fact as a sentence. */
export function scoutingTitle(scout: PubScout, ctx: ScoutContext): string {
  return [
    `Their last ${scout.games} public games`,
    ...scoutingFacts(scout, ctx).map(
      (f) => `${f.label}: ${f.lead}${f.detail ? ` (${f.detail})` : ""}`,
    ),
  ].join("\n");
}
