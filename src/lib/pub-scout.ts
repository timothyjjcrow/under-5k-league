// What a player's recent public games say about how they play: the role they
// fill (core or support, by last hits a minute), the level of the lobbies
// they play in, how much of it is ranked or Turbo, and which servers they
// play on. Folded at fetch time from OpenDota's /players/{id}/matches rows
// (`summarizePubMatches`) and stored inside the pub snapshot as small counts,
// so a page never reads raw match rows. Pure and client-safe: the pool row
// and the profile both read it.
import {
  approxRankTierFromMmr,
  DIVINE_STAR_MMR,
  rankMedalTier,
  rankStars,
  rankTierExactMinMmr,
  STAR_MMR,
} from "./rank";

/** The stored counts. Every share is read from these by the functions below. */
export type PubScout = {
  /** Rows in the window: their last ≤100 public games of every mode. */
  games: number;
  /** Ranked matchmaking (lobby 7). */
  ranked: number;
  /** Normal (unranked) matchmaking in a regular mode. */
  unranked: number;
  /** Turbo (game mode 23). The rest of `games` is other modes and lobbies. */
  turbo: number;
  /** Matchmaking games of 10+ minutes judged core or support by last hits a
   *  minute; games in between count as neither. */
  core: number;
  support: number;
  /** Mean lobby MMR (each game's average medal, as MMR) over `lobbyGames`
   *  matchmaking games, or null when none carried an average medal. */
  lobbyMmr: number | null;
  lobbyGames: number;
  /** Server regions by matchmaking games, most first, at most 3. */
  regions: { region: number; games: number }[];
  /** Matchmaking games whose server maps to a known region. */
  regionGames: number;
};

/** One row of OpenDota's /players/{id}/matches, read field by field
 *  (`toRow`): the provider's shapes drift, and one bad row must never sink
 *  the snapshot. */
type PubMatchRow = {
  game_mode: number | null;
  lobby_type: number | null;
  duration: number | null;
  last_hits: number | null;
  average_rank: number | null;
  cluster: number | null;
};

const field = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function toRow(raw: unknown): PubMatchRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  return {
    game_mode: field(d.game_mode),
    lobby_type: field(d.lobby_type),
    duration: field(d.duration),
    last_hits: field(d.last_hits),
    average_rank: field(d.average_rank),
    cluster: field(d.cluster),
  };
}

/** The `project` fields the fetch asks for, so the payload stays small. */
export const PUB_MATCH_FIELDS = [
  "game_mode",
  "lobby_type",
  "duration",
  "last_hits",
  "average_rank",
  "cluster",
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

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;

function isMatchmaking(row: PubMatchRow): boolean {
  return (
    (row.lobby_type === RANKED_LOBBY || row.lobby_type === NORMAL_LOBBY) &&
    row.game_mode != null &&
    REGULAR_MODES.has(row.game_mode)
  );
}

/**
 * Valve's server clusters are numbered by region in tens (111–118 US West,
 * 121–129 US East, 131–138 Europe West…), so a cluster maps through its
 * tens. A cluster outside every known decade is unknown and never counted.
 * Region ids are OpenDota's (`/constants/region`).
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
function medalMidMmr(rankTier: number): number | null {
  const floor = rankTierExactMinMmr(rankTier);
  if (floor == null) return null;
  const medal = rankMedalTier(rankTier);
  if (medal === 8 || !rankStars(rankTier)) return floor + DIVINE_STAR_MMR / 2;
  return floor + (medal === 7 ? DIVINE_STAR_MMR : STAR_MMR) / 2;
}

/** Fold OpenDota match rows (newest first, every mode) into the counts.
 *  `games` counts every row OpenDota sent; a row that isn't an object counts
 *  toward it and nothing else. */
export function summarizePubMatches(raw: readonly unknown[]): PubScout {
  const rows = raw.map(toRow).filter((r): r is PubMatchRow => r !== null);
  let ranked = 0;
  let unranked = 0;
  let turbo = 0;
  let core = 0;
  let support = 0;
  let lobbySum = 0;
  let lobbyGames = 0;
  let regionGames = 0;
  const regionCounts = new Map<number, number>();
  for (const row of rows) {
    if (row.game_mode === TURBO_MODE) turbo++;
    else if (isMatchmaking(row)) {
      if (row.lobby_type === RANKED_LOBBY) ranked++;
      else unranked++;
    }
    if (!isMatchmaking(row)) continue;
    const seconds = row.duration ?? 0;
    if (seconds >= MIN_JUDGED_SECONDS && row.last_hits != null) {
      const perMin = row.last_hits / (seconds / 60);
      if (perMin >= CORE_LH_PER_MIN) core++;
      else if (perMin < SUPPORT_LH_PER_MIN) support++;
    }
    const lobby =
      row.average_rank != null ? medalMidMmr(row.average_rank) : null;
    if (lobby != null) {
      lobbySum += lobby;
      lobbyGames++;
    }
    const region = regionForCluster(row.cluster);
    if (region != null) {
      regionGames++;
      regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
    }
  }
  return {
    games: raw.length,
    ranked,
    unranked,
    turbo,
    core,
    support,
    lobbyMmr: lobbyGames > 0 ? Math.round(lobbySum / lobbyGames) : null,
    lobbyGames,
    regions: [...regionCounts]
      .map(([region, games]) => ({ region, games }))
      .sort((a, b) => b.games - a.games || a.region - b.region)
      .slice(0, 3),
    regionGames,
  };
}

/** Parse the stored counts; null for a missing or malformed field, so an old
 *  snapshot (from before these were stored) reads as "not yet known". */
export function parsePubScout(raw: unknown): PubScout | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.games !== "number") return null;
  const lobbyMmr =
    typeof d.lobbyMmr === "number" &&
    Number.isFinite(d.lobbyMmr) &&
    d.lobbyMmr > 0
      ? Math.round(d.lobbyMmr)
      : null;
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
  return {
    games: count(d.games),
    ranked: count(d.ranked),
    unranked: count(d.unranked),
    turbo: count(d.turbo),
    core: count(d.core),
    support: count(d.support),
    lobbyMmr,
    lobbyGames: lobbyMmr == null ? 0 : count(d.lobbyGames),
    regions,
    regionGames: count(d.regionGames),
  };
}

