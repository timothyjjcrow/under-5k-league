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

// The Discord "Standin" role (Tim's call, 2026-11-17), over REAL HTTP against
// a stand-in for Discord: who the automatic passes give it to and take it
// from, that a quiet league costs no request, and that the admin's "Sync
// Standin role now" reads every member live and fixes what differs. The
// actions that move the role run for real; only the request scope, auth and
// league posts are stubbed.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({
    id: "standin-role-admin",
    name: "Standin Role Admin",
    role: "ADMIN",
    steamId: "76561198000000001",
    avatar: null,
  })),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(async () => ({
    id: "standin-role-admin",
    name: "Standin Role Admin",
  })),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendDiscordMessage: vi.fn(async () => true),
}));
// Every after-response task runs inline here (there is no response); keep
// each one's promise so a test can wait for the role pass an action started.
const afterTasks = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));
vi.mock("@/lib/after-response", () => ({
  runAfterResponse: (task: () => Promise<unknown>) => {
    const p = task().catch(() => undefined);
    afterTasks.pending.push(p);
    return p.then(() => undefined);
  },
}));

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { SETTING_KEYS, getSetting, setSetting } from "@/lib/settings";
import { _clearMemberRouteGateForTests } from "@/lib/discord-roles";
import {
  STANDIN_ROLE_AWAY_RETRY_MS,
  parseStandinRoleLedger,
} from "@/lib/standin-role";
import {
  getStandinRoleStatus,
  syncStandinRole,
  syncStandinRoleFromWorker,
} from "@/lib/standin-role-service";
import {
  saveStandinRole,
  syncStandinRoleNow,
} from "@/app/actions/admin-discord";
import {
  promoteStandinToPlayer,
  signFreeAgent,
  withdrawSignup,
} from "@/app/actions/admin-roster";
import { leaveLeague, unlinkDiscord } from "@/app/actions/registration";
import {
  DRAFT_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "@/lib/constants";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  makeTeam,
  makeUser,
  runDraftToCompletion,
  sessionFor,
  startDraftState,
} from "./factories";

const GUILD = "910000000000000001";
const ROLE = "910000000000000002";
const OTHER_ROLE = "910000000000000099";

type Recorded = { method: string; url: string };

let server: Server;
let base: string;
let recorded: Recorded[] = [];
/** discordId → the roles the stand-in says they hold; absent = not a member. */
let members: Map<string, string[]>;
/** Answer every role write with this status instead (500, 403…). */
let writeStatus: number | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const method = req.method ?? "";
      const url = req.url ?? "";
      recorded.push({ method, url });
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const role = url.match(/^\/guilds\/\d+\/members\/(\d+)\/roles\/(\d+)$/);
      if (role) {
        if (writeStatus) return send(writeStatus, { code: 50013 });
        const [, id, roleId] = role;
        const held = members.get(id);
        if (!held) return send(404, { code: 10007, message: "Unknown Member" });
        const next = held.filter((r) => r !== roleId);
        if (method === "PUT") next.push(roleId);
        members.set(id, next);
        return send(204);
      }
      const member = url.match(/^\/guilds\/\d+\/members\/(\d+)$/);
      if (member && method === "GET") {
        const held = members.get(member[1]);
        if (!held) return send(404, { code: 10007, message: "Unknown Member" });
        return send(200, { roles: held, pending: false });
      }
      return send(404, { code: 0 });
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

beforeEach(async () => {
  recorded = [];
  members = new Map();
  writeStatus = null;
  afterTasks.pending = [];
  _clearMemberRouteGateForTests();
  vi.stubEnv("DISCORD_BOT_TOKEN", "test-token");
  vi.stubEnv("DISCORD_GUILD_ID", GUILD);
  vi.stubEnv("DISCORD_API_BASE", base);
  // Undeclared, like the tests and Vercel production: Discord writes on.
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("LEAGUE_DEPLOY_ENV", undefined);
  await setSetting(SETTING_KEYS.STANDIN_ROLE_ID, ROLE);
});

afterEach(async () => {
  await settle();
  vi.unstubAllEnvs();
});

/** Wait for every after-response task an action started (role passes). */
async function settle() {
  while (afterTasks.pending.length) {
    const batch = afterTasks.pending.splice(0);
    await Promise.all(batch);
  }
}

