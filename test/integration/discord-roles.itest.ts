import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getDiscordReach,
  getPingHealth,
  getRoleConfig,
  hasPingRole,
  pingOptInAvailable,
  setPingRole,
  type RoleConfig,
} from "@/lib/discord-roles";
import { SETTING_KEYS, setSetting } from "@/lib/settings";
import { prisma } from "@/lib/prisma";
import { makeSeason, makeUser } from "./factories";

// The self-serve inhouse ping opt-in, over REAL HTTP against a stand-in for
// Discord. What has to hold:
//   * the feature is OFF unless bot token + guild + role are all configured
//   * "do they have the role?" answers null (unknown) rather than guessing
//     false — an unticked box shown to someone already opted in makes them
//     click it and change nothing, which reads as broken
//   * a 403 (bot's role sits below the ping role) is reported as its own
//     outcome, because no amount of retrying fixes it

type Recorded = { method: string; url: string; auth: string | undefined };

let server: Server;
let base: string;
let recorded: Recorded[] = [];
let respond: (r: Recorded) => { status: number; body?: unknown };

const GUILD = "900000000000000001";
const ROLE = "900000000000000002";
const MEMBER = "900000000000000003";

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const entry = {
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
      };
      recorded.push(entry);
      const out = respond(entry);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  recorded = [];
  respond = () => ({ status: 204 });
  process.env.DISCORD_BOT_TOKEN = "test-token";
  process.env.DISCORD_GUILD_ID = GUILD;
  delete process.env.DISCORD_INHOUSE_ROLE_ID;
  delete process.env.DISCORD_API_BASE;
});

const cfg = (): RoleConfig => ({
  token: "test-token",
  guildId: GUILD,
  roleId: ROLE,
  apiBase: base,
});

describe("configuration gate", () => {
  it("is unavailable with no bot token", async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    await setSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID, ROLE);
    expect(await getRoleConfig()).toBeNull();
    expect(await pingOptInAvailable()).toBe(false);
  });

  it("is unavailable with no role chosen — a token alone grants nothing", async () => {
    expect(await getRoleConfig()).toBeNull();
    expect(await pingOptInAvailable()).toBe(false);
  });

  it("is available once token, guild and role all exist", async () => {
    await setSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID, ROLE);
    expect(await getRoleConfig()).toEqual({
      token: "test-token",
      guildId: GUILD,
      roleId: ROLE,
    });
    expect(await pingOptInAvailable()).toBe(true);
  });
});

describe("setPingRole", () => {
  it("PUTs the role on the right member, authenticated as a bot", async () => {
    expect(await setPingRole(MEMBER, true, cfg())).toBe("ok");
    expect(recorded[0].method).toBe("PUT");
    expect(recorded[0].url).toBe(
      `/guilds/${GUILD}/members/${MEMBER}/roles/${ROLE}`,
    );
    expect(recorded[0].auth).toBe("Bot test-token");
  });

  it("DELETEs the same path to opt out", async () => {
    expect(await setPingRole(MEMBER, false, cfg())).toBe("ok");
    expect(recorded[0].method).toBe("DELETE");
  });

  it("is idempotent — adding a role twice is not an error", async () => {
    await setPingRole(MEMBER, true, cfg());
    expect(await setPingRole(MEMBER, true, cfg())).toBe("ok");
  });

  it("distinguishes the failure an ADMIN has to fix", async () => {
    // 403 = the bot's own role sits below the ping role, so Discord refuses.
    // Retrying never fixes it; the message must say so rather than blaming
    // the player's click.
    respond = () => ({ status: 403, body: { code: 50013 } });
    expect(await setPingRole(MEMBER, true, cfg())).toBe("forbidden");
  });

  it("distinguishes a player who isn't in the server", async () => {
    respond = () => ({ status: 404, body: { code: 10007 } });
    expect(await setPingRole(MEMBER, true, cfg())).toBe("not-a-member");
  });

  it("degrades to a retryable failure instead of throwing", async () => {
    respond = () => ({ status: 500 });
    expect(await setPingRole(MEMBER, true, cfg())).toBe("failed");
    // and when Discord is simply unreachable:
    expect(
      await setPingRole(MEMBER, true, { ...cfg(), apiBase: "http://127.0.0.1:1" }),
    ).toBe("failed");
  });
});

describe("hasPingRole", () => {
  it("reads the member's live roles rather than a mirrored column", async () => {
    respond = () => ({ status: 200, body: { roles: [ROLE, "other"] } });
    expect(await hasPingRole(MEMBER, cfg())).toBe(true);
    expect(recorded[0].method).toBe("GET");
    expect(recorded[0].url).toBe(`/guilds/${GUILD}/members/${MEMBER}`);
  });

  it("is false when they hold other roles but not this one", async () => {
    respond = () => ({ status: 200, body: { roles: ["other"] } });
    expect(await hasPingRole(MEMBER, cfg())).toBe(false);
  });

  it("answers UNKNOWN, never false, when it cannot tell", async () => {
    // Guessing "off" would show an unticked box to someone already opted in —
    // they click it, nothing changes, and the feature looks broken.
    respond = () => ({ status: 404 }); // not in the server
    expect(await hasPingRole(MEMBER, cfg())).toBeNull();
    respond = () => ({ status: 500 }); // Discord having a bad day
    expect(await hasPingRole(MEMBER, cfg())).toBeNull();
    expect(
      await hasPingRole(MEMBER, { ...cfg(), apiBase: "http://127.0.0.1:1" }),
    ).toBeNull();
  });
});

