import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { INHOUSE, INHOUSE_STATUS } from "@/lib/constants";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import type { SessionUser } from "@/lib/auth";
import { requeueLastSeenAt } from "@/lib/inhouse";
import {
  cancelLobby,
  declineMatch,
  getInhouseState,
  joinQueue,
  loadInhouseRoomRows,
} from "@/lib/inhouse-service";
import { inhouseRoomDue } from "@/lib/inhouse-room-due";
import { pollInhouseState } from "@/lib/inhouse-room-state";
import { publishInhouseRoomChange } from "@/lib/inhouse-room-version";
import {
  createInhouseBoard,
  resetBoardStatsCache,
} from "@/lib/inhouse-board-service";
import { SETTING_KEYS, getSetting, setSetting } from "@/lib/settings";
import {
  ON_POSTGRES,
  makeUser,
  raceAll,
  raceN,
  sessionFor,
} from "./factories";

// The room poll (pollInhouseState): what the route's {action:"state"} runs.
// It must reply exactly as before while doing only the work that is due:
//
// - maintenance only when the pure due check finds work, through the 2s
//   claim's winner, and the next signed-in poll after a clock runs out shows
//   the resolved room;
// - the heartbeat only when touchQueueHeartbeat's WHERE could match, with a
//   player backdated by a cancel or decline re-confirmed by their next poll;
// - the board repainted by a signed-in poll after a change, never re-checked
//   on idle polls;
// - anonymous polls only read.

const HOOK = "https://discord.com/api/webhooks/11111/token-a-inert-value";
const MSG_ID = "1379001234567890123";

vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return {
    ...actual,
    sendInhouseDiscordMessage: vi.fn(async () => true),
    getInhouseWebhookUrl: vi.fn(async () => HOOK),
    postWebhookMessage: vi.fn(async () => ({ id: MSG_ID })),
    patchWebhookMessage: vi.fn(async () => "ok" as const),
    deleteWebhookMessage: vi.fn(async () => true),
  };
});
import {
  getInhouseWebhookUrl,
  patchWebhookMessage,
  postWebhookMessage,
} from "@/lib/discord";

// cancelLobby logs the admin action through the session; there is no cookie
// jar here.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getSessionUser: vi.fn(async () => ({ id: "admin-session", name: "Boss" })),
  };
});

const mockPatch = vi.mocked(patchWebhookMessage);
const mockPost = vi.mocked(postWebhookMessage);
const mockHook = vi.mocked(getInhouseWebhookUrl);

