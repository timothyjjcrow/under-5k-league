import { getSetting, SETTING_KEYS } from "./settings";

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

export type RoleConfig = {
  token: string;
  guildId: string;
  roleId: string;
  /** Test seam only — production always uses Discord. */
  apiBase?: string;
};

/**
 * All three pieces, or null. The role id lives in the Setting table (an admin
 * edits it at runtime); the token and guild are env, because a token must
 * never sit anywhere an admin page could read it back.
 */
export async function getRoleConfig(): Promise<RoleConfig | null> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) return null;
  const roleId =
    (await getSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID)) ||
    process.env.DISCORD_INHOUSE_ROLE_ID ||
    null;
  if (!roleId) return null;
  // DISCORD_API_BASE exists so the whole flow can be exercised against a
  // stand-in locally; unset (i.e. always, in production) it is Discord.
  return { token, guildId, roleId, apiBase: process.env.DISCORD_API_BASE };
}

/** True when the site can offer the opt-in at all (bot token + guild + role). */
export async function pingOptInAvailable(): Promise<boolean> {
  return (await getRoleConfig()) !== null;
}

async function call(
  cfg: RoleConfig,
  path: string,
  method: "GET" | "PUT" | "DELETE",
): Promise<Response | null> {
  try {
    return await fetch(`${cfg.apiBase ?? API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${cfg.token}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(4000),
    });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[discord] role call failed:", err);
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
