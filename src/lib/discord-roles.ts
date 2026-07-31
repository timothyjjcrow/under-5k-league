import { prisma } from "./prisma";
import { REGISTRATION_STATUS } from "./constants";
import { getInhousePingRoleId } from "./discord";
import type { DiscordReachFunnel, ReachPlayer } from "./discord-reach";

// Self-serve opt-in to the inhouse ping role.
//
// Discord has no native "members may give themselves this role" toggle — the
// only built-in mechanism is Community Onboarding, which is a lot of server
// configuration to obtain one checkbox. So the site does it instead: a player
// ticks a box on /me and we add the role over the REST API.
//
// This is the ONE place the app uses a bot token, and it stays deliberately
// tiny: two calls (add role, remove role) plus a read, no gateway connection,
// no background process, no slash commands. The token is a bearer credential
// under the same rule as the webhook URL — server-only, never rendered, never
// logged, never returned to the browser.
//
// Everything here is best-effort and typed so callers can tell "it worked"
// from "Discord said no" from "we aren't configured for this".

const API = "https://discord.com/api/v10";

/** Bot credentials for guild-scoped work that needs no particular role. */
export type GuildConfig = {
  token: string;
  guildId: string;
  /** Test seam only — production always uses Discord. */
  apiBase?: string;
};

export type RoleConfig = GuildConfig & { roleId: string };

/**
 * Token + guild, with no ping role required.
 *
 * Deliberately separate from getRoleConfig: that one returns null when no ping
 * role is chosen, which is correct for the opt-in and WRONG for anything else
 * the bot does. Gating the OAuth guild-join on getRoleConfig would silently
 * disable joining on any server that simply hasn't picked a ping role.
 */
export function getGuildConfig(): GuildConfig | null {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) return null;
  // DISCORD_API_BASE exists so the whole flow can be exercised against a
  // stand-in locally; unset (i.e. always, in production) it is Discord.
  return { token, guildId, apiBase: process.env.DISCORD_API_BASE };
}

/**
 * All three pieces, or null. The role id lives in the Setting table (an admin
 * edits it at runtime); the token and guild are env, because a token must
 * never sit anywhere an admin page could read it back.
 */
export async function getRoleConfig(): Promise<RoleConfig | null> {
  const guild = getGuildConfig();
  if (!guild) return null;
  const roleId = await getInhousePingRoleId();
  if (!roleId) return null;
  return { ...guild, roleId };
}

/** True when the site can offer the opt-in at all (bot token + guild + role). */
export async function pingOptInAvailable(): Promise<boolean> {
  return (await getRoleConfig()) !== null;
}

