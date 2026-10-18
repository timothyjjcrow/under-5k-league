import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import { INHOUSE, INHOUSE_STATUS } from "@/lib/constants";
import { effectiveDotaAccountId } from "@/lib/dota-account";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { inhouseLobbyCode } from "@/lib/inhouse";
import { abandonedReason, adminCancelReason } from "@/lib/inhouse-end-reason";
import { getSessionUser, requireAdmin, type SessionUser } from "@/lib/auth";
import {
  callLobbyBot,
  inhouseBotGameStatus,
  lobbyBotConnection,
  recoverableInhouseBotLobby,
  resolveDotaLobby,
} from "@/lib/dota-lobby-service";
import {
  cancelLobby,
  endInhouseGameFromBot,
  finishGame,
  giveUpOnResult,
  joinQueue,
  maybeAutoDetectResult,
  recordMatch,
  resolveAbandonedLobby,
  voidLastResult,
} from "@/lib/inhouse-service";
import { readInhouseRoomVersion } from "@/lib/inhouse-room-version";
import {
  inhouseBotReleasesStarted,
  settleInhouseBotReleases,
} from "@/lib/lobby-bot-releases";
import { POST } from "@/app/api/dota-lobby/route";
import { voidInhouseResult } from "@/app/actions/inhouse-admin";
import { ON_POSTGRES, makeUser, raceAll, sessionFor } from "./factories";

// The website's side of the lobby bot's lifecycle (2026-10-18): the bot's
// postgame ends a game (Tim's call), every close releases the bot, Create's
// BUSY frees a bot left on a closed game, and the connection reads the bot the
// same way over the relay and over loopback. OpenDota and Discord are
// stubbed; the bot is a stub behind global fetch.
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
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getSessionUser: vi.fn(async () => null),
    requireAdmin: vi.fn(),
  };
});
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/automation-gate-invalidation", () => ({
  invalidateAutomationGateBestEffort: vi.fn(),
}));
import { invalidateAutomationGateBestEffort } from "@/lib/automation-gate-invalidation";

const mockRecent = vi.mocked(fetchRecentMatchIds);
const mockMatch = vi.mocked(fetchOpenDotaMatch);
const mockSession = vi.mocked(getSessionUser);
const mockGate = vi.mocked(invalidateAutomationGateBestEffort);

const MIN = 60_000;
const BOT_ORIGIN = "http://127.0.0.1:8090";
const SECRET = "test-lifecycle-secret-".repeat(3);
const keyPrefix = LEAGUE_CONFIG.region === "eu" ? "eu:" : "";
const keyOf = (lobbyId: string) => `${keyPrefix}inhouse:${lobbyId}:1`;

type BotRequest = {
  action: string;
  spec?: { key: string; withLifecycle?: boolean } & Record<string, unknown>;
};
const botCalls: BotRequest[] = [];
type BotAnswer = Response | Record<string, unknown>;
let answer: (request: BotRequest) => BotAnswer | Promise<BotAnswer> = () => ({
  state: "idle",
});

/** The bot behind global fetch: `reply` decides each answer. */
function stubBot(reply: typeof answer = answer) {
  answer = reply;
  vi.stubEnv("DOTA_LOBBY_BOT_URL", BOT_ORIGIN);
  vi.stubEnv("DOTA_LOBBY_BOT_SECRET", SECRET);
  vi.stubEnv("DOTA_INHOUSE_LEAGUE_ID", "54321");
  vi.stubEnv("DOTA_SEASON_LOBBY_BOT_ENABLED", "false");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as BotRequest;
      botCalls.push(request);
      const out = await answer(request);
      return out instanceof Response ? out : Response.json(out);
    }),
  );
}

