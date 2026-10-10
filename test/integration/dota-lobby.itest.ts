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
  inhouseBotGameStatus,
} from "@/lib/dota-lobby-service";
import { parseLobbyLeagueId } from "@/lib/dota-lobby";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { getSessionUser } from "@/lib/auth";
import { POST } from "@/app/api/dota-lobby/route";
vi.mock("@/lib/auth", () => ({ getSessionUser: vi.fn() }));
const keyPrefix = LEAGUE_CONFIG.region === "eu" ? "eu:" : "";

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
  it("uses the season ticket, Captains Mode, configured region, stable credentials, and a new key for game two", async () => {
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
        key: `${keyPrefix}season:${match.id}:1`,
        leagueId: 12345,
        gameMode: 2,
        serverRegion: LEAGUE_CONFIG.gameServerRegionId,
        radiant: [home.user.steamId],
        dire: [away.user.steamId],
      },
    });
    // Players type the name into Dota's lobby browser, so it names the league
    // the way the site and Discord do, never the old "LD2L".
    expect(first.spec.name).toBe(
      `${LEAGUE_CONFIG.name} ${home.team.name} vs ${away.team.name} G1 ${match.id.slice(-8)}`,
    );
    expect(first.spec.name).not.toContain("LD2L");
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
    expect(second.spec.key).toBe(`${keyPrefix}season:${match.id}:2`);
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
        key: `${keyPrefix}inhouse:${lobby.id}:1`,
        leagueId: 54321,
        gameMode: 2,
        serverRegion: LEAGUE_CONFIG.gameServerRegionId,
        radiant: [player.steamId],
        dire: [captain.steamId],
        // Sides read as the captain's team; a side with no captain on the
        // roster falls back to its number.
        radiantName: "Team 2",
        direName: "Captain's team",
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
            key: "other-region-cannot-be-selected-by-the-client",
            leagueId: 99,
            gameMode: 1,
          }),
        )
      ).status,
    ).toBe(200);
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.spec).toMatchObject({ key: `${keyPrefix}season:${match.id}:1`, leagueId: 12345, gameMode: 2 });
  });
  it("rejects another region's job key before sending any worker action", async () => {
    const { match, home } = await fixture();
    const { spec } = await resolveDotaLobby(asSession(home.user), "season", match.id);
    const otherPrefix = LEAGUE_CONFIG.region === "eu" ? "" : "eu:";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const action of [undefined, "create", "start", "release"] as const) {
      await expect(callLobbyBot({ ...spec, key: `${otherPrefix}season:${match.id}:1` }, action))
        .rejects.toThrow("does not belong to this league");
    }
    expect(fetch).not.toHaveBeenCalled();
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
  it("marks only the confirmed in-house game started", async () => {
    const user = await makeUser("Captain");
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: "READY",
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
    ).toMatchObject({ status: "IN_PROGRESS", startedAt: expect.any(Date) });
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
        expect(await result.json()).toMatchObject({ error: expect.stringContaining("once its teams are locked") });
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
      spec: { key: `${keyPrefix}inhouse:${old.id}:1` },
    });
    const outsider = await makeUser("Outsider");
    vi.mocked(getSessionUser).mockResolvedValue(asSession(outsider));
    expect((await POST(request({ kind: "inhouse", id: old.id, action: "release" }))).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("lets each of two live games use the bot under its own job", async () => {
    const one = await makeUser("Game One Captain");
    const two = await makeUser("Game Two Captain");
    const games = [];
    for (const [slot, user] of [
      [1, one],
      [2, two],
    ] as const) {
      games.push(
        await prisma.inhouseLobby.create({
          data: {
            status: "READY",
            slot,
            players: { create: { userId: user.id, team: 1, isCaptain: true } },
          },
        }),
      );
    }
    // The slot index holds one live lobby per slot, on both providers.
    await expect(
      prisma.inhouseLobby.create({ data: { status: "READY_CHECK", slot: 2 } }),
    ).rejects.toMatchObject({ code: "P2002" });
    const fetch = vi
      .fn()
      .mockImplementation(async () => Response.json({ state: "ready" }));
    vi.stubGlobal("fetch", fetch);
    for (const [game, captain] of [
      [games[0], one],
      [games[1], two],
    ] as const) {
      vi.mocked(getSessionUser).mockResolvedValue(asSession(captain));
      expect(
        (await POST(request({ kind: "inhouse", id: game.id, action: "create" })))
          .status,
      ).toBe(200);
      expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toMatchObject({
        action: "create",
        spec: { key: `${keyPrefix}inhouse:${game.id}:1` },
      });
    }
    // A captain controls only their own game's bot.
    vi.mocked(getSessionUser).mockResolvedValue(asSession(one));
    expect(
      (await POST(request({ kind: "inhouse", id: games[1].id, action: "create" })))
        .status,
    ).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("words the bot's roster refusal for the kind of game", async () => {
    const { match, home } = await fixture();
    const season = await resolveDotaLobby(
      asSession(home.user),
      "season",
      match.id,
    );
    const captain = await makeUser("Roster Captain");
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: "READY",
        players: {
          create: [{ userId: captain.id, team: 1, isCaptain: true }],
        },
      },
    });
    const inhouse = await resolveDotaLobby(
      asSession(captain),
      "inhouse",
      lobby.id,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "ROSTER" }), { status: 409 }),
      ),
    );
    // Inhouses have no match page or stand-ins to point at.
    const inhouseError = await callLobbyBot(inhouse.spec, "start").catch(
      (e: Error) => e.message,
    );
    expect(inhouseError).toBe(
      "All ten players must sit on their assigned side (Radiant or Dire) before the bot can start.",
    );
    await expect(callLobbyBot(season.spec, "start")).rejects.toThrow(
      "Check stand-ins on the match page.",
    );
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

