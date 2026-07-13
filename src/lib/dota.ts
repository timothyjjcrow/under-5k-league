// OpenDota API client + SteamID helpers. OpenDota is a free, public REST API
// over Valve's Dota 2 match data (what Dotabuff-style sites are built on).
// Set OPENDOTA_API_KEY for higher rate limits (optional).

const BASE = "https://api.opendota.com/api";
const STEAM64_BASE = BigInt("76561197960265728");
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Convert a 64-bit SteamID to a 32-bit Dota account id (or null if invalid). */
export function steamIdToAccountId(steamId64: string): number | null {
  try {
    const v = BigInt(steamId64) - STEAM64_BASE;
    return v > BigInt(0) && v < MAX_SAFE ? Number(v) : null;
  } catch {
    return null;
  }
}

export function accountIdToSteamId64(accountId: number): string {
  return (BigInt(accountId) + STEAM64_BASE).toString();
}

/** Pull a numeric Dota match id out of a raw id or an OpenDota/Dotabuff/Stratz URL. */
export function parseMatchId(input: string): string | null {
  const m = String(input).trim().match(/(\d{6,})/);
  return m ? m[1] : null;
}

/**
 * Parse a Dota account id from user input: a raw account id, a SteamID64, an
 * OpenDota/Dotabuff player URL, or a Steam profile URL. Returns the 32-bit id.
 */
export function parseAccountId(input: string): number | null {
  const match = String(input).trim().match(/(\d{5,})/);
  if (!match) return null;
  const digits = match[1];
  if (digits.length >= 17) return steamIdToAccountId(digits);
  const n = Number(digits);
  // Account ids are 32-bit — anything bigger is a mis-paste (e.g. a truncated
  // SteamID64) that would silently link a nonexistent account.
  return Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff ? n : null;
}

function withKey(url: string): string {
  const key = process.env.OPENDOTA_API_KEY;
  if (!key) return url;
  return `${url}${url.includes("?") ? "&" : "?"}api_key=${key}`;
}

/**
 * One per-metric benchmark from OpenDota: the player's raw value and their
 * percentile (0..1) against everyone playing that hero worldwide. Present on
 * plain /matches/{id} payloads — no replay parse required.
 */
export type OpenDotaBenchmark = { raw?: number | null; pct?: number | null };

export type OpenDotaPlayer = {
  account_id: number | null;
  player_slot: number;
  hero_id: number;
  isRadiant?: boolean;
  kills: number;
  deaths: number;
  assists: number;
  personaname?: string | null;
  net_worth?: number;
  last_hits?: number;
  gold_per_min?: number;
  xp_per_min?: number;
  denies?: number;
  level?: number;
  hero_damage?: number;
  tower_damage?: number;
  hero_healing?: number;
  benchmarks?: Record<string, OpenDotaBenchmark> | null;
};

export type OpenDotaMatch = {
  match_id: number;
  radiant_win: boolean;
  duration: number;
  start_time: number;
  radiant_score?: number;
  dire_score?: number;
  leagueid?: number;
  players: OpenDotaPlayer[];
};

export async function fetchOpenDotaMatch(
  dotaMatchId: string,
): Promise<OpenDotaMatch | null> {
  try {
    const res = await fetch(withKey(`${BASE}/matches/${dotaMatchId}`), {
      cache: "no-store",
      // A hung OpenDota call would otherwise block the server action (or the
      // inhouse poll) indefinitely — the sibling fetchers all time out too.
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.error || !Array.isArray(data.players)) return null;
    return data as OpenDotaMatch;
  } catch {
    return null;
  }
}

/** Recent match ids for a player (needs public match data enabled in Dota). */
export async function fetchRecentMatchIds(
  accountId: number,
  limit = 20,
): Promise<number[]> {
  try {
    const res = await fetch(
      withKey(`${BASE}/players/${accountId}/recentMatches`),
      { cache: "no-store", signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .slice(0, limit)
      .map((m: { match_id?: number }) => m.match_id)
      .filter((x): x is number => typeof x === "number");
  } catch {
    return [];
  }
}

/**
 * Result of a rank fetch. `ok:false` means OpenDota couldn't be reached — a
 * rate-limit (HTTP 429), 5xx, or an 8s timeout — which is NOT the same as "no
 * medal". Callers doing a bulk sync must not overwrite a stored medal with the
 * null from a failed call, or a busy moment silently wipes everyone's rank.
 * `ok:true` means OpenDota answered; `rankTier` is the medal, or null when the
 * profile is genuinely unranked / has public match data off.
 */
export type RankTierResult =
  | { ok: true; rankTier: number | null }
  | { ok: false; rankTier: null };

/** Fetch a player's ranked medal, distinguishing "unreachable" from "no rank". */
export async function fetchRankTier(accountId: number): Promise<RankTierResult> {
  try {
    const res = await fetch(withKey(`${BASE}/players/${accountId}`), {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, rankTier: null };
    const data = await res.json();
    const rankTier =
      typeof data?.rank_tier === "number" ? data.rank_tier : null;
    return { ok: true, rankTier };
  } catch {
    return { ok: false, rankTier: null };
  }
}

/**
 * A player's current ranked medal (OpenDota rank_tier), or null if unavailable.
 * Convenience wrapper over `fetchRankTier` that collapses "unreachable" and "no
 * rank" back to null — only safe where a null result won't overwrite a stored
 * medal (e.g. the signup fetch, which writes only when it gets a real medal).
 */
export async function fetchPlayerRankTier(
  accountId: number,
): Promise<number | null> {
  return (await fetchRankTier(accountId)).rankTier;
}

/** All match ids for a Valve league id (from OpenDota /leagues/{id}/matches). */
export async function fetchLeagueMatchIds(leagueId: string): Promise<number[]> {
  try {
    const res = await fetch(withKey(`${BASE}/leagues/${leagueId}/matches`), {
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .map((m: { match_id?: number }) => m.match_id)
      .filter((x): x is number => typeof x === "number");
  } catch {
    return [];
  }
}

// hero_id -> localized name, cached in-memory (fetched from OpenDota constants).
let heroCache: Record<number, string> | null = null;
export async function getHeroNames(): Promise<Record<number, string>> {
  if (heroCache) return heroCache;
  try {
    const res = await fetch(`${BASE}/constants/heroes`, {
      next: { revalidate: 86400 },
    });
    const data = await res.json();
    const map: Record<number, string> = {};
    for (const key of Object.keys(data)) {
      const h = data[key];
      if (h && typeof h.id === "number") map[h.id] = h.localized_name ?? `Hero ${h.id}`;
    }
    heroCache = map;
    return map;
  } catch {
    return {};
  }
}
