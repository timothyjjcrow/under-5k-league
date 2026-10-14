import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  getSessionUser: vi.fn(),
  clientIp: vi.fn(),
  rateLimit: vi.fn(),
  getInhouseState: vi.fn(),
  joinQueue: vi.fn(),
  leaveQueue: vi.fn(),
  acceptMatch: vi.fn(),
  declineMatch: vi.fn(),
  castVote: vi.fn(),
  makePick: vi.fn(),
  startGame: vi.fn(),
  finishGame: vi.fn(),
  giveUpOnResult: vi.fn(),
  setInhouseRoles: vi.fn(),
  recordMatch: vi.fn(),
  autoDetectResult: vi.fn(),
  cancelLobby: vi.fn(),
  voidLastResult: vi.fn(),
  removeFromQueue: vi.fn(),
  pollInhouseState: vi.fn(),
  readInhouseRoomVersion: vi.fn(),
  publishInhouseRoomChange: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidateTag }));
vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/rate-limit", () => ({
  clientIp: mocks.clientIp,
  rateLimit: mocks.rateLimit,
  retryAfterSeconds: (result: { retryAfterMs: number }) =>
    String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
}));
vi.mock("@/lib/inhouse-service", () => ({
  getInhouseState: mocks.getInhouseState,
  joinQueue: mocks.joinQueue,
  leaveQueue: mocks.leaveQueue,
  acceptMatch: mocks.acceptMatch,
  declineMatch: mocks.declineMatch,
  castVote: mocks.castVote,
  makePick: mocks.makePick,
  startGame: mocks.startGame,
  finishGame: mocks.finishGame,
  giveUpOnResult: mocks.giveUpOnResult,
  setInhouseRoles: mocks.setInhouseRoles,
  recordMatch: mocks.recordMatch,
  autoDetectResult: mocks.autoDetectResult,
  cancelLobby: mocks.cancelLobby,
  voidLastResult: mocks.voidLastResult,
  removeFromQueue: mocks.removeFromQueue,
}));
vi.mock("@/lib/inhouse-room-state", () => ({
  pollInhouseState: mocks.pollInhouseState,
}));
vi.mock("@/lib/inhouse-room-version", () => ({
  readInhouseRoomVersion: mocks.readInhouseRoomVersion,
  publishInhouseRoomChange: mocks.publishInhouseRoomChange,
}));

import { POST } from "./route";

const user = { id: "player-1", name: "Player", role: "USER" };
const VERSION = "room-version-1";
const state = { now: 1_800_000_000_000, lobby: null, queue: [] };
const actionMocks = [
  mocks.joinQueue,
  mocks.leaveQueue,
  mocks.acceptMatch,
  mocks.declineMatch,
  mocks.castVote,
  mocks.makePick,
  mocks.startGame,
  mocks.finishGame,
  mocks.giveUpOnResult,
  mocks.setInhouseRoles,
  mocks.recordMatch,
  mocks.autoDetectResult,
  mocks.cancelLobby,
  mocks.voidLastResult,
  mocks.removeFromQueue,
];

function request(body: unknown) {
  return new NextRequest("https://league.example/api/inhouse", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://league.example",
    },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string) {
  return new NextRequest("https://league.example/api/inhouse", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://league.example",
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Order tests below install implementations; start each test without one.
  mocks.revalidateTag.mockReset();
  mocks.getSessionUser.mockResolvedValue(user);
  mocks.clientIp.mockReturnValue("203.0.113.10");
  mocks.rateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
  mocks.pollInhouseState.mockResolvedValue({ state, invalidateGate: false });
  mocks.getInhouseState.mockResolvedValue(state);
  mocks.readInhouseRoomVersion.mockResolvedValue(VERSION);
  mocks.publishInhouseRoomChange.mockResolvedValue(undefined);
  for (const action of actionMocks) action.mockResolvedValue({ ok: true });
});

