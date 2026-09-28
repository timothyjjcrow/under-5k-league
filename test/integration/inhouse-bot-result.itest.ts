import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { INHOUSE, INHOUSE_STATUS } from "@/lib/constants";
import { effectiveDotaAccountId } from "@/lib/dota-account";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { maybeAutoDetectResult } from "@/lib/inhouse-service";
import { makeUser } from "./factories";

// When the lobby bot hosted the game, the result scan asks the bot for the
// match id it saw and looks up that ONE match — validated exactly like a
// pasted id — instead of scanning ten players' recent games. OpenDota and the
// Discord sender are stubbed; the bot is a stubbed relay behind global fetch.
vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return {
    ...actual,
    fetchRecentMatchIds: vi.fn(async () => [] as number[]),
    fetchOpenDotaMatch: vi.fn(async () => null),
  };
});
import { fetchOpenDotaMatch, fetchRecentMatchIds } from "@/lib/dota";

vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return { ...actual, sendInhouseDiscordMessage: vi.fn(async () => true) };
});

const mockRecent = vi.mocked(fetchRecentMatchIds);
const mockMatch = vi.mocked(fetchOpenDotaMatch);
const BOT_ORIGIN = "http://127.0.0.1:8090";
const keyPrefix = LEAGUE_CONFIG.region === "eu" ? "eu:" : "";

type BotReply = { state: string; lobbyId?: string; matchId?: string };
const botCalls: { url: string; init: RequestInit }[] = [];

/** The relay answers every status read with `reply` (or fails with `error`). */
function stubBot(reply: BotReply | Error) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      botCalls.push({ url: String(url), init });
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("DOTA_LOBBY_BOT_URL", BOT_ORIGIN);
  vi.stubEnv("DOTA_LOBBY_BOT_SECRET", "test-lobby-secret-".repeat(4));
  vi.stubEnv("DOTA_INHOUSE_LEAGUE_ID", "54321");
  botCalls.length = 0;
  mockRecent.mockReset();
  mockMatch.mockReset();
  mockRecent.mockResolvedValue([]);
  mockMatch.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A drafted READY lobby (nobody pressed Start), formed `minutes` ago. */
async function readyLobby(minutes = INHOUSE.DETECT_READY_MIN_MINUTES + 30) {
  const users = [];
  for (let i = 0; i < INHOUSE.LOBBY_SIZE; i++)
    users.push(await makeUser(`Bot game ${i}`));
  const lobby = await prisma.inhouseLobby.create({
    data: {
      status: INHOUSE_STATUS.READY,
      radiantTeam: 1,
      createdAt: new Date(Date.now() - minutes * 60_000),
      players: {
        create: users.map((u, i) => ({
          userId: u.id,
          team: i < INHOUSE.TEAM_SIZE ? 1 : 2,
          isCaptain: i === 0 || i === INHOUSE.TEAM_SIZE,
          mmr: 3000,
        })),
      },
    },
  });
  const accounts = users.map((u) => effectiveDotaAccountId(u)!);
  return {
    lobby,
    team1: accounts.slice(0, INHOUSE.TEAM_SIZE),
    team2: accounts.slice(INHOUSE.TEAM_SIZE),
  };
}

/** An OpenDota match with `radiant` on Radiant and `dire` on Dire. */
function playedGame(opts: {
  matchId: string;
  radiant: number[];
  dire: number[];
  startTime: number;
  radiantWin?: boolean;
}) {
  const line = (accountId: number, slot: number, isRadiant: boolean) => ({
    account_id: accountId,
    player_slot: slot,
    hero_id: (slot % 128) + 1,
    isRadiant,
    kills: 5,
    deaths: 5,
    assists: 5,
  });
  return {
    match_id: Number(opts.matchId),
    radiant_win: opts.radiantWin ?? true,
    duration: 2400,
    start_time: opts.startTime,
    radiant_score: 25,
    dire_score: 25,
    players: [
      ...opts.radiant.map((a, i) => line(a, i, true)),
      ...opts.dire.map((a, i) => line(a, 128 + i, false)),
    ],
  } as never;
}

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);
const statusOf = async (id: string) =>
  (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id } })).status;

