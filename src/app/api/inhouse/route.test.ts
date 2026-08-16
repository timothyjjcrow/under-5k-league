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
  recordMatch: vi.fn(),
  autoDetectResult: vi.fn(),
  cancelLobby: vi.fn(),
  voidLastResult: vi.fn(),
  placeInhouseBet: vi.fn(),
  claimThrottle: vi.fn(),
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
  recordMatch: mocks.recordMatch,
  autoDetectResult: mocks.autoDetectResult,
  cancelLobby: mocks.cancelLobby,
  voidLastResult: mocks.voidLastResult,
}));
vi.mock("@/lib/inhouse-bet-service", () => ({
  placeInhouseBet: mocks.placeInhouseBet,
}));
vi.mock("@/lib/settings", () => ({
  claimThrottle: mocks.claimThrottle,
  SETTING_KEYS: {
    INHOUSE_ROOM_MAINTENANCE_AT: "inhouseRoomMaintenanceAt",
  },
}));

import { POST } from "./route";

const user = { id: "player-1", name: "Player", role: "USER" };
const state = { now: 1_800_000_000_000, lobby: null, queue: [] };
const actionMocks = [
  mocks.joinQueue,
  mocks.leaveQueue,
  mocks.acceptMatch,
  mocks.declineMatch,
  mocks.castVote,
  mocks.makePick,
  mocks.startGame,
  mocks.recordMatch,
  mocks.autoDetectResult,
  mocks.cancelLobby,
  mocks.voidLastResult,
  mocks.placeInhouseBet,
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
  mocks.getSessionUser.mockResolvedValue(user);
  mocks.clientIp.mockReturnValue("203.0.113.10");
  mocks.rateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
  mocks.claimThrottle.mockResolvedValue(true);
  mocks.getInhouseState.mockResolvedValue(state);
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
    expect(mocks.claimThrottle).not.toHaveBeenCalled();
    expect(mocks.getInhouseState).toHaveBeenCalledWith(null, {
      runMaintenance: false,
      syncBoard: false,
    });
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
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
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v3", {
      expire: 0,
    });
  });

  it("expires the gate after a dispatched mutation returns an error", async () => {
    mocks.makePick.mockResolvedValue({ ok: false, error: "Pick expired" });

    const response = await POST(request({ action: "pick", userId: "late" }));

    expect(response.status).toBe(400);
    expect(mocks.getInhouseState).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v3", {
      expire: 0,
    });
  });

  it("expires the gate when the post-commit state read fails", async () => {
    mocks.getInhouseState.mockRejectedValue(new Error("read failed"));

    await expect(POST(request({ action: "leave" }))).rejects.toThrow(
      "read failed",
    );
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v3", {
      expire: 0,
    });
  });

  it("lets the fleet-throttled authenticated poll winner run recovery", async () => {
    const response = await POST(request({ action: "state" }));

    expect(response.status).toBe(200);
    expect(mocks.claimThrottle).toHaveBeenCalledWith(
      "inhouseRoomMaintenanceAt",
      2,
      expect.any(Number),
    );
    expect(mocks.getInhouseState).toHaveBeenCalledWith(user, {
      runMaintenance: true,
      syncBoard: true,
    });
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v3", {
      expire: 0,
    });
  });

  it("returns personalized state without maintenance when another instance owns the throttle", async () => {
    mocks.claimThrottle.mockResolvedValue(false);

    const response = await POST(request({ action: "state" }));

    expect(response.status).toBe(200);
    expect(mocks.getInhouseState).toHaveBeenCalledWith(user, {
      runMaintenance: false,
      syncBoard: false,
    });
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
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

  it("treats a force string as false and only literal true as forced", async () => {
    await POST(request({ action: "cancel", force: "false" }));
    await POST(request({ action: "cancel", force: true }));

    expect(mocks.cancelLobby).toHaveBeenNthCalledWith(1, user, {
      force: false,
    });
    expect(mocks.cancelLobby).toHaveBeenNthCalledWith(2, user, {
      force: true,
    });
  });

  it("rejects an unknown explicit action without reading fresh state", async () => {
    const response = await POST(request({ action: "launch-missiles" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/unknown action/i);
    expect(mocks.getInhouseState).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });
});
