import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MEMBERSHIP_MEMBER_TTL_MS,
  MEMBERSHIP_RECHECK_TTL_MS,
  _clearMembershipMemoForTests,
  discordReachWarning,
  fetchGuildMember,
  getDiscordReach,
  getDiscordReachFunnel,
  getGuildConfig,
  getPingHealth,
  getRoleConfig,
  guildMembership,
  joinGuild,
  hasPingRole,
  memoGuildMembership,
  pingOptInAvailable,
  primeMembershipMemo,
  setPingRole,
  sweepGuildMemberships,
  type DiscordReachFunnel,
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

type Recorded = {
  method: string;
  url: string;
  auth: string | undefined;
  /** Raw request body — joinGuild sends the user's token in it. */
  body: string;
};

let server: Server;
let base: string;
let recorded: Recorded[] = [];
let respond: (r: Recorded) => {
  status: number;
  body?: unknown;
  /** Extra response headers — the rate-pacing tests speak X-RateLimit-*. */
  headers?: Record<string, string>;
};

const GUILD = "900000000000000001";
const ROLE = "900000000000000002";
const MEMBER = "900000000000000003";

beforeAll(async () => {
  server = createServer((req, res) => {
    // Buffer rather than drain: joinGuild's whole contract is that the user's
    // OAuth token rides in the BODY while the bot token is in the header, and
    // a test that can't see the body can't tell those apart.
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const entry = {
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: raw,
      };
      recorded.push(entry);
      const out = respond(entry);
      res.writeHead(out.status, {
        "content-type": "application/json",
        ...(out.headers ?? {}),
      });
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
  // The membership memo is process-global; a "member" cached by one test
  // would answer for a different test's stand-in responses.
  _clearMembershipMemoForTests();
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

  const BOT_USER = "900000000000000009";
  const MANAGE_ROLES = "268435456";

  /** Bot holds `botRole` at `botPos`; the ping role sits at `pingPos`. */
  const guild =
    (botPos: number, pingPos: number, perms = MANAGE_ROLES) =>
    (r: Recorded) => {
      if (r.url === "/users/@me") {
        return { status: 200, body: { id: BOT_USER, username: "ggd2l" } };
      }
      if (r.url.endsWith(`/members/${BOT_USER}`)) {
        return { status: 200, body: { roles: ["botrole"] } };
      }
      return {
        status: 200,
        body: [
          { id: GUILD, name: "@everyone", position: 0, permissions: "0" },
          { id: "botrole", name: "ggd2l", position: botPos, permissions: perms },
          { id: ROLE, name: "Inhouse Ping", position: pingPos, permissions: "0" },
        ],
      };
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
    respond = (r) =>
      r.url === "/users/@me"
        ? { status: 200, body: { id: BOT_USER, username: "ggd2l" } }
        : { status: 404 };
    const h = await getPingHealth();
    expect(h.botInGuild).toBe(false);
  });

  it("NEVER treats a non-2xx JSON body as data", async () => {
    // The bug this replaces: GET /guilds/{id}/members/@me is not a route —
    // it 400s with a perfectly valid JSON error body. Parsing that as a member
    // object left roles undefined, so the bot's height defaulted to 0 and
    // "can grant" was false on EVERY server, while reporting "bot in server".
    respond = (r) =>
      r.url === "/users/@me"
        ? { status: 200, body: { id: BOT_USER, username: "ggd2l" } }
        : {
            status: 400,
            body: {
              code: 50035,
              errors: { user_id: 'Value "@me" is not snowflake.' },
            },
          };
    const h = await getPingHealth();
    expect(h.canGrant).not.toBe(false); // must NOT assert a failure it can't see
    expect(h.problem).toBeTruthy();
  });

  it("asks who it is before looking itself up — @me has no GET form", async () => {
    respond = guild(9, 5);
    await getPingHealth();
    expect(recorded[0].url).toBe("/users/@me");
    expect(recorded.some((r) => r.url.endsWith("/members/@me"))).toBe(false);
    expect(recorded.some((r) => r.url.endsWith(`/members/${BOT_USER}`))).toBe(
      true,
    );
  });

  it("refuses when the bot lacks Manage Roles, even if it sits higher", async () => {
    respond = guild(9, 5, "0");
    const h = await getPingHealth();
    expect(h.hasManageRoles).toBe(false);
    expect(h.canGrant).toBe(false);
  });

  it("treats an equal position as not grantable — Discord requires strictly higher", async () => {
    respond = guild(5, 5);
    const h = await getPingHealth();
    expect(h.canGrant).toBe(false);
  });

  it("reports the raw positions so a wrong verdict can't hide", async () => {
    respond = guild(9, 5);
    const h = await getPingHealth();
    expect(h.botTopPosition).toBe(9);
    expect(h.rolePosition).toBe(5);
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

  it("diagnoses the bot WITHOUT a ping role — the membership funnel depends on it", async () => {
    // Bot-without-role is an explicitly supported config (getGuildConfig's
    // doc), and it can run the guild-membership sweep — so when that sweep
    // reads all-unknown because the bot was kicked or the guild id is wrong,
    // THIS is the surface that has to say so. Gating everything on the role
    // id left exactly that league with no diagnosis at all.
    await setSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID, "");
    respond = guild(5, 2);
    const h = await getPingHealth();
    expect(h.hasRole).toBe(false);
    expect(h.botInGuild).toBe(true);
    // false, not null: the guild() fixture grants Manage Roles but not
    // Create Instant Invite — a REAL verdict here is exactly the point,
    // because null is what the old role-gated version returned.
    expect(h.canInvite).toBe(false);
    expect(h.hasManageRoles).toBe(true);
    // Role rows stay null — there is nothing to look for, and false would
    // read as "your role is missing" to an admin who never chose one.
    expect(h.roleExists).toBeNull();
    expect(h.canGrant).toBeNull();
  });

  it("spots a bot that was never invited even with no role chosen", async () => {
    await setSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID, "");
    respond = (r) =>
      r.url === "/users/@me"
        ? { status: 200, body: { id: BOT_USER, username: "ggd2l" } }
        : { status: 404 };
    const h = await getPingHealth();
    expect(h.botInGuild).toBe(false);
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

// The OAuth guild-join. Shipped with only a mocked dep in discord-link.itest,
// which cannot catch the class of bug that has already bitten this file once:
// branching on a STATUS whose meaning is counter-intuitive. Here 204 means
// "already a member" (success), not failure, and 201 has to be read for
// `pending` before it can be called success either.
describe("joinGuild (OAuth guilds.join)", () => {
  const guildCfg = () => ({ token: "test-token", guildId: GUILD, apiBase: base });

  it("PUTs the member with the BOT token in the header and the USER token in the body", async () => {
    respond = () => ({ status: 201, body: { pending: false } });
    const out = await joinGuild(MEMBER, "user-access-token", guildCfg());

    expect(out).toBe("joined");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("PUT");
    expect(recorded[0].url).toBe(`/guilds/${GUILD}/members/${MEMBER}`);
    // Bot token authenticates the ADDER; the user's token is their consent.
    // Neither alone works, so both must be on the wire.
    expect(recorded[0].auth).toBe("Bot test-token");
    expect(JSON.parse(recorded[0].body)).toEqual({
      access_token: "user-access-token",
    });
  });

  // Membership Screening leaves them in the guild but unable to read, talk or
  // be pinged. Reporting that as a clean success is how a player ends up
  // believing they're reachable while no notification can arrive.
  it("reports membership screening rather than claiming success", async () => {
    respond = () => ({ status: 201, body: { pending: true } });
    expect(await joinGuild(MEMBER, "tok", guildCfg())).toBe("joined-pending");
  });

  it("treats 204 as ALREADY a member — the normal case for anyone who used the invite", async () => {
    respond = () => ({ status: 204 });
    expect(await joinGuild(MEMBER, "tok", guildCfg())).toBe("already");
  });

  it("survives a 201 with no parseable body", async () => {
    respond = () => ({ status: 201, body: null });
    expect(await joinGuild(MEMBER, "tok", guildCfg())).toBe("joined");
  });

  // 403 is the admin's problem and never resolves by retrying: the bot lacks
  // CREATE_INSTANT_INVITE, or the token is from a different application than
  // the OAuth client. It has to stay distinguishable from a transient failure.
  it("distinguishes a permanent 403 from a transient failure", async () => {
    respond = () => ({ status: 403, body: { message: "Missing Permissions" } });
    expect(await joinGuild(MEMBER, "tok", guildCfg())).toBe("forbidden");

    respond = () => ({ status: 500 });
    expect(await joinGuild(MEMBER, "tok", guildCfg())).toBe("failed");
  });

  it("never throws when Discord is unreachable", async () => {
    expect(
      await joinGuild(MEMBER, "tok", {
        token: "test-token",
        guildId: GUILD,
        apiBase: "http://127.0.0.1:1",
      }),
    ).toBe("failed");
  });
});

describe("getGuildConfig", () => {
  // The distinction that matters: getRoleConfig returns null without a ping
  // role, and gating the guild-join on THAT would silently disable joining on
  // any league that simply hasn't picked one.
  it("needs only token + guild, unlike getRoleConfig", async () => {
    expect(await getRoleConfig()).toBeNull(); // no role set in this test
    expect(getGuildConfig()).toEqual({ token: "test-token", guildId: GUILD });
  });

  it("is null without a bot token", async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    expect(getGuildConfig()).toBeNull();
  });

  it("is null without a guild", async () => {
    delete process.env.DISCORD_GUILD_ID;
    expect(getGuildConfig()).toBeNull();
  });
});

// "Is this player actually in the server?" — the check behind the /me card,
// the dashboard join nag and the admin funnel. The whole hazard is the 404:
// this endpoint 404s BOTH for "player not in the guild" (code 10007) and for
// "the BOT isn't in the guild / wrong guild id" (code 10004), and reading the
// second as the first would tell every player in the league they left a
// server they're sitting in. Branch on the body, never the status — the
// lesson this file has now learned three times.
describe("guildMembership / fetchGuildMember", () => {
  const guildCfg = () => ({ token: "test-token", guildId: GUILD, apiBase: base });

  it("reads a full member from the same lookup hasPingRole uses", async () => {
    respond = () => ({ status: 200, body: { pending: false, roles: [ROLE] } });
    expect(await guildMembership(MEMBER, guildCfg())).toBe("member");
    expect(recorded[0].method).toBe("GET");
    expect(recorded[0].url).toBe(`/guilds/${GUILD}/members/${MEMBER}`);
    expect(recorded[0].auth).toBe("Bot test-token");
  });

  it("keeps Membership Screening distinct — pending members can't be pinged", async () => {
    respond = () => ({ status: 200, body: { pending: true, roles: [] } });
    expect(await guildMembership(MEMBER, guildCfg())).toBe("pending");
  });

  it("treats 404 Unknown Member as definitively not in the server", async () => {
    respond = () => ({ status: 404, body: { code: 10007 } });
    expect(await guildMembership(MEMBER, guildCfg())).toBe("not-member");
  });

  it("treats 404 Unknown User (deleted account) as not in the server", async () => {
    respond = () => ({ status: 404, body: { code: 10013 } });
    expect(await guildMembership(MEMBER, guildCfg())).toBe("not-member");
  });

  it("NEVER reads a 404 Unknown Guild as a player who left", async () => {
    // The bot is missing or DISCORD_GUILD_ID is wrong — our problem. Calling
    // that "not-member" would nag the whole league to re-join at once.
    respond = () => ({ status: 404, body: { code: 10004 } });
    expect(await guildMembership(MEMBER, guildCfg())).toBeNull();
    // ...and a 404 with no code proves nothing either.
    respond = () => ({ status: 404 });
    expect(await guildMembership(MEMBER, guildCfg())).toBeNull();
  });

  it("answers unknown on server errors and when unreachable", async () => {
    respond = () => ({ status: 500 });
    expect(await guildMembership(MEMBER, guildCfg())).toBeNull();
    expect(
      await guildMembership(MEMBER, { ...guildCfg(), apiBase: "http://127.0.0.1:1" }),
    ).toBeNull();
  });

  it("hands /me the roles from the same single request", async () => {
    respond = () => ({ status: 200, body: { pending: false, roles: [ROLE] } });
    const info = await fetchGuildMember(MEMBER, guildCfg());
    expect(info).toEqual({ membership: "member", roles: [ROLE] });
    expect(recorded).toHaveLength(1);
  });
});

// The member-route pacing. On the first production sweep exactly one
// bucket's worth of lookups answered and the other eleven burned into 429s —
// "couldn't check 11" on the one card the admin reads before the draft.
describe("member lookup rate pacing", () => {
  const guildCfg = () => ({ token: "test-token", guildId: GUILD, apiBase: base });
  const MEMBER_OK = { status: 200, body: { pending: false, roles: [] } };

  it("honors retry_after on a 429 and completes on the single retry", async () => {
    let calls = 0;
    respond = () =>
      ++calls === 1
        ? { status: 429, body: { retry_after: 0.05, global: false } }
        : MEMBER_OK;
    expect(await guildMembership(MEMBER, guildCfg())).toBe("member");
    expect(recorded).toHaveLength(2);
  });

  it("gives up as unknown when Discord asks for a longer wait than the cap", async () => {
    // A 30s retry_after must not dangle a render — and must not be answered
    // with a second request that is a guaranteed 429.
    respond = () => ({ status: 429, body: { retry_after: 30 } });
    expect(await guildMembership(MEMBER, guildCfg())).toBeNull();
    expect(recorded).toHaveLength(1);
  });

  it("paces the NEXT lookup off the rate headers instead of burning it into a 429", async () => {
    // The stand-in enforces its own bucket: the first response announces
    // empty-until-t, and a second request arriving BEFORE t gets a 429.
    // Without the proactive gate the client would eat that 429 and pay a
    // third request on retry — so asserting exactly two requests is what
    // proves the pacing, not just the outcome.
    let notBefore = 0;
    respond = () => {
      if (notBefore === 0) {
        notBefore = Date.now() + 60;
        return {
          ...MEMBER_OK,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset-after": "0.06",
          },
        };
      }
      return Date.now() < notBefore
        ? { status: 429, body: { retry_after: 0.06 } }
        : MEMBER_OK;
    };
    const A = "800000000000000031";
    const B = "800000000000000032";
    expect(await memoGuildMembership(A, guildCfg(), 1000)).toBe("member");
    expect(await memoGuildMembership(B, guildCfg(), 1000)).toBe("member");
    expect(recorded).toHaveLength(2);
  });

  it("a rate-limited burst completes within one sweep instead of leaving a tail unknown", async () => {
    // The production shape: a bucket of 5 per window against a 12-player
    // sweep. Every id must classify on the first pass — pacing, not luck.
    const WINDOW_MS = 60;
    let windowStart = Date.now();
    let used = 0;
    respond = () => {
      const now = Date.now();
      if (now - windowStart >= WINDOW_MS) {
        windowStart = now;
        used = 0;
      }
      if (++used > 5) {
        return {
          status: 429,
          body: { retry_after: (windowStart + WINDOW_MS - now) / 1000 },
        };
      }
      return used === 5
        ? {
            ...MEMBER_OK,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset-after": String(
                (windowStart + WINDOW_MS - now) / 1000,
              ),
            },
          }
        : MEMBER_OK;
    };
    const ids = Array.from({ length: 12 }, (_, i) => `8000000000000001${String(i).padStart(2, "0")}`);
    const out = await sweepGuildMemberships(ids, guildCfg());
    const unknowns = ids.filter((id) => out.get(id) === null);
    expect(unknowns).toEqual([]);
    expect([...out.values()].every((v) => v === "member")).toBe(true);
  });
});

describe("memoGuildMembership — bounding the hot-path cost", () => {
  const guildCfg = () => ({ token: "test-token", guildId: GUILD, apiBase: base });

  it("serves repeats from the memo instead of re-asking Discord", async () => {
    respond = () => ({ status: 200, body: { roles: [] } });
    expect(await memoGuildMembership(MEMBER, guildCfg(), 1000)).toBe("member");
    expect(await memoGuildMembership(MEMBER, guildCfg(), 1000)).toBe("member");
    expect(recorded).toHaveLength(1);
  });

  it("re-checks a non-member quickly but holds a member for minutes", async () => {
    // The asymmetry is the point: a not-member is mid-fix (they just clicked
    // Join), so the nag must notice the join fast; a member going stale only
    // means a leaver keeps a green badge slightly longer.
    respond = () => ({ status: 404, body: { code: 10007 } });
    expect(await memoGuildMembership(MEMBER, guildCfg(), 1000)).toBe("not-member");
    respond = () => ({ status: 200, body: { roles: [] } });
    // Inside the recheck window: still the cached answer, no new request.
    expect(
      await memoGuildMembership(MEMBER, guildCfg(), 1000 + MEMBERSHIP_RECHECK_TTL_MS - 1),
    ).toBe("not-member");
    expect(recorded).toHaveLength(1);
    // Past it: the join they just completed becomes visible.
    const t2 = 1000 + MEMBERSHIP_RECHECK_TTL_MS + 1;
    expect(await memoGuildMembership(MEMBER, guildCfg(), t2)).toBe("member");
    expect(recorded).toHaveLength(2);
    // A member is NOT re-checked at the recheck cadence...
    expect(
      await memoGuildMembership(MEMBER, guildCfg(), t2 + MEMBERSHIP_RECHECK_TTL_MS + 1),
    ).toBe("member");
    expect(recorded).toHaveLength(2);
    // ...only once the longer member TTL lapses.
    await memoGuildMembership(MEMBER, guildCfg(), t2 + MEMBERSHIP_MEMBER_TTL_MS + 1);
    expect(recorded).toHaveLength(3);
  });

  it("dedupes CONCURRENT lookups — /admin's two funnel consumers, one request", async () => {
    // The Discord card and the Start-draft confirm both sweep the same season
    // in the same request. A result-only memo can't help: on a cold cache both
    // fire before either writes, doubling the burst for every player at once.
    respond = () => ({ status: 200, body: { roles: [] } });
    const [a, b] = await Promise.all([
      memoGuildMembership(MEMBER, guildCfg(), 1000),
      memoGuildMembership(MEMBER, guildCfg(), 1000),
    ]);
    expect(a).toBe("member");
    expect(b).toBe("member");
    expect(recorded).toHaveLength(1);
  });

  it("primeMembershipMemo makes a fresh live answer visible to the memo", async () => {
    // /me does its own live lookup; priming keeps the dashboard nag from
    // contradicting what the profile page just showed.
    primeMembershipMemo(MEMBER, "member", 1000);
    expect(await memoGuildMembership(MEMBER, guildCfg(), 2000)).toBe("member");
    expect(recorded).toHaveLength(0);
  });

  it("an answer primed mid-flight is not clobbered by the older request resolving", async () => {
    // /me's live read can land while an admin sweep's request for the same
    // player is still on the wire; the sweep resolving later must not
    // overwrite the fresher answer. (The prime runs synchronously after the
    // lookup starts, so the ordering is deterministic — network completion
    // can't be processed before this tick yields.)
    respond = () => ({ status: 404, body: { code: 10007 } });
    const older = memoGuildMembership(MEMBER, guildCfg(), 1000); // in flight
    primeMembershipMemo(MEMBER, "member", 2000); // fresher live answer lands
    expect(await older).toBe("not-member"); // the caller still gets its truth
    expect(await memoGuildMembership(MEMBER, guildCfg(), 3000)).toBe("member");
    expect(recorded).toHaveLength(1);
  });

  it("a null prime is IGNORED — one failed /me lookup must not erase a real answer", async () => {
    // The dashboard nag renders from this memo; letting a Discord hiccup on
    // /me overwrite a valid "not-member" would blank the nag for a player who
    // still needs it.
    primeMembershipMemo(MEMBER, "not-member", 1000);
    primeMembershipMemo(MEMBER, null, 2000);
    expect(await memoGuildMembership(MEMBER, guildCfg(), 3000)).toBe("not-member");
    expect(recorded).toHaveLength(0);
  });
});

describe("sweepGuildMemberships", () => {
  const guildCfg = () => ({ token: "test-token", guildId: GUILD, apiBase: base });
  const A = "800000000000000001";
  const B = "800000000000000002";
  const C = "800000000000000003";

  it("classifies each player independently and degrades failures per-id", async () => {
    respond = (r) => {
      if (r.url.endsWith(`/members/${A}`)) return { status: 200, body: { roles: [] } };
      if (r.url.endsWith(`/members/${B}`)) return { status: 404, body: { code: 10007 } };
      return { status: 500 };
    };
    const out = await sweepGuildMemberships([A, B, C], guildCfg());
    expect(out.get(A)).toBe("member");
    expect(out.get(B)).toBe("not-member");
    expect(out.get(C)).toBeNull(); // unknown — never inferred from neighbours
  });

  it("dedupes ids so one player never costs two requests", async () => {
    respond = () => ({ status: 200, body: { roles: [] } });
    await sweepGuildMemberships([A, A, A], guildCfg());
    expect(recorded).toHaveLength(1);
  });

  it("stops fetching at the aggregate deadline and reports the rest as unknown", async () => {
    // The per-call 4s timeout compounds across serial batches — a hanging
    // Discord must not dangle the streamed admin section for ceil(N/4)×4s.
    // Deadline 0 = the budget is already spent: every id must come back
    // null (the funnel's honest "couldn't check"), with ZERO requests made,
    // and never a fabricated not-member.
    respond = () => ({ status: 200, body: { roles: [] } });
    const out = await sweepGuildMemberships([A, B, C], guildCfg(), 1000, 0);
    expect(recorded).toHaveLength(0);
    expect(out.get(A)).toBeNull();
    expect(out.get(B)).toBeNull();
    expect(out.get(C)).toBeNull();
  });
});

describe("getDiscordReachFunnel — the admin's pre-draft denominator", () => {
  const link = (userId: string, discordId: string) =>
    prisma.user.update({ where: { id: userId }, data: { discordId } });
  const reg = (userId: string, seasonId: string) =>
    prisma.registration.create({
      data: { seasonId, userId, status: "ACTIVE", type: "PLAYER", mmr: 3000 },
    });

  it("reports guild:null and makes NO Discord calls without a bot", async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    const season = await makeSeason({});
    const u = await makeUser("Linked");
    await link(u.id, "800000000000000010");
    await reg(u.id, season.id);
    const funnel = await getDiscordReachFunnel(season.id);
    expect(funnel.guild).toBeNull();
    expect(funnel.linked).toBe(1);
    expect(recorded).toHaveLength(0);
  });

  it("splits the linked into in-server / pending / missing / unknown, by name", async () => {
    process.env.DISCORD_API_BASE = base;
    const season = await makeSeason({});
    const ids = {
      In: "800000000000000021",
      Pending: "800000000000000022",
      Gone: "800000000000000023",
      Fuzzy: "800000000000000024",
    } as const;
    for (const [name, discordId] of Object.entries(ids)) {
      const u = await makeUser(name);
      await link(u.id, discordId);
      await reg(u.id, season.id);
    }
    const plain = await makeUser("Unlinked");
    await reg(plain.id, season.id);
    respond = (r) => {
      if (r.url.endsWith(`/members/${ids.In}`))
        return { status: 200, body: { roles: [] } };
      if (r.url.endsWith(`/members/${ids.Pending}`))
        return { status: 200, body: { pending: true, roles: [] } };
      if (r.url.endsWith(`/members/${ids.Gone}`))
        return { status: 404, body: { code: 10007 } };
      return { status: 500 };
    };
    const funnel = await getDiscordReachFunnel(season.id);
    expect(funnel.registered).toBe(5);
    expect(funnel.linked).toBe(4);
    expect(funnel.unlinkedNames).toEqual(["Unlinked"]);
    expect(funnel.guild).toEqual({
      inServer: 1,
      pending: 1,
      pendingNames: ["Pending"],
      missing: 1,
      missingNames: ["Gone"],
      unknown: 1,
    });
  });

  it("never counts an unanswered player as missing", async () => {
    // Discord down must read as "couldn't check", not "everyone left".
    process.env.DISCORD_API_BASE = base;
    const season = await makeSeason({});
    for (let i = 0; i < 3; i++) {
      const u = await makeUser(`P${i}`);
      await link(u.id, `80000000000000010${i}`);
      await reg(u.id, season.id);
    }
    respond = () => ({ status: 500 });
    const funnel = await getDiscordReachFunnel(season.id);
    expect(funnel.guild?.missing).toBe(0);
    expect(funnel.guild?.missingNames).toEqual([]);
    expect(funnel.guild?.unknown).toBe(3);
  });
});

