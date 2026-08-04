import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getActiveSeason: vi.fn(),
  getDraftState: vi.fn(),
  placeBid: vi.fn(),
  nominatePlayer: vi.fn(),
  rateLimit: vi.fn(),
  clientIp: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/season", () => ({ getActiveSeason: mocks.getActiveSeason }));
vi.mock("@/lib/draft-service", () => ({
  getDraftState: mocks.getDraftState,
  placeBid: mocks.placeBid,
  nominatePlayer: mocks.nominatePlayer,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  clientIp: mocks.clientIp,
}));

import { POST as tick } from "./tick/route";
import { POST as bid } from "./bid/route";
import { POST as nominate } from "./nominate/route";
import { POST as adminNominate } from "./admin-nominate/route";

const user = { id: "captain-1", name: "Captain", role: "USER" };
const admin = { id: "admin-1", name: "Admin", role: "ADMIN" };
const season = { id: "season-1", name: "Season One" };
const state = { seasonId: season.id, status: "IN_PROGRESS" };
const turn = {
  seasonId: season.id,
  draftVersion: 1_800_000_000_000,
  nominatorTeamId: "team-1",
  nominationEndsAt: 1_800_000_030_000,
};
const lot = {
  seasonId: season.id,
  draftVersion: 1_800_000_000_001,
  nominatedUserId: "player-1",
  currentBid: 7,
  currentBidTeamId: "team-2",
  bidEndsAt: 1_800_000_030_001,
};

function request(path: string, body: unknown) {
  return new NextRequest(`https://league.example/api/draft/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://league.example",
    },
    body: JSON.stringify(body),
  });
}

function rawRequest(path: string, body: string) {
  return new NextRequest(`https://league.example/api/draft/${path}`, {
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
  mocks.getActiveSeason.mockResolvedValue(season);
  mocks.getDraftState.mockResolvedValue(state);
  mocks.placeBid.mockResolvedValue({ ok: true });
  mocks.nominatePlayer.mockResolvedValue({ ok: true });
  mocks.rateLimit.mockReturnValue({ allowed: true });
  mocks.clientIp.mockReturnValue("203.0.113.10");
});

describe("POST /api/draft/tick", () => {
  it("returns a no-store snapshot only for the room's expected season", async () => {
    const response = await tick(request("tick", { seasonId: season.id }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(state);
    expect(mocks.getDraftState).toHaveBeenCalledWith(season.id, user);
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      `draft:user:${user.id}`,
      expect.objectContaining({ limit: 300 }),
      expect.any(Number),
    );
  });

  it("rejects a parked tab after the active season changes", async () => {
    const response = await tick(request("tick", { seasonId: "old-season" }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/active season changed/i);
    expect(mocks.getDraftState).not.toHaveBeenCalled();
  });

  it("rejects a missing season claim instead of attaching an old tab implicitly", async () => {
    const response = await tick(request("tick", {}));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(
      /active season changed|out of date/i,
    );
    expect(mocks.getDraftState).not.toHaveBeenCalled();
  });

  it("gives anonymous spectators the bounded IP allowance", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await tick(request("tick", { seasonId: season.id }));

    expect(response.status).toBe(200);
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      "draft:preflight:ip:203.0.113.10",
      expect.objectContaining({ limit: 1200 }),
      expect.any(Number),
    );
    expect(mocks.getDraftState).toHaveBeenCalledWith(season.id, null);
  });
});

