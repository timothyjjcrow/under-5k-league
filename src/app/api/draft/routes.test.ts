import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  getSessionUser: vi.fn(),
  getActiveSeason: vi.fn(),
  getDraftState: vi.fn(),
  placeBid: vi.fn(),
  nominatePlayer: vi.fn(),
  rateLimit: vi.fn(),
  clientIp: vi.fn(),
  claimThrottle: vi.fn(),
  pollDraftRoomState: vi.fn(),
  holdDraftRoomPoll: vi.fn(),
  readDraftRoomVersion: vi.fn(),
  draftRoomHoldMark: vi.fn(),
  draftRoomShuttingDown: vi.fn(() => false),
}));

vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidateTag }));
vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/season", () => ({ getActiveSeason: mocks.getActiveSeason }));
vi.mock("@/lib/draft-service", () => ({
  getDraftState: mocks.getDraftState,
  placeBid: mocks.placeBid,
  nominatePlayer: mocks.nominatePlayer,
}));
vi.mock("@/lib/draft-room-state", () => ({
  pollDraftRoomState: mocks.pollDraftRoomState,
  holdDraftRoomPoll: mocks.holdDraftRoomPoll,
}));
vi.mock("@/lib/draft-room-wait", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/draft-room-wait")>()),
  draftRoomShuttingDown: mocks.draftRoomShuttingDown,
}));
vi.mock("@/lib/draft-room-version", () => ({
  readDraftRoomVersion: mocks.readDraftRoomVersion,
  draftRoomHoldMark: mocks.draftRoomHoldMark,
  // The real token rule: a missing row is "none".
  draftRoomVersionToken: (version: string | null) => version ?? "none",
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  clientIp: mocks.clientIp,
  retryAfterSeconds: (result: { retryAfterMs?: number }) =>
    String(Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 1000))),
}));
vi.mock("@/lib/settings", () => ({
  claimThrottle: mocks.claimThrottle,
  SETTING_KEYS: {
    DRAFT_ROOM_MAINTENANCE_AT: "draftRoomMaintenanceAt",
  },
}));

import { POST as tick } from "./tick/route";
import { POST as bid } from "./bid/route";
import { POST as nominate } from "./nominate/route";
import { POST as adminNominate } from "./admin-nominate/route";

const user = { id: "captain-1", name: "Captain", role: "USER" };
const VERSION = "draft-room-version-1";
const admin = { id: "admin-1", name: "Admin", role: "ADMIN" };
const season = { id: "season-1", name: "Season One" };
const state = {
  seasonId: season.id,
  seasonStatus: "DRAFT",
  status: "IN_PROGRESS",
  me: { myTeamId: null as string | null },
};
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
  mocks.claimThrottle.mockResolvedValue(true);
  // The tick labels its reply with the version it read its rows under.
  mocks.pollDraftRoomState.mockImplementation(
    async (_viewer: unknown, _seasonId: string, version: string | null) => ({
      state,
      version,
      invalidateGate: false,
    }),
  );
  mocks.holdDraftRoomPoll.mockResolvedValue("changed");
  mocks.readDraftRoomVersion.mockResolvedValue(VERSION);
  mocks.draftRoomHoldMark.mockReturnValue(0);
  mocks.draftRoomShuttingDown.mockReturnValue(false);
  mocks.clientIp.mockReturnValue("203.0.113.10");
});

