import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import { NextRequest } from "next/server";
import type { User } from "@prisma/client";

// The inhouse room snapshot (inhouse-room-cache.ts) behind the room poll:
// each server instance keeps one copy of the room's shared rows, labelled
// with the room version, and serves it only while the version it reads on
// every poll is unchanged. These tests hold it to "players see exactly what
// they see today":
//
// - output parity: a warm snapshot answers every kind of viewer exactly as
//   the fresh, read-only getInhouseState does;
// - freshness: every writer the room shows, through its production entry
//   point, moves the version, and the next poll shows the change;
// - cross-instance: a change made through one module instance shows on
//   another's next poll (only the database version crosses instances);
// - the provider window: every writer publishes BEFORE its Discord or
//   OpenDota call (rule P), so no instance labels post-commit rows with the
//   old version while the call runs;
// - no version row: every poll builds fresh and nothing is stored;
// - on Postgres: raced publishes, the stale-fill seam, and polls raced
//   against picks never going backwards.

const HOOK = "https://discord.com/api/webhooks/11111/token-a-inert-value";
const MSG_ID = "1379001234567890123";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getSessionUser: vi.fn(async () => null),
    requireUser: vi.fn(),
    requireAdmin: vi.fn(),
  };
});
vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return {
    ...actual,
    fetchRecentMatchIds: vi.fn(async () => [] as number[]),
    fetchOpenDotaMatch: vi.fn(async () => null),
    fetchPlayerRankTier: vi.fn(async () => null),
  };
});
vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return {
    ...actual,
    sendInhouseDiscordMessage: vi.fn(async () => true),
    sendDiscordMessage: vi.fn(async () => true),
    getInhouseWebhookUrl: vi.fn(async () => HOOK),
    postWebhookMessage: vi.fn(async () => ({ id: MSG_ID })),
    patchWebhookMessage: vi.fn(async () => "ok" as const),
    deleteWebhookMessage: vi.fn(async () => true),
  };
});
vi.mock("@/lib/steam", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/steam")>();
  return { ...actual, fetchSteamProfiles: vi.fn() };
});
vi.mock("@/lib/invite-ref-cookie", () => ({
  takeInviteRef: vi.fn(async () => null),
}));

import { prisma } from "@/lib/prisma";
import { INHOUSE, INHOUSE_STATUS } from "@/lib/constants";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { getSessionUser, requireAdmin, requireUser, type SessionUser } from "@/lib/auth";
import {
  fetchOpenDotaMatch,
  fetchRecentMatchIds,
} from "@/lib/dota";
import {
  patchWebhookMessage,
  sendInhouseDiscordMessage,
} from "@/lib/discord";
import { fetchSteamProfiles } from "@/lib/steam";
import { effectiveDotaAccountId } from "@/lib/dota-account";
import { requeueLastSeenAt } from "@/lib/inhouse";
import {
  autoDetectResult,
  getInhouseState,
  joinQueue,
  makePick,
  maybeAutoDetectResult,
  maybeFormLobby,
  recordMatch,
  voidLastResult,
} from "@/lib/inhouse-service";
import { pollInhouseState } from "@/lib/inhouse-room-state";
import {
  publishInhouseRoomChange,
  readInhouseRoomVersion,
} from "@/lib/inhouse-room-version";
import { createInhouseBoard, resetBoardStatsCache } from "@/lib/inhouse-board-service";
import { reconcileMissingInhouseResultAnnouncements } from "@/lib/inhouse-announcement-outbox";
import { runResultSync } from "@/lib/result-sync-service";
import { upsertLeagueUser } from "@/lib/users";
import { databaseDiagnostics } from "@/lib/db-observability";
import { SETTING_KEYS, setSetting } from "@/lib/settings";
import { POST as inhousePOST } from "@/app/api/inhouse/route";
import { POST as dotaLobbyPOST } from "@/app/api/dota-lobby/route";
import { voidInhouseResult } from "@/app/actions/inhouse-admin";
import { refreshSteamProfile, saveRegistration } from "@/app/actions/registration";
import {
  ON_POSTGRES,
  makeSeason,
  makeUser,
  raceAll,
  raceN,
  sessionFor,
} from "./factories";

const mockSession = vi.mocked(getSessionUser);
const mockRequireUser = vi.mocked(requireUser);
const mockRequireAdmin = vi.mocked(requireAdmin);
const mockRecent = vi.mocked(fetchRecentMatchIds);
const mockMatch = vi.mocked(fetchOpenDotaMatch);
const mockSend = vi.mocked(sendInhouseDiscordMessage);
const mockPatch = vi.mocked(patchWebhookMessage);
const mockSteam = vi.mocked(fetchSteamProfiles);