async function call(
  cfg: GuildConfig,
  path: string,
  method: "GET" | "PUT" | "DELETE",
  body?: unknown,
): Promise<Response | null> {
  try {
    return await fetch(`${cfg.apiBase ?? API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${cfg.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[discord] bot call failed:", err);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Guild membership — is a linked player actually IN the server?
// ---------------------------------------------------------------------------

/**
 * What one member lookup can say about a linked player.
 *
 * `null` means WE DON'T KNOW — Discord unreachable, rate-limited, or a 404
 * whose error code doesn't prove anything (see below). Callers must render
 * unknown as the state they already show today, never as "not a member":
 * telling a player they left a server they're in reads as broken, and telling
 * an admin ten players are missing when Discord is having a bad day sends
 * them chasing a problem that doesn't exist.
 */
export type GuildMembership = "member" | "pending" | "not-member" | null;

export type GuildMemberInfo =
  | { membership: "member" | "pending"; roles: string[] }
  | { membership: "not-member" }
  | null;

// Discord's JSON error codes. A bare 404 status is NOT "player not in the
// server" — this endpoint also 404s with Unknown Guild (10004) when the BOT
// isn't in the guild or the guild id is wrong, and reading that as "every
// player left" would nag the entire league to re-join a server they're all in.
// Same lesson as the @me/400 bug above: branch on what the body actually
// says, never on the status alone.
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013; // account deleted — equally not in the server

// ---------------------------------------------------------------------------
// Member-route rate pacing. Discord's per-guild bucket for GET member is
// single-digit requests per second, and the funnel sweeps every linked player
// at once — on the first production run exactly one bucket's worth answered
// and the other eleven burned into 429s, rendering as "couldn't check 11".
// Two halves, both needed: read X-RateLimit-Remaining/Reset-After off every
// response and PAUSE before spending a request the bucket can't honor, and on
// an actual 429 honor retry_after with ONE retry. Waits are capped: a
// retry_after longer than the cap means give up as unknown now rather than
// dangle a render — the sweep's aggregate deadline and /me's blocking path
// both depend on no single lookup stalling for long.
// ---------------------------------------------------------------------------

const RATE_WAIT_MAX_MS = 2_500;
/** guildId → epoch-ms until which the member bucket is known to be empty. */
const memberRouteBlocked = new Map<string, number>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait out a known-empty bucket. False = the wait exceeds the cap — don't
 *  spend a request on a guaranteed 429. */
async function memberGateWait(guildId: string): Promise<boolean> {
  const wait = (memberRouteBlocked.get(guildId) ?? 0) - Date.now();
  if (wait <= 0) return true;
  if (wait > RATE_WAIT_MAX_MS) return false;
  await sleep(wait);
  return true;
}

function noteMemberRoute(guildId: string, blockedForSec: number): void {
  if (!Number.isFinite(blockedForSec) || blockedForSec < 0) return;
  memberRouteBlocked.set(
    guildId,
    Math.max(
      memberRouteBlocked.get(guildId) ?? 0,
      Date.now() + blockedForSec * 1000,
    ),
  );
}

export function _clearMemberRouteGateForTests(): void {
  memberRouteBlocked.clear();
}

/**
 * The raw member lookup. One GET answers both questions this app has about a
 * member — "are they in the server?" (membership, with Membership Screening's
 * `pending` kept distinct because a pending member can't read or be pinged)
 * and "which roles do they hold?" — so surfaces that need both (/me) pay for
 * one request, not two. Rate-paced via the gate above; a lookup the bucket
 * cannot honor inside the wait cap degrades to null (unknown), never to a
 * fabricated answer.
 */
export async function fetchGuildMember(
  discordId: string,
  cfg: GuildConfig,
): Promise<GuildMemberInfo> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await memberGateWait(cfg.guildId))) return null;
    const res = await call(
      cfg,
      `/guilds/${cfg.guildId}/members/${discordId}`,
      "GET",
    );
    if (!res) return null;
    if (res.status === 429) {
      // Body retry_after (float seconds) is the precise value; the
      // Retry-After header is the whole-second fallback. No parseable value
      // still blocks the route briefly — a free-spinning retry loop against a
      // 429 is the one thing this must never become.
      let retryAfter = Number(res.headers.get("retry-after"));
      try {
        const body = (await res.json()) as { retry_after?: unknown };
        if (typeof body?.retry_after === "number") retryAfter = body.retry_after;
      } catch {
        /* headers-only is fine */
      }
      noteMemberRoute(cfg.guildId, Number.isFinite(retryAfter) ? retryAfter : 1);
      continue; // second pass re-enters the gate: waits if capped, else null
    }
    // Proactive half: when this response spent the bucket's last request,
    // remember when it refills so the NEXT lookup waits instead of 429ing.
    if (Number(res.headers.get("x-ratelimit-remaining")) === 0) {
      noteMemberRoute(
        cfg.guildId,
        Number(res.headers.get("x-ratelimit-reset-after")),
      );
    }
    if (res.status === 404) {
      try {
        const body = (await res.json()) as { code?: unknown };
        return body?.code === UNKNOWN_MEMBER || body?.code === UNKNOWN_USER
          ? { membership: "not-member" }
          : null; // Unknown Guild etc. — OUR configuration's problem, not theirs
      } catch {
        return null;
      }
    }
    if (!res.ok) return null;
    try {
      const body = (await res.json()) as { roles?: unknown; pending?: unknown };
      return {
        membership: body?.pending === true ? "pending" : "member",
        roles: Array.isArray(body.roles) ? (body.roles as string[]) : [],
      };
    } catch {
      return null;
    }
  }
  return null; // second 429 — the bucket is being contested; unknown for now
}

/** Membership alone, for surfaces that don't care about roles. */
export async function guildMembership(
  discordId: string,
  cfg: GuildConfig,
): Promise<GuildMembership> {
  const info = await fetchGuildMember(discordId, cfg);
  return info === null ? null : info.membership;
}

/**
 * Does this member currently hold the ping role?
 *
 * `null` means WE DON'T KNOW — Discord was unreachable, or the player isn't in
 * the server. The caller must render that as an unknown state rather than
 * guessing "off": showing an unticked box to someone who is opted in would
 * make them tick it again and change nothing, which reads as broken.
 *
 * Read live rather than mirrored into a column on purpose. A local boolean
 * drifts the moment someone removes the role in Discord, and then the site
 * confidently displays the opposite of the truth.
 */
export async function hasPingRole(
  discordId: string,
  cfg: RoleConfig,
): Promise<boolean | null> {
  const info = await fetchGuildMember(discordId, cfg);
  if (info === null || info.membership === "not-member") return null;
  return info.roles.includes(cfg.roleId);
}

/**
 * In-process memo over guildMembership, for the surfaces that render on every
 * page view (the dashboard join nag, the admin funnel, the start-draft
 * confirm). Membership stays a LIVE read everywhere — the hasPingRole comment
 * above explains why a mirrored column is worse — but a hot page must not turn
 * every render into a Discord request, so answers are held briefly
 * (loadBoardStats' pattern).
 *
 * The TTLs are asymmetric on purpose. "member" is safe to hold for minutes:
 * its only failure mode is a player who leaves the server keeping a green
 * badge slightly longer. Everything else — not-member, pending, unknown — is
 * held for seconds, because the player it describes is mid-fix: they just
 * clicked Join, and a nag that outlives the thing it asks for by minutes
 * reads as broken (the DiscordSetupCard rule).
 */
export const MEMBERSHIP_MEMBER_TTL_MS = 5 * 60_000;
export const MEMBERSHIP_RECHECK_TTL_MS = 30_000;

const membershipMemo = new Map<string, { at: number; value: GuildMembership }>();
// In-flight promises, keyed like the memo. A result-only memo cannot dedupe
// CONCURRENT lookups — /admin renders two funnel consumers (the Discord card
// and the Start-draft confirm) in the same request, and on a cold memo both
// sweeps would fire before either writes a result, doubling the burst against
// Discord for every player at once.
const membershipInflight = new Map<string, Promise<GuildMembership>>();

export async function memoGuildMembership(
  discordId: string,
  cfg: GuildConfig,
  nowMs = Date.now(),
): Promise<GuildMembership> {
  const hit = membershipMemo.get(discordId);
  if (hit) {
    const ttl =
      hit.value === "member"
        ? MEMBERSHIP_MEMBER_TTL_MS
        : MEMBERSHIP_RECHECK_TTL_MS;
    if (nowMs - hit.at < ttl) return hit.value;
  }
  const inflight = membershipInflight.get(discordId);
  if (inflight) return inflight;
  const req = guildMembership(discordId, cfg)
    .then((value) => {
      // Supersession check: a prime (or a later lookup) that landed while
      // this request was on the wire is FRESHER — /me's live read must not be
      // clobbered by an admin sweep that merely resolved after it.
      const existing = membershipMemo.get(discordId);
      if (!existing || existing.at <= nowMs) {
        membershipMemo.set(discordId, { at: nowMs, value });
      }
      return value;
    })
    .finally(() => {
      membershipInflight.delete(discordId);
    });
  membershipInflight.set(discordId, req);
  return req;
}

/**
 * Feed a fresh answer (e.g. /me's own live lookup) into the memo, so the
 * dashboard nag converges on what the profile page just showed instead of the
 * two surfaces disagreeing for a memo window.
 *
 * A `null` prime is IGNORED: null is the absence of an answer, and letting one
 * failed /me lookup erase a valid "not-member" cached seconds earlier would
 * blank the dashboard nag for a player who still needs it. (memoGuildMembership
 * caching its own nulls briefly is different — that bounds retry storms.)
 */
export function primeMembershipMemo(
  discordId: string,
  value: GuildMembership,
  nowMs = Date.now(),
): void {
  if (value === null) return;
  membershipMemo.set(discordId, { at: nowMs, value });
}

export function _clearMembershipMemoForTests(): void {
  membershipMemo.clear();
  membershipInflight.clear();
  _clearMemberRouteGateForTests();
}

/**
 * Membership for a batch of linked players, memoised, a few requests in
 * flight at a time. Per-id lookups rather than the bulk member-list endpoint
 * on purpose: listing a guild's members needs the GUILD_MEMBERS privileged
 * intent — a Developer Portal checkbox that would be a FIFTH way for this
 * integration to be half-configured, invisible until the list 403s. At league
 * scale (tens of players) the per-id form costs a burst the memo amortises
 * away, and a player Discord won't answer for degrades to `null` (unknown)
 * instead of poisoning the whole sweep.
 *
 * The AGGREGATE deadline exists because the per-call 4s timeout compounds:
 * ceil(N/4) serial batches against a hanging Discord is 40+ seconds of a
 * streamed admin section dangling for a 40-player league. Once the budget is
 * spent, the ids not yet fetched come back `null` — reported by the funnel as
 * its honest "couldn't check" count, never silently dropped.
 */
export const SWEEP_DEADLINE_MS = 8_000;

export async function sweepGuildMemberships(
  discordIds: string[],
  cfg: GuildConfig,
  nowMs = Date.now(),
  deadlineMs = SWEEP_DEADLINE_MS,
): Promise<Map<string, GuildMembership>> {
  const ids = [...new Set(discordIds)];
  const out = new Map<string, GuildMembership>();
  // Wall-clock on purpose (nowMs is the memo's injectable TTL clock, not a
  // stopwatch): the deadline is about real elapsed network time.
  const startedAt = Date.now();
  let next = 0;
  const workers = Array.from(
    { length: Math.min(4, ids.length) },
    async () => {
      while (next < ids.length) {
        const id = ids[next++];
        if (Date.now() - startedAt >= deadlineMs) {
          out.set(id, null);
          continue;
        }
        out.set(id, await memoGuildMembership(id, cfg, nowMs));
      }
    },
  );
  await Promise.all(workers);
  return out;
}

export type RoleChange = "ok" | "not-a-member" | "forbidden" | "failed";

/**
 * Add or remove the ping role. PUT is idempotent (adding a role someone
 * already has is a 204), which is what makes a double-click harmless.
 *
 * `forbidden` is the one an admin has to act on and is worth distinguishing:
 * it means the bot's own role sits BELOW the ping role in the server's role
 * list, so Discord refuses to let it grant that role. No amount of retrying
 * fixes it, and the error message should say so rather than blaming the
 * player's click.
 */
export async function setPingRole(
  discordId: string,
  on: boolean,
  cfg: RoleConfig,
): Promise<RoleChange> {
  const res = await call(
    cfg,
    `/guilds/${cfg.guildId}/members/${discordId}/roles/${cfg.roleId}`,
    on ? "PUT" : "DELETE",
  );
  if (!res) return "failed";
  if (res.ok || res.status === 204) return "ok";
  if (res.status === 404) return "not-a-member";
  if (res.status === 403) return "forbidden";
  return "failed";
}

// ---------------------------------------------------------------------------
// Guild join (OAuth `guilds.join`)
// ---------------------------------------------------------------------------

export type GuildJoin =
  | "joined"
  /** In the guild, but Membership Screening still has them behind the rules. */
  | "joined-pending"
  | "already"
  | "forbidden"
  | "failed";

/**
 * Add a player to the league's server using the access token they just granted.
 *
 * Discord's "Add Guild Member" wants BOTH credentials at once: the bot token in
 * the Authorization header (the bot is the one doing the adding, and must hold
 * CREATE_INSTANT_INVITE) and the user's own `guilds.join` access token in the
 * body (their consent). Neither alone works, which is why this can only run
 * inside the OAuth callback while the token is still in hand — see
 * handleDiscordCallback, which discards it immediately afterwards.
 *
 * 403 is the one an admin must act on and never resolves by retrying: either
 * the bot lacks CREATE_INSTANT_INVITE, or the token belongs to a DIFFERENT
 * application than the OAuth client the player just authorised. getPingHealth
 * checks both so it doesn't have to be diagnosed from a player's bug report.
 */
export async function joinGuild(
  discordId: string,
  accessToken: string,
  cfg: GuildConfig,
): Promise<GuildJoin> {
  const res = await call(
    cfg,
    `/guilds/${cfg.guildId}/members/${discordId}`,
    "PUT",
    { access_token: accessToken },
  );
  if (!res) return "failed";
  // 204 = already a member. Discord changes nothing and sends no body, so this
  // is the normal outcome for anyone who joined via the invite link first.
  if (res.status === 204) return "already";
  if (res.status === 201) {
    // Membership Screening / Onboarding lands new members as `pending`: they
    // are in the server but can't read, talk, or be pinged until they accept
    // the rules. Reporting that as a clean success would leave them thinking
    // they're reachable when no notification can arrive.
    try {
      const body = (await res.json()) as { pending?: unknown };
      return body?.pending === true ? "joined-pending" : "joined";
    } catch {
      return "joined";
    }
  }
  if (res.status === 403) return "forbidden";
  return "failed";
}

// ---------------------------------------------------------------------------
// Setup diagnostics
// ---------------------------------------------------------------------------

/**
 * Answers "is this actually working?" for the admin, because the opt-in has
 * FOUR independent ways to be half-configured and three of them are invisible
 * until a player clicks the button and gets an error.
 *
 * The one worth the extra API call is `canGrant`: Discord refuses to let a bot
 * assign a role positioned above its own, and nothing in the portal warns you.
 * Left undetected it looks like a site bug, reported by a confused player, days
 * later. Here it's a red line with the exact fix.
 */
export type PingHealth = {
  hasToken: boolean;
  hasGuild: boolean;
  hasRole: boolean;
  /** null = not checked (config incomplete) or Discord unreachable. */
  botInGuild: boolean | null;
  roleExists: boolean | null;
  canGrant: boolean | null;
  botName: string | null;
  roleName: string | null;
  /** The raw numbers behind canGrant. A diagnostic that emits only a boolean
   *  is how the previous version of this check stayed wrong for so long —
   *  there was nothing to sanity-check it against. */
  botTopPosition: number | null;
  rolePosition: number | null;
  hasManageRoles: boolean | null;
  /**
   * CREATE_INSTANT_INVITE — what the OAuth guild-join needs. Separate from
   * Manage Roles: a bot invited only for the ping role has one and not the
   * other, and the join then 403s on every player forever.
   */
  canInvite: boolean | null;
  /**
   * Is the bot token from the SAME application as DISCORD_CLIENT_ID? Discord
   * only honours a `guilds.join` token for the application that issued it, so
   * a mismatched pair fails permanently while every other check stays green.
   * null = DISCORD_CLIENT_ID unset, so there's nothing to compare against.
   */
  appMatchesOauth: boolean | null;
  /** Set when a check couldn't run at all, e.g. a bad token. */
  problem: string | null;
};

type Fetched = { ok: boolean; status: number; data: unknown };

/**
 * GET + parse, keeping the status. Every caller MUST branch on `ok`: Discord
 * returns errors as perfectly valid JSON, so a body that parses proves
 * nothing. Letting a 400 through as data is exactly the bug that made this
 * whole check report a false failure on every server it ran on.
 */
async function getJson(cfg: GuildConfig, path: string): Promise<Fetched | null> {
  const res = await call(cfg, path, "GET");
  if (!res) return null;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

// tsconfig targets ES2017, so BigInt LITERALS (8n) don't compile — see the
// same gotcha in CLAUDE.md for match ids. 1<<3, 1<<28 and 1<<0.
const ADMINISTRATOR = BigInt("8");
const MANAGE_ROLES = BigInt("268435456");
const CREATE_INSTANT_INVITE = BigInt("1");

export async function getPingHealth(): Promise<PingHealth> {
  const hasToken = !!process.env.DISCORD_BOT_TOKEN;
  const hasGuild = !!process.env.DISCORD_GUILD_ID;
  const roleId = await getInhousePingRoleId();
  const base: PingHealth = {
    hasToken,
    hasGuild,
    hasRole: !!roleId,
    botInGuild: null,
    roleExists: null,
    canGrant: null,
    botName: null,
    roleName: null,
    botTopPosition: null,
    rolePosition: null,
    hasManageRoles: null,
    canInvite: null,
    appMatchesOauth: null,
    problem: null,
  };
  // The bot checks need only token+guild; ONLY the role rows need a role id.
  // This used to gate everything on getRoleConfig, which meant a league that
  // configured the bot without picking a ping role — an explicitly supported
  // state, see getGuildConfig's doc — got no diagnosis at all: a kicked bot or
  // a wrong guild id left the membership funnel reading "couldn't check" while
  // the one surface that can name the cause returned all-null.
  const cfg = getGuildConfig();
  if (!cfg) return base;

  // 1. Who are we? A bot token's /users/@me IS valid — unlike the member
  //    lookup, which has no @me form on GET and 400s with "not snowflake".
  const meUser = await getJson(cfg, "/users/@me");
  if (!meUser) return { ...base, problem: "Couldn't reach Discord." };
  if (meUser.status === 401) {
    return {
      ...base,
      problem: "Discord rejected the bot token — reset it and update the env var.",
    };
  }
  if (!meUser.ok) {
    return { ...base, problem: `Discord refused the identity check (${meUser.status}).` };
  }
  const botId = (meUser.data as { id?: string })?.id;
  const botName = (meUser.data as { username?: string })?.username ?? null;
  if (!botId) return { ...base, problem: "Unexpected reply from Discord." };

  // A bot user's id IS its application id, so this is a free check — and the
  // only way to catch a bot token paired with a different app's OAuth client,
  // which breaks the guild-join permanently while looking fine everywhere else.
  const oauthClientId = process.env.DISCORD_CLIENT_ID || null;
  const appMatchesOauth = oauthClientId ? botId === oauthClientId : null;
  const known = { ...base, botName, appMatchesOauth };

  // 2. Our own member row, by REAL snowflake.
  const [member, rolesRes] = await Promise.all([
    getJson(cfg, `/guilds/${cfg.guildId}/members/${botId}`),
    getJson(cfg, `/guilds/${cfg.guildId}/roles`),
  ]);
  if (!member || !rolesRes) {
    return { ...known, problem: "Couldn't reach Discord." };
  }
  if (member.status === 404 || member.status === 403) {
    return { ...known, botInGuild: false };
  }
  if (!member.ok || !rolesRes.ok) {
    return {
      ...known,
      problem: `Discord refused the guild lookup (${member.ok ? rolesRes.status : member.status}).`,
    };
  }

  const roles = rolesRes.data as
    | { id: string; name: string; position: number; permissions: string; managed?: boolean }[]
    | undefined;
  const myRoleIds = (member.data as { roles?: string[] })?.roles;
  if (!Array.isArray(roles) || !Array.isArray(myRoleIds)) {
    return { ...known, botInGuild: true, problem: "Unexpected reply from Discord." };
  }

  const byId = new Map(roles.map((r) => [r.id, r]));
  const target = roleId ? (byId.get(roleId) ?? null) : null;
  // The bot's height is its HIGHEST role; @everyone (id === guildId) is 0.
  const botTop = myRoleIds.reduce(
    (top, id) => Math.max(top, byId.get(id)?.position ?? 0),
    0,
  );
  // Hierarchy is necessary but NOT sufficient — the bot also needs the
  // permission. permissions is a STRING bitfield, so BigInt it.
  const perms = myRoleIds.reduce((acc, id) => {
    const r = byId.get(id);
    return r ? acc | BigInt(r.permissions ?? "0") : acc;
  }, BigInt(byId.get(cfg.guildId)?.permissions ?? "0"));
  const isAdmin = (perms & ADMINISTRATOR) === ADMINISTRATOR;
  const hasManageRoles = isAdmin || (perms & MANAGE_ROLES) === MANAGE_ROLES;
  const canInvite =
    isAdmin || (perms & CREATE_INSTANT_INVITE) === CREATE_INSTANT_INVITE;

  return {
    ...known,
    botInGuild: true,
    // null (not false) when no role id is chosen — there is nothing to find.
    roleExists: roleId ? !!target : null,
    roleName: target?.name ?? null,
    botTopPosition: botTop,
    rolePosition: target?.position ?? null,
    hasManageRoles,
    canInvite,
    // STRICTLY greater: an equal position is not "lower" and Discord refuses
    // it. A managed (integration-owned) role can never be assigned by anyone.
    canGrant: target
      ? hasManageRoles && !target.managed && botTop > target.position
      : null,
    problem: null,
  };
}

/**
 * How many of this season's registered players can a Discord notification
 * actually reach?
 *
 * This is the denominator under every notification feature the league has:
 * personal mentions when a lobby forms, the un-RSVP'd ping in the week
 * reminder, and the self-serve ping role all silently skip anyone who never
 * linked. Without the number it is impossible to tell whether that machinery
 * is aimed at the whole league or at six people — and if it's six, the useful
 * next move is getting people to link, not building more of it.
 *
 * Deliberately a plain DB count over an @unique column: no Discord calls, so
 * it costs nothing and cannot fail. It measures LINKED, not "in the server" or
 * "DM-reachable" — those need per-member API calls, and the cheap number is
 * the one that changes the decision.
 */
export async function getDiscordReach(seasonId: string | null): Promise<{
  registered: number;
  linked: number;
  unlinkedNames: string[];
}> {
  if (!seasonId) return { registered: 0, linked: 0, unlinkedNames: [] };
  const regs = await prisma.registration.findMany({
    where: { seasonId, status: REGISTRATION_STATUS.ACTIVE },
    select: { user: { select: { name: true, discordId: true } } },
  });
  const linked = regs.filter((r) => !!r.user.discordId).length;
  return {
    registered: regs.length,
    linked,
    // Named so an admin can actually chase them; capped so a league where
    // nobody has linked doesn't render a wall of names.
    unlinkedNames: regs
      .filter((r) => !r.user.discordId)
      .map((r) => r.user.name)
      .slice(0, 12),
  };
}

// The funnel's shape + its pure copy builders live in discord-reach.ts (a
// "use client" component needs them, and this module imports prisma).
// Re-exported so existing server-side import paths keep working.
export {
  discordChaseMessage,
  discordReachWarning,
  type DiscordReachFunnel,
  type ReachPlayer,
} from "./discord-reach";

/**
 * getDiscordReach plus the step it cannot see: of the linked, who is actually
 * IN the server? Linking proves ownership of a handle; only membership makes
 * the player reachable — a linked non-member wears the same verified ✓ while
 * every mention, ping and week reminder silently misses them, which makes
 * them the most deceptive cohort in the funnel.
 *
 * `guild: null` = no bot+guild configured, membership is unknowable, and
 * callers must render exactly what getDiscordReach always rendered. Kept as a
 * separate function (not folded into getDiscordReach) because that one's
 * contract is "no Discord calls, cannot fail" and several callers rely on it
 * being free.
 */
export async function getDiscordReachFunnel(
  seasonId: string | null,
): Promise<DiscordReachFunnel> {
  if (!seasonId) {
    return { registered: 0, linked: 0, unlinkedNames: [], guild: null };
  }
  const regs = await prisma.registration.findMany({
    where: { seasonId, status: REGISTRATION_STATUS.ACTIVE },
    select: {
      user: { select: { name: true, discordId: true, discordName: true } },
    },
  });
  const linkedUsers = regs
    .filter((r) => !!r.user.discordId)
    .map((r) => ({
      name: r.user.name,
      discordId: r.user.discordId as string,
      // The handle of the account they LINKED — what makes a "missing"
      // verdict checkable against the member list (see ReachPlayer).
      handle: r.user.discordName ?? "",
    }));
  // Name lists are UNCAPPED here — the chase message has to name everyone,
  // and a display cap is the card's concern, not the data's. (getDiscordReach
  // above keeps its 12-cap; its consumers only ever render.)
  const base = {
    registered: regs.length,
    linked: linkedUsers.length,
    unlinkedNames: regs
      .filter((r) => !r.user.discordId)
      .map((r) => r.user.name),
  };
  const cfg = getGuildConfig();
  if (!cfg) return { ...base, guild: null };

  const byId = await sweepGuildMemberships(
    linkedUsers.map((u) => u.discordId),
    cfg,
  );
  let inServer = 0;
  let unknown = 0;
  const pendingNames: ReachPlayer[] = [];
  const missingNames: ReachPlayer[] = [];
  for (const u of linkedUsers) {
    switch (byId.get(u.discordId) ?? null) {
      case "member":
        inServer++;
        break;
      case "pending":
        pendingNames.push({ name: u.name, handle: u.handle });
        break;
      case "not-member":
        missingNames.push({ name: u.name, handle: u.handle });
        break;
      default:
        unknown++;
    }
  }
  return {
    ...base,
    guild: {
      inServer,
      pending: pendingNames.length,
      pendingNames,
      missing: missingNames.length,
      missingNames,
      unknown,
    },
  };
}

/**
 * The "will the announcement actually reach this player?" note, appended to
 * the toast of actions that create an obligation for someone — a standin
 * assignment is the most action-demanding message the league sends, and if
 * the standin can't hear it, the CAPTAIN who arranged the cover is the one
 * who needs to know NOW, not on match night. Empty string when the player is
 * reachable — or when we simply can't tell (a Discord hiccup must not dress
 * itself up as "this player is unreachable"). Never throws: a toast garnish
 * must not be able to fail the assignment it rides on.
 */
export async function reachabilityNote(userId: string): Promise<string> {
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, discordId: true },
    });
    if (!u) return "";
    if (!u.discordId) {
      return ` Heads up: ${u.name} hasn't linked Discord, so the announcement won't notify them — contact them directly.`;
    }
    const cfg = getGuildConfig();
    if (!cfg) return "";
    // Deadline-raced: the assignment is already committed, and behind a
    // contested rate gate the lookup's worst case (gate wait + timeout +
    // retry) is ~13s — a toast garnish must not hold the captain's success
    // message hostage that long. Timeout = unknown = silence, as always.
    const membership = await Promise.race([
      memoGuildMembership(u.discordId, cfg),
      new Promise<null>((r) => setTimeout(() => r(null), 2_500)),
    ]);
    if (membership === "not-member") {
      return ` Heads up: ${u.name} isn't in the league's Discord server, so the ping can't reach them — contact them directly.`;
    }
    if (membership === "pending") {
      return ` Heads up: ${u.name} hasn't accepted the Discord server's rules yet, so the ping can't reach them.`;
    }
    return "";
  } catch {
    return "";
  }
}