// --- Reads -------------------------------------------------------------------
// Each read needs enough games to mean something and returns null below it,
// so a thin window renders nothing rather than a confident-looking share.

/** Games a share needs before it is shown. */
export const PUB_READ_MIN_GAMES = 10;

export type RoleLean = "core" | "support" | "both";

export type PubRoleRead = {
  lean: RoleLean;
  /** "Mostly support" / "Mostly core" / "Core and support". */
  label: string;
  /** Share (0–100) of judged games on the side it leans, or of support for
   *  "both". */
  percent: number;
  core: number;
  support: number;
};

/** A side needs this share of judged games to be what they "mostly" play. */
const LEAN_SHARE = 0.7;

export function pubRoleRead(scout: PubScout): PubRoleRead | null {
  const judged = scout.core + scout.support;
  if (judged < PUB_READ_MIN_GAMES) return null;
  const supportShare = scout.support / judged;
  const base = { core: scout.core, support: scout.support };
  if (supportShare >= LEAN_SHARE) {
    return {
      ...base,
      lean: "support",
      label: "Mostly support",
      percent: Math.round(supportShare * 100),
    };
  }
  if (1 - supportShare >= LEAN_SHARE) {
    return {
      ...base,
      lean: "core",
      label: "Mostly core",
      percent: Math.round((1 - supportShare) * 100),
    };
  }
  return {
    ...base,
    lean: "both",
    label: "Core and support",
    percent: Math.round(supportShare * 100),
  };
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
};

export function pubLobbyRead(scout: PubScout): PubLobbyRead | null {
  if (scout.lobbyMmr == null || scout.lobbyGames < PUB_READ_MIN_GAMES) {
    return null;
  }
  const mmr = Math.round(scout.lobbyMmr / 50) * 50;
  return { mmr, rankTier: approxRankTierFromMmr(mmr), games: scout.lobbyGames };
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
    .map((b) => ({ ...b, percent: Math.round((b.games / scout.games) * 100) }))
    .sort((a, b) => b.games - a.games);
}

export type PubRegionShare = { region: number; name: string; percent: number };

/** Their main server region, plus any other with at least a fifth of games. */
export function pubRegionRead(scout: PubScout): PubRegionShare[] | null {
  if (scout.regionGames < PUB_READ_MIN_GAMES || scout.regions.length === 0) {
    return null;
  }
  return scout.regions
    .map((r) => ({
      region: r.region,
      name: regionName(r.region),
      percent: Math.round((r.games / scout.regionGames) * 100),
    }))
    .filter((r, i) => i === 0 || r.percent >= 20);
}

/** True when any read has enough games to show. */
export function pubScoutHasReads(scout: PubScout | null | undefined): boolean {
  if (!scout) return false;
  return (
    pubRoleRead(scout) != null ||
    pubLobbyRead(scout) != null ||
    pubModeRead(scout) != null ||
    pubRegionRead(scout) != null
  );
}
