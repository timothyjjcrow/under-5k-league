import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The inhouse pings never hold a request someone is waiting on. Discord can
// take 5s to answer a post, and the room holds the player's controls (one
// action lock) until their POST answers, so the "match found" ping and the
// queue's "almost there" ping go out after the response (runAfterResponse,
// Next's `after`). The worker is the exception: its own response comes only
// after a pass of up to 45s, so it sends the match-found ping at once, inside
// the ready check's 90s.
//
// `after` is captured here, as a request scope would hold it. Outside a
// request (the other suites) it throws and the ping is sent inline.
const { after } = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after };
});
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSessionUser: vi.fn(async () => null) };
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
    postWebhookMessage: vi.fn(async () => null),
    patchWebhookMessage: vi.fn(async () => "ok" as const),
    deleteWebhookMessage: vi.fn(async () => true),
  };
});
import { prisma } from "@/lib/prisma";
import { INHOUSE, INHOUSE_STATUS } from "@/lib/constants";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import { sendInhouseDiscordMessage } from "@/lib/discord";
import { maybeFormLobby } from "@/lib/inhouse-service";
import { runResultSync } from "@/lib/result-sync-service";
import { readInhouseRoomVersion } from "@/lib/inhouse-room-version";
import { POST } from "@/app/api/inhouse/route";
import { makeUser, sessionFor } from "./factories";

const mockSession = vi.mocked(getSessionUser);
const mockSend = vi.mocked(sendInhouseDiscordMessage);

/** Tasks handed to `after`, in order, to run once "the response is sent". */
let scheduled: (() => Promise<unknown>)[] = [];

beforeEach(() => {
  scheduled = [];
  after.mockReset().mockImplementation((task: () => Promise<unknown>) => {
    scheduled.push(task);
  });
  mockSession.mockReset().mockResolvedValue(null);
  mockSend.mockReset().mockResolvedValue(true);
});

/** Run what `after` was handed, as Next does once the response is out. */
async function sendResponse() {
  const tasks = scheduled;
  scheduled = [];
  for (const task of tasks) await task();
}

const pings = (kind: RegExp) =>
  mockSend.mock.calls.map(([content]) => content).filter((c) => kind.test(c));
const MATCH_FOUND = /Inhouse match found/;
const QUEUE_PING = /Inhouse queue/;

/** `n` signed-up players queued and present, without a join's side effects. */
async function queued(n: number, prefix: string) {
  const now = Date.now();
  const out: SessionUser[] = [];
  for (let i = 0; i < n; i += 1) {
    const user = await makeUser(`${prefix}${i}`);
    await prisma.inhouseQueueEntry.create({
      data: {
        userId: user.id,
        mmr: 3000 + i,
        joinedAt: new Date(now - 60_000 + i),
        lastSeenAt: new Date(now - 1_000),
        idleExpiresAt: new Date(now + 60 * 60_000),
      },
    });
    out.push(sessionFor(user));
  }
  return out;
}

/** POST /api/inhouse as `session`. */
async function room(session: SessionUser, body: Record<string, unknown>) {
  mockSession.mockResolvedValue(session);
  const res = await POST(
    new NextRequest("http://localhost:3000/api/inhouse", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

const readyChecks = () =>
  prisma.inhouseLobby.count({ where: { status: INHOUSE_STATUS.READY_CHECK } });

describe("inhouse pings go out after the response", () => {
  it("the tenth joiner's POST answers before the match-found ping is sent", async () => {
    await queued(INHOUSE.LOBBY_SIZE - 1, "Q");
    const tenth = sessionFor(await makeUser("Tenth"));
    const before = await readInhouseRoomVersion();

    const res = await room(tenth, { action: "join", mmr: 3000 });

    expect(res.status).toBe(200);
    expect(res.json.lobby?.status).toBe(INHOUSE_STATUS.READY_CHECK);
    expect(await readyChecks()).toBe(1);
    // Answered, and Discord not asked yet: the ping waits for the response.
    expect(mockSend).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    // Rule P still holds: the room was told before the ping goes out.
    expect(await readInhouseRoomVersion()).not.toBe(before);

    await sendResponse();
    const found = pings(MATCH_FOUND);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("Tenth");
    expect(found[0]).toContain("Q0");
  });

  it("a room poll that forms the game answers before the ping is sent", async () => {
    const [viewer] = await queued(INHOUSE.LOBBY_SIZE, "P");

    const res = await room(viewer, { action: "state" });

    expect(res.status).toBe(200);
    expect(res.json.lobby?.status).toBe(INHOUSE_STATUS.READY_CHECK);
    expect(mockSend).not.toHaveBeenCalled();
    expect(scheduled.length).toBeGreaterThanOrEqual(1);

    await sendResponse();
    expect(pings(MATCH_FOUND)).toHaveLength(1);
  });

  it("the join that crosses the milestone answers before the queue ping is sent", async () => {
    await queued(INHOUSE.QUEUE_PING_AT - 1, "M");
    const joiner = sessionFor(await makeUser("Milestone"));

    const res = await room(joiner, { action: "join", mmr: 3000 });

    expect(res.status).toBe(200);
    expect(res.json.me?.inQueue).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    await sendResponse();
    expect(pings(QUEUE_PING)).toHaveLength(1);
    expect(pings(MATCH_FOUND)).toHaveLength(0);
  });

  it("a failed ping after the response loses nothing", async () => {
    await queued(INHOUSE.LOBBY_SIZE - 1, "F");
    const tenth = sessionFor(await makeUser("Tenth"));
    mockSend.mockRejectedValue(new Error("discord down"));

    expect((await room(tenth, { action: "join", mmr: 3000 })).status).toBe(200);
    await expect(sendResponse()).resolves.toBeUndefined();
    expect(await readyChecks()).toBe(1);
  });
});

describe("the worker sends the match-found ping during its pass", () => {
  it("through its inhouse leg, before its response", async () => {
    await queued(INHOUSE.LOBBY_SIZE, "W");

    await runResultSync();

    expect(await readyChecks()).toBe(1);
    // Sent during the pass, not left for after the worker's response.
    expect(pings(MATCH_FOUND)).toHaveLength(1);
  });

  it("only when asked: the default waits for the response", async () => {
    await queued(INHOUSE.LOBBY_SIZE, "D");
    expect(await maybeFormLobby({ pingAfterResponse: false })).toBe(true);
    expect(pings(MATCH_FOUND)).toHaveLength(1);
    expect(scheduled).toHaveLength(0);

    await queued(INHOUSE.LOBBY_SIZE, "E");
    expect(await maybeFormLobby()).toBe(true);
    expect(pings(MATCH_FOUND)).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    await sendResponse();
    expect(pings(MATCH_FOUND)).toHaveLength(2);
  });
});