beforeEach(() => {
  botCalls.length = 0;
  answer = () => ({ state: "idle" });
  mockRecent.mockReset().mockResolvedValue([]);
  mockMatch.mockReset().mockResolvedValue(null);
  mockSession.mockReset().mockResolvedValue(null);
  mockGate.mockClear();
});
afterEach(async () => {
  setRaceHook(null);
  // A close's bot release runs on after the action answers: let it finish
  // against this test's stubs, never the real fetch.
  await settleInhouseBotReleases();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Player = { user: Awaited<ReturnType<typeof makeUser>>; session: SessionUser };

async function makePlayers(count: number, prefix: string): Promise<Player[]> {
  const out: Player[] = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser(`${prefix}${i}`);
    out.push({ user, session: sessionFor(user) });
  }
  return out;
}

async function makeAdmin(name = "Lifecycle admin") {
  const user = await makeUser(name, "ADMIN");
  const session = sessionFor(user);
  mockSession.mockResolvedValue(session);
  return session;
}

/** A game being played, formed `formed` minutes ago: team 1 is Radiant. */
async function playedLobby(
  players: Player[],
  opts: { status?: string; slot?: number; formed?: number; started?: number } = {},
) {
  const status = opts.status ?? INHOUSE_STATUS.IN_PROGRESS;
  const formed = opts.formed ?? 60;
  const now = Date.now();
  return prisma.inhouseLobby.create({
    data: {
      status,
      slot: opts.slot ?? 1,
      radiantTeam: 1,
      createdAt: new Date(now - formed * MIN),
      startedAt:
        status === INHOUSE_STATUS.IN_PROGRESS
          ? new Date(now - (opts.started ?? Math.max(0, formed - 10)) * MIN)
          : null,
      players: {
        create: players.map((p, i) => ({
          userId: p.user.id,
          team: i < INHOUSE.TEAM_SIZE ? 1 : 2,
          isCaptain: i === 0 || i === INHOUSE.TEAM_SIZE,
          mmr: 3000,
          queuedAt: new Date(now - formed * MIN - MIN + i),
          acceptedAt: new Date(now - formed * MIN),
        })),
      },
    },
  });
}

const lobbyRow = (id: string) =>
  prisma.inhouseLobby.findUniqueOrThrow({ where: { id } });
const queuedIds = async () =>
  new Set((await prisma.inhouseQueueEntry.findMany()).map((q) => q.userId));

/** An OpenDota match with team 1 on Radiant, started after formation. */
function playedMatch(players: Player[], matchId: number, createdAt: Date) {
  const accounts = players.map((p) => effectiveDotaAccountId(p.user)!);
  const line = (accountId: number, slot: number, isRadiant: boolean) => ({
    account_id: accountId,
    player_slot: slot,
    hero_id: (slot % 128) + 1,
    isRadiant,
    kills: 5,
    deaths: 5,
    assists: 5,
  });
  const game = {
    match_id: matchId,
    radiant_win: true,
    duration: 2400,
    start_time: Math.floor(createdAt.getTime() / 1000) + 600,
    radiant_score: 25,
    dire_score: 20,
    players: [
      ...accounts.slice(0, 5).map((a, i) => line(a, i, true)),
      ...accounts.slice(5).map((a, i) => line(a, 128 + i, false)),
    ],
  };
  mockRecent.mockResolvedValue([matchId]);
  mockMatch.mockImplementation(async (id: string) =>
    (String(id) === String(matchId) ? game : null) as never,
  );
}

function lobbyRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/dota-lobby", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });
}

/** Each bot request's action and key, once every release has landed. */
async function sent() {
  await settleInhouseBotReleases();
  return botCalls.map((c) => [c.action, c.spec?.key ?? null]);
}

// ---------------------------------------------------------------------------

describe("the bot's postgame marks the game over (endInhouseGameFromBot)", () => {
  it.each([INHOUSE_STATUS.READY, INHOUSE_STATUS.IN_PROGRESS])(
    "a %s game moves to AWAITING_RESULT: nobody requeued, the room told, the gate woken, the bot released",
    async (status) => {
      stubBot(() => ({ state: "started", matchId: "9050201642" }));
      const players = await makePlayers(INHOUSE.LOBBY_SIZE, `BO-${status}-`);
      const lobby = await playedLobby(players, { status });
      const before = Date.now();

      expect(await endInhouseGameFromBot(lobby.id)).toBe(true);

      const done = await lobbyRow(lobby.id);
      expect(done.status).toBe(INHOUSE_STATUS.AWAITING_RESULT);
      expect(done.finishedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(done.startedAt?.getTime() ?? null).toBe(lobby.startedAt?.getTime() ?? null);
      // Not a result: nothing about the outcome is written.
      expect(done).toMatchObject({ winnerTeam: null, completedAt: null, dotaMatchId: null });
      // Unlike a player's press, nobody is put back in the queue.
      expect(await prisma.inhouseQueueEntry.count()).toBe(0);
      expect(await readInhouseRoomVersion()).not.toBeNull();
      expect(mockGate).toHaveBeenCalled();
      expect(await sent()).toEqual([["release", keyOf(lobby.id)]]);
    },
  );

  it.each([
    INHOUSE_STATUS.READY_CHECK,
    INHOUSE_STATUS.DRAFTING,
    INHOUSE_STATUS.AWAITING_RESULT,
    INHOUSE_STATUS.COMPLETED,
    INHOUSE_STATUS.CANCELLED,
  ])("changes nothing on a %s game", async (status) => {
    stubBot();
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, `BO-no-${status}-`);
    const lobby = await playedLobby(players, { status });
    const pressed = new Date(Date.now() - 5 * MIN);
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { finishedAt: status === INHOUSE_STATUS.AWAITING_RESULT ? pressed : null },
    });

    expect(await endInhouseGameFromBot(lobby.id)).toBe(false);

    expect(await lobbyRow(lobby.id)).toMatchObject({
      status,
      finishedAt: status === INHOUSE_STATUS.AWAITING_RESULT ? pressed : null,
    });
    expect(await readInhouseRoomVersion()).toBeNull();
    expect(mockGate).not.toHaveBeenCalled();
    expect(await sent()).toEqual([]);
  });

  it("offers the freed slot to the queue: ten waiting players form the next game in it", async () => {
    const a = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-slot-a-");
    const b = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-slot-b-");
    const waiting = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-slot-q-");
    const game1 = await playedLobby(a, { slot: 1 });
    await playedLobby(b, { slot: 2 });
    for (const p of waiting) expect(await joinQueue(p.session, 3000)).toEqual({ ok: true });
    // Both slots are held: nobody formed.
    expect(await prisma.inhouseLobby.count({ where: { status: INHOUSE_STATUS.READY_CHECK } })).toBe(0);

    expect(await endInhouseGameFromBot(game1.id)).toBe(true);

    const next = await prisma.inhouseLobby.findFirstOrThrow({
      where: { status: INHOUSE_STATUS.READY_CHECK },
      include: { players: true },
    });
    expect(next.slot).toBe(1);
    expect(new Set(next.players.map((p) => p.userId))).toEqual(
      new Set(waiting.map((p) => p.user.id)),
    );
  });
});

