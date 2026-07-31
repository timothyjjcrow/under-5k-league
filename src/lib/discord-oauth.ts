// Discord account linking uses OAuth2 (authorization-code + PKCE) with the
// minimal `identify` scope — plus `guilds.join` when the league has a bot and
// a server configured, so one click both links the account and puts the player
// in the server (see buildDiscordAuthUrl). The flow:
//   1. /api/auth/discord (signed-in only) generates a state + PKCE verifier,
//      stashes them in a short-lived httpOnly cookie, and redirects to Discord.
//   2. Discord sends the user back to our callback with ?code&state.
//   3. The callback checks state against the cookie (CSRF — otherwise an
//      attacker could splice THEIR Discord onto YOUR account), exchanges the
//      code server-side (client secret + verifier), and reads /users/@me.
//   4. We persist ONLY the snowflake id + username. Tokens are dropped on the
//      floor — neither scope grants anything worth keeping, so a DB leak leaks
//      a public id, not credentials. The guild join happens INSIDE the callback
//      precisely so the token never has to outlive the request.
// DISCORD_CLIENT_SECRET is a server-only credential (webhook-URL rule): it is
// never rendered to the client and never logged.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { safeReturnPath } from "./return-path";

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const TOKEN_URL = "https://discord.com/api/v10/oauth2/token";
const ME_URL = "https://discord.com/api/v10/users/@me";

// One-shot httpOnly cookie carrying `state.verifier` across the round-trip.
// Scoped to /api/auth/discord so it never rides other requests.
export const DISCORD_OAUTH_COOKIE = "ld2l_discord_oauth";
export const DISCORD_OAUTH_COOKIE_PATH = "/api/auth/discord";
export const DISCORD_OAUTH_MAX_AGE = 600; // the round-trip takes seconds

/** URL-safe random value for `state` / the PKCE verifier. */
export function randomOauthValue(): string {
  return randomBytes(32).toString("base64url");
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)). Pure — unit-tested. */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Pack state + verifier (+ an optional validated return path) into the
 * one-shot cookie value. The path rides base64url so it can never smuggle a
 * `.` into the format, and it is validated at BOTH ends: here (never pack
 * garbage) and again at unpack (the cookie is client-held bytes — a tampered
 * value must degrade to "no return path", not become a redirect target).
 * Linking is a full-page round-trip that used to always land on /me — which
 * was wrong for everyone who clicked from the dashboard join nag.
 */
export function packOauthCookie(
  state: string,
  verifier: string,
  next?: string | null,
): string {
  const safe = safeReturnPath(next);
  if (!safe) return `${state}.${verifier}`;
  return `${state}.${verifier}.${Buffer.from(safe).toString("base64url")}`;
}

/** Unpack the cookie; null on anything malformed. A bad THIRD part only
 *  drops the return path — the state/verifier halves still work, so a stale
 *  two-part cookie from before this format keeps round-tripping. Pure —
 *  unit-tested. */
export function unpackOauthCookie(
  value: string | null | undefined,
): { state: string; verifier: string; next: string | null } | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) {
    return null;
  }
  let next: string | null = null;
  if (parts.length === 3 && parts[2]) {
    try {
      next = safeReturnPath(Buffer.from(parts[2], "base64url").toString("utf8"));
    } catch {
      next = null;
    }
  }
  return { state: parts[0], verifier: parts[1], next };
}

/**
 * Where the callback lands. Only a FULL success ("joined" / "linked") honors
 * the return path — every other outcome carries a ?discord= code that only
 * /me knows how to render (and scrub), so sending it anywhere else would
 * strand an unexplained query param on a page with no note for it. A success
 * bound for /me anyway keeps its code, so the profile page still confirms.
 */
export function oauthLandingPath(code: string, next: string | null): string {
  const success = code === "joined" || code === "linked";
  if (success && next && next !== "/me") return next;
  return `/me?discord=${code}`;
}

/** Constant-time string compare (length leak is fine — states are fixed-size). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * The discord.com/oauth2/authorize redirect. Pure — unit-tested.
 *
 * `withGuildJoin` adds the ONE extra scope this app ever asks for, and it is
 * conditional on purpose: it lets the callback drop the player straight into
 * the league's server instead of making them find the invite separately. It
 * changes what the consent screen promises ("Join servers for you"), so it is
 * requested ONLY when DISCORD_BOT_TOKEN + DISCORD_GUILD_ID are set and the
 * join can really happen. Asking for a permission we can't exercise would be
 * the worst of both — the scarier screen and none of the payoff.
 *
 * Still no email, no guild LIST, no messages: `guilds.join` is write-only.
 */
export function buildDiscordAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  withGuildJoin?: boolean;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    scope: opts.withGuildJoin ? "identify guilds.join" : "identify",
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type DiscordProfile = {
  /** The snowflake — the stable identity (usernames change, ids don't). */
  discordId: string;
  /** The handle captains paste into Discord search. */
  discordName: string;
};

/**
 * Validate a /users/@me payload into the two fields we store. Null on any
 * unexpected shape — never persist something Discord didn't clearly assert.
 * Legacy discriminator accounts keep their `name#1234` form (matches what
 * normalizeDiscordName accepts for the manual fallback). Pure — unit-tested.
 */
export function discordProfileFromMe(json: unknown): DiscordProfile | null {
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const username = typeof o.username === "string" ? o.username.trim() : "";
  if (!/^\d{5,25}$/.test(id)) return null;
  if (!username || username.length > 40) return null;
  const discriminator =
    typeof o.discriminator === "string" ? o.discriminator : "0";
  const discordName =
    discriminator && discriminator !== "0"
      ? `${username}#${discriminator}`
      : username;
  return { discordId: id, discordName };
}

/**
 * Exchange the authorization code for an access token. Returns the token or
 * null — never throws (a Discord hiccup becomes a "try again" redirect).
 */
export async function exchangeDiscordCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<string | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        grant_type: "authorization_code",
        code: opts.code,
        redirect_uri: opts.redirectUri,
        code_verifier: opts.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const token = data?.access_token;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

/** Fetch /users/@me with the (immediately discarded) access token. */
export async function fetchDiscordIdentity(
  accessToken: string,
): Promise<DiscordProfile | null> {
  try {
    const res = await fetch(ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return discordProfileFromMe(await res.json());
  } catch {
    return null;
  }
}
