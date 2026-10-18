import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The inhouse room's long-poll through the real route and database: a state
// request that sends back the version its client shows is held until the
// room changes, its next clock or its hold, then answered as any poll. These
// hold it to "instant, and no more requests than changes":
//
// - a mutation by another player answers a held request well under a second;
// - a server action loaded as ANOTHER module instance (a `next start`
//   process loads src/lib twice) wakes it as fast: the registry is per
//   process, not per module;
// - a version moved where no publish here ran (the other release slot) is
//   caught by the watch;
// - a held request ends at the room's next clock, and the poll that wakes
//   resolves the work that came due;
// - a client that goes away ends its hold and gets no poll;
// - looping clients make about one request per change, plus one per hold.

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
    getInhouseWebhookUrl: vi.fn(async () => null),
  };
});

import { prisma } from "@/lib/prisma";
import { INHOUSE, INHOUSE_STATUS } from "@/lib/constants";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import {
  publishInhouseRoomChange,
  readInhouseRoomVersion,
} from "@/lib/inhouse-room-version";
import { heldInhouseRoomRequests } from "@/lib/inhouse-room-wait";
import { SETTING_KEYS } from "@/lib/settings";
import { POST as inhousePOST } from "@/app/api/inhouse/route";
import { makeUser, sessionFor } from "./factories";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// Each request runs as its own viewer, even while others run beside it.
const viewer = new AsyncLocalStorage<SessionUser | null>();
const mockSession = vi.mocked(getSessionUser);