describe("POST /api/inhouse request boundary", () => {
  it("rejects foreign-origin mutations before session or action work", async () => {
    const req = request({ action: "join", mmr: 1000 });
    req.headers.set("origin", "https://sibling.example");

    const response = await POST(req);

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.joinQueue).not.toHaveBeenCalled();
  });

  it("rejects text/plain JSON before parsing", async () => {
    const req = request({ action: "join", mmr: 1000 });
    req.headers.set("content-type", "text/plain");

    const response = await POST(req);

    expect(response.status).toBe(415);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  it("keeps state public with a NAT-safe shared polling allowance", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await POST(request({ action: "state" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(state);
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      "inhouse:state:ip:203.0.113.10",
      { limit: 1200, windowMs: 60_000 },
      expect.any(Number),
    );
    // The poll owns the signed-out rules (reads only); the route hands it
    // the session as resolved on this request and runs nothing itself.
    expect(mocks.pollInhouseState).toHaveBeenCalledWith(null, VERSION);
    expect(mocks.getInhouseState).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
    // A poll reads the room version; it never publishes one.
    expect(mocks.readInhouseRoomVersion).toHaveBeenCalledOnce();
    expect(mocks.publishInhouseRoomChange).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON instead of silently running a state poll", async () => {
    const response = await POST(rawRequest("{not-json"));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/valid JSON/i);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.getInhouseState).not.toHaveBeenCalled();
  });

  it("rejects an oversized JSON body before auth, rate-limit, or service work", async () => {
    const response = await POST(
      request({ action: "state", padding: "x".repeat(9_000) }),
    );

    expect(response.status).toBe(413);
    expect(mocks.clientIp).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.getInhouseState).not.toHaveBeenCalled();
    expect(mocks.pollInhouseState).not.toHaveBeenCalled();
  });

  it.each([null, [], "state", 7, true])(
    "rejects a non-object JSON body (%j)",
    async (body) => {
      const response = await POST(request(body));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/JSON object/i);
      expect(mocks.getInhouseState).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { action: "" }, { action: "   " }, { action: 7 }])(
    "requires an explicit string action (%j)",
    async (body) => {
      const response = await POST(request(body));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/action is required/i);
      expect(mocks.getInhouseState).not.toHaveBeenCalled();
    },
  );

  it("rate-limits public state without running auth or resolvers", async () => {
    mocks.rateLimit.mockReturnValue({ allowed: false, retryAfterMs: 1_000 });

    const response = await POST(request({ action: "state" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.getInhouseState).not.toHaveBeenCalled();
    expect(mocks.pollInhouseState).not.toHaveBeenCalled();
  });

  it("requires authentication for mutations and bounds signed-out attempts by IP", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await POST(request({ action: "join", mmr: 4000 }));

    expect(response.status).toBe(401);
    expect((await response.json()).error).toMatch(/sign in/i);
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      "inhouse:mutation:ip:203.0.113.10",
      { limit: 300, windowMs: 60_000 },
      expect.any(Number),
    );
    expect(mocks.joinQueue).not.toHaveBeenCalled();
  });

  it("uses an independent per-user mutation bucket and returns fresh state", async () => {
    const response = await POST(request({ action: "leave" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(state);
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      `inhouse:mutation:user:${user.id}`,
      { limit: 300, windowMs: 60_000 },
      expect.any(Number),
    );
    expect(mocks.leaveQueue).toHaveBeenCalledWith(user);
    expect(mocks.getInhouseState).toHaveBeenCalledWith(user, {
      runMaintenance: false,
      syncBoard: false,
    });
    expect(mocks.revalidateTag).toHaveBeenCalledOnce();
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v12", {
      expire: 0,
    });
  });

  it("expires the gate after a dispatched mutation returns an error", async () => {
    mocks.makePick.mockResolvedValue({ ok: false, error: "Pick expired" });

    const response = await POST(request({ action: "pick", userId: "late" }));

    expect(response.status).toBe(400);
    expect(mocks.getInhouseState).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v12", {
      expire: 0,
    });
  });

  it("expires the gate when the post-commit state read fails", async () => {
    mocks.getInhouseState.mockRejectedValue(new Error("read failed"));

    await expect(POST(request({ action: "leave" }))).rejects.toThrow(
      "read failed",
    );
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v12", {
      expire: 0,
    });
  });

  it("polls as the signed-in viewer and expires the gate when the poll changed it", async () => {
    mocks.pollInhouseState.mockResolvedValue({ state, invalidateGate: true });

    const response = await POST(request({ action: "state" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(state);
    expect(mocks.getSessionUser).toHaveBeenCalledOnce();
    expect(mocks.pollInhouseState).toHaveBeenCalledWith(user, VERSION);
    // Maintenance is the poll's call, never the route's own.
    expect(mocks.getInhouseState).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).toHaveBeenCalledOnce();
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v12", {
      expire: 0,
    });
  });

  it("leaves the gate alone when a signed-in poll changed nothing it schedules on", async () => {
    const response = await POST(request({ action: "state" }));

    expect(response.status).toBe(200);
    expect(mocks.pollInhouseState).toHaveBeenCalledWith(user, VERSION);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
    expect(mocks.publishInhouseRoomChange).not.toHaveBeenCalled();
  });

  it("passes a failed poll through without expiring the gate itself", async () => {
    // pollInhouseState expires the gate on its own throw path once it has
    // changed something; the route never saw a result to read the flag from.
    mocks.pollInhouseState.mockRejectedValue(new Error("read failed"));

    await expect(POST(request({ action: "state" }))).rejects.toThrow(
      "read failed",
    );
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it.each([
    ["ok", () => {}, 200],
    [
      "a refusal",
      () => mocks.leaveQueue.mockResolvedValue({ ok: false, error: "no" }),
      400,
    ],
  ] as const)(
    "publishes the room change after %s, before the response and the gate",
    async (_label, arrange, status) => {
      arrange();
      const order: string[] = [];
      mocks.leaveQueue.mockImplementation(async () => {
        order.push("dispatch");
        return status === 200 ? { ok: true } : { ok: false, error: "no" };
      });
      mocks.getInhouseState.mockImplementation(async () => {
        order.push("read");
        return state;
      });
      mocks.publishInhouseRoomChange.mockImplementation(async () => {
        order.push("publish");
      });
      mocks.revalidateTag.mockImplementation(() => {
        order.push("gate");
      });

      const response = await POST(request({ action: "leave" }));

      expect(response.status).toBe(status);
      expect(order).toEqual(
        status === 200
          ? ["dispatch", "publish", "read", "publish", "gate"]
          : ["dispatch", "publish", "gate"],
      );
    },
  );

  it.each([
    ["join", mocks.joinQueue],
    ["leave", mocks.leaveQueue],
    ["accept", mocks.acceptMatch],
    ["decline", mocks.declineMatch],
    ["vote", mocks.castVote],
    ["pick", mocks.makePick],
    ["start", mocks.startGame],
    ["finish", mocks.finishGame],
    ["roles", mocks.setInhouseRoles],
    ["record", mocks.recordMatch],
    ["detect", mocks.autoDetectResult],
    ["cancel", mocks.cancelLobby],
    ["giveup", mocks.giveUpOnResult],
    ["void", mocks.voidLastResult],
    ["remove", mocks.removeFromQueue],
  ] as const)("%s: dispatch, publish, fresh read, publish, then the gate", async (action, service) => {
    const order: string[] = [];
    service.mockImplementation(async () => {
      order.push("dispatch");
      return { ok: true };
    });
    mocks.getInhouseState.mockImplementation(async () => {
      order.push("read");
      return state;
    });
    mocks.publishInhouseRoomChange.mockImplementation(async () => {
      order.push("publish");
    });
    mocks.revalidateTag.mockImplementation(() => {
      order.push("gate");
    });

    const response = await POST(request({ action, mmr: 3000, userId: "u2" }));

    expect(response.status).toBe(200);
    expect(order).toEqual(["dispatch", "publish", "read", "publish", "gate"]);
  });

  it("publishes the action's commit before the follow-up read starts", async () => {
    // The read is several round trips: a poll sent while the action was in
    // flight must find the new version during it, not after it.
    let publishedBeforeRead = 0;
    mocks.getInhouseState.mockImplementation(async () => {
      publishedBeforeRead = mocks.publishInhouseRoomChange.mock.calls.length;
      return state;
    });

    const response = await POST(request({ action: "pick", userId: "u2" }));

    expect(response.status).toBe(200);
    expect(publishedBeforeRead).toBe(1);
  });

  it("publishes again when the follow-up read throws after its heartbeat", async () => {
    mocks.getInhouseState.mockRejectedValue(new Error("read failed"));

    await expect(
      POST(request({ action: "pick", userId: "u2" })),
    ).rejects.toThrow("read failed");
    expect(mocks.publishInhouseRoomChange).toHaveBeenCalledTimes(2);
    expect(mocks.revalidateTag).toHaveBeenCalledOnce();
  });

  it("publishes the room change when an action throws", async () => {
    mocks.makePick.mockRejectedValue(new Error("boom"));

    await expect(
      POST(request({ action: "pick", userId: "u2" })),
    ).rejects.toThrow("boom");
    expect(mocks.publishInhouseRoomChange).toHaveBeenCalledOnce();
    expect(mocks.revalidateTag).toHaveBeenCalledOnce();
  });

  it.each([
    ["signed out", () => mocks.getSessionUser.mockResolvedValue(null), { action: "join" }],
    ["unknown", () => {}, { action: "launch-missiles" }],
    [
      "rate-limited",
      () => mocks.rateLimit.mockReturnValue({ allowed: false, retryAfterMs: 1_000 }),
      { action: "leave" },
    ],
  ] as const)("publishes nothing for an action never dispatched (%s)", async (_l, arrange, body) => {
    arrange();
    await POST(request(body));
    expect(mocks.publishInhouseRoomChange).not.toHaveBeenCalled();
  });

  it("returns 429 before dispatching a rate-limited mutation", async () => {
    mocks.rateLimit.mockReturnValue({ allowed: false, retryAfterMs: 1_000 });

    const response = await POST(request({ action: "leave" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      `inhouse:mutation:user:${user.id}`,
      expect.objectContaining({ limit: 300 }),
      expect.any(Number),
    );
    expect(mocks.leaveQueue).not.toHaveBeenCalled();
    expect(mocks.getInhouseState).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("cancels with the viewer alone, ignoring a stale force flag", async () => {
    // The forced cancel existed only for live games with Cred staked on them.
    // Betting is gone, so an old tab's `force` must not reach the service.
    await POST(request({ action: "cancel", force: true }));

    expect(mocks.cancelLobby).toHaveBeenCalledOnce();
    expect(mocks.cancelLobby).toHaveBeenCalledWith(user, null);
  });

  it("hands each lobby action the game the room showed", async () => {
    // Two games can be live: the click is judged against the lobby it was on.
    await POST(request({ action: "cancel", lobbyId: "lobby-2" }));
    await POST(request({ action: "accept", lobbyId: "lobby-2" }));
    await POST(request({ action: "pick", userId: "u9", lobbyId: "lobby-2" }));
    // Only a string names a game.
    await POST(request({ action: "decline", lobbyId: { id: "lobby-2" } }));

    expect(mocks.cancelLobby).toHaveBeenCalledWith(user, "lobby-2");
    expect(mocks.acceptMatch).toHaveBeenCalledWith(user, "lobby-2");
    expect(mocks.makePick).toHaveBeenCalledWith(user, "u9", "lobby-2");
    expect(mocks.declineMatch).toHaveBeenCalledWith(user, null);
  });

  it("marks the game the room showed over, queueing the presser only on a literal true", async () => {
    await POST(request({ action: "finish", lobbyId: "lobby-2", requeue: true }));
    await POST(request({ action: "finish", lobbyId: "lobby-1", requeue: "yes" }));

    expect(mocks.finishGame).toHaveBeenNthCalledWith(1, user, "lobby-2", {
      requeue: true,
    });
    expect(mocks.finishGame).toHaveBeenNthCalledWith(2, user, "lobby-1", {
      requeue: false,
    });
  });

  it("gives up on a result only through its own action, naming the game", async () => {
    await POST(request({ action: "giveup", lobbyId: "lobby-3" }));
    await POST(request({ action: "cancel", lobbyId: "lobby-3" }));

    expect(mocks.giveUpOnResult).toHaveBeenCalledOnce();
    expect(mocks.giveUpOnResult).toHaveBeenCalledWith(user, "lobby-3");
    expect(mocks.cancelLobby).toHaveBeenCalledWith(user, "lobby-3");
  });

  it("removes a queued player only through its own action, naming them", async () => {
    // The service decides who may (admins) and whether they're still queued;
    // the route hands it the named player, and a missing name as "".
    await POST(request({ action: "remove", userId: "player-9" }));
    await POST(request({ action: "remove" }));

    expect(mocks.removeFromQueue).toHaveBeenNthCalledWith(1, user, "player-9");
    expect(mocks.removeFromQueue).toHaveBeenNthCalledWith(2, user, "");
    expect(mocks.leaveQueue).not.toHaveBeenCalled();
  });

  it("hands the raw role choice to the service, on its own and with a join", async () => {
    // The service validates strictly; the route never reshapes what was sent.
    await POST(request({ action: "roles", roles: ["2", "3"] }));
    await POST(request({ action: "join", mmr: 3000, roles: ["5"] }));
    await POST(request({ action: "join", mmr: 3000 }));

    expect(mocks.setInhouseRoles).toHaveBeenCalledWith(user, ["2", "3"]);
    expect(mocks.joinQueue).toHaveBeenNthCalledWith(1, user, 3000, ["5"]);
    expect(mocks.joinQueue).toHaveBeenNthCalledWith(2, user, 3000, undefined);
  });

  it("refuses the retired bet action as unknown", async () => {
    const response = await POST(request({ action: "bet", stake: 20 }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/unknown action/i);
    expect(mocks.getInhouseState).not.toHaveBeenCalled();
  });

  it("rejects an unknown explicit action without reading fresh state", async () => {
    const response = await POST(request({ action: "launch-missiles" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/unknown action/i);
    expect(mocks.getInhouseState).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });
});