describe("POST /api/draft/bid", () => {
  it("rejects a foreign-origin credentialed mutation before auth or database work", async () => {
    const req = request("bid", { ...lot, amount: 8 });
    req.headers.set("origin", "https://sibling.example");

    const response = await bid(req);

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.getActiveSeason).not.toHaveBeenCalled();
  });

  it("rejects text/plain JSON before auth or body parsing", async () => {
    const req = request("bid", { ...lot, amount: 8 });
    req.headers.set("content-type", "text/plain");

    const response = await bid(req);

    expect(response.status).toBe(415);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  it("requires a signed-in captain", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await bid(request("bid", { ...lot, amount: 8 }));
    expect(response.status).toBe(401);
    expect(mocks.placeBid).not.toHaveBeenCalled();
  });

  it("forwards the exact lot identity to the service", async () => {
    const response = await bid(request("bid", { ...lot, amount: 8 }));

    expect(response.status).toBe(200);
    expect(mocks.placeBid).toHaveBeenCalledWith(
      season.id,
      user,
      8,
      expect.objectContaining({
        draftVersion: lot.draftVersion,
        nominatedUserId: lot.nominatedUserId,
        currentBidTeamId: lot.currentBidTeamId,
        bidEndsAt: lot.bidEndsAt,
      }),
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      `draft:mutation:${user.id}`,
      expect.objectContaining({ limit: 120 }),
      expect.any(Number),
    );
  });

  it("rate-limits repeated authenticated mutations before reading the season", async () => {
    mocks.rateLimit.mockReturnValueOnce({
      allowed: false,
      retryAfterMs: 2_100,
    });
    const response = await bid(request("bid", { ...lot, amount: 8 }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(mocks.getActiveSeason).not.toHaveBeenCalled();
    expect(mocks.placeBid).not.toHaveBeenCalled();
  });

  it("rejects missing lot metadata without attempting a bid", async () => {
    const response = await bid(
      request("bid", { seasonId: season.id, amount: 8 }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/out of date/i);
    expect(mocks.placeBid).not.toHaveBeenCalled();
  });

  it("returns a conflict when the service observes a changed lot", async () => {
    mocks.placeBid.mockResolvedValue({
      ok: false,
      error: "Another bid just landed — try again",
    });
    const response = await bid(request("bid", { ...lot, amount: 8 }));
    expect(response.status).toBe(409);
  });

  it("fails closed on malformed JSON", async () => {
    const response = await bid(rawRequest("bid", "{not-json"));

    expect(response.status).toBe(409);
    expect(mocks.placeBid).not.toHaveBeenCalled();
  });
});

describe("nomination routes", () => {
  it("forwards the captain's exact nomination turn", async () => {
    const response = await nominate(
      request("nominate", { ...turn, playerId: "player-2", amount: 3 }),
    );

    expect(response.status).toBe(200);
    expect(mocks.nominatePlayer).toHaveBeenCalledWith(
      season.id,
      user,
      "player-2",
      3,
      expect.objectContaining({
        draftVersion: turn.draftVersion,
        nominatorTeamId: turn.nominatorTeamId,
        nominationEndsAt: turn.nominationEndsAt,
      }),
    );
  });

  it("keeps the admin fallback role-restricted", async () => {
    const response = await adminNominate(request("admin-nominate", turn));
    expect(response.status).toBe(403);
    expect(mocks.nominatePlayer).not.toHaveBeenCalled();
  });

  it("requires the exact nomination turn metadata", async () => {
    const response = await nominate(
      request("nominate", {
        seasonId: season.id,
        playerId: "player-2",
        amount: 3,
      }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/out of date/i);
    expect(mocks.nominatePlayer).not.toHaveBeenCalled();
  });

  it("auto-nominates from the expected turn for an admin", async () => {
    mocks.getSessionUser.mockResolvedValue(admin);
    mocks.getDraftState.mockResolvedValue({
      ...state,
      nominatedPlayer: null,
      minBid: 1,
      available: [{ userId: "player-top" }],
    });

    const response = await adminNominate(request("admin-nominate", turn));

    expect(response.status).toBe(200);
    expect(mocks.nominatePlayer).toHaveBeenCalledWith(
      season.id,
      admin,
      "player-top",
      1,
      expect.objectContaining({
        draftVersion: turn.draftVersion,
        nominatorTeamId: turn.nominatorTeamId,
        nominationEndsAt: turn.nominationEndsAt,
      }),
    );
  });
});
