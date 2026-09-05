import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { recoverableInhouseBotLobby } from "@/lib/dota-lobby-service";
import { POST } from "@/app/api/dota-lobby/recovery/route";
import { POST as lobbyPost } from "@/app/api/dota-lobby/route";
import { makeUser, sessionFor } from "./factories";
import { LEAGUE_CONFIG } from "@/lib/league-config";

vi.mock("@/lib/auth", () => ({ getSessionUser: vi.fn() }));
const keyPrefix = LEAGUE_CONFIG.region === "eu" ? "eu:" : "";

beforeEach(() => {
  vi.stubEnv("DOTA_LOBBY_BOT_URL", "http://127.0.0.1:8090");
  vi.stubEnv("DOTA_LOBBY_BOT_SECRET", "test-recovery-secret-".repeat(4));
  vi.stubEnv("DOTA_INHOUSE_LEAGUE_ID", "54321");
  vi.stubEnv("DOTA_SEASON_LOBBY_BOT_ENABLED", "false");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function request(body: unknown = {}, origin = "http://localhost:3000") {
  return new NextRequest("http://localhost:3000/api/dota-lobby/recovery", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify(body),
  });
}
async function admin() {
  const user = await makeUser("Admin", "ADMIN");
  vi.mocked(getSessionUser).mockResolvedValue(sessionFor(user));
  return user;
}
const botSteamId = "76561198000000000";
function health(activeKey: string | null = null, online = true) {
  return {
    online,
    steamId: botSteamId,
    activeKey,
    lobbyId: "987654321",
    gameMode: 2,
    serverRegion: 2,
    leagueId: 54321,
    password: "must-never-be-returned",
  };
}

describe("closed in-house bot recovery", () => {
  it("requires a same-origin admin session before contacting the worker", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    const user = await makeUser("Player");
    vi.mocked(getSessionUser).mockResolvedValue(sessionFor(user));
    expect((await POST(request())).status).toBe(403);
    await expect(recoverableInhouseBotLobby(sessionFor(user))).rejects.toThrow("Admins only");
    await admin();
    expect((await POST(request({}, "https://evil.example"))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stays disabled without a worker connection", async () => {
    await admin();
    vi.stubEnv("DOTA_LOBBY_BOT_URL", "");
    vi.stubEnv("DOTA_LOBBY_BOT_SECRET", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, online: false, steamId: null, id: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["READY_CHECK", "CAPTAIN_VOTE", "DRAFTING", "READY", "IN_PROGRESS", "COMPLETED", "CANCELLED"])(
    "offers recovery for %s only when the database says the room is closed",
    async (status) => {
      await admin();
      const lobby = await prisma.inhouseLobby.create({ data: { status } });
      const fetch = vi.fn().mockResolvedValue(Response.json(health(`${keyPrefix}inhouse:${lobby.id}:1`)));
      vi.stubGlobal("fetch", fetch);
      const response = await POST(request({ id: "client-cannot-select-a-room", action: "release" }));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({
        enabled: true,
        online: true,
        steamId: botSteamId,
        id: ["COMPLETED", "CANCELLED"].includes(status) ? lobby.id : null,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: "health" });
      expect(fetch.mock.calls[0][1]).toMatchObject({
        cache: "no-store",
        redirect: "error",
        headers: { Authorization: `Bearer ${process.env.DOTA_LOBBY_BOT_SECRET}` },
      });
    },
  );

  it.each([null, "season:fixture:1", "inhouse:missing:1", "inhouse:room:2", "inhouse:../private:1"])(
    "does not expose an out-of-scope worker key: %s",
    async (key) => {
      await admin();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(health(key === null ? null : `${keyPrefix}${key}`))));
      expect(await (await POST(request())).json()).toEqual({
        enabled: true, online: true, steamId: botSteamId, id: null,
      });
    },
  );

  it("never offers recovery for another region's job even when its ID exists locally", async () => {
    await admin();
    const lobby = await prisma.inhouseLobby.create({ data: { status: "CANCELLED" } });
    const otherPrefix = LEAGUE_CONFIG.region === "eu" ? "" : "eu:";
    const otherKey = `${otherPrefix}inhouse:${lobby.id}:1`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(health(otherKey))));
    expect(await (await POST(request())).json()).toEqual({
      enabled: true, online: true, steamId: botSteamId, id: null,
    });
  });

  it("reports a disconnected relay as offline and recovers on the next successful check", async () => {
    await admin();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: "OFFLINE", secret: "never-return" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json(health()));
    vi.stubGlobal("fetch", fetch);
    const offline = await POST(request());
    expect(offline.status).toBe(200);
    expect(await offline.json()).toEqual({ enabled: true, online: false, steamId: null, id: null });
    expect(await (await POST(request())).json()).toEqual({
      enabled: true, online: true, steamId: botSteamId, id: null,
    });
  });

  it("preserves scoped closed-room recovery while the worker is reconnecting to Dota", async () => {
    await admin();
    const lobby = await prisma.inhouseLobby.create({ data: { status: "CANCELLED" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(health(`${keyPrefix}inhouse:${lobby.id}:1`, false))));
    expect(await (await POST(request())).json()).toEqual({
      enabled: true, online: false, steamId: botSteamId, id: lobby.id,
    });
  });

  it("allows explicit scoped release while historical create and start remain forbidden", async () => {
    await admin();
    const lobby = await prisma.inhouseLobby.create({ data: { status: "CANCELLED" } });
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      const { action } = JSON.parse(init.body);
      return Response.json({ state: action === "release" ? "released" : "ready" });
    });
    vi.stubGlobal("fetch", fetch);
    const status = await lobbyPost(request({ kind: "inhouse", id: lobby.id, action: "status" }));
    expect(await status.json()).toMatchObject({ canControl: false, canRelease: true });
    for (const action of ["create", "start"])
      expect((await lobbyPost(request({ kind: "inhouse", id: lobby.id, action }))).status).toBe(400);
    const released = await lobbyPost(request({ kind: "inhouse", id: lobby.id, action: "release" }));
    expect(released.status).toBe(200);
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toMatchObject({
      action: "release", spec: { key: `${keyPrefix}inhouse:${lobby.id}:1` },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not disclose worker errors or accept malformed health responses", async () => {
    await admin();
    for (const response of [
      Response.json({}),
      Response.json(null),
      Response.json({ ...health(), online: "true" }),
      Response.json({ ...health(), steamId: "secret-account" }),
      Response.json({ ...health(), activeKey: 123 }),
      Response.json({ code: "secret" }, { status: 409 }),
      Response.json({ code: "OFFLINE", secret: "never-return" }, { status: 500 }),
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      const result = await POST(request());
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({
        error: "Could not check bot recovery. Confirm the bot is online, then try again.",
      });
    }
  });
});