// The claim's seam sits OUTSIDE any transaction, so each rival commits on
// SQLite too. The `fired` flag fails a drifted label. Without the claim's
// status predicate every one of these goes red: the blind write would move
// a COMPLETED or CANCELLED game to AWAITING_RESULT, or restamp a press.
describe("endInhouseGameFromBot::status — the claim loses to a rival that lands first", () => {
  const SEAM = "inhouse.endInhouseGameFromBot.beforeClaim";

  it("a result recorded first keeps the game COMPLETED", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-seam-result-");
    const lobby = await playedLobby(players);
    playedMatch(players, 7500000101, lobby.createdAt);
    let fired = false;
    let rival: unknown = null;
    setRaceHook(
      onceAt(SEAM, async () => {
        fired = true;
        rival = await recordMatch(players[1].session, "7500000101", lobby.id);
      }),
    );

    expect(await endInhouseGameFromBot(lobby.id)).toBe(false);
    expect(fired).toBe(true);
    expect(rival).toEqual({ ok: true });
    expect(await lobbyRow(lobby.id)).toMatchObject({
      status: INHOUSE_STATUS.COMPLETED,
      dotaMatchId: "7500000101",
      finishedAt: null,
    });
  });

  it("an admin cancel first keeps the game CANCELLED with its ten requeued", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-seam-cancel-");
    const lobby = await playedLobby(players);
    const admin = await makeAdmin("Seam cancel admin");
    let fired = false;
    let rival: unknown = null;
    setRaceHook(
      onceAt(SEAM, async () => {
        fired = true;
        rival = await cancelLobby(admin, lobby.id);
      }),
    );

    expect(await endInhouseGameFromBot(lobby.id)).toBe(false);
    expect(fired).toBe(true);
    expect(rival).toEqual({ ok: true });
    expect(await lobbyRow(lobby.id)).toMatchObject({
      status: INHOUSE_STATUS.CANCELLED,
      finishedAt: null,
      endReason: adminCancelReason(admin.name, INHOUSE_STATUS.IN_PROGRESS),
    });
    expect(await queuedIds()).toEqual(new Set(players.map((p) => p.user.id)));
  });

  it("the abandon sweep first keeps the game CANCELLED as abandoned", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-seam-sweep-");
    const lobby = await playedLobby(players, {
      formed: INHOUSE.ABANDON_IN_PROGRESS_HOURS * 60 + 30,
    });
    let fired = false;
    setRaceHook(
      onceAt(SEAM, async () => {
        fired = true;
        expect(await resolveAbandonedLobby()).toBe(true);
      }),
    );

    expect(await endInhouseGameFromBot(lobby.id)).toBe(false);
    expect(fired).toBe(true);
    expect(await lobbyRow(lobby.id)).toMatchObject({
      status: INHOUSE_STATUS.CANCELLED,
      finishedAt: null,
      endReason: abandonedReason(INHOUSE_STATUS.IN_PROGRESS),
    });
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
  });

  it("a Game over press first keeps its own stamp and its presser's requeue", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-seam-press-");
    const lobby = await playedLobby(players);
    let fired = false;
    let rival: unknown = null;
    setRaceHook(
      onceAt(SEAM, async () => {
        fired = true;
        rival = await finishGame(players[2].session, lobby.id, { requeue: true });
      }),
    );

    expect(await endInhouseGameFromBot(lobby.id)).toBe(false);
    expect(fired).toBe(true);
    expect(rival).toEqual({ ok: true });
    const pressed = await lobbyRow(lobby.id);
    expect(pressed.status).toBe(INHOUSE_STATUS.AWAITING_RESULT);
    // The press's finishedAt stands: the bot's claim wrote nothing.
    await new Promise((r) => setTimeout(r, 5));
    expect(await endInhouseGameFromBot(lobby.id)).toBe(false);
    expect((await lobbyRow(lobby.id)).finishedAt).toEqual(pressed.finishedAt);
    expect(await queuedIds()).toEqual(new Set([players[2].user.id]));
  });
});