describe("discordReachWarning — the Start-draft confirm line", () => {
  const funnel = (over: Partial<DiscordReachFunnel>): DiscordReachFunnel => ({
    registered: 10,
    linked: 10,
    unlinkedNames: [],
    guild: {
      inServer: 10,
      pending: 0,
      pendingNames: [],
      missing: 0,
      missingNames: [],
      unknown: 0,
    },
    ...over,
  });

  it("is EMPTY when everyone is linked and in the server", () => {
    expect(discordReachWarning(funnel({}))).toBe("");
    // ...and empty with no bot and full linkage — byte-identical confirm to
    // what shipped before this feature existed.
    expect(discordReachWarning(funnel({ guild: null }))).toBe("");
  });

  it("names the missing and pending, counts the never-linked", () => {
    const line = discordReachWarning(
      funnel({
        registered: 10,
        linked: 8,
        unlinkedNames: ["H", "I"],
        guild: {
          inServer: 5,
          pending: 1,
          pendingNames: ["Percy"],
          missing: 2,
          missingNames: ["Alice", "Bob"],
          unknown: 0,
        },
      }),
    );
    expect(line).toContain("2 are not in the Discord server (Alice, Bob)");
    expect(line).toContain("1 hasn't accepted the server rules (Percy)");
    expect(line).toContain("2 never linked Discord at all");
    // Counts only for the unlinked — their names live on the Discord card.
    expect(line).not.toContain("H, I");
  });

  it("reports unanswerable players as a caveat, never as missing — and never claims a cause", () => {
    const line = discordReachWarning(
      funnel({
        guild: {
          inServer: 8,
          pending: 0,
          pendingNames: [],
          missing: 0,
          missingNames: [],
          unknown: 2,
        },
      }),
    );
    expect(line).toContain(
      "2 couldn't be checked (the Discord notifications card has the diagnosis)",
    );
    expect(line).not.toContain("not in the Discord server");
    // "didn't answer" would be a lie for a kicked bot / wrong guild id, which
    // produce exactly this state permanently; the confirm must not diagnose.
    expect(line).not.toContain("didn't answer");
  });

  it("still warns about the unlinked when no bot is configured", () => {
    const line = discordReachWarning(
      funnel({ registered: 10, linked: 6, guild: null }),
    );
    expect(line).toContain("4 never linked Discord at all");
  });

  it("caps the name run so the confirm stays a dialog", () => {
    const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const line = discordReachWarning(
      funnel({
        guild: {
          inServer: 2,
          pending: 0,
          pendingNames: [],
          missing: 8,
          missingNames: names,
          unknown: 0,
        },
      }),
    );
    expect(line).toContain("A, B, C, D, E, F +2 more");
    expect(line).not.toContain("G");
  });
});