beforeEach(() => {
  mockSession.mockReset().mockImplementation(async () => viewer.getStore() ?? null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Reply = { status: number; json: Record<string, unknown> | null; ms: number };

/** POST /api/inhouse as `session`, timed. */
async function room(
  session: SessionUser | null,
  body: Record<string, unknown>,
  route: typeof inhousePOST = inhousePOST,
  signal?: AbortSignal,
): Promise<Reply> {
  const started = Date.now();
  const res = await viewer.run(session, () =>
    route(
      new NextRequest("http://localhost:3000/api/inhouse", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify(body),
        signal,
      }),
    ),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, ms: Date.now() - started };
}

/** A plain poll, and the version it names. */
async function plainPoll(session: SessionUser | null) {
  const res = await room(session, { action: "state" });
  expect(res.status).toBe(200);
  const version = res.json?.roomVersion;
  expect(typeof version).toBe("string");
  return { state: res.json!, version: version as string };
}

/** A held poll for `since`, still running. */
function heldPoll(
  session: SessionUser | null,
  since: string,
  holdMs: number = INHOUSE.LONG_POLL_HOLD_MS,
) {
  return room(session, { action: "state", since, holdMs });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Until `n` requests are held in this process. */
async function untilHeld(n: number) {
  for (let i = 0; i < 200 && heldInhouseRoomRequests() < n; i++) await sleep(10);
  expect(heldInhouseRoomRequests()).toBe(n);
}

async function users(n: number, prefix: string, role = "USER") {
  const out: { id: string; session: SessionUser }[] = [];
  for (let i = 0; i < n; i++) {
    const user = await makeUser(`${prefix}${i}`, role);
    out.push({ id: user.id, session: sessionFor(user) });
  }
  return out;
}

/** Well under the 2s watch: what "instant" has to mean here. */
const INSTANT_MS = 1_000;

describe("the long-poll: a held request answers when the room changes", () => {
  it("another player's join answers every held request at once, with the new version", async () => {
    const [watcher, joiner] = await users(2, "LP-");
    await publishInhouseRoomChange();
    const signedOut = await plainPoll(null);
    const signedIn = await plainPoll(watcher.session);
    expect(signedIn.version).toBe(signedOut.version);

    const holds = [heldPoll(null, signedOut.version), heldPoll(watcher.session, signedIn.version)];
    await untilHeld(2);
    await sleep(300);
    expect(heldInhouseRoomRequests()).toBe(2);

    const joined = await room(joiner.session, { action: "join", mmr: 3000 });
    expect(joined.status).toBe(200);
    const joinedAt = Date.now();
    const replies = await Promise.all(holds);
    // From the join's response to the held replies: coalesce, jitter, poll.
    expect(Date.now() - joinedAt).toBeLessThan(INSTANT_MS);
    for (const reply of replies) {
      expect(reply.status).toBe(200);
      expect(reply.json?.roomVersion).not.toBe(signedIn.version);
      expect((reply.json?.queue as unknown[]).length).toBe(1);
    }
    expect(heldInhouseRoomRequests()).toBe(0);
  });

  it("a server action in another module instance wakes the route's held request as fast", async () => {
    // A completed game an admin voids through /inhouse/history's action.
    const p = await users(10, "V-");
    const [boss] = await users(1, "Boss-", "ADMIN");
    const game = await prisma.inhouseLobby.create({
      data: {
        slot: 1,
        radiantTeam: 1,
        status: INHOUSE_STATUS.COMPLETED,
        createdAt: new Date(Date.now() - 2 * HOUR),
        startedAt: new Date(Date.now() - 100 * MIN),
        completedAt: new Date(Date.now() - 3 * MIN),
        winnerTeam: 1,
        radiantScore: 30,
        direScore: 20,
        durationSecs: 2400,
        dotaMatchId: "7123456789",
        eloDeltas: JSON.stringify(Object.fromEntries(p.map((x, i) => [x.id, i < 5 ? 25 : -25]))),
        players: {
          create: p.map((x, i) => ({
            userId: x.id,
            mmr: 4000 - i * 50,
            queuedAt: new Date(Date.now() - 2 * HOUR + i),
            team: i < 5 ? 1 : 2,
            isCaptain: i === 0 || i === 5,
          })),
        },
      },
    });
    await publishInhouseRoomChange();
    const before = await plainPoll(p[0].session);
    expect((before.state.lastResult as { lobbyId: string } | null)?.lobbyId).toBe(game.id);

    // Pages and server actions: a second copy of every module, in this
    // process. Only the registry on globalThis (and the database) is shared.
    vi.resetModules();
    const actions = await import("@/app/actions/inhouse-admin");
    vi.mocked((await import("@/lib/auth")).requireAdmin).mockResolvedValue(boss.session);
    const held = heldPoll(p[0].session, before.version);
    await untilHeld(1);

    const fd = new FormData();
    fd.set("lobbyId", game.id);
    const voidedAt = Date.now();
    expect((await actions.voidInhouseResult({}, fd))?.error).toBeUndefined();
    const reply = await held;
    expect(Date.now() - voidedAt).toBeLessThan(INSTANT_MS);
    expect(reply.status).toBe(200);
    expect(reply.json?.roomVersion).not.toBe(before.version);
    expect(reply.json?.lastResult).toBeNull();
  });

  it("the watch catches a version moved outside this process (the other release slot)", async () => {
    await publishInhouseRoomChange();
    const { version } = await plainPoll(null);
    const held = heldPoll(null, version);
    await untilHeld(1);
    // The other slot's publish: the row moves, nothing here is told.
    await prisma.setting.update({
      where: { key: SETTING_KEYS.INHOUSE_ROOM_VERSION },
      data: { value: "the-other-slots-version" },
    });
    const reply = await held;
    expect(reply.json?.roomVersion).toBe("the-other-slots-version");
    expect(reply.ms).toBeLessThan(
      INHOUSE.LONG_POLL_WATCH_MS + INHOUSE.LONG_POLL_JITTER_MS + INSTANT_MS,
    );
  });

  it("a fresh database holds under its token, and its first publish answers", async () => {
    expect(await readInhouseRoomVersion()).toBeNull();
    const { version } = await plainPoll(null);
    expect(version).toBe("none");
    const held = heldPoll(null, version);
    await untilHeld(1);
    await publishInhouseRoomChange();
    const reply = await held;
    expect(reply.ms).toBeLessThan(INSTANT_MS);
    expect(reply.json?.roomVersion).not.toBe("none");
  });
});

describe("the long-poll: a held request ends by itself", () => {
  it("at the hold the client asked for, under the same version", async () => {
    await publishInhouseRoomChange();
    const { version } = await plainPoll(null);
    const reply = await heldPoll(null, version, 600);
    expect(reply.status).toBe(200);
    expect(reply.json?.roomVersion).toBe(version);
    expect(reply.ms).toBeGreaterThanOrEqual(590);
    expect(reply.ms).toBeLessThan(600 + INHOUSE.LONG_POLL_JITTER_MS + INSTANT_MS);
  });

  /** A ready check two accepts short, its clock running out in `inMs`. */
  async function readyCheckEnding(inMs: number) {
    const p = await users(10, "RC-");
    const acceptEndsAt = new Date(Date.now() + inMs);
    await prisma.inhouseLobby.create({
      data: {
        slot: 1,
        radiantTeam: 1,
        status: INHOUSE_STATUS.READY_CHECK,
        acceptEndsAt,
        players: {
          create: p.map((x, i) => ({
            userId: x.id,
            mmr: 4000 - i * 50,
            queuedAt: new Date(Date.now() - HOUR + i),
            acceptedAt: i < 8 ? new Date() : null,
          })),
        },
      },
    });
    await publishInhouseRoomChange();
    const { version, state } = await plainPoll(p[0].session);
    expect((state.lobby as { status: string }).status).toBe(INHOUSE_STATUS.READY_CHECK);
    // The plain poll may have taken the 2s claim for its board check.
    await prisma.setting.deleteMany({ where: { key: SETTING_KEYS.INHOUSE_ROOM_MAINTENANCE_AT } });
    return { p, acceptEndsAt, version };
  }

  it("at the room's next clock, and the signed-in poll that wakes resolves it", async () => {
    const { p, acceptEndsAt, version } = await readyCheckEnding(1_500);
    const reply = await heldPoll(p[0].session, version, INHOUSE.LONG_POLL_TIMED_HOLD_MS);
    const late = Date.now() - acceptEndsAt.getTime();
    expect(late).toBeGreaterThanOrEqual(INHOUSE.LONG_POLL_CLOCK_GRACE_MS - 20);
    expect(late).toBeLessThan(INSTANT_MS + INHOUSE.LONG_POLL_CLOCK_GRACE_MS);
    // The check failed (two never accepted): the reply shows it.
    expect(reply.json?.lobby).toBeNull();
    // It names the version read BEFORE its rows, never a newer one it may not
    // show: its own maintenance published since, so the client's next request
    // is answered at once rather than held.
    expect(reply.json?.roomVersion).toBe(version);
    const next = await heldPoll(p[0].session, version, INHOUSE.LONG_POLL_TIMED_HOLD_MS);
    expect(next.ms).toBeLessThan(INSTANT_MS);
    expect(next.json?.roomVersion).not.toBe(version);
    expect(next.json?.lobby).toBeNull();
  });

  it("past a claim another poll holds, the member's next hold retries the due work", async () => {
    const { p, acceptEndsAt, version } = await readyCheckEnding(1_200);
    // Another poll won the 2s claim just before the deadline and never
    // resolved anything (it was checking the board).
    await sleep(1_100);
    await prisma.setting.create({
      data: { key: SETTING_KEYS.INHOUSE_ROOM_MAINTENANCE_AT, value: new Date().toISOString() },
    });
    // The client's loop: re-issue with the version each reply names.
    let reply = await heldPoll(p[0].session, version, INHOUSE.LONG_POLL_TIMED_HOLD_MS);
    let requests = 1;
    while (reply.json?.lobby && requests < 5) {
      reply = await heldPoll(p[0].session, String(reply.json.roomVersion), INHOUSE.LONG_POLL_TIMED_HOLD_MS);
      requests += 1;
    }
    expect(reply.json?.lobby).toBeNull();
    // One wake at the clock that lost the claim, one retry past it.
    expect(requests).toBe(2);
    expect(Date.now() - acceptEndsAt.getTime()).toBeLessThan(
      INHOUSE.LONG_POLL_CLOCK_GRACE_MS + INHOUSE.LONG_POLL_DUE_RETRY_MS + INSTANT_MS,
    );
  });

  it("when its client goes away: no poll, nothing left held", async () => {
    await publishInhouseRoomChange();
    const { version } = await plainPoll(null);
    const controller = new AbortController();
    const held = room(null, { action: "state", since: version }, inhousePOST, controller.signal);
    await untilHeld(1);
    const findMany = vi.spyOn(prisma.inhouseQueueEntry, "findMany");
    controller.abort();
    const reply = await held;
    expect(reply.status).toBe(204);
    expect(reply.ms).toBeLessThan(INSTANT_MS);
    expect(heldInhouseRoomRequests()).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("the long-poll's request volume", () => {
  it("looping clients make about one request per change, plus one per hold", async () => {
    // Four viewers long-poll the way the room does (send back the version,
    // re-issue at once, never closer than the gap) while another player joins
    // and leaves every 1.2s, for 6s. A ladder client spends its requests on
    // time; these spend them on changes.
    const viewers = [null, ...(await users(3, "VOL-")).map((u) => u.session)];
    const [mover] = await users(1, "MOVE-");
    await publishInhouseRoomChange();
    const RUN_MS = 6_000;
    const CHANGE_MS = 1_200;
    const stopAt = Date.now() + RUN_MS;
    const counts = viewers.map(() => 0);
    const loops = viewers.map(async (session, i) => {
      let version = (await plainPoll(session)).version;
      counts[i] += 1;
      while (Date.now() < stopAt) {
        const started = Date.now();
        const reply = await heldPoll(session, version, Math.max(0, stopAt - Date.now()));
        counts[i] += 1;
        version = String(reply.json?.roomVersion);
        const gap = INHOUSE.LONG_POLL_MIN_GAP_MS - (Date.now() - started);
        if (gap > 0) await sleep(gap);
      }
    });
    let changes = 0;
    for (let at = CHANGE_MS; at < RUN_MS; at += CHANGE_MS) {
      await sleep(CHANGE_MS);
      const action = changes % 2 === 0 ? "join" : "leave";
      expect((await room(mover.session, { action, mmr: 3000 })).status).toBe(200);
      changes += 1;
    }
    await Promise.all(loops);
    // Each change wakes each viewer once (a mutation's two publishes are
    // coalesced), plus the first poll and the hold's end.
    for (const n of counts) {
      expect(n).toBeGreaterThanOrEqual(changes);
      expect(n).toBeLessThanOrEqual(changes + 3);
    }
    // For the record: the fallback ladder over the same 6s would be 2 polls
    // queued (3s), 1 spectating (10s), 4 in a clocked stage (1.5s); the
    // ladder before 2026-10-18 0-1 queued (10s) and 0-1 spectating (30s).
    process.stdout.write(
      `[long-poll volume] ${viewers.length} viewers, ${changes} changes in ${RUN_MS / SEC}s: requests ${counts.join(", ")}\n`,
    );
  });
});
