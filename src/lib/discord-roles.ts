import { prisma } from "./prisma";
import { REGISTRATION_STATUS } from "./constants";
import { getInhousePingRoleId } from "./discord";

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
  const res = await call(
    cfg,
    `/guilds/${cfg.guildId}/members/${discordId}`,
    "GET",
  );
  if (!res) return null;
  if (res.status === 404) return null; // not in the server — can't say
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as { roles?: unknown };
    return Array.isArray(body.roles) && body.roles.includes(cfg.roleId);
  } catch {
    return null;
  }
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
async function getJson(cfg: RoleConfig, path: string): Promise<Fetched | null> {
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
  const cfg = await getRoleConfig();
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
  const target = byId.get(cfg.roleId) ?? null;
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
    roleExists: !!target,
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