/** Let the next automatic pass write at once (the 5s spam floor). */
async function releaseFloor() {
  await prisma.setting.deleteMany({ where: { key: SETTING_KEYS.STANDIN_ROLE_AT } });
}

const writes = () =>
  recorded
    .filter((r) => r.method === "PUT" || r.method === "DELETE")
    .map((r) => `${r.method} ${r.url.split("/")[4]}`)
    .sort();

const put = (id: string) => `PUT ${id}`;
const del = (id: string) => `DELETE ${id}`;

async function ledger() {
  return parseStandinRoleLedger(
    await getSetting(SETTING_KEYS.STANDIN_ROLE_STATE),
    ROLE,
  );
}

let seq = 0;
/** A user with a linked Discord account that is in the server. */
async function linkedUser(name: string, opts: { inServer?: boolean } = {}) {
  const user = await makeUser(name);
  const discordId = `92000000000000${String(++seq).padStart(4, "0")}`;
  await prisma.user.update({ where: { id: user.id }, data: { discordId } });
  if (opts.inServer !== false) members.set(discordId, []);
  return { ...user, discordId };
}

async function signUp(
  seasonId: string,
  userId: string,
  type: string,
  status: string = REGISTRATION_STATUS.ACTIVE,
) {
  await prisma.registration.create({
    data: { seasonId, userId, type, status, mmr: 3000, roles: "1" },
  });
}

/** A regular season after a finished auction, with one of every kind. */
async function regularSeason() {
  const season = await makeSeason({
    status: SEASON_STATUS.REGULAR_SEASON,
    teamSize: 5,
  });
  await prisma.draft.create({
    data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
  });
  const team = await makeTeam(season.id, "Short Side", 0);
  const standin = await linkedUser("Standin Sam");
  await signUp(season.id, standin.id, REGISTRATION_TYPE.STANDIN);
  const agent = await linkedUser("Free Agent Fay");
  await signUp(season.id, agent.id, REGISTRATION_TYPE.PLAYER);
  const rostered = await linkedUser("Rostered Rae");
  await signUp(season.id, rostered.id, REGISTRATION_TYPE.PLAYER);
  await prisma.teamMember.create({
    data: { seasonId: season.id, teamId: team.id, userId: rostered.id },
  });
  const gone = await linkedUser("Withdrawn Will");
  await signUp(
    season.id,
    gone.id,
    REGISTRATION_TYPE.STANDIN,
    REGISTRATION_STATUS.WITHDRAWN,
  );
  const unlinked = await makeUser("Unlinked Una");
  await signUp(season.id, unlinked.id, REGISTRATION_TYPE.STANDIN);
  return { season, team, standin, agent, rostered, gone, unlinked };
}