// Raced, not staged: on Postgres the two run concurrently and either order
// may win; each outcome must be whole. (On SQLite raceAll runs them in turn.)
describe("endInhouseGameFromBot raced against its rivals", () => {
  const ROUNDS = ON_POSTGRES ? 8 : 2;

  it("against an admin cancel: either a requeued cancel or a game over, never both", async () => {
    const admin = await makeAdmin("Race cancel admin");
    for (let round = 0; round < ROUNDS; round++) {
      await prisma.inhouseQueueEntry.deleteMany();
      const players = await makePlayers(INHOUSE.LOBBY_SIZE, `BO-race-c${round}-`);
      const lobby = await playedLobby(players, { slot: 1 });
      const [ended, cancelled] = await raceAll<unknown>([
        () => endInhouseGameFromBot(lobby.id),
        () => cancelLobby(admin, lobby.id),
      ]);
      const done = await lobbyRow(lobby.id);
      if (done.status === INHOUSE_STATUS.CANCELLED) {
        expect(ended).toBe(false);
        expect(cancelled).toEqual({ ok: true });
        expect(done.finishedAt).toBeNull();
        expect(await queuedIds()).toEqual(new Set(players.map((p) => p.user.id)));
      } else {
        expect(done.status).toBe(INHOUSE_STATUS.AWAITING_RESULT);
        expect(ended).toBe(true);
        expect(cancelled).toMatchObject({ ok: false });
        expect(done.endReason).toBeNull();
        expect(await prisma.inhouseQueueEntry.count()).toBe(0);
      }
      await prisma.inhouseLobby.update({
        where: { id: lobby.id },
        data: { status: INHOUSE_STATUS.COMPLETED },
      });
    }
  });

  it("against a Game over press: the game is over once, and only the presser queues", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await prisma.inhouseQueueEntry.deleteMany();
      const players = await makePlayers(INHOUSE.LOBBY_SIZE, `BO-race-p${round}-`);
      const lobby = await playedLobby(players, { slot: 1 });
      const [, pressed] = await raceAll<unknown>([
        () => endInhouseGameFromBot(lobby.id),
        () => finishGame(players[4].session, lobby.id, { requeue: true }),
      ]);
      expect(pressed).toEqual({ ok: true });
      const done = await lobbyRow(lobby.id);
      expect(done.status).toBe(INHOUSE_STATUS.AWAITING_RESULT);
      expect(done.finishedAt).not.toBeNull();
      expect(await queuedIds()).toEqual(new Set([players[4].user.id]));
      await prisma.inhouseLobby.update({
        where: { id: lobby.id },
        data: { status: INHOUSE_STATUS.COMPLETED },
      });
    }
  });

  it("against the abandon sweep: abandoned or over, never an abandoned game marked over", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const players = await makePlayers(INHOUSE.LOBBY_SIZE, `BO-race-s${round}-`);
      const lobby = await playedLobby(players, {
        slot: 1,
        formed: INHOUSE.ABANDON_IN_PROGRESS_HOURS * 60 + 30,
      });
      const [ended] = await raceAll<unknown>([
        () => endInhouseGameFromBot(lobby.id),
        () => resolveAbandonedLobby(),
      ]);
      const done = await lobbyRow(lobby.id);
      if (done.status === INHOUSE_STATUS.CANCELLED) {
        expect(ended).toBe(false);
        expect(done.finishedAt).toBeNull();
      } else {
        expect(done.status).toBe(INHOUSE_STATUS.AWAITING_RESULT);
        expect(ended).toBe(true);
        expect(done.endReason).toBeNull();
      }
      await prisma.inhouseLobby.update({
        where: { id: lobby.id },
        data: { status: INHOUSE_STATUS.COMPLETED },
      });
    }
  });
});

