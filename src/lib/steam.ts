// Steam sign-in uses OpenID 2.0 (NOT OAuth2). The flow:
//   1. Redirect the user to Steam with an openid checkid_setup request.
//   2. Steam redirects back to our return_to URL with a signed assertion.
//   3. We verify the assertion by POSTing it back to Steam (check_authentication).
//   4. The user's SteamID64 is the trailing number of openid.claimed_id.
//   5. Optionally enrich name/avatar via the Steam Web API (needs STEAM_API_KEY).

const STEAM_OPENID = "https://steamcommunity.com/openid/login";

export function buildSteamLoginUrl(returnTo: string, realm: string): string {
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": realm,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return `${STEAM_OPENID}?${params.toString()}`;
}

/** Verify the OpenID callback with Steam. Returns the SteamID64 or null. */
export async function verifySteamCallback(
  query: URLSearchParams,
): Promise<string | null> {
  const claimedId = query.get("openid.claimed_id") || "";
  const idMatch = claimedId.match(/(\d{17})$/);
  if (!idMatch) return null;

  const params = new URLSearchParams();
  for (const [k, v] of query.entries()) params.set(k, v);
  params.set("openid.mode", "check_authentication");

  const res = await fetch(STEAM_OPENID, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await res.text();
  if (!/is_valid\s*:\s*true/i.test(text)) return null;

  return idMatch[1];
}

export type SteamProfile = {
  name: string;
  avatar: string | null;
  profileUrl: string | null;
};

/** Enrich a SteamID with persona name/avatar. Falls back to a placeholder. */
export async function fetchSteamProfile(steamId: string): Promise<SteamProfile> {
  const key = process.env.STEAM_API_KEY;
  const fallback: SteamProfile = {
    name: `Player ${steamId.slice(-5)}`,
    avatar: null,
    profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
  };
  if (!key) return fallback;
  try {
    const res = await fetch(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${steamId}`,
      { cache: "no-store" },
    );
    const data = await res.json();
    const p = data?.response?.players?.[0];
    if (!p) return fallback;
    return {
      name: p.personaname || fallback.name,
      avatar: p.avatarfull || null,
      profileUrl: p.profileurl || fallback.profileUrl,
    };
  } catch {
    return fallback;
  }
}

/**
 * Batch-fetch real Steam profiles (name/avatar/url) for many SteamIDs at once
 * (GetPlayerSummaries takes up to 100 per call). Only real, resolved profiles
 * are included in the returned map — unknown/fake ids are omitted so callers
 * never overwrite good data with a placeholder.
 */
export async function fetchSteamProfiles(
  steamIds: string[],
): Promise<Map<string, SteamProfile>> {
  const key = process.env.STEAM_API_KEY;
  const out = new Map<string, SteamProfile>();
  if (!key || steamIds.length === 0) return out;

  for (let i = 0; i < steamIds.length; i += 100) {
    const batch = steamIds.slice(i, i + 100);
    try {
      const res = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${batch.join(",")}`,
        { cache: "no-store", signal: AbortSignal.timeout(10000) },
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const p of data?.response?.players ?? []) {
        out.set(String(p.steamid), {
          name: p.personaname || `Player ${String(p.steamid).slice(-5)}`,
          avatar: p.avatarfull || null,
          profileUrl: p.profileurl || null,
        });
      }
    } catch {
      /* skip this batch on error */
    }
  }
  return out;
}
