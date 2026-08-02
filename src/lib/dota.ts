// OpenDota API client + SteamID helpers. OpenDota is a free, public REST API
// over Valve's Dota 2 match data (what Dotabuff-style sites are built on).
// Set OPENDOTA_API_KEY for higher rate limits (optional).

import type { PubStats } from "./pub-stats";

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
 * Parse a Valve league id from user input: a raw id or a pasted league URL.
 *
 * The digit floor is the whole point, exactly as in `parseMatchId` above. A bare
 * `/(\d+)/` takes the FIRST digit run, and the admin card's own instructions
 * send the reader to the dota2.com league page — so pasting that URL stored a
 * league id of "2". That is not merely a wrong value: any truthy `dotaLeagueId`
 * puts
 * automatic result sync into league-feed-only mode, so the per-match roster scan
 * that had been working is switched off and NOTHING imports, with no error and
 * nothing to clear the field.
 *
 * Returns null for "no id here" so the caller can refuse rather than store junk;
 * an empty input is the caller's business (that means "clear it").
 */
export function parseLeagueId(input: string): string | null {
  const m = String(input).trim().match(/(\d{4,})/);
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

/**
 * Recent match ids for a player (needs public match data enabled in Dota).
 * `null` = OpenDota unreachable (non-2xx, rate limit, timeout) — NOT the same
 * as an empty history; callers reasoning about "is this player private?" must
 * not conflate the two (same rule as fetchRankTier's ok flag).
 */
export async function fetchRecentMatchIds(
  accountId: number,
  limit = 20,
): Promise<number[] | null> {
  try {
    const res = await fetch(
      withKey(`${BASE}/players/${accountId}/recentMatches`),
      { cache: "no-store", signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data
      .slice(0, limit)
      .map((m: { match_id?: number }) => m.match_id)
      .filter((x): x is number => typeof x === "number");
  } catch {
    return null;
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
  | { ok: true; rankTier: number | null; fhUnavailable: boolean | null }
  | { ok: false; rankTier: null; fhUnavailable: null };

/**
 * Fetch a player's ranked medal, distinguishing "unreachable" from "no rank".
 * Also carries `profile.fh_unavailable` — OpenDota's "full history
 * unavailable" flag, true when the player's "Expose Public Match Data" is off.
 * That setting is the #1 reason automatic result import can't see a player's
 * games, so every medal refresh doubles as a private-data check. Null when
 * OpenDota didn't include the field.
 */
export async function fetchRankTier(accountId: number): Promise<RankTierResult> {
  try {
    const res = await fetch(withKey(`${BASE}/players/${accountId}`), {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, rankTier: null, fhUnavailable: null };
    const data = await res.json();
    const rankTier =
      typeof data?.rank_tier === "number" ? data.rank_tier : null;
    const fh = data?.profile?.fh_unavailable;
    return {
      ok: true,
      rankTier,
      fhUnavailable: typeof fh === "boolean" ? fh : null,
    };
  } catch {
    return { ok: false, rankTier: null, fhUnavailable: null };
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

/**
 * Result of a pub-scouting fetch — the fetchRankTier contract: `ok:false`
 * means OpenDota couldn't be reached (429/5xx/timeout/garbage), which is NOT
 * the same as "no games". Callers must never overwrite a stored snapshot on a
 * failed call, or a busy moment silently wipes everyone's scouting data.
 */
export type PubStatsResult =
  | { ok: true; stats: PubStats }
  | { ok: false; stats: null };

/**
 * A player's pub-game scouting snapshot: W/L over their last ≤100 games
 * (/players/{id}/wl?limit=100) plus all-time games / most-played heroes /
 * last-played time (/players/{id}/heroes). Two calls, run in parallel — both
 * must answer or the whole fetch reports unreachable, so a half-answer never
 * masquerades as a snapshot. A player with match data private legitimately
 * returns all-zero figures; that is a real answer, stored as such (the UI
 * treats an empty recent window as "nothing scoutable").
 */
export async function fetchPubStats(accountId: number): Promise<PubStatsResult> {
  try {
    const [wlRes, heroesRes] = await Promise.all([
      fetch(withKey(`${BASE}/players/${accountId}/wl?limit=100`), {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      }),
      fetch(withKey(`${BASE}/players/${accountId}/heroes`), {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      }),
    ]);
    if (!wlRes.ok || !heroesRes.ok) return { ok: false, stats: null };
    const wl = await wlRes.json();
    const heroes = await heroesRes.json();
    const wins = wl?.win;
    const losses = wl?.lose;
    if (
      typeof wins !== "number" ||
      typeof losses !== "number" ||
      !Array.isArray(heroes)
    ) {
      return { ok: false, stats: null };
    }
    // OpenDota has historically served hero_id as a STRING on this endpoint —
    // coerce rather than trust the type.
    const rows = heroes
      .map((h: Record<string, unknown>) => ({
        heroId: Number(h?.hero_id),
        games: Number(h?.games) || 0,
        wins: Number(h?.win) || 0,
        lastPlayed: Number(h?.last_played) || 0,
      }))
      .filter((h) => Number.isFinite(h.heroId) && h.heroId > 0);
    const totalGames = rows.reduce((s, h) => s + h.games, 0);
    const lastPlayedAt = rows.reduce((m, h) => Math.max(m, h.lastPlayed), 0);
    const topHeroes = rows
      .filter((h) => h.games > 0)
      .sort((a, b) => b.games - a.games)
      .slice(0, 5)
      .map(({ heroId, games, wins: w }) => ({ heroId, games, wins: w }));
    return {
      ok: true,
      stats: {
        recentWins: wins,
        recentLosses: losses,
        totalGames,
        lastPlayedAt: lastPlayedAt > 0 ? lastPlayedAt : null,
        topHeroes,
      },
    };
  } catch {
    return { ok: false, stats: null };
  }
}

/**
 * All match ids for a Valve league id (from OpenDota /leagues/{id}/matches).
 *
 * `null` means OpenDota was UNREACHABLE (429/5xx/timeout/garbage) — the
 * fetchRecentMatchIds contract — vs `[]` for a league with genuinely no
 * games. Collapsing both to [] left syncLeagueGames unable to tell an outage
 * from an empty league: the auto path burned its throttle interval and the
 * admin's manual toast implied zero league games during a blip.
 */
export async function fetchLeagueMatchIds(
  leagueId: string,
): Promise<number[] | null> {
  try {
    const res = await fetch(withKey(`${BASE}/leagues/${leagueId}/matches`), {
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data
      .map((m: { match_id?: number }) => m.match_id)
      .filter((x): x is number => typeof x === "number");
  } catch {
    return null;
  }
}