describe("who ends a game from the bot's postgame", () => {
  it("the bot panel's read: a playable game ends, and the reply says it is no longer playable", async () => {
    stubBot(() => ({ state: "started", matchId: "9050201642", over: true }));
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-route-");
    const lobby = await playedLobby(players, { status: INHOUSE_STATUS.READY });
    mockSession.mockResolvedValue(players[0].session);

    const res = await POST(lobbyRequest({ kind: "inhouse", id: lobby.id, action: "status" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      playable: false,
      canControl: false,
      canRelease: true,
      status: { state: "started", matchId: "9050201642", over: true },
    });
    const done = await lobbyRow(lobby.id);
    // Over, not started: a READY game Dota showed over keeps no late start
    // stamp (it would move the result scan's clock).
    expect(done).toMatchObject({ status: INHOUSE_STATUS.AWAITING_RESULT, startedAt: null });
    expect(done.finishedAt).not.toBeNull();
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
    expect((await sent()).map(([action]) => action)).toEqual(["status", "release"]);
  });

  it.each([
    ["the string \"true\"", "true"],
    ["1", 1],
    ["false", false],
  ])("reads over: %s as unknown, and leaves the game alone", async (_label, over) => {
    stubBot(() => ({ state: "started", over, releasing: over }));
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-strict-");
    const lobby = await playedLobby(players);
    mockSession.mockResolvedValue(players[0].session);

    const body = await (
      await POST(lobbyRequest({ kind: "inhouse", id: lobby.id, action: "status" }))
    ).json();
    expect(body.status).toEqual({ state: "started" });
    expect(body.playable).toBe(true);
    expect((await lobbyRow(lobby.id)).status).toBe(INHOUSE_STATUS.IN_PROGRESS);
  });

  it("shows a pending release to the panel", async () => {
    stubBot(() => ({ state: "started", releasing: true }));
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-releasing-");
    const lobby = await playedLobby(players);
    mockSession.mockResolvedValue(players[0].session);
    const body = await (
      await POST(lobbyRequest({ kind: "inhouse", id: lobby.id, action: "release" }))
    ).json();
    expect(body.status).toEqual({ state: "started", releasing: true });
    expect((await lobbyRow(lobby.id)).status).toBe(INHOUSE_STATUS.IN_PROGRESS);
  });

  it("the result scan's own bot read, with no tab open (the backstop)", async () => {
    stubBot(() => ({ state: "started", matchId: "9050201642", over: true }));
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-scan-");
    const lobby = await playedLobby(players);

    expect(await maybeAutoDetectResult({ deadlineMs: Date.now() + 60_000 })).toEqual({
      recorded: false,
      deadlineReached: false,
    });
    const done = await lobbyRow(lobby.id);
    expect(done.status).toBe(INHOUSE_STATUS.AWAITING_RESULT);
    expect(done.finishedAt).not.toBeNull();
    // The bot's id is still looked up, and the scan carries on as for any
    // game marked over.
    expect(mockMatch).toHaveBeenCalledWith("9050201642", expect.anything());
    expect((await sent()).map(([action]) => action)).toEqual(["status", "release"]);
  });

  // 2026-10-18 review: the backstop's claim and the formation after it ran
  // without the route's try/catch, so one failure there aborted the pass:
  // this game's OpenDota lookup and every other game's scan.
  it("a failure in the bot-driven update never costs the scan its lookups", async () => {
    stubBot(() => ({ state: "started", matchId: "9050201643", over: true }));
    const first = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-scan-fail-a-");
    const second = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-scan-fail-b-");
    const a = await playedLobby(first, { slot: 1 });
    const b = await playedLobby(second, { slot: 2, formed: 61 });
    let fired = false;
    setRaceHook(
      onceAt("inhouse.endInhouseGameFromBot.beforeClaim", async () => {
        fired = true;
        throw new Error("simulated failure after the bot's read");
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await maybeAutoDetectResult({ deadlineMs: Date.now() + 60_000 })).toEqual({
        recorded: false,
        deadlineReached: false,
      });
      expect(fired).toBe(true);
      expect(error).toHaveBeenCalledWith("[inhouse] bot-driven game update failed");
    } finally {
      error.mockRestore();
    }
    // The failed game still got its OpenDota lookup, and the other game was
    // scanned (and marked over) in the same pass.
    expect(mockMatch.mock.calls.filter(([id]) => String(id) === "9050201643")).toHaveLength(2);
    const statuses = [(await lobbyRow(a.id)).status, (await lobbyRow(b.id)).status].sort();
    expect(statuses).toEqual([INHOUSE_STATUS.AWAITING_RESULT, INHOUSE_STATUS.IN_PROGRESS].sort());
  });
});

describe("every close releases the bot, without waiting on it", () => {
  /** A bot whose release never answers until `answerRelease()`. */
  function hungRelease() {
    let answerRelease!: () => void;
    const answered = new Promise<void>((r) => (answerRelease = r));
    stubBot(async (request) => {
      if (request.action === "release") await answered;
      return { state: "released" };
    });
    return () => answerRelease();
  }

  it("an admin cancel answers at once and releases the cancelled game's job", async () => {
    const answerRelease = hungRelease();
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-rel-cancel-");
    const lobby = await playedLobby(players, { status: INHOUSE_STATUS.READY });
    const admin = await makeAdmin();
    // The cancel resolves while the bot still hasn't answered its release.
    expect(await cancelLobby(admin, lobby.id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(botCalls.map((c) => c.action)).toEqual(["release"]));
    answerRelease();
    expect(await sent()).toEqual([["release", keyOf(lobby.id)]]);
  });

  it("a Game over press answers at once and releases its game's job", async () => {
    const answerRelease = hungRelease();
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-rel-press-");
    const lobby = await playedLobby(players);
    expect(await finishGame(players[0].session, lobby.id, { requeue: true })).toEqual({
      ok: true,
    });
    await vi.waitFor(() => expect(botCalls.map((c) => c.action)).toContain("release"));
    answerRelease();
    expect(await sent()).toEqual([
      ["status", keyOf(lobby.id)],
      ["release", keyOf(lobby.id)],
    ]);
  });

  it("an admin's give-up on a pending result releases its game's job", async () => {
    stubBot(() => ({ state: "started" }));
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-rel-giveup-");
    const lobby = await playedLobby(players, { status: INHOUSE_STATUS.AWAITING_RESULT });
    const admin = await makeAdmin();
    expect(await giveUpOnResult(admin, lobby.id)).toEqual({ ok: true });
    expect(await sent()).toEqual([["release", keyOf(lobby.id)]]);
  });

  it("a recorded result, and then its void (the service and the admin form), each release its game's job", async () => {
    stubBot(() => ({ state: "started", matchId: "7500000201" }));
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-rel-void-");
    const lobby = await playedLobby(players);
    playedMatch(players, 7500000201, lobby.createdAt);
    expect(await recordMatch(players[0].session, "7500000201", lobby.id)).toEqual({ ok: true });
    expect(await sent()).toEqual([["release", keyOf(lobby.id)]]);

    const admin = await makeAdmin();
    expect(await voidLastResult(admin, lobby.id)).toEqual({ ok: true });
    expect(await sent()).toEqual([
      ["release", keyOf(lobby.id)],
      ["release", keyOf(lobby.id)],
    ]);

    // The history page's Void goes through the same service.
    const other = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-rel-void2-");
    const second = await playedLobby(other, { slot: 2 });
    playedMatch(other, 7500000202, second.createdAt);
    expect(await recordMatch(other[0].session, "7500000202", second.id)).toEqual({ ok: true });
    vi.mocked(requireAdmin).mockResolvedValue(admin);
    const form = new FormData();
    form.set("lobbyId", second.id);
    expect((await voidInhouseResult({}, form))?.error).toBeUndefined();
    const releases = (await sent()).filter(([action]) => action === "release");
    expect(releases.filter(([, key]) => key === keyOf(second.id))).toHaveLength(2);
  });

  it("never calls out, or even reads the game, when no bot is configured", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-rel-none-");
    const lobby = await playedLobby(players, { status: INHOUSE_STATUS.READY });
    const admin = await makeAdmin();
    const before = inhouseBotReleasesStarted();
    expect(await cancelLobby(admin, lobby.id)).toEqual({ ok: true });
    await settleInhouseBotReleases();
    expect(fetch).not.toHaveBeenCalled();
    // No release started at all: one would read the game before finding no
    // bot to send it to.
    expect(inhouseBotReleasesStarted()).toBe(before);
    // Configured, the same close starts exactly one (this test can fail).
    stubBot(() => ({ state: "released" }));
    const second = await playedLobby(await makePlayers(INHOUSE.LOBBY_SIZE, "BO-rel-some-"), {
      status: INHOUSE_STATUS.READY,
      slot: 2,
    });
    expect(await cancelLobby(admin, second.id)).toEqual({ ok: true });
    expect(inhouseBotReleasesStarted()).toBe(before + 1);
  });
});

describe("Create's BUSY", () => {
  async function readyGame(prefix: string) {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, prefix);
    const lobby = await playedLobby(players, { status: INHOUSE_STATUS.READY, slot: 2 });
    mockSession.mockResolvedValue(players[0].session);
    return lobby;
  }
  const create = (id: string) =>
    POST(lobbyRequest({ kind: "inhouse", id, action: "create" }));
  const health = (activeKey: string | null) => ({
    online: true,
    steamId: "76561198000000000",
    activeKey,
  });
  const busy = new Response(JSON.stringify({ code: "BUSY" }), { status: 409 });

  const busyCopy =
    "The bot is hosting another game's lobby. It hosts one game at a time and is free again when that game ends: try again then, or host this game by hand.";
  const leavingCopy = (id: string) =>
    `Asked the bot to leave finished game #${inhouseLobbyCode(id)}. It leaves as soon as Dota lets it: at once if that game's lobby is gone, otherwise when that game ends in Dota. Press “Create Dota lobby” again in a minute, or host this game by hand.`;

  /** A closed game the bot still holds, and Create on a new game. */
  async function heal(prefix: string, release: (request: BotRequest) => BotAnswer) {
    const old = await playedLobby(await makePlayers(INHOUSE.LOBBY_SIZE, `${prefix}old-`), {
      status: INHOUSE_STATUS.AWAITING_RESULT,
    });
    stubBot((request) =>
      request.action === "create"
        ? busy.clone()
        : request.action === "health"
          ? health(keyOf(old.id))
          : release(request),
    );
    const lobby = await readyGame(`${prefix}new-`);
    const res = await create(lobby.id);
    expect(res.status).toBe(400);
    expect(await sent()).toEqual([
      ["create", keyOf(lobby.id)],
      ["health", null],
      ["release", keyOf(old.id)],
    ]);
    return { old, error: (await res.json()).error as string };
  }

  it.each([
    ["it left the lobby", { state: "released" }],
    ["it is leaving the lobby screen", { state: "ready", releasing: true }],
  ])("frees the bot from a closed game of this league and says so (%s)", async (_label, reply) => {
    const { old, error } = await heal("BO-busy-", () => reply);
    expect(error).toBe(
      `Freeing the bot from finished game #${inhouseLobbyCode(old.id)}. Press “Create Dota lobby” again in a few seconds.`,
    );
  });

  // 2026-10-18 review: the copy promised "a few seconds" whatever the
  // release did. A closed game still running in Dota (an early "Game over"
  // press, an admin cancel) keeps the bot until its postgame.
  it("says the bot leaves when that game ends when Dota is still running it", async () => {
    const { old, error } = await heal("BO-busy-run-", () => ({
      state: "started",
      releasing: true,
    }));
    expect(error).toBe(leavingCopy(old.id));
  });

  it("says the release was asked for when its answer was lost", async () => {
    const { old, error } = await heal(
      "BO-busy-lost-",
      () => new Response("upstream timeout", { status: 524 }),
    );
    expect(error).toBe(leavingCopy(old.id));
  });

  // A release the bot refused changed nothing: never "Freeing…".
  it.each(["STATE", "OFFLINE", "INVALID"])(
    "keeps the BUSY answer when the bot refuses the release (%s)",
    async (code) => {
      const { error } = await heal(
        `BO-busy-ref-${code}-`,
        () => new Response(JSON.stringify({ code }), { status: 409 }),
      );
      expect(error).toBe(busyCopy);
    },
  );

  it.each([
    ["a game still being played", "live"],
    ["the other league's game", "other-league"],
    ["nothing it can name", "none"],
  ] as const)("only explains itself when the holder is %s", async (_label, holder) => {
    const live = await playedLobby(await makePlayers(INHOUSE.LOBBY_SIZE, "BO-busy-live-"));
    const otherKey =
      LEAGUE_CONFIG.region === "eu" ? `inhouse:${live.id}:1` : `eu:inhouse:${live.id}:1`;
    stubBot((request) =>
      request.action === "create"
        ? busy.clone()
        : health(holder === "live" ? keyOf(live.id) : holder === "other-league" ? otherKey : null),
    );
    const lobby = await readyGame(`BO-busy-${holder}-`);

    const res = await create(lobby.id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(busyCopy);
    expect((await sent()).map(([action]) => action)).toEqual(["create", "health"]);
  });
});

describe("the bot connection", () => {
  it("in production takes https, or plain http only to the bot on this box", () => {
    vi.stubEnv("DOTA_LOBBY_BOT_SECRET", SECRET);
    const accepts = (url: string, nodeEnv = "production") => {
      vi.stubEnv("DOTA_LOBBY_BOT_URL", url);
      vi.stubEnv("NODE_ENV", nodeEnv);
      try {
        return lobbyBotConnection();
      } catch {
        return "refused";
      } finally {
        vi.stubEnv("NODE_ENV", "test");
      }
    };
    expect(accepts("http://127.0.0.1:8090")).toEqual({
      origin: "http://127.0.0.1:8090",
      token: SECRET,
      loopback: true,
    });
    expect(accepts("http://[::1]:8090")).toMatchObject({ origin: "http://[::1]:8090", loopback: true });
    expect(accepts("https://ggd2l-dota-lobby-relay.ggd2l.workers.dev")).toMatchObject({
      loopback: false,
    });
    for (const url of [
      "http://localhost:8090",
      "http://10.0.0.1:8090",
      "http://example.com:8090",
      "http://127.0.0.1",
      "http://127.0.0.1:8090/lobby",
      "http://user:pw@127.0.0.1:8090",
      "http://127.0.0.1:8090/?x=1",
      "ftp://127.0.0.1:8090",
    ])
      expect(accepts(url), url).toBe("refused");
    // Development also takes localhost, as before.
    expect(accepts("http://localhost:8090", "test")).toMatchObject({ loopback: true });
  });

  it("says the bot isn't running when nothing listens, a definite failure for an invite too", async () => {
    // A real refused connection: a port that was just free on loopback.
    const port = await new Promise<number>((resolve) => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        server.close(() => resolve(port));
      });
    });
    vi.stubEnv("DOTA_LOBBY_BOT_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("DOTA_LOBBY_BOT_SECRET", SECRET);
    vi.stubEnv("DOTA_INHOUSE_LEAGUE_ID", "54321");
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-refused-");
    const lobby = await playedLobby(players, { status: INHOUSE_STATUS.READY });
    mockSession.mockResolvedValue(players[0].session);
    const notRunning =
      "The lobby bot isn't running right now, so nothing was sent to Dota. Try again in a minute, or host this game by hand.";
    for (const action of ["create", "invite"]) {
      const res = await POST(lobbyRequest({ kind: "inhouse", id: lobby.id, action }));
      expect(res.status).toBe(400);
      expect(await res.json(), action).toEqual({ error: notRunning });
    }
  });

  it("reads replies within the relay's limits: an oversize or off-contract reply is unknown, a bad id is dropped", async () => {
    stubBot();
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-bounded-");
    const lobby = await playedLobby(players, { status: INHOUSE_STATUS.READY });
    const { spec } = await resolveDotaLobby(players[0].session, "inhouse", lobby.id);
    const unknown =
      "The lobby bot could not be reached. Refresh its status before retrying; the request may have reached Dota.";
    stubBot(() => Response.json({ state: "ready", pad: "x".repeat(9_000) }));
    await expect(callLobbyBot(spec, "start")).rejects.toThrow(unknown);
    stubBot(() => new Response("upstream timeout", { status: 524 }));
    await expect(callLobbyBot(spec, "start")).rejects.toThrow(unknown);
    stubBot(() => ({ state: "ready", lobbyId: "<b>1</b>", matchId: "007" }));
    expect(await callLobbyBot(spec, "start")).toEqual({
      state: "ready",
      lobbyId: undefined,
      matchId: undefined,
    });
    // Admin recovery's health read goes through the same reader.
    const admin = await makeAdmin();
    stubBot(() => Response.json({ online: true, steamId: null, activeKey: null, pad: "x".repeat(9_000) }));
    await expect(recoverableInhouseBotLobby(admin)).rejects.toThrow("Could not check bot recovery");
  });

  it("asks for the lifecycle flags on every request", async () => {
    stubBot(() => ({ state: "ready" }));
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-lifecycle-");
    const lobby = await playedLobby(players, { status: INHOUSE_STATUS.READY });
    mockSession.mockResolvedValue(players[0].session);
    for (const action of ["status", "create", "start", "invite", "release"])
      await POST(lobbyRequest({ kind: "inhouse", id: lobby.id, action }));
    const rows = await prisma.inhouseLobbyPlayer.findMany({
      where: { lobbyId: lobby.id },
      include: { user: true },
    });
    await inhouseBotGameStatus({ id: lobby.id, radiantTeam: 1, players: rows });
    expect(botCalls).toHaveLength(6);
    for (const call of botCalls) expect(call.spec?.withLifecycle).toBe(true);
  });
});