beforeEach(() => {
  delete process.env.VERCEL_ENV;
  resetBoardStatsCache();
  mockHook.mockReset().mockResolvedValue(HOOK);
  mockPatch.mockReset().mockResolvedValue("ok");
  mockPost.mockReset().mockResolvedValue({ id: MSG_ID });
});
afterEach(() => {
  setRaceHook(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// ---- helpers ---------------------------------------------------------------

type Player = { id: string; session: SessionUser };

async function players(n: number, prefix: string): Promise<Player[]> {
  const out: Player[] = [];
  for (let i = 0; i < n; i++) {
    const u = await makeUser(`${prefix}${i}`);
    out.push({ id: u.id, session: sessionFor(u) });
  }
  return out;
}

/**
 * Queue rows written directly: nothing forms, nothing is announced. The
 * deadline is written after the inserts because Postgres's queue triggers
 * (migration 20260831000000_inhouse_queue_idle_timeout) renew every row's
 * deadline on an insert.
 */
async function queueRows(
  list: Player[],
  over: {
    lastSeenAt?: Date;
    joinedAt?: (i: number) => Date;
    idleExpiresAt?: Date | null;
  } = {},
) {
  const now = Date.now();
  for (const [i, p] of list.entries()) {
    await prisma.inhouseQueueEntry.create({
      data: {
        userId: p.id,
        mmr: 3000 + i,
        joinedAt: over.joinedAt ? over.joinedAt(i) : new Date(now - HOUR + i),
        lastSeenAt: over.lastSeenAt ?? new Date(now - 5 * SEC),
      },
    });
  }
  await prisma.inhouseQueueEntry.updateMany({
    where: { userId: { in: list.map((p) => p.id) } },
    data: {
      idleExpiresAt:
        over.idleExpiresAt === undefined
          ? new Date(now + 3 * HOUR)
          : over.idleExpiresAt,
    },
  });
}

type LobbyOver = {
  status: string;
  slot?: number;
  createdAt?: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  acceptEndsAt?: Date | null;
  voteEndsAt?: Date | null;
  pickTeam?: number | null;
  pickEndsAt?: Date | null;
};

/** A lobby written directly with ten players. `seat(i)` sets each player. */
async function lobbyOf(
  list: Player[],
  over: LobbyOver,
  seat: (i: number) => {
    team?: number | null;
    isCaptain?: boolean;
    acceptedAt?: Date | null;
    votedMethod?: string | null;
  } = () => ({}),
) {
  return prisma.inhouseLobby.create({
    data: {
      slot: 1,
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

/** A draft: captains on teams 1 and 2, everyone else in the pool. */
const draftSeats = (i: number) =>
  i === 0
    ? { team: 1, isCaptain: true }
    : i === 1
      ? { team: 2, isCaptain: true }
      : {};

/** Everything a resolver could write, for before/after comparison. */
async function roomDb() {
  const [lobbies, queue] = await Promise.all([
    prisma.inhouseLobby.findMany({
      orderBy: { id: "asc" },
      include: { players: { orderBy: { userId: "asc" } } },
    }),
    prisma.inhouseQueueEntry.findMany({ orderBy: { userId: "asc" } }),
  ]);
  return JSON.stringify({ lobbies, queue });
}

/** Let the next poll claim the 2s maintenance throttle again. */
const releaseMaintenanceClaim = () =>
  prisma.setting.deleteMany({
    where: { key: SETTING_KEYS.INHOUSE_ROOM_MAINTENANCE_AT },
  });

/** Spy on the heartbeat statement: the queue updateMany that sets lastSeenAt. */
function heartbeatSpy() {
  const spy = vi.spyOn(prisma.inhouseQueueEntry, "updateMany");
  return {
    calls: () =>
      spy.mock.calls.filter(
        ([args]) =>
          !!args &&
          typeof args.data === "object" &&
          args.data !== null &&
          "lastSeenAt" in args.data,
      ).length,
    async written() {
      let total = 0;
      for (const [i, [args]] of spy.mock.calls.entries()) {
        if (!args || !args.data || !("lastSeenAt" in args.data)) continue;
        total += (await spy.mock.results[i].value).count;
      }
      return total;
    },
  };
}

const withoutNow = <T extends { now: number }>(s: T) => ({ ...s, now: 0 });

// ---------------------------------------------------------------------------

describe("room poll — the same reply as getInhouseState", () => {
  it("replies as the read-only getInhouseState does when nothing is due", async () => {
    const queued = await players(3, "Q");
    await queueRows(queued);
    const lobbyPlayers = await players(10, "L");
    await lobbyOf(lobbyPlayers, {
      status: INHOUSE_STATUS.IN_PROGRESS,
      startedAt: new Date(Date.now() - 20 * MIN),
    }, (i) => ({ team: i < 5 ? 1 : 2, isCaptain: i === 0 || i === 5 }));
    const outsider = sessionFor(await makeUser("Outsider"));

    for (const viewer of [
      null,
      queued[0].session,
      lobbyPlayers[3].session,
      outsider,
    ]) {
      await releaseMaintenanceClaim();
      const polled = await pollInhouseState(viewer);
      const fresh = await getInhouseState(viewer, {
        runMaintenance: false,
        syncBoard: false,
        detectResults: false,
      });
      expect(withoutNow(polled.state)).toEqual(withoutNow(fresh));
      expect(polled.invalidateGate).toBe(false);
    }
  });
});

describe("room poll — maintenance gating", () => {
  it("claims nothing and opens no resolver transaction when nothing is due", async () => {
    const queued = await players(3, "Q");
    await queueRows(queued);
    // The first poll's board check settles this instance's memo.
    await pollInhouseState(queued[0].session);
    const claimed = await getSetting(SETTING_KEYS.INHOUSE_ROOM_MAINTENANCE_AT);
    expect(claimed).not.toBeNull();

    const raw = vi.spyOn(prisma, "$executeRaw");
    const tx = vi.spyOn(prisma, "$transaction");
    for (const p of queued) {
      const polled = await pollInhouseState(p.session);
      expect(polled.invalidateGate).toBe(false);
      expect(polled.state.queue).toHaveLength(3);
    }
    expect(raw).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
    expect(await getSetting(SETTING_KEYS.INHOUSE_ROOM_MAINTENANCE_AT)).toBe(
      claimed,
    );
  });

  it("makes no claim at all where Discord writes are off and nothing is due", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const queued = await players(2, "Q");
    await queueRows(queued);
    const raw = vi.spyOn(prisma, "$executeRaw");
    await pollInhouseState(queued[0].session);
    await pollInhouseState(queued[1].session);
    expect(raw).not.toHaveBeenCalled();
    expect(
      await getSetting(SETTING_KEYS.INHOUSE_ROOM_MAINTENANCE_AT),
    ).toBeNull();
  });

  it("an expired pick: the next signed-in poll shows the auto-pick", async () => {
    const ten = await players(10, "D");
    const lobby = await lobbyOf(
      ten,
      {
        status: INHOUSE_STATUS.DRAFTING,
        pickTeam: INHOUSE.FIRST_PICK_TEAM,
        pickEndsAt: new Date(Date.now() - SEC),
      },
      draftSeats,
    );
    const polled = await pollInhouseState(ten[5].session);
    expect(polled.invalidateGate).toBe(true);
    expect(polled.state.lobby?.id).toBe(lobby.id);
    expect(polled.state.lobby?.pool).toHaveLength(7);
    // The top remaining MMR went to the team on the clock, and the turn moved.
    expect(polled.state.lobby?.teams.find((t) => t.team === INHOUSE.FIRST_PICK_TEAM)?.players.map((p) => p.userId))
      .toEqual([ten[2].id]);
    expect(polled.state.lobby?.pickTeam).toBe(3 - INHOUSE.FIRST_PICK_TEAM);
  });

  it("an expired ready check: the next poll shows the accepter back in the queue", async () => {
    const ten = await players(10, "R");
    await lobbyOf(
      ten,
      { status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(Date.now() - SEC) },
      (i) => ({ acceptedAt: i < 3 ? new Date() : null }),
    );
    const polled = await pollInhouseState(ten[0].session);
    expect(polled.state.lobby).toBeNull();
    expect(polled.state.me.inQueue).toBe(true);
    expect(polled.state.queue.map((q) => q.userId).sort()).toEqual(
      [ten[0].id, ten[1].id, ten[2].id].sort(),
    );
  });

  it("a stuck all-accepted ready check opens the vote before its clock", async () => {
    const ten = await players(10, "A");
    await lobbyOf(
      ten,
      { status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(Date.now() + MIN) },
      () => ({ acceptedAt: new Date() }),
    );
    const polled = await pollInhouseState(ten[4].session);
    expect(polled.state.lobby?.status).toBe(INHOUSE_STATUS.CAPTAIN_VOTE);
  });

  it.each([
    ["everyone voted before the clock", MIN, "MMR"],
    ["the vote clock ran out", -SEC, null],
  ] as const)("a captain vote where %s: the next poll shows the draft", async (_l, offset, method) => {
    const ten = await players(10, "V");
    await lobbyOf(
      ten,
      { status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: new Date(Date.now() + offset) },
      () => ({ acceptedAt: new Date(), votedMethod: method }),
    );
    const polled = await pollInhouseState(ten[9].session);
    expect(polled.state.lobby?.status).toBe(INHOUSE_STATUS.DRAFTING);
    expect(polled.state.lobby?.pickTeam).toBe(INHOUSE.FIRST_PICK_TEAM);
  });

  it("a draft that lost its pick turn is put back on the clock", async () => {
    const ten = await players(10, "T");
    await lobbyOf(
      ten,
      { status: INHOUSE_STATUS.DRAFTING, pickTeam: null, pickEndsAt: null },
      draftSeats,
    );
    const polled = await pollInhouseState(ten[3].session);
    expect(polled.state.lobby?.pickTeam).toBe(INHOUSE.FIRST_PICK_TEAM);
    expect(polled.state.lobby?.pickEndsAt).not.toBeNull();
  });

  it("ten present and a free slot: the next poll forms the lobby", async () => {
    const ten = await players(10, "F");
    await queueRows(ten);
    const polled = await pollInhouseState(ten[7].session);
    expect(polled.state.lobby?.status).toBe(INHOUSE_STATUS.READY_CHECK);
    expect(polled.state.me.inLobby).toBe(true);
    expect(polled.state.queue).toHaveLength(0);
  });

  it("a queue past its four-hour window comes back empty in that poll", async () => {
    const four = await players(4, "E");
    await queueRows(four, { idleExpiresAt: new Date(Date.now() - SEC) });
    const polled = await pollInhouseState(four[0].session);
    expect(polled.state.queue).toHaveLength(0);
    expect(polled.state.me.inQueue).toBe(false);
  });

  it.each([
    ["READY", { status: INHOUSE_STATUS.READY, createdAt: new Date(Date.now() - 7 * HOUR) }],
    [
      "IN_PROGRESS",
      { status: INHOUSE_STATUS.IN_PROGRESS, startedAt: new Date(Date.now() - 7 * HOUR) },
    ],
  ] as const)(
    "an abandoned %s game frees its slot and the queue re-forms on the same poll",
    async (_label, over) => {
      const stale = await players(10, "S");
      const dead = await lobbyOf(stale, { ...over, slot: 1 }, (i) => ({
        team: i < 5 ? 1 : 2,
      }));
      const live = await players(10, "G");
      await lobbyOf(
        live,
        { status: INHOUSE_STATUS.IN_PROGRESS, slot: 2, startedAt: new Date() },
        (i) => ({ team: i < 5 ? 1 : 2 }),
      );
      const waiting = await players(10, "W");
      await queueRows(waiting);

      const polled = await pollInhouseState(waiting[0].session);
      expect(
        (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: dead.id } }))
          .status,
      ).toBe(INHOUSE_STATUS.CANCELLED);
      expect(polled.state.lobby?.status).toBe(INHOUSE_STATUS.READY_CHECK);
      expect(polled.state.lobby?.slot).toBe(1);
      expect(polled.state.me.inLobby).toBe(true);
    },
  );

  it("a game marked over and never resolved is given up on", async () => {
    const ten = await players(10, "P");
    const game = await lobbyOf(
      ten,
      {
        status: INHOUSE_STATUS.AWAITING_RESULT,
        finishedAt: new Date(Date.now() - 7 * HOUR),
      },
      (i) => ({ team: i < 5 ? 1 : 2 }),
    );
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const polled = await pollInhouseState(admin);
    expect(polled.state.pendingResultIds).not.toContain(game.id);
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: game.id } }))
        .status,
    ).toBe(INHOUSE_STATUS.CANCELLED);
  });

  it("an anonymous poll in a due room changes nothing", async () => {
    const ten = await players(10, "N");
    await lobbyOf(
      ten,
      {
        status: INHOUSE_STATUS.DRAFTING,
        pickTeam: 1,
        pickEndsAt: new Date(Date.now() - SEC),
      },
      draftSeats,
    );
    const others = await players(10, "O");
    await queueRows(others, { lastSeenAt: new Date(Date.now() - 31 * SEC) });
    const before = await roomDb();
    const raw = vi.spyOn(prisma, "$executeRaw");

    const polled = await pollInhouseState(null);

    expect(polled.invalidateGate).toBe(false);
    expect(polled.state.otherLobbies[0]?.pool).toHaveLength(8);
    expect(await roomDb()).toBe(before);
    expect(raw).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
    expect(
      await getSetting(SETTING_KEYS.INHOUSE_ROOM_MAINTENANCE_AT),
    ).toBeNull();
  });
});