function fd(fields: Record<string, string> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe("the automatic pass", () => {
  it("does nothing, and asks Discord nothing, with no role id saved", async () => {
    await setSetting(SETTING_KEYS.STANDIN_ROLE_ID, "");
    await regularSeason();
    expect(await syncStandinRole()).toBe("off");
    expect(recorded).toEqual([]);
  });

  it("does nothing where Discord writes are off (staging)", async () => {
    vi.stubEnv("LEAGUE_DEPLOY_ENV", "staging");
    await regularSeason();
    expect(await syncStandinRole()).toBe("off");
    expect(recorded).toEqual([]);
  });

  it("gives it to standins and, after the auction, free agents; nobody else", async () => {
    const fx = await regularSeason();
    expect(await syncStandinRole()).toBe("applied");
    expect(writes()).toEqual([put(fx.agent.discordId), put(fx.standin.discordId)].sort());
    expect(members.get(fx.standin.discordId)).toEqual([ROLE]);
    expect((await ledger()).held).toEqual(
      [fx.agent.discordId, fx.standin.discordId].sort(),
    );

    // Nothing changed: the next pass reads the league and asks Discord nothing.
    recorded = [];
    await releaseFloor();
    expect(await syncStandinRole()).toBe("unchanged");
    expect(recorded).toEqual([]);
  });

  it("gives an unrostered player nothing before the auction is done", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.IN_PROGRESS },
    });
    const pool = await linkedUser("Pool Pat");
    await signUp(season.id, pool.id, REGISTRATION_TYPE.PLAYER);
    const standin = await linkedUser("Early Standin");
    await signUp(season.id, standin.id, REGISTRATION_TYPE.STANDIN);

    await syncStandinRole();
    expect(writes()).toEqual([put(standin.discordId)]);
  });

  it("takes it off everyone when the season ends", async () => {
    const fx = await regularSeason();
    await syncStandinRole();
    await prisma.season.update({
      where: { id: fx.season.id },
      data: { status: SEASON_STATUS.COMPLETE },
    });
    recorded = [];
    await releaseFloor();
    await syncStandinRole();
    expect(writes()).toEqual([del(fx.agent.discordId), del(fx.standin.discordId)].sort());
    expect(members.get(fx.standin.discordId)).toEqual([]);
    expect((await ledger()).held).toEqual([]);
  });

  it("remembers a standin who isn't in the server, retries later, and at once after a link", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    const away = await linkedUser("Not Joined Yet", { inServer: false });
    await signUp(season.id, away.id, REGISTRATION_TYPE.STANDIN);

    await syncStandinRole();
    expect(writes()).toEqual([put(away.discordId)]);
    expect(Object.keys((await ledger()).away)).toEqual([away.discordId]);

    // Within the retry window a pass spends no request on them…
    recorded = [];
    await releaseFloor();
    expect(await syncStandinRole()).toBe("unchanged");
    expect(recorded).toEqual([]);

    // …after it, it tries again; and the Discord link retries at once.
    members.set(away.discordId, []);
    await releaseFloor();
    await syncStandinRole({ nowMs: Date.now() + STANDIN_ROLE_AWAY_RETRY_MS + 1000 });
    expect(writes()).toEqual([put(away.discordId)]);
    expect(members.get(away.discordId)).toEqual([ROLE]);

    // retryNow (the OAuth callback's) skips the wait.
    const late = await linkedUser("Joined Just Now", { inServer: false });
    await signUp(season.id, late.id, REGISTRATION_TYPE.STANDIN);
    await releaseFloor();
    await syncStandinRole();
    members.set(late.discordId, []);
    recorded = [];
    await releaseFloor();
    await syncStandinRole({ retryNow: [late.discordId] });
    expect(writes()).toEqual([put(late.discordId)]);
  });

  it("leaves a failed write for the next pass, and stops at a hierarchy refusal", async () => {
    const fx = await regularSeason();
    writeStatus = 500;
    expect(await syncStandinRole()).toBe("partial");
    expect((await ledger()).held).toEqual([]);

    // 403: the bot's role sits below Standin. One request, then it stops.
    writeStatus = 403;
    recorded = [];
    await releaseFloor();
    expect(await syncStandinRole()).toBe("partial");
    expect(writes()).toHaveLength(1);

    writeStatus = null;
    recorded = [];
    await releaseFloor();
    expect(await syncStandinRole()).toBe("applied");
    expect(writes()).toEqual([put(fx.agent.discordId), put(fx.standin.discordId)].sort());
  });

  it("starts empty for a new role id: the old role is left alone", async () => {
    const fx = await regularSeason();
    await syncStandinRole();
    await setSetting(SETTING_KEYS.STANDIN_ROLE_ID, OTHER_ROLE);
    recorded = [];
    await releaseFloor();
    await syncStandinRole();
    expect(recorded.every((r) => r.url.endsWith(`/roles/${OTHER_ROLE}`))).toBe(true);
    expect(members.get(fx.standin.discordId)?.sort()).toEqual([ROLE, OTHER_ROLE].sort());
  });

  it("the worker looks after a pass that changed the league, otherwise every ten minutes", async () => {
    await regularSeason();
    const now = Date.now();
    expect(await syncStandinRoleFromWorker(false, { nowMs: now })).toBe("applied");
    expect(await syncStandinRoleFromWorker(false, { nowMs: now + 1000 })).toBe("idle");
    expect(await syncStandinRoleFromWorker(true, { nowMs: now + 2000 })).toBe("unchanged");
  });
});