describe("inhouse — recording a bot-hosted game from the bot's match id", () => {
  it("records it from READY with one match lookup and no history scan", async () => {
    const { lobby, team1, team2 } = await readyLobby();
    stubBot({ state: "started", lobbyId: "30007027938516500", matchId: "7300000001" });
    mockMatch.mockResolvedValue(
      playedGame({
        matchId: "7300000001",
        radiant: team1,
        dire: team2,
        startTime: seconds(lobby.createdAt) + 600,
        radiantWin: false,
      }),
    );

    // The scheduled worker's form of the call: bounded by its deadline.
    expect(
      await maybeAutoDetectResult({ deadlineMs: Date.now() + 60_000 }),
    ).toEqual({ recorded: true, deadlineReached: false });

    const done = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(done.status).toBe(INHOUSE_STATUS.COMPLETED);
    expect(done.dotaMatchId).toBe("7300000001");
    expect(done.winnerTeam).toBe(2);
    expect(done.startedAt).toBeNull();
    // One OpenDota call, for the bot's id; not ten recent-match lists.
    expect(mockMatch).toHaveBeenCalledOnce();
    expect(mockMatch.mock.calls[0]?.[0]).toBe("7300000001");
    expect(mockRecent).not.toHaveBeenCalled();

    // One status read of THIS lobby's bot job — never a create or start.
    expect(botCalls).toHaveLength(1);
    expect(botCalls[0].url).toBe(`${BOT_ORIGIN}/lobby`);
    expect(new Headers(botCalls[0].init.headers).get("Authorization")).toBe(
      `Bearer ${"test-lobby-secret-".repeat(4)}`,
    );
    const body = JSON.parse(String(botCalls[0].init.body));
    expect(body.action).toBe("status");
    expect(body.spec.key).toBe(`${keyPrefix}inhouse:${lobby.id}:1`);
    expect(body.spec.leagueId).toBe(54321);
  });

  it.each([
    ["another group's game", "strangers"],
    ["a game from before the lobby formed", "yesterday"],
  ] as const)(
    "refuses the bot's id when it names %s and falls back to the history scan",
    async (_label, kind) => {
      const { lobby, team1, team2 } = await readyLobby();
      stubBot({ state: "started", matchId: "7300000002" });
      mockMatch.mockResolvedValue(
        kind === "strangers"
          ? playedGame({
              matchId: "7300000002",
              radiant: [11, 12, 13, 14, 15],
              dire: [21, 22, 23, 24, 25],
              startTime: seconds(lobby.createdAt) + 600,
            })
          : playedGame({
              matchId: "7300000002",
              radiant: team1,
              dire: team2,
              startTime: seconds(lobby.createdAt) - 86_400,
            }),
      );

      expect(await maybeAutoDetectResult()).toBe(false);
      expect(await statusOf(lobby.id)).toBe(INHOUSE_STATUS.READY);
      // The id wasn't this lobby's game, so the players' histories are
      // searched the ordinary way (they share nothing here).
      expect(mockRecent).toHaveBeenCalledTimes(INHOUSE.LOBBY_SIZE);
    },
  );

  it("waits for OpenDota to publish the bot's game instead of scanning ten histories", async () => {
    const { lobby } = await readyLobby();
    stubBot({ state: "started", matchId: "7300000003" });

    expect(await maybeAutoDetectResult()).toBe(false);
    expect(mockMatch).toHaveBeenCalledExactlyOnceWith("7300000003", {});
    expect(mockRecent).not.toHaveBeenCalled();
    // The attempt still took the scan's interval, like any other scan.
    const scanned = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(scanned.status).toBe(INHOUSE_STATUS.READY);
    expect(scanned.detectedAt).not.toBeNull();

    // Hours later OpenDota still has nothing: something happened to the bot's
    // game, so the history scan runs again as well.
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        createdAt: new Date(
          Date.now() - (INHOUSE.DETECT_BOT_MATCH_WAIT_MINUTES + 1) * 60_000,
        ),
        detectedAt: null,
      },
    });
    expect(await maybeAutoDetectResult()).toBe(false);
    expect(mockRecent).toHaveBeenCalledTimes(INHOUSE.LOBBY_SIZE);
  });

  it("does not spend the history scan's budget when the bot's lookup hits the deadline", async () => {
    const { lobby } = await readyLobby();
    stubBot({ state: "started", matchId: "7300000004" });
    const deadlineMs = Date.now() + 60_000;
    mockMatch.mockImplementation(async () => {
      vi.spyOn(Date, "now").mockReturnValue(deadlineMs + 1);
      return null;
    });

    expect(await maybeAutoDetectResult({ deadlineMs })).toEqual({
      recorded: false,
      deadlineReached: true,
    });
    expect(mockRecent).not.toHaveBeenCalled();
    // An unfinished attempt gives its claim back rather than buying a backoff.
    const after = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(after.detectedAt).toBeNull();
  });

  it.each([
    ["isn't hosting this game", { state: "idle" } as BotReply],
    [
      "never launched it (a stale id on a blocked lobby)",
      { state: "blocked", matchId: "7300000005" } as BotReply,
    ],
    ["can't be reached", new Error("connect ECONNREFUSED")],
  ])(
    "scans the players' histories as before when the bot %s",
    async (_label, reply) => {
      const { lobby, team1, team2 } = await readyLobby();
      stubBot(reply);
      mockRecent.mockResolvedValue([7300000006]);
      mockMatch.mockResolvedValue(
        playedGame({
          matchId: "7300000006",
          radiant: team1,
          dire: team2,
          startTime: seconds(lobby.createdAt) + 600,
        }),
      );

      expect(await maybeAutoDetectResult()).toBe(true);
      expect(mockRecent).toHaveBeenCalledTimes(INHOUSE.LOBBY_SIZE);
      expect(mockMatch).toHaveBeenCalledExactlyOnceWith("7300000006", {});
      expect(botCalls).toHaveLength(1);
      const done = await prisma.inhouseLobby.findUniqueOrThrow({
        where: { id: lobby.id },
      });
      expect(done.status).toBe(INHOUSE_STATUS.COMPLETED);
      expect(done.dotaMatchId).toBe("7300000006");
    },
  );

  it("never calls out when no bot is configured", async () => {
    vi.stubEnv("DOTA_LOBBY_BOT_URL", "");
    vi.stubEnv("DOTA_LOBBY_BOT_SECRET", "");
    const { lobby } = await readyLobby();
    stubBot({ state: "started", matchId: "7300000007" });

    expect(await maybeAutoDetectResult()).toBe(false);
    expect(botCalls).toHaveLength(0);
    expect(mockMatch).not.toHaveBeenCalledWith("7300000007", {});
    expect(mockRecent).toHaveBeenCalledTimes(INHOUSE.LOBBY_SIZE);
    expect(await statusOf(lobby.id)).toBe(INHOUSE_STATUS.READY);
  });
});
