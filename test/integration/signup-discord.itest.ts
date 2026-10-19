import { createServer, type Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Discord before a signup (src/lib/signup-discord.ts), driven through the real
// saveRegistration against the test DB, with the membership lookup over REAL
// HTTP to a stand-in for Discord's member route. Session, revalidation,
// OpenDota and the signup post are stubbed, as in registration.itest.ts.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchPlayerRankTier: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { saveRegistration } from "@/app/actions/registration";
import { requireUser } from "@/lib/auth";
import { fetchPlayerRankTier } from "@/lib/dota";
import {
  _clearMembershipMemoForTests,
  primeMembershipMemo,
} from "@/lib/discord-roles";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import { makeSeason, makeUser, sessionFor } from "./factories";

const GUILD = "910000000000000001";

type Recorded = { method: string; url: string };
let server: Server;
let base: string;
let recorded: Recorded[] = [];
/** Discord's answer for one member id. */
let answerFor: (discordId: string) => { status: number; body?: unknown } = () => ({
  status: 200,
  body: { roles: [] },
});

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "" };
      recorded.push(entry);
      const id = entry.url.match(/\/members\/(\d+)$/)?.[1] ?? "";
      const out = answerFor(id);
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
  answerFor = () => ({ status: 200, body: { roles: [] } });
  // Linking and the bot both configured, as both leagues run.
  vi.stubEnv("DISCORD_CLIENT_ID", "signup-discord-client");
  vi.stubEnv("DISCORD_CLIENT_SECRET", "signup-discord-secret");
  vi.stubEnv("DISCORD_BOT_TOKEN", "signup-discord-bot");
  vi.stubEnv("DISCORD_GUILD_ID", GUILD);
  vi.stubEnv("DISCORD_API_BASE", base);
  _clearMembershipMemoForTests();
  vi.mocked(requireUser).mockReset();
  vi.mocked(fetchPlayerRankTier).mockReset();
  vi.mocked(fetchPlayerRankTier).mockResolvedValue(null);
});

afterEach(() => {
  setRaceHook(null);
  vi.unstubAllEnvs();
});

function form(fields: Record<string, string | number>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
}

const PLAYER = { type: "PLAYER", mmr: 3000, roles: "2" };

// Strings: an 18-digit snowflake is past 2^53, where `n++` stops counting.
let snowflakeSeq = 0;
const nextSnowflake = () => `92000000000000${String(snowflakeSeq++).padStart(4, "0")}`;
/** A signed-in player, linked to a fresh Discord account unless `linked` is false. */
async function signIn(name: string, linked = true) {
  const user = await makeUser(name);
  const discordId = linked ? nextSnowflake() : null;
  const stored = linked
    ? await prisma.user.update({
        where: { id: user.id },
        data: { discordId, discordName: name.toLowerCase().replace(/\W/g, "") },
      })
    : user;
  vi.mocked(requireUser).mockResolvedValue(sessionFor(stored));
  return { user: stored, discordId };
}

async function signupOf(seasonId: string, userId: string) {
  return prisma.registration.findUnique({
    where: { seasonId_userId: { seasonId, userId } },
  });
}

const memberLookups = () =>
  recorded.filter((r) => r.method === "GET" && r.url.includes(`/guilds/${GUILD}/members/`));