describe("the actions that move it", () => {
  it("signFreeAgent takes it off the player it signs", async () => {
    const fx = await regularSeason();
    await syncStandinRole();
    recorded = [];
    await releaseFloor();

    const res = await signFreeAgent(
      {},
      fd({ userId: fx.agent.id, teamId: fx.team.id }),
    );
    expect(res?.error).toBeUndefined();
    await settle();
    expect(writes()).toEqual([del(fx.agent.discordId)]);
    expect(members.get(fx.agent.discordId)).toEqual([]);
  });

  it("withdrawSignup takes it off a removed standin", async () => {
    const fx = await regularSeason();
    await syncStandinRole();
    recorded = [];
    await releaseFloor();

    const reg = await prisma.registration.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: fx.season.id, userId: fx.standin.id } },
    });
    const res = await withdrawSignup({}, fd({ registrationId: reg.id }));
    expect(res?.error).toBeUndefined();
    await settle();
    expect(writes()).toEqual([del(fx.standin.discordId)]);
  });

  it("promoting a standin before the auction puts them in the pool, without the role", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    const standin = await linkedUser("Late Joiner");
    await signUp(season.id, standin.id, REGISTRATION_TYPE.STANDIN);
    await syncStandinRole();
    expect(members.get(standin.discordId)).toEqual([ROLE]);
    recorded = [];
    await releaseFloor();

    const res = await promoteStandinToPlayer({}, fd({ userId: standin.id }));
    expect(res?.error).toBeUndefined();
    await settle();
    expect(writes()).toEqual([del(standin.discordId)]);
  });

  it("promoting after the auction keeps it (a free agent) until they are signed", async () => {
    const fx = await regularSeason();
    await syncStandinRole();
    recorded = [];
    await releaseFloor();

    const promoted = await promoteStandinToPlayer({}, fd({ userId: fx.standin.id }));
    expect(promoted?.error).toBeUndefined();
    await settle();
    expect(writes()).toEqual([]);

    await releaseFloor();
    const signed = await signFreeAgent(
      {},
      fd({ userId: fx.standin.id, teamId: fx.team.id }),
    );
    expect(signed?.error).toBeUndefined();
    await settle();
    expect(writes()).toEqual([del(fx.standin.discordId)]);
  });

  it("leaveLeague takes it off the standin who leaves", async () => {
    const fx = await regularSeason();
    await syncStandinRole();
    recorded = [];
    await releaseFloor();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(fx.standin));

    const res = await leaveLeague({}, new FormData());
    expect(res?.error).toBeUndefined();
    await settle();
    expect(writes()).toEqual([del(fx.standin.discordId)]);
  });

  it("unlinking Discord takes it off the account that was linked", async () => {
    const fx = await regularSeason();
    await syncStandinRole();
    recorded = [];
    await releaseFloor();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(fx.standin));

    const res = await unlinkDiscord({}, new FormData());
    expect(res?.error).toBeUndefined();
    await settle();
    expect(writes()).toContain(del(fx.standin.discordId));
    expect(members.get(fx.standin.discordId)).toEqual([]);
  });

  it("the auction's last sale gives the unsold player the role", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT, teamSize: 2 });
    await makeCaptain(season.id, "Cap A", 100, 0);
    await makeCaptain(season.id, "Cap B", 100, 1);
    const players = [];
    for (const name of ["Pick One", "Pick Two", "Left Over"]) {
      const user = await makePlayer(season.id, name, 3000);
      const discordId = `93000000000000${String(++seq).padStart(4, "0")}`;
      await prisma.user.update({ where: { id: user.id }, data: { discordId } });
      members.set(discordId, []);
      players.push({ ...user, discordId });
    }
    await startDraftState(season.id);
    await syncStandinRole();
    expect(writes()).toEqual([]);

    await runDraftToCompletion(season.id);
    await settle();
    const rostered = new Set(
      (await prisma.teamMember.findMany({ where: { seasonId: season.id } })).map(
        (m) => m.userId,
      ),
    );
    const unsold = players.filter((p) => !rostered.has(p.id));
    expect(unsold).toHaveLength(1);
    expect(writes()).toEqual([put(unsold[0].discordId)]);
  });
});

