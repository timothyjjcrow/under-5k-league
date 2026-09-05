import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  sessionFor as asSession,
  makeCaptain,
  makeSeason,
  makeUser,
} from "./factories";
import {
  resolveDotaLobby,
  lobbyBotConnection,
  lobbyBotKindEnabled,
  callLobbyBot,
} from "@/lib/dota-lobby-service";
import { parseLobbyLeagueId } from "@/lib/dota-lobby";
import { getSessionUser } from "@/lib/auth";
import { POST } from "@/app/api/dota-lobby/route";
vi.mock("@/lib/auth", () => ({ getSessionUser: vi.fn() }));

beforeEach(() => {
  vi.stubEnv("DOTA_LOBBY_BOT_URL", "http://127.0.0.1:8090");
  vi.stubEnv("DOTA_LOBBY_BOT_SECRET", "test-lobby-secret-".repeat(4));
  vi.stubEnv("DOTA_INHOUSE_LEAGUE_ID", "54321");
  vi.stubEnv("DOTA_SEASON_LOBBY_BOT_ENABLED", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function fixture() {
  // Season support is intentionally opt-in; normal operation is in-house only.
  vi.stubEnv("DOTA_SEASON_LOBBY_BOT_ENABLED", "true");
  const season = await makeSeason({ status: "REGULAR_SEASON", teamSize: 5 });
  await prisma.season.update({
    where: { id: season.id },
    data: { dotaLeagueId: "12345" },
  });
  const home = await makeCaptain(season.id, "Home", 100, 0);
  const away = await makeCaptain(season.id, "Away", 100, 1);
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      homeTeamId: home.team.id,
      awayTeamId: away.team.id,
      week: 1,
      bestOf: 2,
    },
  });
  return { season, home, away, match };
}
function request(body: unknown, origin = "http://localhost:3000") {
  return new NextRequest("http://localhost:3000/api/dota-lobby", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

describe("Dota lobby authorization and settings", () => {
  it.each([undefined, "", "false", "TRUE", "1"])(
    "reserves the bot for in-house games when the season opt-in is %s",
    async (enabled) => {
      const { home, match } = await fixture();
      const { spec } = await resolveDotaLobby(asSession(home.user), "season", match.id);
      vi.stubEnv("DOTA_SEASON_LOBBY_BOT_ENABLED", enabled);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      vi.mocked(getSessionUser).mockResolvedValue(asSession(home.user));
      expect(lobbyBotKindEnabled("inhouse")).toBe(true);
      expect(lobbyBotKindEnabled("season")).toBe(false);
      const status = await POST(request({ kind: "season", id: match.id, action: "status" }));
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ enabled: false });
      for (const action of ["create", "start", "release"]) {
        const result = await POST(request({ kind: "season", id: match.id, action }));
        expect(result.status).toBe(403);
      }
      await expect(resolveDotaLobby(asSession(home.user), "season", match.id))
        .rejects.toThrow("in-house games only");
      await expect(callLobbyBot(spec, "create")).rejects.toThrow("in-house games only");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("uses the season ticket, Captains Mode, US East, stable credentials, and a new key for game two", async () => {
    const { home, away, match } = await fixture();
    const first = await resolveDotaLobby(
      asSession(home.user),
      "season",
      match.id,
    );
    expect(first).toMatchObject({
      playable: true,
      canControl: true,
      spec: {
        leagueId: 12345,
        gameMode: 2,
        serverRegion: 2,
        radiant: [home.user.steamId],
        dire: [away.user.steamId],
      },
    });
    const repeat = await resolveDotaLobby(
      asSession(away.user),
      "season",
      match.id,
    );
    expect(repeat.spec).toEqual(first.spec);
    await prisma.match.update({
      where: { id: match.id },
      data: { homeScore: 1 },
    });
    const second = await resolveDotaLobby(
      asSession(home.user),
      "season",
      match.id,
    );
    expect(second.spec.key).toBe(`season:${match.id}:2`);
    expect(second.spec.password).not.toBe(first.spec.password);
    expect(second.spec.leagueId).toBe(12345);
  });
  it("uses approved stand-ins and verified Dota account overrides", async () => {
    const { home, match } = await fixture();
    const standin = await makeUser("Stand-in");
    await prisma.user.update({
      where: { id: standin.id },
      data: { dotaAccountIdV2: 4000000000 },
    });
    await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: home.team.id,
        standinUserId: standin.id,
        replacingUserId: home.user.id,
      },
    });
    const result = await resolveDotaLobby(
      asSession(home.user),
      "season",
      match.id,
    );
    expect(result.spec.radiant).toEqual(["76561201960265728"]);
    expect(result.spec.radiant).not.toContain(home.user.steamId);
  });
  it("blocks archived, completed, withdrawn, and wrong-phase fixtures", async () => {
    const { home, match, season } = await fixture();
    const read = () =>
      resolveDotaLobby(asSession(home.user), "season", match.id);
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });
    expect((await read()).playable).toBe(false);
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: true, status: "PLAYOFFS" },
    });
    expect((await read()).playable).toBe(false);
    await prisma.season.update({
      where: { id: season.id },
      data: { status: "REGULAR_SEASON" },
    });
    await prisma.team.update({
      where: { id: home.team.id },
      data: { withdrawn: true },
    });
    expect((await read()).playable).toBe(false);
    await prisma.team.update({
      where: { id: home.team.id },
      data: { withdrawn: false },
    });
    await prisma.match.update({
      where: { id: match.id },
      data: { status: "COMPLETED" },
    });
    expect((await read()).playable).toBe(false);
  });
  it("keeps the in-house ticket separate and respects drafted sides", async () => {
    const captain = await makeUser("Captain");
    const player = await makeUser("Player");
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: "READY",
        radiantTeam: 2,
        players: {
          create: [
            { userId: captain.id, team: 1, isCaptain: true },
            { userId: player.id, team: 2 },
          ],
        },
      },
    });
    const result = await resolveDotaLobby(
      asSession(captain),
      "inhouse",
      lobby.id,
    );
    expect(result).toMatchObject({
      canControl: true,
      playable: true,
      spec: {
        leagueId: 54321,
        gameMode: 2,
        serverRegion: 2,
        radiant: [player.steamId],
        dire: [captain.steamId],
      },
    });
    expect(
      (await resolveDotaLobby(asSession(player), "inhouse", lobby.id))
        .canControl,
    ).toBe(false);
    vi.stubEnv("DOTA_INHOUSE_LEAGUE_ID", "Under 5K In-House League");
    await expect(
      resolveDotaLobby(asSession(captain), "inhouse", lobby.id),
    ).rejects.toThrow("numeric");
  });
  it("denies outsiders and participant mutations before contacting Steam", async () => {
    const { match, home } = await fixture();
    const outsider = await makeUser("Outsider");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.mocked(getSessionUser).mockResolvedValue(asSession(outsider));
    expect(
      (await POST(request({ kind: "season", id: match.id, action: "create" })))
        .status,
    ).toBe(400);
    await prisma.teamMember.create({
      data: {
        seasonId: match.seasonId,
        teamId: home.team.id,
        userId: outsider.id,
      },
    });
    expect(
      (await POST(request({ kind: "season", id: match.id, action: "create" })))
        .status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires authentication and same origin; ignores client-supplied settings", async () => {
    const { match, home } = await fixture();
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect(
      (await POST(request({ kind: "season", id: match.id, action: "create" })))
        .status,
    ).toBe(401);
    vi.mocked(getSessionUser).mockResolvedValue(asSession(home.user));
    expect(
      (
        await POST(
          request(
            { kind: "season", id: match.id, action: "create" },
            "https://evil.example",
          ),
        )
      ).status,
    ).toBe(403);
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ state: "creating" }));
    vi.stubGlobal("fetch", fetch);
    expect(
      (
        await POST(
          request({
            kind: "season",
            id: match.id,
            action: "create",
            leagueId: 99,
            gameMode: 1,
          }),
        )
      ).status,
    ).toBe(200);
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.spec).toMatchObject({ leagueId: 12345, gameMode: 2 });
  });
  it("rejects closed fixtures and malformed actions before calling the worker", async () => {
    const { match, home } = await fixture();
    vi.mocked(getSessionUser).mockResolvedValue(asSession(home.user));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await prisma.match.update({ where: { id: match.id }, data: { status: "COMPLETED" } });
    for (const action of ["create", "start", ["status"]]) {
      expect((await POST(request({ kind: "season", id: match.id, action }))).status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("marks only the confirmed in-house game started without extending bets", async () => {
    const user = await makeUser("Captain");
    const deadline = new Date(Date.now() + 120000);
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: "READY",
        betsCloseAt: deadline,
        players: { create: { userId: user.id, team: 1, isCaptain: true } },
      },
    });
    vi.mocked(getSessionUser).mockResolvedValue(asSession(user));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ state: "started", lobbyId: "123456789012345678" }),
        ),
    );
    await POST(request({ kind: "inhouse", id: lobby.id, action: "status" }));
    expect(
      await prisma.inhouseLobby.findUnique({ where: { id: lobby.id } }),
    ).toMatchObject({ status: "IN_PROGRESS", betsCloseAt: deadline });
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { status: "CANCELLED" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ state: "started" })),
    );
    await POST(request({ kind: "inhouse", id: lobby.id, action: "status" }));
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: lobby.id } }))
        .status,
    ).toBe("CANCELLED");
  });
  it.each(["COMPLETED", "CANCELLED"])(
    "does not resurrect a game changed to %s while the bot response is pending",
    async (status) => {
      const user = await makeUser("Captain");
      const lobby = await prisma.inhouseLobby.create({
        data: {
          status: "READY",
          players: { create: { userId: user.id, team: 1, isCaptain: true } },
        },
      });
      vi.mocked(getSessionUser).mockResolvedValue(asSession(user));
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
        // The route has read READY, but the game ends before Steam replies.
        await prisma.inhouseLobby.update({ where: { id: lobby.id }, data: { status } });
        return Response.json({ state: "started" });
      }));
      const response = await POST(request({ kind: "inhouse", id: lobby.id, action: "status" }));
      expect(response.status).toBe(200);
      expect(await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: lobby.id } }))
        .toMatchObject({ status, startedAt: null });
    },
  );
  it.each(["READY_CHECK", "CAPTAIN_VOTE", "DRAFTING", "COMPLETED", "CANCELLED"])(
    "prevents in-house create and start while the game is %s",
    async (status) => {
      const user = await makeUser("Captain");
      const lobby = await prisma.inhouseLobby.create({
        data: {
          status,
          players: { create: { userId: user.id, team: 1, isCaptain: true } },
        },
      });
      vi.mocked(getSessionUser).mockResolvedValue(asSession(user));
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      for (const action of ["create", "start"]) {
        const result = await POST(request({ kind: "inhouse", id: lobby.id, action }));
        expect(result.status).toBe(400);
        expect(await result.json()).toMatchObject({ error: expect.stringContaining("current active") });
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("allows the current in-house game and retains scoped release for its cancelled predecessor", async () => {
    const user = await makeUser("Captain");
    const old = await prisma.inhouseLobby.create({
      data: {
        status: "CANCELLED",
        players: { create: { userId: user.id, team: 1, isCaptain: true } },
      },
    });
    const current = await prisma.inhouseLobby.create({
      data: {
        status: "READY",
        players: { create: { userId: user.id, team: 1, isCaptain: true } },
      },
    });
    vi.mocked(getSessionUser).mockResolvedValue(asSession(user));
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      const { action } = JSON.parse(init.body);
      return Response.json({ state: action === "release" ? "released" : "ready" });
    });
    vi.stubGlobal("fetch", fetch);
    for (const action of ["create", "start"]) {
      expect((await POST(request({ kind: "inhouse", id: current.id, action }))).status).toBe(200);
      expect((await POST(request({ kind: "inhouse", id: old.id, action }))).status).toBe(400);
    }
    expect((await POST(request({ kind: "inhouse", id: old.id, action: "release" }))).status).toBe(200);
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toMatchObject({
      action: "release",
      spec: { key: `inhouse:${old.id}:1` },
    });
    const outsider = await makeUser("Outsider");
    vi.mocked(getSessionUser).mockResolvedValue(asSession(outsider));
    expect((await POST(request({ kind: "inhouse", id: old.id, action: "release" }))).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("rejects duplicate active in-house games in PostgreSQL or legacy data", async () => {
    const user = await makeUser("Captain");
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: "READY",
        players: { create: { userId: user.id, team: 1, isCaptain: true } },
      },
    });
    if (process.env.PG_TEST_URL) {
      // PostgreSQL's partial unique index prevents the legacy state itself.
      await expect(prisma.inhouseLobby.create({ data: { status: "READY_CHECK" } }))
        .rejects.toMatchObject({ code: "P2002" });
      return;
    }
    await prisma.inhouseLobby.create({ data: { status: "READY_CHECK" } });
    vi.mocked(getSessionUser).mockResolvedValue(asSession(user));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const action of ["create", "start"]) {
      expect((await POST(request({ kind: "inhouse", id: lobby.id, action }))).status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("handles unreachable workers without disclosing service credentials", async () => {
    const { match, home } = await fixture();
    const { spec } = await resolveDotaLobby(
      asSession(home.user),
      "season",
      match.id,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("private-token-in-driver-error")),
    );
    await expect(callLobbyBot(spec, "create")).rejects.toThrow(
      "could not be reached",
    );
  });
  it("validates numeric tickets and fails closed on invalid bot configuration", () => {
    for (const value of ["0", "-1", "1.5", "123x", "4294967296", ""])
      expect(parseLobbyLeagueId(value)).toBeNull();
    expect(parseLobbyLeagueId("4294967295")).toBe(4294967295);
    vi.stubEnv("DOTA_LOBBY_BOT_URL", "https://example.com/?token=secret");
    expect(() => lobbyBotConnection()).toThrow("configuration");
  });
});