describe("one bot read serves every panel of a game", () => {
  it("shares a status read among viewers, keeps each viewer's own row, and lets a write refresh it", async () => {
    const seats = (ids: string[]) =>
      ids.map((id) => ({ id, seat: "absent", invite: "none" }));
    stubBot((request) => ({
      state: request.action === "create" ? "creating" : "ready",
      players: seats([
        ...((request.spec?.radiant as string[]) ?? []),
        ...((request.spec?.dire as string[]) ?? []),
      ]),
    }));
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "BO-cache-");
    const lobby = await playedLobby(players, { status: INHOUSE_STATUS.READY });
    const read = async (viewer: Player) => {
      mockSession.mockResolvedValue(viewer.session);
      return (await POST(lobbyRequest({ kind: "inhouse", id: lobby.id, action: "status" }))).json();
    };

    const first = await read(players[0]);
    const second = await read(players[7]);
    expect(botCalls.map((c) => c.action)).toEqual(["status"]);
    // The bot's reply is shared; each viewer's own row is their own.
    expect(first.players.filter((p: { self: boolean }) => p.self).map((p: { name: string }) => p.name)).toEqual([
      players[0].user.name,
    ]);
    expect(second.players.filter((p: { self: boolean }) => p.self).map((p: { name: string }) => p.name)).toEqual([
      players[7].user.name,
    ]);
    expect(second.inviteScope).toBe("self");
    expect(first.inviteScope).toBe("missing");

    // A write always asks the bot, and the next read shows what it did.
    mockSession.mockResolvedValue(players[0].session);
    await POST(lobbyRequest({ kind: "inhouse", id: lobby.id, action: "create" }));
    expect((await read(players[3])).status.state).toBe("creating");
    expect(botCalls.map((c) => c.action)).toEqual(["status", "create"]);

    // The worker's bounded read always asks the bot.
    const rows = await prisma.inhouseLobbyPlayer.findMany({
      where: { lobbyId: lobby.id },
      include: { user: true },
    });
    await inhouseBotGameStatus({ id: lobby.id, radiantTeam: 1, players: rows });
    expect(botCalls.map((c) => c.action)).toEqual(["status", "create", "status"]);
  });
});