// The bot invites the roster into its lobby and reports who is where
// (ops/dota-lobby-bot, commit 8543702). Live test 2026-10-10: the invite pops
// up within seconds and joins without the password, the player lands on no
// side, and a player whose Dota blocks non-friend invites sees nothing while
// the GC still answers "invite created". The site asks for that seat report
// on its own reads, never on the worker's, and never sends a Steam id on.
describe("lobby invites and the seat report", () => {
  /** A Dota account override's playing Steam id (account 4000000000). */
  const OVERRIDE_STEAM_ID = "76561201960265728";

  type BotRequest = {
    action: string;
    spec: Record<string, unknown> & { key: string; radiant: string[]; dire: string[] };
  };

  /**
   * A bot that invites: "ready", a seat report when asked (everyone absent,
   * not invited yet) or `players` on every reply when given, and an invite's
   * count.
   */
  function inviteBot(
    options: { state?: string; players?: unknown; invited?: unknown } = {},
  ) {
    const calls: BotRequest[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as BotRequest;
      calls.push(body);
      const ids = [...new Set([...body.spec.radiant, ...body.spec.dire])];
      const reply: Record<string, unknown> = {
        state: options.state ?? "ready",
        lobbyId: "30007027938516500",
      };
      if ("players" in options) reply.players = options.players;
      else if (body.spec.withPlayers === true)
        reply.players = ids.map((id) => ({ id, seat: "absent", invite: "none" }));
      if (body.action === "invite")
        reply.invited =
          "invited" in options
            ? options.invited
            : ((body.spec.invite as string[] | undefined) ?? ids).length;
      return Response.json(reply);
    });
    vi.stubGlobal("fetch", fetch);
    return { fetch, calls };
  }

  /** A READY in-house game, two a side; `override` plays on account 4000000000. */
  async function inhouseGame(status = "READY") {
    const radiantCaptain = await makeUser("Radiant Captain");
    const radiantPlayer = await makeUser("Radiant Player");
    const direCaptain = await makeUser("Dire Captain");
    const override = await makeUser("Override Player");
    await prisma.user.update({
      where: { id: override.id },
      data: { dotaAccountIdV2: 4000000000 },
    });
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status,
        radiantTeam: 1,
        players: {
          create: [
            { userId: radiantCaptain.id, team: 1, isCaptain: true },
            { userId: radiantPlayer.id, team: 1 },
            { userId: direCaptain.id, team: 2, isCaptain: true },
            { userId: override.id, team: 2 },
          ],
        },
      },
    });
    const steamIds = [
      radiantCaptain.steamId,
      radiantPlayer.steamId,
      direCaptain.steamId,
      override.steamId,
      OVERRIDE_STEAM_ID,
    ];
    return { lobby, radiantCaptain, radiantPlayer, direCaptain, override, steamIds };
  }

  const as = (user: Parameters<typeof asSession>[0]) =>
    vi.mocked(getSessionUser).mockResolvedValue(asSession(user));
  const inhouse = (id: string, action: string) =>
    POST(request({ kind: "inhouse", id, action }));

  /** No Steam id of the game's, nor any SteamID64 at all, in the browser's JSON. */
  function expectNoSteamIds(json: unknown, steamIds: string[]) {
    const text = JSON.stringify(json);
    for (const steamId of steamIds) expect(text).not.toContain(steamId);
    expect(text).not.toMatch(/7656\d{13}/);
  }

  it("asks for the seat report on every browser read and action, and sends invites only on an invite", async () => {
    const { lobby, radiantCaptain } = await inhouseGame();
    as(radiantCaptain);
    const bot = inviteBot();
    for (const action of ["status", "create", "start", "release", "invite"]) {
      expect((await inhouse(lobby.id, action)).status).toBe(200);
      const sent = bot.calls.at(-1)!;
      expect(sent.action).toBe(action);
      expect(sent.spec.key).toBe(`${keyPrefix}inhouse:${lobby.id}:1`);
      expect(sent.spec.withPlayers).toBe(true);
    }
    expect(bot.calls.filter((c) => "invite" in c.spec)).toEqual([]);
  });

  it("never asks the worker's status read for seats or invites", async () => {
    const { lobby, radiantCaptain, radiantPlayer, direCaptain } =
      await inhouseGame();
    const bot = inviteBot({
      players: [{ id: radiantCaptain.steamId, seat: "radiant", invite: "sent" }],
    });
    const players = await prisma.inhouseLobbyPlayer.findMany({
      where: { lobbyId: lobby.id },
      include: { user: true },
    });
    const status = await inhouseBotGameStatus({
      id: lobby.id,
      radiantTeam: lobby.radiantTeam,
      players,
    });
    expect(bot.calls).toHaveLength(1);
    expect(bot.calls[0].action).toBe("status");
    expect(bot.calls[0].spec).not.toHaveProperty("withPlayers");
    expect(bot.calls[0].spec).not.toHaveProperty("invite");
    // The request is exactly the spec an older bot reads.
    expect(Object.keys(bot.calls[0].spec).sort()).toEqual(
      [
        "key",
        "name",
        "password",
        "leagueId",
        "gameMode",
        "serverRegion",
        "radiant",
        "dire",
        "radiantName",
        "direName",
      ].sort(),
    );
    expect(bot.calls[0].spec.radiant).toEqual([
      radiantCaptain.steamId,
      radiantPlayer.steamId,
    ]);
    expect(bot.calls[0].spec.dire).toEqual([direCaptain.steamId, OVERRIDE_STEAM_ID]);
    // A list it never asked for is ignored.
    expect(status).toEqual({
      state: "ready",
      lobbyId: "30007027938516500",
      matchId: undefined,
    });
  });

  it("sends a captain's invite with no targets: the bot invites everyone missing", async () => {
    const { lobby, direCaptain, steamIds } = await inhouseGame();
    as(direCaptain);
    const bot = inviteBot();
    const response = await inhouse(lobby.id, "invite");
    expect(response.status).toBe(200);
    expect(bot.calls).toHaveLength(1);
    expect(bot.calls[0]).toMatchObject({
      action: "invite",
      spec: { key: `${keyPrefix}inhouse:${lobby.id}:1`, withPlayers: true },
    });
    expect(bot.calls[0].spec).not.toHaveProperty("invite");
    const body = await response.json();
    expect(body).toMatchObject({ inviteScope: "missing", invited: 4 });
    expectNoSteamIds(body, steamIds);
  });

  it("lets an admin off the roster invite everyone missing", async () => {
    const { lobby } = await inhouseGame();
    const admin = await makeUser("Admin", "ADMIN");
    as(admin);
    const bot = inviteBot();
    const response = await inhouse(lobby.id, "invite");
    expect(response.status).toBe(200);
    expect(bot.calls[0].spec).not.toHaveProperty("invite");
    const body = await response.json();
    expect(body.inviteScope).toBe("missing");
    expect(body.players.some((p: { self: boolean }) => p.self)).toBe(false);
  });

  it("sends a rostered player's invite to their own playing Steam id only", async () => {
    const { lobby, radiantPlayer, override, steamIds } = await inhouseGame();
    const bot = inviteBot();
    as(radiantPlayer);
    const own = await inhouse(lobby.id, "invite");
    expect(own.status).toBe(200);
    expect(bot.calls.at(-1)!.spec.invite).toEqual([radiantPlayer.steamId]);
    const ownBody = await own.json();
    expect(ownBody).toMatchObject({ inviteScope: "self", invited: 1 });
    expectNoSteamIds(ownBody, steamIds);
    // A Dota account override: the account they play on, never their login.
    as(override);
    expect((await inhouse(lobby.id, "invite")).status).toBe(200);
    expect(bot.calls.at(-1)!.spec.invite).toEqual([OVERRIDE_STEAM_ID]);
    expect(bot.calls.at(-1)!.spec.invite).not.toContain(override.steamId);
    // The client can't widen it: extra fields are ignored.
    await POST(
      request({
        kind: "inhouse",
        id: lobby.id,
        action: "invite",
        invite: [radiantPlayer.steamId],
        spec: { invite: [radiantPlayer.steamId] },
      }),
    );
    expect(bot.calls.at(-1)!.spec.invite).toEqual([OVERRIDE_STEAM_ID]);
  });

  it("refuses an invite from a viewer off the roster before contacting the bot", async () => {
    const { lobby } = await inhouseGame();
    const bot = inviteBot();
    as(await makeUser("Outsider"));
    expect((await inhouse(lobby.id, "invite")).status).toBe(400);
    // Benched in the room (no side): viewing is fine, inviting is not.
    const benched = await makeUser("Benched");
    await prisma.inhouseLobbyPlayer.create({
      data: { lobbyId: lobby.id, userId: benched.id, team: null },
    });
    as(benched);
    const refused = await inhouse(lobby.id, "invite");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Only the captains and admins can control this lobby.",
    });
    const status = await inhouse(lobby.id, "status");
    expect((await status.json()).inviteScope).toBeNull();
    expect(bot.calls.map((c) => c.action)).toEqual(["status"]);
  });

  it.each([
    "READY_CHECK",
    "CAPTAIN_VOTE",
    "DRAFTING",
    "AWAITING_RESULT",
    "COMPLETED",
    "CANCELLED",
  ])("refuses every invite while the game is %s", async (status) => {
    const { lobby, radiantCaptain, radiantPlayer } = await inhouseGame(status);
    const bot = inviteBot();
    const admin = await makeUser("Admin", "ADMIN");
    for (const user of [radiantCaptain, radiantPlayer, admin]) {
      as(user);
      const result = await inhouse(lobby.id, "invite");
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({
        error:
          "Only a live in-house game's bot can invite players, once its teams are locked.",
      });
    }
    expect(bot.fetch).not.toHaveBeenCalled();
    // Its status read says nobody may invite, so no button shows.
    as(radiantCaptain);
    expect((await (await inhouse(lobby.id, "status")).json()).inviteScope).toBeNull();
  });

  it("gives the browser names, sides and seats, never a Steam id", async () => {
    const { lobby, radiantCaptain, radiantPlayer, direCaptain, steamIds } =
      await inhouseGame();
    inviteBot({
      players: [
        { id: radiantCaptain.steamId, seat: "radiant", invite: "sent" },
        { id: radiantPlayer.steamId, seat: "unassigned", invite: "sent" },
        { id: direCaptain.steamId, seat: "absent", invite: "offline" },
        { id: OVERRIDE_STEAM_ID, seat: "absent", invite: "failed" },
      ],
    });
    as(radiantPlayer);
    const body = await (await inhouse(lobby.id, "status")).json();
    expect(body.players).toEqual([
      { name: "Radiant Captain", side: "radiant", seat: "radiant", invite: "sent", self: false },
      { name: "Radiant Player", side: "radiant", seat: "unassigned", invite: "sent", self: true },
      { name: "Dire Captain", side: "dire", seat: "absent", invite: "offline", self: false },
      { name: "Override Player", side: "dire", seat: "absent", invite: "failed", self: false },
    ]);
    // The status is the status alone.
    expect(body.status).toEqual({ state: "ready", lobbyId: "30007027938516500" });
    expect(body).not.toHaveProperty("invited");
    expectNoSteamIds(body, steamIds);
  });

  it.each<[string, unknown]>([
    ["missing (an older bot)", undefined],
    ["not a list", { [OVERRIDE_STEAM_ID]: "absent" }],
    ["an unknown seat", "unknown-seat"],
    ["an extra key", "extra-key"],
    ["short of the roster", "short"],
    ["a stranger on it", "stranger"],
    ["the right length with one id swapped", "swapped"],
  ])("shows no list when the bot's seat report is %s", async (_, kind) => {
    const { lobby, radiantCaptain, steamIds } = await inhouseGame();
    const roster = (await resolveDotaLobby(asSession(radiantCaptain), "inhouse", lobby.id))
      .roster;
    const ids = roster.map((p) => p.steamId);
    const entry = (id: string) => ({ id, seat: "absent", invite: "none" });
    const players =
      kind === "unknown-seat"
        ? ids.map((id, i) => (i ? entry(id) : { ...entry(id), seat: "spectating" }))
        : kind === "extra-key"
          ? ids.map((id) => ({ ...entry(id), name: "x" }))
          : kind === "short"
            ? ids.slice(1).map(entry)
            : kind === "stranger"
              ? [...ids.map(entry), entry("76561198999999999")]
              : kind === "swapped"
                ? ids.map((id, i) => entry(i ? id : "76561198999999999"))
                : kind;
    inviteBot({ players });
    as(radiantCaptain);
    const response = await inhouse(lobby.id, "status");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("players");
    expect(body.status).toEqual({ state: "ready", lobbyId: "30007027938516500" });
    expectNoSteamIds(body, steamIds);
  });

  it("leaves out an invite count that didn't parse: the outcome is unknown", async () => {
    const { lobby, radiantCaptain } = await inhouseGame();
    as(radiantCaptain);
    for (const invited of [undefined, -1, 21, 2.5, "3", null]) {
      inviteBot({ invited });
      const body = await (await inhouse(lobby.id, "invite")).json();
      expect(body).not.toHaveProperty("invited");
    }
  });

  it("maps the bot's invite refusals to fixed messages", async () => {
    const { lobby, radiantCaptain } = await inhouseGame();
    as(radiantCaptain);
    const refuse = (body: unknown, status = 409) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(body), { status })),
      );
    const error = async (action = "invite") =>
      (await (await inhouse(lobby.id, action)).json()).error;
    refuse({ code: "STATE" });
    expect(await error()).toBe(
      "The bot invites players only while its lobby is ready and waiting for them. Refresh its status first.",
    );
    refuse({ code: "INVALID" }, 400);
    expect(await error()).toBe(
      "The bot couldn't match those invites to this game's roster. Refresh its status, then try again.",
    );
    refuse({ code: "toString" });
    expect(await error()).toBe(
      "The bot could not complete that request. Refresh its status before retrying.",
    );
    // The invite-only wording never reaches the other actions.
    refuse({ code: "STATE" });
    expect(await error("start")).toBe(
      "This lobby cannot perform that action. Refresh its status first.",
    );
    refuse({ code: "INVALID" }, 400);
    expect(await error("create")).toBe(
      "The bot could not complete that request. Refresh its status before retrying.",
    );
    refuse({ code: "OFFLINE" });
    expect(await error("start")).toBe(
      "The bot is not connected to Dota yet. Try again shortly.",
    );
  });

  it("marks an invite whose answer was lost as unknown, never failed", async () => {
    const { lobby, radiantCaptain } = await inhouseGame();
    as(radiantCaptain);
    const unknown =
      "The lobby bot didn't confirm, but the invites may have gone out. Check the list before sending again.";
    // The relay answers OFFLINE for a reply it lost after delivery, too.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "OFFLINE" }), { status: 409 })),
    );
    let body = await (await inhouse(lobby.id, "invite")).json();
    expect(body).toEqual({ error: unknown, unknown: true });
    // No answer at all.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("relay-secret-in-driver-error")),
    );
    body = await (await inhouse(lobby.id, "invite")).json();
    expect(body).toEqual({ error: unknown, unknown: true });
    // Any other action's lost answer keeps its own message, and no flag.
    body = await (await inhouse(lobby.id, "start")).json();
    expect(body.unknown).toBeUndefined();
    expect(body.error).not.toBe(unknown);
    // A definite refusal of an invite is not unknown.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "STATE" }), { status: 409 })),
    );
    body = await (await inhouse(lobby.id, "invite")).json();
    expect(body.unknown).toBeUndefined();
  });

  it("counts invites against the write limit", async () => {
    const { lobby, radiantCaptain } = await inhouseGame();
    as(radiantCaptain);
    const bot = inviteBot();
    for (let i = 0; i < 10; i++)
      expect((await inhouse(lobby.id, "invite")).status).toBe(200);
    expect((await inhouse(lobby.id, "invite")).status).toBe(429);
    expect(bot.calls).toHaveLength(10);
    // Reads have their own budget.
    expect((await inhouse(lobby.id, "status")).status).toBe(200);
  });

  it("invites a booked stand-in to their own playing account, and refuses the player they replace", async () => {
    const { home, match } = await fixture();
    const replaced = await makeUser("Replaced");
    await prisma.teamMember.create({
      data: { seasonId: match.seasonId, teamId: home.team.id, userId: replaced.id },
    });
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
        replacingUserId: replaced.id,
      },
    });
    const bot = inviteBot();
    vi.mocked(getSessionUser).mockResolvedValue(asSession(standin));
    const response = await POST(request({ kind: "season", id: match.id, action: "invite" }));
    expect(response.status).toBe(200);
    expect(bot.calls.at(-1)).toMatchObject({
      action: "invite",
      spec: {
        key: `${keyPrefix}season:${match.id}:1`,
        withPlayers: true,
        invite: [OVERRIDE_STEAM_ID],
      },
    });
    const body = await response.json();
    expect(body.inviteScope).toBe("self");
    expect(body.players).toContainEqual({
      name: "Stand-in",
      side: "radiant",
      seat: "absent",
      invite: "none",
      self: true,
    });
    expectNoSteamIds(body, [home.user.steamId, standin.steamId, OVERRIDE_STEAM_ID]);
    // Still on the team, but not playing this match: may view, not invite.
    vi.mocked(getSessionUser).mockResolvedValue(asSession(replaced));
    expect(
      (await POST(request({ kind: "season", id: match.id, action: "invite" }))).status,
    ).toBe(403);
    // The home captain invites everyone missing.
    vi.mocked(getSessionUser).mockResolvedValue(asSession(home.user));
    expect(
      (await POST(request({ kind: "season", id: match.id, action: "invite" }))).status,
    ).toBe(200);
    expect(bot.calls.at(-1)!.spec).not.toHaveProperty("invite");
    expect(bot.calls).toHaveLength(2);
  });

  it("refuses a season invite once the match is closed", async () => {
    const { home, match } = await fixture();
    await prisma.match.update({ where: { id: match.id }, data: { status: "COMPLETED" } });
    const bot = inviteBot();
    vi.mocked(getSessionUser).mockResolvedValue(asSession(home.user));
    const result = await POST(request({ kind: "season", id: match.id, action: "invite" }));
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: "This match is not open for play." });
    expect(bot.fetch).not.toHaveBeenCalled();
  });

  it("rejects invite targets off the spec's roster before contacting the bot", async () => {
    const { lobby, radiantCaptain } = await inhouseGame();
    const { spec } = await resolveDotaLobby(asSession(radiantCaptain), "inhouse", lobby.id);
    const bot = inviteBot();
    for (const invite of [
      [],
      ["76561198999999999"],
      [spec.radiant[0], spec.radiant[0]],
    ])
      await expect(callLobbyBot(spec, "invite", { invite })).rejects.toThrow(
        "Only this game's own players can be invited.",
      );
    expect(bot.fetch).not.toHaveBeenCalled();
    // Targets travel only on an invite.
    await callLobbyBot(spec, "create", { invite: [spec.radiant[0]] });
    expect(bot.calls[0].spec).not.toHaveProperty("invite");
  });
});