describe("getPingHealth — the setup diagnostic", () => {
  beforeEach(async () => {
    process.env.DISCORD_API_BASE = base;
    await setSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID, ROLE);
  });

  /** Bot holds `botRole` at `botPos`; the ping role sits at `pingPos`. */
  const guild = (botPos: number, pingPos: number) => (r: Recorded) =>
    r.url.endsWith("/members/@me")
      ? {
          status: 200,
          body: { roles: ["botrole"], user: { username: "ggd2l" } },
        }
      : {
          status: 200,
          body: [
            { id: "botrole", name: "ggd2l", position: botPos },
            { id: ROLE, name: "Inhouse Ping", position: pingPos },
          ],
        };

  it("reports every piece present and grantable", async () => {
    respond = guild(5, 2);
    const h = await getPingHealth();
    expect(h).toMatchObject({
      hasToken: true,
      hasGuild: true,
      hasRole: true,
      botInGuild: true,
      roleExists: true,
      canGrant: true,
      botName: "ggd2l",
      roleName: "Inhouse Ping",
      problem: null,
    });
  });

  it("CATCHES the role-hierarchy mistake — the one nothing else warns about", async () => {
    // Bot below the ping role: Discord silently refuses every grant, and
    // without this the first symptom is a confused player days later.
    respond = guild(1, 9);
    const h = await getPingHealth();
    expect(h.botInGuild).toBe(true);
    expect(h.roleExists).toBe(true);
    expect(h.canGrant).toBe(false);
  });

  it("spots a role id that doesn't exist in this server", async () => {
    await setSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID, "111111111111111111");
    respond = guild(5, 2);
    const h = await getPingHealth();
    expect(h.roleExists).toBe(false);
    expect(h.canGrant).toBeNull();
  });

  it("spots a bot that was never invited", async () => {
    respond = () => ({ status: 404 });
    const h = await getPingHealth();
    expect(h.botInGuild).toBe(false);
  });

  it("names a bad token rather than blaming the config", async () => {
    respond = () => ({ status: 401 });
    const h = await getPingHealth();
    expect(h.problem).toMatch(/token/i);
  });

  it("reports missing env without calling Discord at all", async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    recorded = [];
    const h = await getPingHealth();
    expect(h.hasToken).toBe(false);
    expect(h.hasRole).toBe(true); // the role IS chosen; the token isn't set
    expect(h.botInGuild).toBeNull();
    expect(recorded).toHaveLength(0);
  });
});

describe("getDiscordReach — the denominator", () => {
  it("counts only ACTIVE registrations for the season", async () => {
    const season = await makeSeason({});
    const other = await makeSeason({});
    const linked = await makeUser("Linked");
    const plain = await makeUser("Plain");
    const withdrawn = await makeUser("Gone");
    const elsewhere = await makeUser("Elsewhere");
    await prisma.user.update({
      where: { id: linked.id },
      data: { discordId: "111222333444555666" },
    });
    const reg = (userId: string, seasonId: string, status: string) =>
      prisma.registration.create({
        data: { seasonId, userId, status, type: "PLAYER", mmr: 3000 },
      });
    await reg(linked.id, season.id, "ACTIVE");
    await reg(plain.id, season.id, "ACTIVE");
    await reg(withdrawn.id, season.id, "WITHDRAWN");
    await reg(elsewhere.id, other.id, "ACTIVE");

    const reach = await getDiscordReach(season.id);
    expect(reach.registered).toBe(2);
    expect(reach.linked).toBe(1);
    expect(reach.unlinkedNames).toEqual(["Plain"]);
  });

  it("is zero-safe with no season and makes no Discord calls", async () => {
    recorded = [];
    expect(await getDiscordReach(null)).toEqual({
      registered: 0,
      linked: 0,
      unlinkedNames: [],
    });
    expect(recorded).toHaveLength(0);
  });

  it("caps the name list so an unlinked league isn't a wall of text", async () => {
    const season = await makeSeason({});
    for (let i = 0; i < 15; i++) {
      const u = await makeUser(`P${i}`);
      await prisma.registration.create({
        data: {
          seasonId: season.id,
          userId: u.id,
          status: "ACTIVE",
          type: "PLAYER",
          mmr: 3000,
        },
      });
    }
    const reach = await getDiscordReach(season.id);
    expect(reach.registered).toBe(15);
    expect(reach.linked).toBe(0);
    expect(reach.unlinkedNames).toHaveLength(12);
  });
});