describe("POST /api/draft/tick", () => {
  it("returns a no-store reply for the room's expected season, naming its version", async () => {
    mocks.pollDraftRoomState.mockResolvedValue({ state, version: VERSION, invalidateGate: true });

    const response = await tick(request("tick", { seasonId: season.id }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      ...state,
      roomVersion: VERSION,
      held: false,
    });
    // Settling a clock is the tick's call (draft-room-state.ts), never the
    // route's own.
    expect(mocks.pollDraftRoomState).toHaveBeenCalledWith(user, season.id, VERSION);
    expect(mocks.getDraftState).not.toHaveBeenCalled();
    expect(mocks.claimThrottle).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      `draft:user:${user.id}`,
      expect.objectContaining({ limit: 300 }),
      expect.any(Number),
    );
    // The tick won the claim and settled a clock: the gate is expired.
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v13", {
      expire: 0,
    });
  });

  it("leaves the gate alone when the tick settled nothing", async () => {
    const response = await tick(request("tick", { seasonId: season.id }));

    expect(response.status).toBe(200);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("rejects a parked tab after the active season changes", async () => {
    const response = await tick(request("tick", { seasonId: "old-season" }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/active season changed/i);
    expect(mocks.pollDraftRoomState).not.toHaveBeenCalled();
    expect(mocks.holdDraftRoomPoll).not.toHaveBeenCalled();
  });

  it("rejects a missing season claim instead of attaching an old tab implicitly", async () => {
    const response = await tick(request("tick", { since: VERSION }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(
      /active season changed|out of date/i,
    );
    expect(mocks.pollDraftRoomState).not.toHaveBeenCalled();
    expect(mocks.holdDraftRoomPoll).not.toHaveBeenCalled();
  });

  it("answers 404 with no active season, and when the season's row went away", async () => {
    mocks.getActiveSeason.mockResolvedValueOnce(null);
    const none = await tick(request("tick", { seasonId: season.id }));
    expect(none.status).toBe(404);
    expect(mocks.pollDraftRoomState).not.toHaveBeenCalled();

    mocks.pollDraftRoomState.mockResolvedValueOnce({
      state: null,
      version: VERSION,
      invalidateGate: false,
    });
    const gone = await tick(request("tick", { seasonId: season.id }));
    expect(gone.status).toBe(404);
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
    expect(mocks.pollDraftRoomState).toHaveBeenCalledWith(null, season.id, VERSION);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("answers a tick without `since` at once, as every tick was before", async () => {
    for (const extra of [
      {},
      { since: 7 },
      { since: "" },
      { since: "x".repeat(65) },
    ]) {
      vi.clearAllMocks();
      mocks.pollDraftRoomState.mockResolvedValue({ state, version: VERSION, invalidateGate: false });
      mocks.readDraftRoomVersion.mockResolvedValue(VERSION);
      mocks.rateLimit.mockReturnValue({ allowed: true });
      const response = await tick(
        request("tick", { seasonId: season.id, ...extra }),
      );
      expect(response.status).toBe(200);
      expect(mocks.holdDraftRoomPoll).not.toHaveBeenCalled();
      expect(mocks.getSessionUser).toHaveBeenCalledOnce();
      expect(mocks.pollDraftRoomState).toHaveBeenCalledOnce();
    }
  });

  it("answers at once when the client is behind the room, and says it was not held", async () => {
    const response = await tick(
      request("tick", {
        seasonId: season.id,
        since: "an-older-version",
        holdMs: 25_000,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.holdDraftRoomPoll).not.toHaveBeenCalled();
    const json = await response.json();
    expect(json.roomVersion).toBe(VERSION);
    // The client counts these to back off from a version that keeps moving
    // (roomUnheldStreak, draftLongPollGapMs).
    expect(json.held).toBe(false);
  });

  it("holds a tick whose client shows the version, then authorizes and reads again", async () => {
    const order: string[] = [];
    mocks.draftRoomHoldMark.mockImplementation(() => {
      order.push("mark");
      return 7;
    });
    mocks.readDraftRoomVersion
      .mockImplementationOnce(async () => {
        order.push("version");
        return VERSION;
      })
      .mockImplementationOnce(async () => {
        order.push("version again");
        return "draft-room-version-2";
      });
    const later = { ...user, role: "ADMIN" };
    mocks.getSessionUser
      .mockImplementationOnce(async () => user)
      .mockImplementationOnce(async () => later);
    mocks.holdDraftRoomPoll.mockImplementation(async () => {
      order.push("hold");
      return "changed";
    });
    mocks.pollDraftRoomState.mockImplementation(async () => {
      order.push("poll");
      return { state, version: "draft-room-version-2", invalidateGate: false };
    });

    const shownAt = Date.now() - 4_000;
    const req = request("tick", {
      seasonId: season.id,
      since: VERSION,
      sinceNow: shownAt,
      holdMs: 10_000,
    });
    const response = await tick(req);

    expect(response.status).toBe(200);
    expect(order).toEqual(["mark", "version", "hold", "version again", "poll"]);
    expect(mocks.getActiveSeason).toHaveBeenCalledTimes(2);
    expect(mocks.holdDraftRoomPoll).toHaveBeenCalledWith({
      viewer: user,
      seasonId: season.id,
      version: VERSION,
      // The shown reply's clock goes to the hold, which answers at once for a
      // lot whose clock ran out since (draftRoomWakeAt's fromMs).
      hold: { since: VERSION, holdMs: 10_000, sinceNowMs: shownAt },
      mark: 7,
      signal: req.signal,
    });
    // The tick runs as the session and on the version read AFTER the hold,
    // and the reply names that version, and that it was held.
    expect(mocks.getSessionUser).toHaveBeenCalledTimes(2);
    expect(mocks.pollDraftRoomState).toHaveBeenCalledWith(
      later,
      season.id,
      "draft-room-version-2",
    );
    expect(await response.json()).toEqual({
      ...state,
      roomVersion: "draft-room-version-2",
      held: true,
    });
  });

  it("answers 409 when another season became active during the hold, and 404 when none is", async () => {
    mocks.getActiveSeason
      .mockResolvedValueOnce(season)
      .mockResolvedValueOnce({ id: "season-2", name: "Season Two" });
    const moved = await tick(request("tick", { seasonId: season.id, since: VERSION }));
    expect(moved.status).toBe(409);
    expect(mocks.pollDraftRoomState).not.toHaveBeenCalled();

    mocks.getActiveSeason.mockResolvedValueOnce(season).mockResolvedValueOnce(null);
    const gone = await tick(request("tick", { seasonId: season.id, since: VERSION }));
    expect(gone.status).toBe(404);
    expect(mocks.pollDraftRoomState).not.toHaveBeenCalled();
  });

  it("names the version its tick read the rows under, after the tick's own publish", async () => {
    // A captain's return or a settled clock publishes: the reply carries the
    // copy's newer version, so the client's next tick holds.
    mocks.pollDraftRoomState.mockResolvedValue({ state, version: "after-publish", invalidateGate: true });
    const response = await tick(request("tick", { seasonId: season.id }));
    expect((await response.json()).roomVersion).toBe("after-publish");
  });

  it("holds a signed-out spectator too, for at most the longest hold", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await tick(
      request("tick", { seasonId: season.id, since: VERSION, holdMs: 600_000 }),
    );

    expect(response.status).toBe(200);
    expect(mocks.holdDraftRoomPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: null,
        hold: { since: VERSION, holdMs: 25_000, sinceNowMs: expect.any(Number) },
      }),
    );
    expect(mocks.pollDraftRoomState).toHaveBeenCalledWith(null, season.id, VERSION);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("holds on a database with no version yet, under its token", async () => {
    mocks.readDraftRoomVersion.mockResolvedValue(null);

    const response = await tick(
      request("tick", { seasonId: season.id, since: "none" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.holdDraftRoomPoll).toHaveBeenCalledOnce();
    expect((await response.json()).roomVersion).toBe("none");
  });

  it("does no tick for a client that went away during the hold", async () => {
    mocks.holdDraftRoomPoll.mockResolvedValue("aborted");

    const response = await tick(
      request("tick", { seasonId: season.id, since: VERSION }),
    );

    expect(response.status).toBe(204);
    expect(mocks.pollDraftRoomState).not.toHaveBeenCalled();
    expect(mocks.readDraftRoomVersion).toHaveBeenCalledOnce();
  });

  it("answers a current `since` at once while the process stops, and says it was not held", async () => {
    // SIGTERM answers every hold at once, but Caddy keeps sending a slot it
    // still routes to new requests on open connections: those must read as
    // unheld, or every tab re-polls once a second until the slot exits.
    mocks.draftRoomShuttingDown.mockReturnValue(true);

    const response = await tick(
      request("tick", { seasonId: season.id, since: VERSION, holdMs: 25_000 }),
    );

    expect(response.status).toBe(200);
    expect(mocks.holdDraftRoomPoll).not.toHaveBeenCalled();
    expect((await response.json()).held).toBe(false);
  });

  it("rejects an oversized body after the IP preflight but before auth or database work", async () => {
    const response = await tick(
      request("tick", {
        seasonId: season.id,
        padding: "x".repeat(9_000),
      }),
    );

    expect(response.status).toBe(413);
    expect(mocks.rateLimit).toHaveBeenCalledOnce();
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.getActiveSeason).not.toHaveBeenCalled();
    expect(mocks.readDraftRoomVersion).not.toHaveBeenCalled();
    expect(mocks.pollDraftRoomState).not.toHaveBeenCalled();
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
    expect(mocks.revalidateTag).toHaveBeenCalledOnce();
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v13", {
      expire: 0,
    });
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
    // placeBid can first resolve an expired lot before discovering that this
    // request lost the race, so a dispatched attempt always expires the gate.
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v13", {
      expire: 0,
    });
  });

  it("fails closed on malformed JSON", async () => {
    const response = await bid(rawRequest("bid", "{not-json"));

    expect(response.status).toBe(400);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.placeBid).not.toHaveBeenCalled();
  });

  it("rejects an oversized mutation body before auth or database work", async () => {
    const response = await bid(
      request("bid", { ...lot, amount: 8, padding: "x".repeat(9_000) }),
    );

    expect(response.status).toBe(413);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.getActiveSeason).not.toHaveBeenCalled();
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
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v13", {
      expire: 0,
    });
  });

  it("keeps the admin fallback role-restricted", async () => {
    const response = await adminNominate(request("admin-nominate", turn));
    expect(response.status).toBe(403);
    expect(mocks.nominatePlayer).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
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

  it("expires the gate when the admin state read resolves a clock then returns early", async () => {
    mocks.getSessionUser.mockResolvedValue(admin);
    mocks.getDraftState.mockResolvedValue(null);

    const response = await adminNominate(request("admin-nominate", turn));

    expect(response.status).toBe(404);
    expect(mocks.nominatePlayer).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).toHaveBeenCalledWith("automation-gate:v13", {
      expire: 0,
    });
  });
});