describe("saveRegistration — Discord before a signup", () => {
  it("refuses an unlinked newcomer before spending an OpenDota call, and stores nothing", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const { user } = await signIn("Unlinked Newcomer", false);

    const result = await saveRegistration({}, form(PLAYER));

    expect(result?.error).toMatch(/^Link your Discord first/);
    expect(await signupOf(season.id, user.id)).toBeNull();
    // Without the gate this player has no medal on file, so the action would
    // claim the cooldown and ask OpenDota.
    expect(vi.mocked(fetchPlayerRankTier)).not.toHaveBeenCalled();
    expect(memberLookups()).toHaveLength(0);
  });

  it("admits a linked account that is in the server, with one live lookup", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const { user, discordId } = await signIn("Linked Member");

    const result = await saveRegistration({}, form(PLAYER));

    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(/^You're signed up!/);
    expect((await signupOf(season.id, user.id))?.status).toBe("ACTIVE");
    expect(memberLookups().map((r) => r.url)).toEqual([
      `/guilds/${GUILD}/members/${discordId}`,
    ]);
  });

  it("refuses a linked account that isn't in the server", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const { user } = await signIn("Not In Server");
    answerFor = () => ({ status: 404, body: { code: 10007, message: "Unknown Member" } });

    const result = await saveRegistration({}, form(PLAYER));

    expect(result?.error).toBe(
      "Your linked Discord account isn't in the league's server yet. Join the server, then sign up.",
    );
    expect(await signupOf(season.id, user.id)).toBeNull();
    expect(vi.mocked(fetchPlayerRankTier)).not.toHaveBeenCalled();
  });

  it("refuses a member still behind the server's rules screen", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const { user } = await signIn("Rules Pending");
    answerFor = () => ({ status: 200, body: { roles: [], pending: true } });

    const result = await saveRegistration({}, form(PLAYER));

    expect(result?.error).toMatch(/^Accept the rules in the league's Discord server, then sign up/);
    expect(await signupOf(season.id, user.id)).toBeNull();
  });

  it("lets the signup through when Discord can't say", async () => {
    // A Discord outage, and a bot missing from the server (Unknown Guild):
    // neither may close signups, and the link is still required.
    const season = await makeSeason({ status: "SIGNUPS" });
    const outage = await signIn("Discord Outage");
    answerFor = () => ({ status: 500 });
    expect((await saveRegistration({}, form(PLAYER)))?.error).toBeUndefined();
    expect((await signupOf(season.id, outage.user.id))?.status).toBe("ACTIVE");

    const kicked = await signIn("Bot Kicked");
    answerFor = () => ({ status: 404, body: { code: 10004, message: "Unknown Guild" } });
    expect((await saveRegistration({}, form(PLAYER)))?.error).toBeUndefined();
    expect((await signupOf(season.id, kicked.user.id))?.status).toBe("ACTIVE");
  });

  it("reads membership live, so a player who just joined isn't refused by a stale memo", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const { user, discordId } = await signIn("Just Joined");
    // /me's last render cached "not-member" seconds ago; they have since
    // joined with the invite.
    primeMembershipMemo(discordId!, "not-member");

    const result = await saveRegistration({}, form(PLAYER));

    expect(result?.error).toBeUndefined();
    expect((await signupOf(season.id, user.id))?.status).toBe("ACTIVE");
    expect(memberLookups()).toHaveLength(1);
  });

  it("asks only for the link where no bot can check the server", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    const season = await makeSeason({ status: "SIGNUPS" });
    const linked = await signIn("Linked No Bot");
    expect((await saveRegistration({}, form(PLAYER)))?.error).toBeUndefined();
    expect((await signupOf(season.id, linked.user.id))?.status).toBe("ACTIVE");
    expect(recorded).toHaveLength(0);

    const unlinked = await signIn("Unlinked No Bot", false);
    expect((await saveRegistration({}, form(PLAYER)))?.error).toMatch(/^Link your Discord first/);
    expect(await signupOf(season.id, unlinked.user.id)).toBeNull();
  });

  it("requires nothing where accounts can't be linked", async () => {
    vi.stubEnv("DISCORD_CLIENT_SECRET", "");
    const season = await makeSeason({ status: "SIGNUPS" });
    const { user } = await signIn("No Linking Here", false);

    expect((await saveRegistration({}, form(PLAYER)))?.error).toBeUndefined();
    expect((await signupOf(season.id, user.id))?.status).toBe("ACTIVE");
    expect(recorded).toHaveLength(0);
  });

  it("leaves an admitted signup's edits alone", async () => {
    // Signed up before the rule, or unlinked since: their form keeps saving.
    const season = await makeSeason({ status: "SIGNUPS" });
    const { user } = await signIn("Admitted Before", false);
    await prisma.registration.create({
      data: { seasonId: season.id, userId: user.id, type: "PLAYER", mmr: 3000, status: "ACTIVE" },
    });

    const result = await saveRegistration({}, form({ ...PLAYER, roles: "3" }));

    expect(result?.message).toMatch(/^Signup updated/);
    expect((await signupOf(season.id, user.id))?.roles).toBe("3");
    expect(recorded).toHaveLength(0);
  });

  it("judges a withdrawn player coming back as a new signup", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const { user } = await signIn("Withdrawn Returner", false);
    await prisma.registration.create({
      data: { seasonId: season.id, userId: user.id, type: "PLAYER", mmr: 3000, status: "WITHDRAWN" },
    });

    const result = await saveRegistration({}, form(PLAYER));

    expect(result?.error).toMatch(/^Link your Discord first/);
    expect((await signupOf(season.id, user.id))?.status).toBe("WITHDRAWN");
  });

  it("covers standin signups after player signups close", async () => {
    const season = await makeSeason({ status: "REGULAR_SEASON" });
    const unlinked = await signIn("Late Standin", false);
    expect(
      (await saveRegistration({}, form({ type: "STANDIN", mmr: 2500 })))?.error,
    ).toMatch(/^Link your Discord first/);
    expect(await signupOf(season.id, unlinked.user.id)).toBeNull();

    const linked = await signIn("Linked Late Standin");
    expect(
      (await saveRegistration({}, form({ type: "STANDIN", mmr: 2500 })))?.message,
    ).toMatch(/^Registered as a standin/);
    expect((await signupOf(season.id, linked.user.id))?.type).toBe("STANDIN");
  });

  it("refuses when the account it judged is unlinked before the write", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const { user } = await signIn("Unlinks Mid Submit");
    let fired = false;
    setRaceHook(
      onceAt("registration.saveRegistration.beforeWrite", async () => {
        fired = true;
        await prisma.user.update({
          where: { id: user.id },
          data: { discordId: null, discordName: "" },
        });
      }),
    );

    const result = await saveRegistration({}, form(PLAYER));

    expect(fired).toBe(true);
    expect(result?.error).toBe(
      "Your Discord link changed while you submitted — check the Discord card, then try again.",
    );
    expect(await signupOf(season.id, user.id)).toBeNull();
  });

  it("refuses when the account is re-linked to one nobody checked", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const { user } = await signIn("Relinks Mid Submit");
    let fired = false;
    setRaceHook(
      onceAt("registration.saveRegistration.beforeWrite", async () => {
        fired = true;
        await prisma.user.update({
          where: { id: user.id },
          data: { discordId: nextSnowflake() },
        });
      }),
    );

    const result = await saveRegistration({}, form(PLAYER));

    expect(fired).toBe(true);
    expect(result?.error).toMatch(/^Your Discord link changed while you submitted/);
    expect(await signupOf(season.id, user.id)).toBeNull();
  });
});