describe("room poll — the due check agrees with the resolvers at every boundary", () => {
  // Date alone is frozen, so the check and the resolvers judge the same
  // instant; timers stay real for Prisma.
  let NOW = 0;
  beforeEach(() => {
    NOW = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  type Case = [string, (ten: Player[]) => Promise<unknown>, boolean];
  const draftAt = (offset: number) => async (ten: Player[]) =>
    lobbyOf(
      ten,
      { status: INHOUSE_STATUS.DRAFTING, pickTeam: 1, pickEndsAt: new Date(NOW + offset) },
      draftSeats,
    );
  const CASES: Case[] = [
    ["accept clock at now", (ten) =>
      lobbyOf(ten, { status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(NOW) }), true],
    ["accept clock 1ms ahead", (ten) =>
      lobbyOf(ten, { status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(NOW + 1) }), false],
    ["all accepted before the clock", (ten) =>
      lobbyOf(
        ten,
        { status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(NOW + MIN) },
        () => ({ acceptedAt: new Date(NOW - SEC) }),
      ), true],
    ["nine of ten accepted before the clock", (ten) =>
      lobbyOf(
        ten,
        { status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(NOW + MIN) },
        (i) => ({ acceptedAt: i < 9 ? new Date(NOW - SEC) : null }),
      ), false],
    ["vote clock at now", (ten) =>
      lobbyOf(ten, { status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: new Date(NOW) }), true],
    ["vote clock 1ms ahead", (ten) =>
      lobbyOf(ten, { status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: new Date(NOW + 1) }), false],
    ["all voted before the clock", (ten) =>
      lobbyOf(
        ten,
        { status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: new Date(NOW + MIN) },
        () => ({ votedMethod: "MMR" }),
      ), true],
    ["nine of ten voted before the clock", (ten) =>
      lobbyOf(
        ten,
        { status: INHOUSE_STATUS.CAPTAIN_VOTE, voteEndsAt: new Date(NOW + MIN) },
        (i) => ({ votedMethod: i < 9 ? "MMR" : null }),
      ), false],
    ["pick clock at now", draftAt(0), true],
    ["pick clock 1ms ahead", draftAt(1), false],
    ["a draft with no pick turn", (ten) =>
      lobbyOf(ten, { status: INHOUSE_STATUS.DRAFTING, pickTeam: null }, draftSeats), true],
    ["READY exactly at its floor", (ten) =>
      lobbyOf(ten, {
        status: INHOUSE_STATUS.READY,
        createdAt: new Date(NOW - INHOUSE.ABANDON_READY_HOURS * HOUR),
      }), false],
    ["READY 1ms past its floor", (ten) =>
      lobbyOf(ten, {
        status: INHOUSE_STATUS.READY,
        createdAt: new Date(NOW - INHOUSE.ABANDON_READY_HOURS * HOUR - 1),
      }), true],
    ["IN_PROGRESS exactly at its floor", (ten) =>
      lobbyOf(ten, {
        status: INHOUSE_STATUS.IN_PROGRESS,
        startedAt: new Date(NOW - INHOUSE.ABANDON_IN_PROGRESS_HOURS * HOUR),
      }), false],
    ["IN_PROGRESS 1ms past its floor", (ten) =>
      lobbyOf(ten, {
        status: INHOUSE_STATUS.IN_PROGRESS,
        startedAt: new Date(NOW - INHOUSE.ABANDON_IN_PROGRESS_HOURS * HOUR - 1),
      }), true],
    ["AWAITING_RESULT exactly at its floor", (ten) =>
      lobbyOf(ten, {
        status: INHOUSE_STATUS.AWAITING_RESULT,
        finishedAt: new Date(NOW - INHOUSE.ABANDON_AWAITING_RESULT_HOURS * HOUR),
      }), false],
    ["AWAITING_RESULT 1ms past its floor", (ten) =>
      lobbyOf(ten, {
        status: INHOUSE_STATUS.AWAITING_RESULT,
        finishedAt: new Date(NOW - INHOUSE.ABANDON_AWAITING_RESULT_HOURS * HOUR - 1),
      }), true],
    ["a queue deadline at now", (ten) =>
      queueRows(ten.slice(0, 3), { idleExpiresAt: new Date(NOW) }), false],
    ["a queue deadline 1ms ago", (ten) =>
      queueRows(ten.slice(0, 3), { idleExpiresAt: new Date(NOW - 1) }), true],
    ["a legacy row joined exactly four hours ago", (ten) =>
      queueRows(ten.slice(0, 3), {
        idleExpiresAt: null,
        joinedAt: () => new Date(NOW - INHOUSE.QUEUE_IDLE_HOURS * HOUR),
      }), false],
    ["a legacy row joined four hours and 1ms ago", (ten) =>
      queueRows(ten.slice(0, 3), {
        idleExpiresAt: null,
        joinedAt: () => new Date(NOW - INHOUSE.QUEUE_IDLE_HOURS * HOUR - 1),
      }), true],
    ["ten seen exactly at the presence cutoff", (ten) =>
      queueRows(ten, { lastSeenAt: new Date(NOW - INHOUSE.QUEUE_AWAY_SECONDS * SEC) }), true],
    ["ten seen 1ms before the presence cutoff", (ten) =>
      queueRows(ten, { lastSeenAt: new Date(NOW - INHOUSE.QUEUE_AWAY_SECONDS * SEC - 1) }), false],
    ["nine present", (ten) => queueRows(ten.slice(0, 9)), false],
  ];

  it.each(CASES)("%s", async (_label, build, expectedDue) => {
    const ten = await players(10, "B");
    await build(ten);
    const due = inhouseRoomDue(await loadInhouseRoomRows(NOW), NOW);
    expect(due.length > 0).toBe(expectedDue);

    const before = await roomDb();
    await getInhouseState(null, {
      runMaintenance: true,
      detectResults: false,
      syncBoard: false,
    });
    const changed = (await roomDb()) !== before;
    expect(changed).toBe(due.length > 0);
  });
});

describe("room poll — the heartbeat", () => {
  const seenAgo = (userId: string, ms: number) =>
    prisma.inhouseQueueEntry.update({
      where: { userId },
      data: { lastSeenAt: new Date(Date.now() - ms) },
    });
  const row = (userId: string) =>
    prisma.inhouseQueueEntry.findUniqueOrThrow({ where: { userId } });

  it("issues no heartbeat statement for a fresh row or a viewer not queued", async () => {
    const [p] = await players(1, "H");
    await queueRows([p]);
    const outsider = sessionFor(await makeUser("Out"));
    const hb = heartbeatSpy();
    await pollInhouseState(p.session);
    await pollInhouseState(outsider);
    expect(hb.calls()).toBe(0);
  });

  it("writes a stale present row once, and not again within the interval", async () => {
    const [p] = await players(1, "H");
    await queueRows([p]);
    await seenAgo(p.id, INHOUSE.QUEUE_HEARTBEAT_SECONDS * SEC + 5 * SEC);
    const before = await row(p.id);
    const hb = heartbeatSpy();

    const first = await pollInhouseState(p.session);
    expect(await hb.written()).toBe(1);
    // Present before and after: no presence flip for the gate.
    expect(first.invalidateGate).toBe(false);

    await pollInhouseState(p.session);
    expect(hb.calls()).toBe(1);

    const after = await row(p.id);
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
    // Presence is not queue activity.
    expect(after.idleExpiresAt?.getTime()).toBe(before.idleExpiresAt?.getTime());
    expect(after.joinedAt.getTime()).toBe(before.joinedAt.getTime());
  });

  it("throttles to one write per interval (inhouse.itest's heartbeat test, on the poll)", async () => {
    const [p] = await players(1, "H");
    await queueRows([p]);
    await seenAgo(p.id, 5 * SEC);
    const before = await row(p.id);
    await pollInhouseState(p.session);
    expect((await row(p.id)).lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime());

    await seenAgo(p.id, INHOUSE.QUEUE_HEARTBEAT_SECONDS * SEC + 5 * SEC);
    await pollInhouseState(p.session);
    const afterStale = await row(p.id);
    expect(afterStale.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
    expect(afterStale.idleExpiresAt?.getTime()).toBe(before.idleExpiresAt?.getTime());
  });

  it("a player cancelled back into the queue moments after polling: their next poll re-confirms them and forms the lobby", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const ten = await players(10, "C");
    for (const p of ten) expect((await joinQueue(p.session, 3000)).ok).toBe(true);
    const lobby = await prisma.inhouseLobby.findFirstOrThrow({
      where: { status: INHOUSE_STATUS.READY_CHECK },
    });
    // The player polls in the ready check (seen just now)…
    const x = ten[0];
    await pollInhouseState(x.session);
    // …nine others queue for the next game (slot 2 free, nine present)…
    const nine = await players(9, "N");
    for (const p of nine) expect((await joinQueue(p.session, 3000)).ok).toBe(true);
    expect(await prisma.inhouseLobby.count()).toBe(1);
    // …and an admin cancels: the ten go back to the queue backdated away.
    expect((await cancelLobby(admin, lobby.id)).ok).toBe(true);
    await publishInhouseRoomChange(); // as the route does after every action
    const backdated = await row(x.id);
    expect(backdated.lastSeenAt.getTime()).toBeLessThanOrEqual(
      requeueLastSeenAt(Date.now()).getTime() + SEC,
    );

    await releaseMaintenanceClaim();
    const polled = await pollInhouseState(x.session);

    expect(polled.invalidateGate).toBe(true);
    expect(polled.state.me.inLobby).toBe(true);
    expect(polled.state.lobby?.status).toBe(INHOUSE_STATUS.READY_CHECK);
    const formed = await prisma.inhouseLobby.findFirstOrThrow({
      where: { status: INHOUSE_STATUS.READY_CHECK },
      include: { players: true },
    });
    expect(formed.players.map((p) => p.userId).sort()).toEqual(
      [x.id, ...nine.map((p) => p.id)].sort(),
    );
  });

  it("a player backdated by someone's decline shows present on their next poll, counted in needed", async () => {
    const ten = await players(10, "K");
    for (const p of ten) expect((await joinQueue(p.session, 3000)).ok).toBe(true);
    const x = ten[0];
    await pollInhouseState(x.session);
    // Someone else declines before x accepted: x goes back backdated. (The
    // route publishes after every action; this calls the service directly.)
    expect((await declineMatch(ten[1].session)).ok).toBe(true);
    await publishInhouseRoomChange();
    const before = await row(x.id);
    expect(before.lastSeenAt.getTime()).toBeLessThan(
      Date.now() - INHOUSE.QUEUE_AWAY_SECONDS * SEC,
    );

    await releaseMaintenanceClaim();
    const polled = await pollInhouseState(x.session);

    expect(polled.invalidateGate).toBe(true);
    const mine = polled.state.queue.find((q) => q.userId === x.id);
    expect(mine?.away).toBe(false);
    // Only x is present; the other eight are still backdated.
    expect(polled.state.needed).toBe(INHOUSE.LOBBY_SIZE - 1);
    const after = await row(x.id);
    expect(after.idleExpiresAt?.getTime()).toBe(before.idleExpiresAt?.getTime());
    expect(after.joinedAt.getTime()).toBe(before.joinedAt.getTime());
  });

  it("the seam: a rival heartbeat landing between the decision and the write stands", async () => {
    const [p] = await players(1, "H");
    await queueRows([p]);
    await seenAgo(p.id, 60 * SEC);
    // A distinctive, fresh value the guarded WHERE must refuse to overwrite.
    const rivalSeen = new Date(Date.now() - 1_234);
    let fired = false;
    setRaceHook(
      onceAt("inhouse.pollInhouseState.beforeHeartbeat", async () => {
        fired = true;
        await prisma.inhouseQueueEntry.update({
          where: { userId: p.id },
          data: { lastSeenAt: rivalSeen },
        });
      }),
    );
    const hb = heartbeatSpy();

    await pollInhouseState(p.session);

    expect(fired).toBe(true);
    expect(hb.calls()).toBe(1);
    expect(await hb.written()).toBe(0);
    expect((await row(p.id)).lastSeenAt.getTime()).toBe(rivalSeen.getTime());
  });
});

describe("room poll — the Discord board", () => {
  /** Let the board's own 10s edit cooldown lapse without waiting. */
  const expireBoardThrottle = () =>
    setSetting(
      SETTING_KEYS.INHOUSE_BOARD_AT,
      new Date(Date.now() - HOUR).toISOString(),
    );
  const boardTitle = (call: number) =>
    (mockPatch.mock.calls[call][2].embeds as { title: string }[])[0].title;

  async function postedBoard(n: number) {
    const queued = await players(n, "Q");
    await queueRows(queued);
    expect((await createInhouseBoard()).ok).toBe(true);
    await expireBoardThrottle();
    // The first poll settles this instance's memo on what is posted.
    await pollInhouseState(queued[0].session);
    expect(mockPatch).not.toHaveBeenCalled();
    return queued;
  }

  it("a join: the next signed-in poll repaints without the worker", async () => {
    const queued = await postedBoard(3);
    const late = (await players(1, "Late"))[0];
    expect((await joinQueue(late.session, 3000)).ok).toBe(true);
    expect(mockPatch).not.toHaveBeenCalled(); // the mutation never edits

    await releaseMaintenanceClaim();
    const polled = await pollInhouseState(queued[1].session);

    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(boardTitle(0)).toContain("4 / 10");
    expect(polled.invalidateGate).toBe(true);
  });

  it("idle polls make no Discord request and claim nothing", async () => {
    const queued = await postedBoard(3);
    const raw = vi.spyOn(prisma, "$executeRaw");
    mockHook.mockClear();
    mockPost.mockClear();
    for (let i = 0; i < 5; i++) {
      await releaseMaintenanceClaim();
      await pollInhouseState(queued[i % 3].session);
    }
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockHook).not.toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
  });

  it("three joins inside the cooldown converge on a later poll", async () => {
    const queued = await postedBoard(2);
    const late = await players(3, "J");
    for (const p of late) {
      expect((await joinQueue(p.session, 3000)).ok).toBe(true);
      await releaseMaintenanceClaim();
      await pollInhouseState(queued[0].session);
    }
    // One edit; the next two were inside the board's cooldown.
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(boardTitle(0)).toContain("3 / 10");

    // Nothing joins now, but the board is still behind: the next poll after
    // the cooldown tries again and shows the final count.
    await expireBoardThrottle();
    await releaseMaintenanceClaim();
    await pollInhouseState(queued[1].session);
    expect(mockPatch).toHaveBeenCalledTimes(2);
    expect(boardTitle(1)).toContain("5 / 10");
  });

  it("a lost maintenance claim backs this instance off instead of re-claiming", async () => {
    const queued = await postedBoard(2);
    const late = (await players(1, "Late"))[0];
    expect((await joinQueue(late.session, 3000)).ok).toBe(true);
    // Another poll holds the claim.
    await setSetting(
      SETTING_KEYS.INHOUSE_ROOM_MAINTENANCE_AT,
      new Date().toISOString(),
    );
    const raw = vi.spyOn(prisma, "$executeRaw");
    await pollInhouseState(queued[0].session);
    await pollInhouseState(queued[1].session);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("renders the same digest as getInhouseState's board sync, both ways", async () => {
    const queued = await postedBoard(3);
    const a = (await players(1, "A"))[0];
    expect((await joinQueue(a.session, 3000)).ok).toBe(true);
    await releaseMaintenanceClaim();
    await pollInhouseState(queued[0].session);
    expect(mockPatch).toHaveBeenCalledTimes(1);
    // getInhouseState's sync finds nothing to do on the poll's edit…
    await expireBoardThrottle();
    await getInhouseState(queued[1].session, {
      runMaintenance: false,
      detectResults: false,
      syncBoard: true,
    });
    expect(mockPatch).toHaveBeenCalledTimes(1);

    // …and the poll finds nothing to do on getInhouseState's.
    const b = (await players(1, "B"))[0];
    expect((await joinQueue(b.session, 3000)).ok).toBe(true);
    await expireBoardThrottle();
    await getInhouseState(queued[1].session, {
      runMaintenance: false,
      detectResults: false,
      syncBoard: true,
    });
    expect(mockPatch).toHaveBeenCalledTimes(2);
    await expireBoardThrottle();
    await releaseMaintenanceClaim();
    const polled = await pollInhouseState(queued[2].session);
    expect(mockPatch).toHaveBeenCalledTimes(2);
    expect(polled.invalidateGate).toBe(false);
  });
});

describe.skipIf(!ON_POSTGRES)("room poll — racing polls on Postgres", () => {
  // The 2s claim elects one maintenance run among polls that all see the
  // same due clock; a reply's invalidateGate marks the winner (none of these
  // viewers is queued, so no presence flip sets it).
  const winners = (replies: { invalidateGate: boolean }[]) =>
    replies.filter((r) => r.invalidateGate).length;

  it("ten polls at an expired pick make exactly one auto-pick", async () => {
    const ten = await players(10, "D");
    const lobby = await lobbyOf(
      ten,
      {
        status: INHOUSE_STATUS.DRAFTING,
        pickTeam: 1,
        pickEndsAt: new Date(Date.now() - SEC),
      },
      draftSeats,
    );
    const replies = await raceAll(ten.map((p) => () => pollInhouseState(p.session)));
    expect(winners(replies)).toBe(1);
    const picked = await prisma.inhouseLobbyPlayer.count({
      where: { lobbyId: lobby.id, isCaptain: false, team: { not: null } },
    });
    expect(picked).toBe(1);
    // Every later payload shows it.
    for (const p of ten.slice(0, 3)) {
      expect((await pollInhouseState(p.session)).state.lobby?.pool).toHaveLength(7);
    }
  });

  it("ten polls at a stuck all-accepted check open one captain vote", async () => {
    const ten = await players(10, "A");
    const lobby = await lobbyOf(
      ten,
      { status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(Date.now() + MIN) },
      () => ({ acceptedAt: new Date() }),
    );
    const replies = await raceAll(ten.map((p) => () => pollInhouseState(p.session)));
    expect(winners(replies)).toBe(1);
    const after = await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: lobby.id } });
    expect(after.status).toBe(INHOUSE_STATUS.CAPTAIN_VOTE);
    expect(after.voteEndsAt).not.toBeNull();
    expect((await pollInhouseState(ten[0].session)).state.lobby?.status).toBe(
      INHOUSE_STATUS.CAPTAIN_VOTE,
    );
  });

  it("ten polls at an expired ready check fail it once", async () => {
    const ten = await players(10, "R");
    const lobby = await lobbyOf(
      ten,
      { status: INHOUSE_STATUS.READY_CHECK, acceptEndsAt: new Date(Date.now() - SEC) },
      (i) => ({ acceptedAt: i < 4 ? new Date() : null }),
    );
    const replies = await raceAll(ten.map((p) => () => pollInhouseState(p.session)));
    expect(winners(replies)).toBe(1);
    const after = await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: lobby.id } });
    expect(after.status).toBe(INHOUSE_STATUS.CANCELLED);
    expect(after.endReason).toBeTruthy();
    expect((await prisma.inhouseQueueEntry.findMany()).map((q) => q.userId).sort())
      .toEqual(ten.slice(0, 4).map((p) => p.id).sort());
  });

  it("two tabs of one viewer at a stale heartbeat write it once", async () => {
    const [p] = await players(1, "H");
    await queueRows([p]);
    for (let round = 0; round < 10; round++) {
      await prisma.inhouseQueueEntry.update({
        where: { userId: p.id },
        data: { lastSeenAt: new Date(Date.now() - 60 * SEC) },
      });
      const hb = heartbeatSpy();
      await raceN(2, () => pollInhouseState(p.session));
      expect(await hb.written(), `round ${round}`).toBe(1);
      vi.restoreAllMocks();
    }
  });
});