beforeEach(() => {
  delete process.env.VERCEL_ENV;
  resetBoardStatsCache();
  mockSession.mockReset().mockResolvedValue(null);
  mockRecent.mockReset().mockResolvedValue([]);
  mockMatch.mockReset().mockResolvedValue(null);
  mockSend.mockReset().mockResolvedValue(true);
  mockPatch.mockReset().mockResolvedValue("ok");
});
afterEach(() => {
  setRaceHook(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// ---- helpers ---------------------------------------------------------------

type Player = { id: string; user: User; session: SessionUser };

async function players(n: number, prefix: string, role = "USER"): Promise<Player[]> {
  const out: Player[] = [];
  for (let i = 0; i < n; i++) {
    const user = await makeUser(`${prefix}${i}`, role);
    out.push({ id: user.id, user, session: sessionFor(user) });
  }
  return out;
}

const admin = async () => (await players(1, "Admin", "ADMIN"))[0];

/** Queue rows written directly (see inhouse-room-poll.itest.ts). */
async function queueRows(
  list: Player[],
  over: {
    lastSeenAt?: (i: number) => Date;
    idleExpiresAt?: Date | null;
  } = {},
) {
  const now = Date.now();
  for (const [i, p] of list.entries()) {
    await prisma.inhouseQueueEntry.create({
      data: {
        userId: p.id,
        mmr: 3000 + i,
        joinedAt: new Date(now - HOUR + i),
        lastSeenAt: over.lastSeenAt ? over.lastSeenAt(i) : new Date(now - 5 * SEC),
      },
    });
  }
  await prisma.inhouseQueueEntry.updateMany({
    where: { userId: { in: list.map((p) => p.id) } },
    data: {
      idleExpiresAt:
        over.idleExpiresAt === undefined ? new Date(now + 3 * HOUR) : over.idleExpiresAt,
    },
  });
}

type LobbyOver = {
  status: string;
  slot?: number;
  createdAt?: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  completedAt?: Date | null;
  acceptEndsAt?: Date | null;
  voteEndsAt?: Date | null;
  pickTeam?: number | null;
  pickEndsAt?: Date | null;
  winnerTeam?: number | null;
  radiantScore?: number | null;
  direScore?: number | null;
  durationSecs?: number | null;
  dotaMatchId?: string | null;
  eloDeltas?: string;
};
type Seat = {
  team?: number | null;
  isCaptain?: boolean;
  pickIndex?: number | null;
  acceptedAt?: Date | null;
  votedMethod?: string | null;
  votedNomineeId?: string | null;
};

/** A lobby written directly with its players. */
async function lobbyOf(list: Player[], over: LobbyOver, seat: (i: number) => Seat = () => ({})) {
  return prisma.inhouseLobby.create({
    data: {
      slot: 1,
      radiantTeam: 1,
      ...over,
      players: {
        create: list.map((p, i) => ({
          userId: p.id,
          mmr: 5000 - i * 100,
          queuedAt: new Date(Date.now() - HOUR + i),
          ...seat(i),
        })),
      },
    },
  });
}

/** Five a side, captains first on each team. */
const teamSeats = (i: number): Seat => ({
  team: i < INHOUSE.TEAM_SIZE ? 1 : 2,
  isCaptain: i === 0 || i === INHOUSE.TEAM_SIZE,
});
/** A draft: captains on teams 1 and 2, everyone else in the pool. */
const draftSeats = (i: number): Seat =>
  i === 0 ? { team: 1, isCaptain: true } : i === 1 ? { team: 2, isCaptain: true } : {};

/** POST /api/inhouse as `session` (null signed out). */
async function room(session: SessionUser | null, body: Record<string, unknown>) {
  mockSession.mockResolvedValue(session);
  const res = await inhousePOST(
    new NextRequest("http://localhost:3000/api/inhouse", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

/** A room poll through the route, as the browser makes it. */
async function poll(session: SessionUser | null) {
  const res = await room(session, { action: "state" });
  expect(res.status).toBe(200);
  return res.json as Awaited<ReturnType<typeof getInhouseState>>;
}

/** The fresh read-only reply, as JSON, for comparison with a poll's. */
async function freshReply(session: SessionUser | null) {
  const state = await getInhouseState(session, {
    runMaintenance: false,
    syncBoard: false,
    detectResults: false,
  });
  return JSON.parse(JSON.stringify(state)) as typeof state;
}

const withoutNow = <T extends { now: number }>(s: T) => ({ ...s, now: 0 });

/** Count Prisma operations (every model call and raw statement) during `fn`. */
async function operationsDuring<T>(fn: () => Promise<T>) {
  const spy = vi.spyOn(databaseDiagnostics, "record");
  try {
    const value = await fn();
    return { value, ops: spy.mock.calls.map(([model, action]) => `${model ?? ""}.${action}`) };
  } finally {
    spy.mockRestore();
  }
}

/** Let the next poll claim the 2s maintenance throttle again. */
const releaseMaintenanceClaim = () =>
  prisma.setting.deleteMany({ where: { key: SETTING_KEYS.INHOUSE_ROOM_MAINTENANCE_AT } });

/** An OpenDota match with team 1 on Radiant (inhouse-game-over.itest.ts). */
function fakeMatch(list: Player[], matchId: number, startTime: number) {
  const accounts = list.map((p) => effectiveDotaAccountId(p.user)!);
  const line = (accountId: number, slot: number, isRadiant: boolean, i: number) => ({
    account_id: accountId,
    player_slot: slot,
    hero_id: i + 1,
    isRadiant,
    kills: isRadiant ? 10 : 3,
    deaths: isRadiant ? 3 : 10,
    assists: 8,
    personaname: `p${accountId}`,
    net_worth: 20000 - i * 500,
    gold_per_min: 500,
    last_hits: 200,
  });
  return {
    match_id: matchId,
    radiant_win: true,
    duration: 2400,
    start_time: startTime,
    radiant_score: 30,
    dire_score: 20,
    players: [
      ...accounts.slice(0, 5).map((a, i) => line(a, i, true, i)),
      ...accounts.slice(5).map((a, i) => line(a, 128 + i, false, i)),
    ],
  };
}

function openDotaHas(match: ReturnType<typeof fakeMatch>) {
  mockRecent.mockResolvedValue([match.match_id]);
  mockMatch.mockImplementation(
    async (id: string) => (String(id) === String(match.match_id) ? match : null) as never,
  );
}

/** A COMPLETED game `agoMs` ago with a stored result. */
const completedGame = (list: Player[], agoMs: number, over: Partial<LobbyOver> = {}) =>
  lobbyOf(
    list,
    {
      status: INHOUSE_STATUS.COMPLETED,
      createdAt: new Date(Date.now() - agoMs - HOUR),
      startedAt: new Date(Date.now() - agoMs - 50 * MIN),
      completedAt: new Date(Date.now() - agoMs),
      winnerTeam: 1,
      radiantScore: 31,
      direScore: 17,
      durationSecs: 2400,
      dotaMatchId: String(7_000_000_000 + Math.floor(Math.random() * 1e6)),
      eloDeltas: JSON.stringify(Object.fromEntries(list.map((p, i) => [p.id, i < 5 ? 25 : -25]))),
      ...over,
    },
    teamSeats,
  );

// ---------------------------------------------------------------------------

describe("room snapshot — a warm snapshot answers exactly as getInhouseState", () => {
  it("for every kind of viewer", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    // Game 1: a ready check, four accepted.
    const g1 = await players(10, "G1-");
    await lobbyOf(
      g1,
      { status: INHOUSE_STATUS.READY_CHECK, slot: 1, acceptEndsAt: new Date(Date.now() + MIN) },
      (i) => ({ acceptedAt: i < 4 ? new Date() : null }),
    );
    // Game 2: a draft, two picks in, ballots cast, team 2's captain on the clock.
    const g2 = await players(10, "G2-");
    await lobbyOf(
      g2,
      {
        status: INHOUSE_STATUS.DRAFTING,
        slot: 2,
        pickTeam: 2,
        pickEndsAt: new Date(Date.now() + MIN),
      },
      (i) => ({
        ...draftSeats(i),
        ...(i === 2 ? { team: 2, pickIndex: 1 } : i === 3 ? { team: 1, pickIndex: 2 } : {}),
        acceptedAt: new Date(),
        votedMethod: i % 3 === 0 ? "VOTE" : "MMR",
        votedNomineeId: i % 3 === 0 ? g2[1].id : null,
      }),
    );
    // A game marked over, its result on the way.
    const pending = await players(10, "PN-");
    await lobbyOf(
      pending,
      {
        status: INHOUSE_STATUS.AWAITING_RESULT,
        slot: 1,
        createdAt: new Date(Date.now() - 2 * HOUR),
        startedAt: new Date(Date.now() - 100 * MIN),
        finishedAt: new Date(Date.now() - 20 * MIN),
      },
      teamSeats,
    );
    // The queue: present, away and backdated rows; some played a game that
    // completed three minutes ago.
    const queued = await players(10, "Q-");
    await completedGame(queued, 3 * MIN);
    await queueRows(queued, {
      lastSeenAt: (i) =>
        i < 6
          ? new Date(Date.now() - 5 * SEC)
          : i < 8
            ? new Date(Date.now() - INHOUSE.QUEUE_AWAY_SECONDS * SEC - HOUR)
            : requeueLastSeenAt(Date.now()),
    });
    // Positions: some chose inhouse ones, others only signed up.
    await prisma.user.updateMany({
      where: { id: { in: [queued[0].id, g1[0].id, g2[1].id] } },
      data: { inhouseRoles: "3,1" },
    });
    for (const p of [queued[1], g1[1], g2[2], pending[3]]) {
      await prisma.registration.create({
        data: { seasonId: season.id, userId: p.id, type: "PLAYER", status: "ACTIVE", mmr: 3000, roles: "2,4" },
      });
    }
    const boss = await admin();
    const [signedUp, stranger] = await players(2, "Out-");
    await prisma.registration.create({
      data: { seasonId: season.id, userId: signedUp.id, type: "PLAYER", status: "ACTIVE", mmr: 3000, roles: "5" },
    });

    await publishInhouseRoomChange();
    const viewers: [string, SessionUser | null][] = [
      ["signed out", null],
      ["a present queued player with a fresh result", queued[0].session],
      ["a signup-roles queued player", queued[1].session],
      ["an away queued player", queued[6].session],
      ["a backdated queued player", queued[8].session],
      ["game 1, accepted", g1[0].session],
      ["game 1, not accepted", g1[7].session],
      ["game 2's captain on the clock", g2[1].session],
      ["game 2's other captain", g2[0].session],
      ["game 2, a pool player who nominated", g2[6].session],
      ["a player of the game marked over", pending[3].session],
      ["an admin outsider", boss.session],
      ["an outsider whose signup is outside the rows", signedUp.session],
      ["an outsider with no positions", stranger.session],
    ];
    // Warm this instance's snapshot (and settle its board memo).
    await pollInhouseState(null);
    await pollInhouseState(stranger.session);

    for (const [label, viewer] of viewers) {
      await releaseMaintenanceClaim();
      const polled = await pollInhouseState(viewer);
      const fresh = await getInhouseState(viewer, {
        runMaintenance: false,
        syncBoard: false,
        detectResults: false,
      });
      expect(withoutNow(polled.state), label).toEqual(withoutNow(fresh));
    }
    // The outsider's positions came from their own signup, outside the rows.
    expect((await pollInhouseState(signedUp.session)).state.me.roles).toEqual({
      roles: "5",
      source: "signup",
    });
    // Ballots go out only as the viewer's own vote and the tallies.
    const serialized = JSON.stringify((await pollInhouseState(g2[6].session)).state);
    expect(serialized).not.toMatch(/votedMethod|votedNomineeId/);
  });

  it("a cache hit costs a member of the room one statement: the version read", async () => {
    const q = await players(3, "Q-");
    await queueRows(q);
    await publishInhouseRoomChange();
    await pollInhouseState(q[0].session); // build + board memo
    const { ops } = await operationsDuring(() => pollInhouseState(q[1].session));
    expect(ops).toEqual(["Setting.findUnique"]);
    // Signed out: the same.
    const anon = await operationsDuring(() => pollInhouseState(null));
    expect(anon.ops).toEqual(["Setting.findUnique"]);
  });

  it("with no version row every poll reads fresh and nothing is stored", async () => {
    const q = await players(3, "Q-");
    await queueRows(q);
    expect(await readInhouseRoomVersion()).toBeNull();
    const first = await operationsDuring(() => pollInhouseState(q[0].session));
    const second = await operationsDuring(() => pollInhouseState(q[1].session));
    for (const run of [first, second]) {
      expect(run.ops.filter((op) => op.startsWith("InhouseQueueEntry.findMany")).length).toBe(1);
    }
    // A direct write shows on the very next poll: nothing was cached.
    await prisma.inhouseQueueEntry.deleteMany({ where: { userId: q[2].id } });
    expect((await pollInhouseState(q[0].session)).state.queue).toHaveLength(2);
    // And polls never create the row.
    expect(await readInhouseRoomVersion()).toBeNull();
  });

  it("serves the snapshot while the version stands, and rebuilds when it moves", async () => {
    const q = await players(3, "Q-");
    await queueRows(q);
    await publishInhouseRoomChange();
    expect((await pollInhouseState(q[0].session)).state.queue).toHaveLength(3);
    // An unpublished direct write is not seen while the version stands…
    await prisma.inhouseQueueEntry.deleteMany({ where: { userId: q[2].id } });
    expect((await pollInhouseState(q[0].session)).state.queue).toHaveLength(3);
    // …and is the moment it moves.
    await publishInhouseRoomChange();
    expect((await pollInhouseState(q[0].session)).state.queue).toHaveLength(2);
  });
});

describe("room snapshot — the heartbeat on a warm snapshot", () => {
  /** The heartbeat statements (queue updateMany setting lastSeenAt). */
  function heartbeats() {
    const spy = vi.spyOn(prisma.inhouseQueueEntry, "updateMany");
    return () =>
      spy.mock.calls.filter(([args]) => !!args?.data && "lastSeenAt" in (args.data as object)).length;
  }

  it("a stale present row is written once; the snapshot remembers it until it is rebuilt", async () => {
    const [p, other] = await players(2, "H-");
    await queueRows([p, other], { lastSeenAt: () => new Date(Date.now() - 2 * MIN) });
    await publishInhouseRoomChange();
    await pollInhouseState(other.session); // warm, and other's own write
    const version = await readInhouseRoomVersion();
    const count = heartbeats();
    const first = await pollInhouseState(p.session);
    expect(first.invalidateGate).toBe(false); // present before and after
    // ... and no publish: every instance would rebuild for a write nobody
    // sees, every 30s per queued tab.
    expect(await readInhouseRoomVersion()).toBe(version);
    // The snapshot still holds the old lastSeenAt (a present → present write
    // publishes nothing), but this instance knows what it wrote.
    for (let i = 0; i < 3; i++) await pollInhouseState(p.session);
    expect(count()).toBe(1);
    const row = await prisma.inhouseQueueEntry.findUniqueOrThrow({ where: { userId: p.id } });
    expect(row.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 10 * SEC);
  });

  it("an away viewer's own poll publishes, so every instance shows them present", async () => {
    const [p, other] = await players(2, "H-");
    await queueRows([p, other], {
      lastSeenAt: (i) => (i === 0 ? requeueLastSeenAt(Date.now()) : new Date(Date.now() - 5 * SEC)),
    });
    await publishInhouseRoomChange();
    const before = await readInhouseRoomVersion();
    expect((await pollInhouseState(other.session)).state.queue.find((q) => q.userId === p.id)?.away).toBe(true);
    const mine = await pollInhouseState(p.session);
    expect(mine.invalidateGate).toBe(true);
    expect(mine.state.queue.find((q) => q.userId === p.id)?.away).toBe(false);
    expect(await readInhouseRoomVersion()).not.toBe(before);
    expect((await pollInhouseState(other.session)).state.queue.find((q) => q.userId === p.id)?.away).toBe(false);
  });
});

// ---- freshness: every writer, through its production entry point ----------

type Ctx = { p: Player[]; boss: Player; lobbyId: string | null; extra?: Player };
type Writer = {
  setup: () => Promise<Ctx>;
  observer: (c: Ctx) => SessionUser | null;
  act: (c: Ctx) => Promise<void>;
  /** The part of the observer's reply the writer must change. */
  view: (s: Awaited<ReturnType<typeof poll>>, c: Ctx) => unknown;
};

/** `n` queued players and an admin. */
const queueCtx = async (n = 3): Promise<Ctx> => {
  const p = await players(n, "Q-");
  await queueRows(p);
  return { p, boss: await admin(), lobbyId: null };
};
/** Ten players in one lobby and an admin. */
const lobbyCtx = async (over: LobbyOver, seat: (i: number) => Seat = teamSeats): Promise<Ctx> => {
  const p = await players(10, "L-");
  const lobby = await lobbyOf(p, over, seat);
  return { p, boss: await admin(), lobbyId: lobby.id };
};
const ok = (res: { status: number; json: unknown }) => expect(res.status, JSON.stringify(res.json)).toBe(200);
const queueIds = (s: Awaited<ReturnType<typeof poll>>) => s.queue.map((q) => q.userId);

const ROUTE_WRITERS: Record<string, Writer> = {
  join: {
    setup: async () => ({ ...(await queueCtx()), extra: (await players(1, "J-"))[0] }),
    observer: (c) => c.p[0].session,
    act: async (c) => ok(await room(c.extra!.session, { action: "join", mmr: 3000 })),
    view: queueIds,
  },
  leave: {
    setup: () => queueCtx(),
    observer: (c) => c.p[0].session,
    act: async (c) => ok(await room(c.p[1].session, { action: "leave" })),
    view: queueIds,
  },
  remove: {
    setup: () => queueCtx(),
    observer: (c) => c.p[0].session,
    act: async (c) => ok(await room(c.boss.session, { action: "remove", userId: c.p[1].id })),
    view: queueIds,
  },
  roles: {
    setup: () => queueCtx(),
    observer: (c) => c.p[0].session,
    act: async (c) => ok(await room(c.p[0].session, { action: "roles", roles: ["2", "3"] })),
    view: (s) => s.me.roles,
  },
  accept: {
    setup: () => lobbyCtx({ status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(Date.now() + MIN) }, () => ({})),
    observer: (c) => c.p[0].session,
    act: async (c) => ok(await room(c.p[1].session, { action: "accept", lobbyId: c.lobbyId })),
    view: (s) => s.lobby?.readyCheck?.acceptedCount,
  },
  decline: {
    setup: () => lobbyCtx({ status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(Date.now() + MIN) }, () => ({})),
    observer: (c) => c.p[0].session,
    act: async (c) => ok(await room(c.p[1].session, { action: "decline", lobbyId: c.lobbyId })),
    view: (s) => [s.lobby?.id ?? null, s.me.inQueue],
  },
  cancel: {
    setup: () => lobbyCtx({ status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(Date.now() + MIN) }, () => ({})),
    observer: (c) => c.p[0].session,
    act: async (c) => ok(await room(c.boss.session, { action: "cancel", lobbyId: c.lobbyId })),
    view: (s) => [s.lobby?.id ?? null, s.me.inQueue],
  },
  vote: {
    setup: () =>
      lobbyCtx({ status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: new Date(Date.now() + MIN) }, () => ({
        acceptedAt: new Date(),
      })),
    observer: (c) => c.p[0].session,
    act: async (c) => ok(await room(c.p[1].session, { action: "vote", method: "MMR", lobbyId: c.lobbyId })),
    view: (s) => s.lobby?.vote?.votedCount,
  },
  pick: {
    setup: () =>
      lobbyCtx(
        { status: INHOUSE_STATUS.DRAFTING, pickTeam: INHOUSE.FIRST_PICK_TEAM, pickEndsAt: new Date(Date.now() + MIN) },
        draftSeats,
      ),
    observer: (c) => c.p[5].session,
    // Team 2 picks first; its captain is the second seat.
    act: async (c) => ok(await room(c.p[1].session, { action: "pick", userId: c.p[2].id, lobbyId: c.lobbyId })),
    view: (s) => s.lobby?.pool.map((p) => p.userId),
  },
  start: {
    setup: () => lobbyCtx({ status: INHOUSE_STATUS.READY, createdAt: new Date(Date.now() - 5 * MIN) }),
    observer: (c) => c.p[5].session,
    act: async (c) => ok(await room(c.p[0].session, { action: "start", lobbyId: c.lobbyId })),
    view: (s) => s.lobby?.status,
  },
  finish: {
    setup: () =>
      lobbyCtx({
        status: INHOUSE_STATUS.IN_PROGRESS,
        createdAt: new Date(Date.now() - HOUR),
        startedAt: new Date(Date.now() - 50 * MIN),
      }),
    observer: (c) => c.p[5].session,
    act: async (c) => ok(await room(c.p[0].session, { action: "finish", lobbyId: c.lobbyId })),
    view: (s) => [s.lobby?.id ?? null, s.pendingResultIds],
  },
  record: {
    setup: () =>
      lobbyCtx({
        status: INHOUSE_STATUS.IN_PROGRESS,
        createdAt: new Date(Date.now() - HOUR),
        startedAt: new Date(Date.now() - 50 * MIN),
      }),
    observer: (c) => c.p[5].session,
    act: async (c) => {
      const match = fakeMatch(c.p, 8_100_000_001, Math.floor((Date.now() - 45 * MIN) / 1000));
      openDotaHas(match);
      ok(await room(c.p[0].session, { action: "record", matchId: String(match.match_id), lobbyId: c.lobbyId }));
    },
    view: (s) => [s.lobby?.id ?? null, s.lastResult?.lobbyId ?? null],
  },
  detect: {
    setup: () =>
      lobbyCtx({
        status: INHOUSE_STATUS.AWAITING_RESULT,
        createdAt: new Date(Date.now() - 2 * HOUR),
        startedAt: new Date(Date.now() - 100 * MIN),
        finishedAt: new Date(Date.now() - 10 * MIN),
      }),
    observer: (c) => c.p[5].session,
    // OpenDota has nothing yet: a refusal, but the check's claim committed.
    act: async (c) => {
      const res = await room(c.p[0].session, { action: "detect", lobbyId: c.lobbyId });
      expect(res.status).toBe(400);
    },
    view: (s) => s.pendingResults.map((r) => r.lastCheckedAt),
  },
  giveup: {
    setup: () =>
      lobbyCtx({
        status: INHOUSE_STATUS.AWAITING_RESULT,
        createdAt: new Date(Date.now() - 2 * HOUR),
        finishedAt: new Date(Date.now() - 10 * MIN),
      }),
    observer: (c) => c.p[0].session,
    act: async (c) => ok(await room(c.boss.session, { action: "giveup", lobbyId: c.lobbyId })),
    view: (s) => s.pendingResultIds,
  },
  void: {
    setup: async () => {
      const p = await players(10, "V-");
      const game = await completedGame(p, 3 * MIN);
      return { p, boss: await admin(), lobbyId: game.id };
    },
    observer: (c) => c.p[0].session,
    act: async (c) => ok(await room(c.boss.session, { action: "void", lobbyId: c.lobbyId })),
    view: (s) => s.lastResult,
  },
};

/** Warm, run the writer, and check the next poll shows it under a new version. */
async function expectFresh(writer: Writer) {
  const ctx = await writer.setup();
  await publishInhouseRoomChange(); // the fixture's own direct writes
  const observer = writer.observer(ctx);
  await poll(observer);
  const warm = await poll(observer); // served from the snapshot
  const before = await readInhouseRoomVersion();
  expect(before).not.toBeNull();

  await writer.act(ctx);

  expect(await readInhouseRoomVersion()).not.toBe(before);
  await releaseMaintenanceClaim();
  const after = await poll(observer);
  expect(writer.view(after, ctx)).not.toEqual(writer.view(warm, ctx));
  expect(withoutNow(after)).toEqual(withoutNow(await freshReply(observer)));
}

describe("room snapshot — every writer the room shows moves the version", () => {
  it.each(Object.keys(ROUTE_WRITERS))("the route's %s action", async (action) => {
    await expectFresh(ROUTE_WRITERS[action]);
  });

  it("maybeFormLobby forming a game", async () => {
    await expectFresh({
      setup: () => queueCtx(10),
      // Signed out: an anonymous poll never runs maintenance, so the warm
      // snapshot holds the ten queued.
      observer: () => null,
      act: async () => expect(await maybeFormLobby()).toBe(true),
      view: (s) => [s.queue.length, s.otherLobbies.length],
    });
  });

  it("maybeFormLobby's queue idle reset, which forms nothing", async () => {
    await expectFresh({
      setup: async () => {
        const p = await players(4, "E-");
        await queueRows(p, { idleExpiresAt: new Date(Date.now() - SEC) });
        return { p, boss: p[0], lobbyId: null };
      },
      observer: () => null,
      act: async () => expect(await maybeFormLobby()).toBe(false),
      view: (s) => s.queue.length,
    });
  });

  it("the lobby bot's start (/api/dota-lobby)", async () => {
    await expectFresh({
      setup: () => lobbyCtx({ status: INHOUSE_STATUS.READY, createdAt: new Date(Date.now() - 5 * MIN) }),
      observer: (c) => c.p[5].session,
      act: async (c) => {
        vi.stubEnv("DOTA_LOBBY_BOT_URL", "http://127.0.0.1:8090");
        vi.stubEnv("DOTA_LOBBY_BOT_SECRET", "test-lobby-secret-".repeat(4));
        vi.stubEnv("DOTA_INHOUSE_LEAGUE_ID", "54321");
        vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ state: "started" })));
        mockSession.mockResolvedValue(c.p[0].session);
        const res = await dotaLobbyPOST(
          new NextRequest("http://localhost:3000/api/dota-lobby", {
            method: "POST",
            headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
            body: JSON.stringify({ kind: "inhouse", id: c.lobbyId, action: "status" }),
          }),
        );
        expect(res.status).toBe(200);
        vi.unstubAllGlobals();
      },
      view: (s) => s.lobby?.status,
    });
  });

  it("the admin void action (/inhouse/history)", async () => {
    await expectFresh({
      ...ROUTE_WRITERS.void,
      act: async (c) => {
        mockRequireAdmin.mockResolvedValue(c.boss.session);
        mockSession.mockResolvedValue(c.boss.session);
        const fd = new FormData();
        fd.set("lobbyId", c.lobbyId!);
        expect((await voidInhouseResult({}, fd))?.error).toBeUndefined();
      },
    });
  });

  it("the result outbox's reconcile (it stamps the Elo the banner shows)", async () => {
    await expectFresh({
      setup: async () => {
        const p = await players(10, "R-");
        const game = await completedGame(p, 3 * MIN, { eloDeltas: "{}" });
        return { p, boss: p[0], lobbyId: game.id };
      },
      observer: (c) => c.p[0].session,
      act: async () => {
        const out = await reconcileMissingInhouseResultAnnouncements({ limit: 10 });
        expect(out.created).toBe(1);
      },
      view: (s) => s.lastResult?.eloDelta,
    });
  });

  it("a Steam profile refresh", async () => {
    await expectFresh({
      setup: () => queueCtx(),
      observer: (c) => c.p[0].session,
      act: async (c) => {
        mockRequireUser.mockResolvedValue(c.p[1].session);
        mockSteam.mockResolvedValue(
          new Map([[c.p[1].user.steamId, { name: "Renamed", avatar: null, profileUrl: null }]]) as never,
        );
        expect((await refreshSteamProfile({}, new FormData()))?.error).toBeUndefined();
      },
      view: (s) => s.queue.map((q) => q.name),
    });
  });

  it("a Steam login", async () => {
    await expectFresh({
      setup: () => queueCtx(),
      observer: (c) => c.p[0].session,
      act: async (c) => {
        await upsertLeagueUser(prisma, {
          steamId: c.p[2].user.steamId,
          profile: { name: "Logged in anew", avatar: null, profileUrl: null },
        });
      },
      view: (s) => s.queue.map((q) => q.name),
    });
  });

  it("a league signup's positions (the room's fallback for unset inhouse ones)", async () => {
    await expectFresh({
      setup: async () => {
        await makeSeason({ status: "SIGNUPS" });
        return queueCtx();
      },
      observer: (c) => c.p[0].session,
      act: async (c) => {
        mockRequireUser.mockResolvedValue(c.p[0].session);
        const fd = new FormData();
        fd.set("type", "PLAYER");
        fd.set("mmr", "3000");
        fd.append("roles", "1");
        fd.append("roles", "4");
        const res = await saveRegistration({}, fd);
        expect(res?.error).toBeUndefined();
      },
      view: (s) => s.me.roles,
    });
  });
});

// ---- resolvers: through the room's winner and through the worker ----------

type Due = {
  setup: () => Promise<Ctx>;
  view: (s: Awaited<ReturnType<typeof poll>>) => unknown;
};
const RESOLVER_CASES: Record<string, Due> = {
  "an expired pick": {
    setup: () =>
      lobbyCtx(
        { status: INHOUSE_STATUS.DRAFTING, pickTeam: INHOUSE.FIRST_PICK_TEAM, pickEndsAt: new Date(Date.now() - SEC) },
        draftSeats,
      ),
    view: (s) => s.otherLobbies[0]?.pool.length,
  },
  "an expired ready check": {
    setup: () =>
      lobbyCtx({ status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(Date.now() - SEC) }, (i) => ({
        acceptedAt: i < 3 ? new Date() : null,
      })),
    view: (s) => [s.otherLobbies.length, s.queue.length],
  },
  "a stuck all-accepted ready check": {
    setup: () =>
      lobbyCtx({ status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(Date.now() + MIN) }, () => ({
        acceptedAt: new Date(),
      })),
    view: (s) => s.otherLobbies[0]?.status,
  },
  "an expired captain vote": {
    setup: () =>
      lobbyCtx({ status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: new Date(Date.now() - SEC) }, () => ({
        acceptedAt: new Date(),
      })),
    view: (s) => s.otherLobbies[0]?.status,
  },
  "an all-voted captain vote": {
    setup: () =>
      lobbyCtx({ status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: new Date(Date.now() + MIN) }, () => ({
        acceptedAt: new Date(),
        votedMethod: "MMR",
      })),
    view: (s) => s.otherLobbies[0]?.status,
  },
  "a draft that lost its pick turn": {
    setup: () => lobbyCtx({ status: INHOUSE_STATUS.DRAFTING, pickTeam: null }, draftSeats),
    view: (s) => s.otherLobbies[0]?.pickTeam,
  },
  "ten present and a free slot": {
    setup: () => queueCtx(10),
    view: (s) => [s.queue.length, s.otherLobbies.length],
  },
  "a queue past its four hours": {
    setup: async () => {
      const p = await players(4, "E-");
      await queueRows(p, { idleExpiresAt: new Date(Date.now() - SEC) });
      return { p, boss: p[0], lobbyId: null };
    },
    view: (s) => s.queue.length,
  },
  "an abandoned READY game": {
    setup: () =>
      lobbyCtx({ status: INHOUSE_STATUS.READY, createdAt: new Date(Date.now() - (INHOUSE.ABANDON_READY_HOURS * HOUR + MIN)) }),
    view: (s) => s.otherLobbies.length,
  },
  "an abandoned IN_PROGRESS game": {
    setup: () =>
      lobbyCtx({
        status: INHOUSE_STATUS.IN_PROGRESS,
        createdAt: new Date(Date.now() - 8 * HOUR),
        startedAt: new Date(Date.now() - (INHOUSE.ABANDON_IN_PROGRESS_HOURS * HOUR + MIN)),
      }),
    view: (s) => s.otherLobbies.length,
  },
  "a game marked over and never resolved": {
    setup: () =>
      lobbyCtx({
        status: INHOUSE_STATUS.AWAITING_RESULT,
        createdAt: new Date(Date.now() - 9 * HOUR),
        finishedAt: new Date(Date.now() - (INHOUSE.ABANDON_AWAITING_RESULT_HOURS * HOUR + MIN)),
      }),
    view: (s) => s.pendingResultIds.length,
  },
};

describe("room snapshot — a resolver's work shows on every instance's next poll", () => {
  /**
   * Warm a signed-out snapshot (anonymous polls never run maintenance, so it
   * keeps the due state), let `resolve` run, then a signed-out poll must
   * show the resolved room under a new version.
   */
  async function expectResolved(due: Due, resolve: () => Promise<void>) {
    await due.setup();
    await publishInhouseRoomChange();
    await poll(null);
    const warm = await poll(null);
    const before = await readInhouseRoomVersion();
    await releaseMaintenanceClaim();

    await resolve();

    expect(await readInhouseRoomVersion()).not.toBe(before);
    const after = await poll(null);
    expect(due.view(after)).not.toEqual(due.view(warm));
    expect(withoutNow(after)).toEqual(withoutNow(await freshReply(null)));
  }

  it.each(Object.keys(RESOLVER_CASES))("%s, through a signed-in poll that wins the claim", async (name) => {
    const outsider = (await players(1, "Poller-"))[0];
    await expectResolved(RESOLVER_CASES[name], async () => {
      const polled = await pollInhouseState(outsider.session);
      expect(polled.invalidateGate).toBe(true);
    });
  });

  it.each(Object.keys(RESOLVER_CASES))("%s, through the worker's inhouse leg", async (name) => {
    await expectResolved(RESOLVER_CASES[name], async () => {
      await runResultSync();
    });
  });

  it("a later resolver that throws still publishes what the earlier ones committed", async () => {
    // resolveReadyCheck commits the failed check (game cancelled, accepters
    // requeued); then resolveCaptainVote's scan fails as a pool timeout
    // would. The poll errors, but every instance must see the requeue.
    const outsider = (await players(1, "Poller-"))[0];
    const due = RESOLVER_CASES["an expired ready check"];
    await expectResolved(due, async () => {
      const findMany = prisma.inhouseLobby.findMany.bind(prisma.inhouseLobby);
      const scan = vi.spyOn(prisma.inhouseLobby, "findMany").mockImplementation(((
        args?: { where?: { status?: unknown } },
      ) =>
        args?.where?.status === INHOUSE_STATUS.CAPTAIN_VOTE
          ? Promise.reject(Object.assign(new Error("pool timeout"), { code: "P2024" }))
          : findMany(args as never)) as never);
      await expect(pollInhouseState(outsider.session)).rejects.toThrow("pool timeout");
      expect(
        scan.mock.calls.some(([args]) => args?.where?.status === INHOUSE_STATUS.CAPTAIN_VOTE),
      ).toBe(true);
      scan.mockRestore();
      // The ready check really was resolved before the throw.
      expect(await prisma.inhouseLobby.count({ where: { status: INHOUSE_STATUS.READY_CHECK } })).toBe(0);
    });
  });
});

// ---- cross-instance ---------------------------------------------------------

describe("room snapshot — two server instances", () => {
  it("a pick made through one instance shows on the other's next poll", async () => {
    const c = await lobbyCtx(
      { status: INHOUSE_STATUS.DRAFTING, pickTeam: INHOUSE.FIRST_PICK_TEAM, pickEndsAt: new Date(Date.now() + MIN) },
      draftSeats,
    );
    await publishInhouseRoomChange();
    const viewer = c.p[5].session;
    // Instance B: a second copy of every module (its own route, snapshot and
    // local publish count); only the database is shared.
    vi.resetModules();
    const bRoute = await import("@/app/api/inhouse/route");
    vi.mocked((await import("@/lib/auth")).getSessionUser).mockResolvedValue(viewer);
    const pollB = async () => {
      const res = await bRoute.POST(
        new NextRequest("http://localhost:3000/api/inhouse", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({ action: "state" }),
        }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as Awaited<ReturnType<typeof poll>>;
    };
    const poolOf = (s: Awaited<ReturnType<typeof poll>>) => s.lobby?.pool.map((p) => p.userId);

    expect(poolOf(await poll(viewer))).toHaveLength(8);
    expect(poolOf(await pollB())).toHaveLength(8);
    expect(poolOf(await pollB())).toHaveLength(8); // warm

    // Instance A takes the pick (its route publishes after it).
    ok(await room(c.p[1].session, { action: "pick", userId: c.p[2].id, lobbyId: c.lobbyId }));

    const onB = poolOf(await pollB());
    expect(onB).toHaveLength(7);
    expect(onB).not.toContain(c.p[2].id);
  });
});

// ---- the provider window: rule P before every Discord / OpenDota call -------

describe("room snapshot — every provider call sees the change already published", () => {
  /** Record the room version each time `mock` is called. */
  function versionsAt<T extends (...args: never[]) => Promise<unknown>>(
    mock: MockedFunction<T>,
    value: Awaited<ReturnType<T>>,
  ) {
    const seen: (string | null)[] = [];
    mock.mockImplementation((async () => {
      seen.push(await readInhouseRoomVersion());
      return value;
    }) as unknown as Parameters<typeof mock.mockImplementation>[0]);
    return seen;
  }

  it("formOneLobby's lobby ping", async () => {
    const q = await players(10, "F-");
    await queueRows(q);
    await publishInhouseRoomChange();
    const before = await readInhouseRoomVersion();
    const seen = versionsAt(mockSend, true);
    expect(await maybeFormLobby()).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(before);
  });

  it("joinQueue's milestone ping", async () => {
    const q = await players(INHOUSE.QUEUE_PING_AT, "M-");
    await queueRows(q.slice(0, -1));
    await publishInhouseRoomChange();
    const before = await readInhouseRoomVersion();
    const seen = versionsAt(mockSend, true);
    expect((await joinQueue(q[q.length - 1].session, 3000)).ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(before);
  });

  it("applyResult's announcement, and the lookups after the manual check's claim", async () => {
    const c = await lobbyCtx({
      status: INHOUSE_STATUS.AWAITING_RESULT,
      createdAt: new Date(Date.now() - 2 * HOUR),
      startedAt: new Date(Date.now() - 100 * MIN),
      finishedAt: new Date(Date.now() - 10 * MIN),
    });
    await publishInhouseRoomChange();
    const before = await readInhouseRoomVersion();
    const match = fakeMatch(c.p, 8_100_000_002, Math.floor((Date.now() - 95 * MIN) / 1000));
    const looked: (string | null)[] = [];
    mockRecent.mockImplementation(async () => {
      looked.push(await readInhouseRoomVersion());
      return [match.match_id];
    });
    mockMatch.mockImplementation(async () => match as never);
    const sent = versionsAt(mockSend, true);

    expect(await autoDetectResult(c.p[0].session, c.lobbyId)).toEqual({ ok: true });

    expect(looked.length).toBeGreaterThan(0);
    for (const v of looked) expect(v).not.toBe(before);
    expect(sent).toHaveLength(1);
    const afterClaim = looked[0];
    // The result's own publish came after the claim's.
    expect(sent[0]).not.toBe(afterClaim);
  });

  it("recordMatch's announcement", async () => {
    const c = await lobbyCtx({
      status: INHOUSE_STATUS.IN_PROGRESS,
      createdAt: new Date(Date.now() - HOUR),
      startedAt: new Date(Date.now() - 50 * MIN),
    });
    await publishInhouseRoomChange();
    const before = await readInhouseRoomVersion();
    const match = fakeMatch(c.p, 8_100_000_003, Math.floor((Date.now() - 45 * MIN) / 1000));
    mockMatch.mockImplementation(async () => match as never);
    const sent = versionsAt(mockSend, true);
    expect(await recordMatch(c.p[0].session, String(match.match_id), c.lobbyId)).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe(before);
  });

  it("voidLastResult's correction", async () => {
    const p = await players(10, "VV-");
    const game = await completedGame(p, 3 * MIN);
    const boss = await admin();
    mockSession.mockResolvedValue(boss.session);
    await publishInhouseRoomChange();
    const before = await readInhouseRoomVersion();
    const sent = versionsAt(mockSend, true);
    expect(await voidLastResult(boss.session, game.id)).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe(before);
  });

  it("voidLastResult stamps the result cursor before it publishes", async () => {
    // A board check that sees the new version reads the board's stats by
    // the result cursor: it must already have moved, or the check settles
    // on the voided game's stats under the new key.
    const p = await players(10, "VC-");
    const game = await completedGame(p, 3 * MIN);
    const boss = await admin();
    mockSession.mockResolvedValue(boss.session);
    const OLD = "2020-01-01T00:00:00.000Z";
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, OLD);
    const cursorAtPublish: (string | null)[] = [];
    const executeRaw = prisma.$executeRaw.bind(prisma);
    vi.spyOn(prisma, "$executeRaw").mockImplementation((async (...args: unknown[]) => {
      if (args.includes(SETTING_KEYS.INHOUSE_ROOM_VERSION)) {
        const cursor = await prisma.setting.findUnique({
          where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
        });
        cursorAtPublish.push(cursor?.value ?? null);
      }
      return (executeRaw as (...a: unknown[]) => Promise<number>)(...args);
    }) as never);
    expect(await voidLastResult(boss.session, game.id)).toEqual({ ok: true });
    expect(cursorAtPublish).toHaveLength(1);
    expect(cursorAtPublish[0]).not.toBe(OLD);
  });

  it("the worker's scan, after its claim", async () => {
    const c = await lobbyCtx({
      status: INHOUSE_STATUS.AWAITING_RESULT,
      createdAt: new Date(Date.now() - 2 * HOUR),
      startedAt: new Date(Date.now() - 100 * MIN),
      finishedAt: new Date(Date.now() - 10 * MIN),
    });
    void c;
    await publishInhouseRoomChange();
    const before = await readInhouseRoomVersion();
    const looked = versionsAt(mockRecent, []);
    await maybeAutoDetectResult();
    expect(looked.length).toBeGreaterThan(0);
    for (const v of looked) expect(v).not.toBe(before);
  });

  // An expired ready check: failing it changes what the board shows (the
  // game goes, its accepters queue).
  const expiredCheck = (slot = 1) =>
    lobbyCtx({ status: INHOUSE_STATUS.READY_CHECK, slot, acceptEndsAt: new Date(Date.now() - SEC) }, (i) => ({
      acceptedAt: i < 3 ? new Date() : null,
    }));

  it("the room winner's board edit, after its resolvers", async () => {
    const c = await expiredCheck();
    expect((await createInhouseBoard()).ok).toBe(true);
    await setSetting(SETTING_KEYS.INHOUSE_BOARD_AT, new Date(Date.now() - HOUR).toISOString());
    await publishInhouseRoomChange();
    const before = await readInhouseRoomVersion();
    const patched = versionsAt(mockPatch, "ok");
    await releaseMaintenanceClaim();
    expect((await pollInhouseState(c.p[5].session)).invalidateGate).toBe(true);
    expect(patched).toHaveLength(1);
    expect(patched[0]).not.toBe(before);
  });

  it("the worker's announcement drain and board sync, after its resolvers", async () => {
    // A recorded result whose announcement is still waiting (Discord was off
    // when it landed), an expired ready check for the resolvers, and a posted
    // board.
    const done = await lobbyCtx({
      status: INHOUSE_STATUS.IN_PROGRESS,
      createdAt: new Date(Date.now() - HOUR),
      startedAt: new Date(Date.now() - 50 * MIN),
    });
    const match = fakeMatch(done.p, 8_100_000_004, Math.floor((Date.now() - 45 * MIN) / 1000));
    openDotaHas(match);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await recordMatch(done.p[0].session, String(match.match_id), done.lobbyId)).toEqual({ ok: true });
    vi.unstubAllEnvs();
    delete process.env.VERCEL_ENV;
    expect(await prisma.inhouseAnnouncement.count({ where: { status: "PENDING" } })).toBe(1);
    await expiredCheck(2);
    expect((await createInhouseBoard()).ok).toBe(true);
    await setSetting(SETTING_KEYS.INHOUSE_BOARD_AT, new Date(Date.now() - HOUR).toISOString());
    await publishInhouseRoomChange();
    const before = await readInhouseRoomVersion();
    const sent = versionsAt(mockSend, true);
    const patched = versionsAt(mockPatch, "ok");

    await runResultSync();

    expect(sent).toHaveLength(1);
    expect(patched).toHaveLength(1);
    for (const v of [...sent, ...patched]) expect(v).not.toBe(before);
  });
});

// ---- Postgres: raced -----------------------------------------------------------

describe("room snapshot — raced", () => {
  it("twenty publishes racing on a missing row: no error, one row", async () => {
    expect(await readInhouseRoomVersion()).toBeNull();
    const errors = vi.spyOn(console, "error");
    await raceN(20, () => publishInhouseRoomChange());
    expect(errors).not.toHaveBeenCalled();
    expect(await prisma.setting.count({ where: { key: SETTING_KEYS.INHOUSE_ROOM_VERSION } })).toBe(1);
  });

  it.each([
    ["on this instance", false],
    ["on another instance", true],
  ] as const)(
    "the seam: a pick published %s between a load's reads and its store is never served after",
    async (_label, elsewhere) => {
      const c = await lobbyCtx(
        { status: INHOUSE_STATUS.DRAFTING, pickTeam: INHOUSE.FIRST_PICK_TEAM, pickEndsAt: new Date(Date.now() + MIN) },
        draftSeats,
      );
      await publishInhouseRoomChange();
      // The rival publishes through a second module instance when "elsewhere":
      // this instance's local fence never hears of it, so only the version
      // label can keep the stale fill out.
      let publish = publishInhouseRoomChange;
      if (elsewhere) {
        vi.resetModules();
        publish = (await import("@/lib/inhouse-room-version")).publishInhouseRoomChange;
      }
      const viewer = c.p[5].session;
      let fired = false;
      setRaceHook(
        onceAt("inhouse.roomCache.beforeStore", async () => {
          fired = true;
          expect(await makePick(c.p[1].session, c.p[2].id, c.lobbyId)).toEqual({ ok: true });
          await publish();
        }),
      );
      // This poll started before the pick: it may show the pool it read.
      const raced = await pollInhouseState(viewer);
      expect(fired).toBe(true);
      expect(raced.state.lobby?.pool).toHaveLength(8);
      // Every poll after the publish shows the pick.
      for (let i = 0; i < 3; i++) {
        const pool = (await pollInhouseState(viewer)).state.lobby?.pool.map((p) => p.userId);
        expect(pool).toHaveLength(7);
        expect(pool).not.toContain(c.p[2].id);
      }
    },
  );

  it.skipIf(!ON_POSTGRES)("polls raced against picks: a viewer's later polls never go backwards", async () => {
    for (let round = 0; round < 50; round++) {
      await prisma.inhouseLobbyPlayer.deleteMany();
      await prisma.inhouseLobby.deleteMany();
      const c = await lobbyCtx(
        { status: INHOUSE_STATUS.DRAFTING, pickTeam: INHOUSE.FIRST_PICK_TEAM, pickEndsAt: new Date(Date.now() + MIN) },
        draftSeats,
      );
      await publishInhouseRoomChange();
      const viewer = c.p[5].session;
      await pollInhouseState(viewer); // warm
      const [, picked] = await raceAll<unknown>([
        () => pollInhouseState(viewer),
        () => room(c.p[1].session, { action: "pick", userId: c.p[2].id, lobbyId: c.lobbyId }),
      ]);
      expect((picked as { status: number }).status, `round ${round}`).toBe(200);
      for (let i = 0; i < 2; i++) {
        const pool = (await pollInhouseState(viewer)).state.lobby?.pool.map((p) => p.userId);
        expect(pool, `round ${round}`).toHaveLength(7);
      }
    }
  });
});