describe("the admin controls", () => {
  it("saveStandinRole saves the id (or a pasted mention) and gives the role", async () => {
    await setSetting(SETTING_KEYS.STANDIN_ROLE_ID, "");
    const fx = await regularSeason();

    const bad = await saveStandinRole({}, fd({ standinRoleId: "Standin" }));
    expect(bad?.error).toMatch(/doesn't look like a role id/);

    const res = await saveStandinRole({}, fd({ standinRoleId: `<@&${ROLE}>` }));
    expect(res?.message).toMatch(/Standin role saved/);
    expect(await getSetting(SETTING_KEYS.STANDIN_ROLE_ID)).toBe(ROLE);
    await settle();
    expect(writes()).toEqual([put(fx.agent.discordId), put(fx.standin.discordId)].sort());
    expect(
      await prisma.adminAction.count({ where: { action: "saveStandinRole" } }),
    ).toBe(1);

    const off = await saveStandinRole({}, fd({ standinRoleId: "" }));
    expect(off?.message).toMatch(/Standin role off/);
    expect(await getSetting(SETTING_KEYS.STANDIN_ROLE_ID)).toBeNull();
  });

  it("Sync Standin role now reads everyone live, fixes what differs and counts it", async () => {
    const fx = await regularSeason();
    // The role given by hand: the standin has it, the free agent doesn't,
    // the rostered player and the withdrawn standin still carry it.
    members.set(fx.standin.discordId, [ROLE]);
    members.set(fx.rostered.discordId, [ROLE, OTHER_ROLE]);
    members.set(fx.gone.discordId, [ROLE]);
    // A standin not in the server.
    const away = await linkedUser("Outside Olly", { inServer: false });
    await signUp(fx.season.id, away.id, REGISTRATION_TYPE.STANDIN);

    const res = await syncStandinRoleNow({}, fd());
    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe(
      "4 players should have the Standin role (3 standins, 1 free agent): gave it to 1 and took it off 2. " +
        "1 of them isn't in the Discord server, so they get it within a few hours of joining. " +
        "1 signup has no linked Discord, so the site can't give them the role.",
    );
    expect(writes()).toEqual(
      [put(fx.agent.discordId), del(fx.rostered.discordId), del(fx.gone.discordId)].sort(),
    );
    expect(members.get(fx.rostered.discordId)).toEqual([OTHER_ROLE]);
    const after = await ledger();
    expect(after.held).toEqual([fx.agent.discordId, fx.standin.discordId].sort());
    expect(Object.keys(after.away)).toEqual([away.discordId]);
    expect(
      await prisma.adminAction.count({ where: { action: "syncStandinRoleNow" } }),
    ).toBe(1);

    // The automatic pass agrees with what the sync saw: nothing to do.
    recorded = [];
    await settle();
    await releaseFloor();
    expect(await syncStandinRole()).toBe("unchanged");
    expect(recorded).toEqual([]);
  });

  it("Sync takes the role off last season's standins the ledger remembers", async () => {
    const old = await makeSeason({ status: SEASON_STATUS.COMPLETE, isActive: false });
    const veteran = await linkedUser("Last Season Lou");
    await signUp(old.id, veteran.id, REGISTRATION_TYPE.STANDIN);
    members.set(veteran.discordId, [ROLE]);
    await setSetting(
      SETTING_KEYS.STANDIN_ROLE_STATE,
      JSON.stringify({ roleId: ROLE, held: [veteran.discordId], away: {} }),
    );
    await makeSeason({ status: SEASON_STATUS.SIGNUPS });

    const res = await syncStandinRoleNow({}, fd());
    expect(res?.message).toMatch(/^Nobody should have the Standin role right now: took it off 1\./);
    expect(members.get(veteran.discordId)).toEqual([]);
  });

  it("Sync refuses where Discord writes are off, and says so", async () => {
    vi.stubEnv("LEAGUE_DEPLOY_ENV", "staging");
    await regularSeason();
    const res = await syncStandinRoleNow({}, fd());
    expect(res?.error).toMatch(/Discord writes are off here/);
    expect(recorded).toEqual([]);
  });

  it("Sync names the hierarchy fix when Discord refuses the write", async () => {
    await regularSeason();
    writeStatus = 403;
    const res = await syncStandinRoleNow({}, fd());
    expect(res?.error).toMatch(/the bot's role must sit above Standin/);
  });

  it("the card's counts come from the database alone", async () => {
    await regularSeason();
    await syncStandinRole();
    recorded = [];
    const status = await getStandinRoleStatus();
    expect(recorded).toEqual([]);
    expect(status).toMatchObject({
      roleId: ROLE,
      botReady: true,
      holders: 3,
      standins: 2,
      unlinkedNames: ["Unlinked Una"],
      given: 2,
      away: 0,
    });
  });
});
