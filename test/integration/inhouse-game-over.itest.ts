import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import {
  INHOUSE,
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_STATUS,
} from "@/lib/constants";
import { effectiveDotaAccountId } from "@/lib/dota-account";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { inhouseLobbyCode } from "@/lib/inhouse";
import {
  inhouseEloDeltasFor,
  summarizeInhouse,
  toFinishedLobby,
} from "@/lib/inhouse-stats";
import { abandonedReason, adminCancelReason } from "@/lib/inhouse-end-reason";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import {
  acceptMatch,
  autoDetectResult,
  cancelLobby,
  giveUpOnResult,
  finishGame,
  getInhouseState,
  joinQueue,
  maybeAutoDetectResult,
  recordMatch,
  resolveAbandonedLobby,
  setInhouseRoles,
} from "@/lib/inhouse-service";
import { makeSeason, makeUser, raceAll, sessionFor } from "./factories";

// "Game over" (finishGame → AWAITING_RESULT) and inhouse positions. OpenDota
// is stubbed at its two network calls (recent-match lists and one match), the
// Discord sender is stubbed, and the lobby bot, when a test needs it, is a
// stubbed relay behind global fetch — the inhouse-bot-result pattern.
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

// logAdminAction resolves its actor from the session; there is no cookie jar
// here, so without this the audit write is swallowed and no row exists.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSessionUser: vi.fn(async () => null) };
});

const mockRecent = vi.mocked(fetchRecentMatchIds);
const mockMatch = vi.mocked(fetchOpenDotaMatch);
const mockSession = vi.mocked(getSessionUser);

// A staged rival for the one interleaving no seam reaches: an admin's LIVE
// cancel reads the lobby, a "Game over" commits, then the cancel claims. The
// read of the ten players (to requeue them) sits between cancelLobby's
// lobby read and its claim, outside any transaction, so the rival runs there.
let beforeCancelPlayersRead: (() => Promise<void>) | null = null;
prisma.$use(async (params, next) => {
  const args = params.args as
    | { where?: { lobbyId?: unknown }; select?: { queuedAt?: unknown } }
    | undefined;
  if (
    beforeCancelPlayersRead &&
    params.model === "InhouseLobbyPlayer" &&
    params.action === "findMany" &&
    typeof args?.where?.lobbyId === "string" &&
    args?.select?.queuedAt === true
  ) {
    const rival = beforeCancelPlayersRead;
    beforeCancelPlayersRead = null;
    await rival();
  }
  return next(params);
});

beforeEach(() => {
  mockRecent.mockReset();
  mockMatch.mockReset();
  mockRecent.mockResolvedValue([]);
  mockMatch.mockResolvedValue(null);
  mockSession.mockReset();
  mockSession.mockResolvedValue(null);
  botCalls.length = 0;
});
afterEach(() => {
  setRaceHook(null);
  beforeCancelPlayersRead = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---- helpers ---------------------------------------------------------------

const MIN = 60_000;
const HOUR = 3_600_000;
const WHICH_GAME =
  "Two games are live. Reload the page and use that game's own controls.";
const NO_GAME_TO_FINISH = "There's no game being played to mark over";

type Player = {
  user: Awaited<ReturnType<typeof makeUser>>;
  session: SessionUser;
};

async function makePlayers(count: number, prefix: string): Promise<Player[]> {
  const out: Player[] = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser(`${prefix}${i}`);
    out.push({ user, session: sessionFor(user) });
  }
  return out;
}

async function makeAdmin(name = "Game-over admin") {
  const user = await makeUser(name, "ADMIN");
  const session = sessionFor(user);
  mockSession.mockResolvedValue(session);
  return session;
}

/**
 * A game being played, built straight into its slot (the draft is not what
 * these tests are about): the first five are team 1 (Radiant). Formed an hour
 * ago by default, so its result scan window — and with it "Game over" — is
 * open.
 */
async function playedLobby(
  players: Player[],
  opts: {
    status?: "READY" | "IN_PROGRESS";
    slot?: number;
    formedMinutesAgo?: number;
    startedMinutesAgo?: number;
  } = {},
) {
  const status = opts.status ?? INHOUSE_STATUS.IN_PROGRESS;
  const formed = opts.formedMinutesAgo ?? 60;
  const started = opts.startedMinutesAgo ?? Math.max(0, formed - 10);
  const now = Date.now();
  return prisma.inhouseLobby.create({
    data: {
      status,
      slot: opts.slot ?? 1,
      radiantTeam: 1,
      createdAt: new Date(now - formed * MIN),
      startedAt:
        status === INHOUSE_STATUS.IN_PROGRESS
          ? new Date(now - started * MIN)
          : null,
      players: {
        create: players.map((p, i) => ({
          userId: p.user.id,
          team: i < INHOUSE.TEAM_SIZE ? 1 : 2,
          isCaptain: i === 0 || i === INHOUSE.TEAM_SIZE,
          mmr: 3000,
          queuedAt: new Date(now - formed * MIN - MIN + i),
        })),
      },
    },
    include: { players: true },
  });
}

/** Team 1's and team 2's Dota account ids, as playedLobby seats them. */
function sides(players: Player[]) {
  const accounts = players.map((p) => effectiveDotaAccountId(p.user)!);
  return {
    team1: accounts.slice(0, INHOUSE.TEAM_SIZE),
    team2: accounts.slice(INHOUSE.TEAM_SIZE),
  };
}

/** An OpenDota match with team1 on Radiant and team2 on Dire. */
function fakeMatch(opts: {
  matchId: number;
  team1: number[];
  team2: number[];
  radiantWin: boolean;
  startTime: number;
}) {
  const line = (
    accountId: number,
    slot: number,
    isRadiant: boolean,
    i: number,
  ) => ({
    account_id: accountId,
    player_slot: slot,
    hero_id: i + 1,
    isRadiant,
    kills: isRadiant ? 10 : 3,
    deaths: isRadiant ? 3 : 10,
    assists: 8,
    personaname: `p${accountId}`,
    net_worth: 20000 - i * 500,
    gold_per_min: 500,
    last_hits: 200,
  });
  return {
    match_id: opts.matchId,
    radiant_win: opts.radiantWin,
    duration: 2400,
    start_time: opts.startTime,
    radiant_score: 30,
    dire_score: 20,
    players: [
      ...opts.team1.map((a, i) => line(a, i, true, i)),
      ...opts.team2.map((a, i) => line(a, 128 + i, false, i)),
    ],
  };
}

type FakeMatch = ReturnType<typeof fakeMatch>;

/** OpenDota knows these games, and every player's recent list has them all. */
function openDotaHas(...games: FakeMatch[]) {
  mockRecent.mockResolvedValue(games.map((g) => g.match_id));
  mockMatch.mockImplementation(
    async (id: string) =>
      (games.find((g) => String(g.match_id) === String(id)) ?? null) as never,
  );
}

const seconds = (ms: number) => Math.floor(ms / 1000);

const lobbyRow = (id: string) =>
  prisma.inhouseLobby.findUniqueOrThrow({ where: { id } });

/** The lobby this player is in among the live ones (status + slot). */
const liveLobbyOf = (userId: string) =>
  prisma.inhouseLobby.findFirst({
    where: {
      status: { in: INHOUSE_ACTIVE_STATUSES },
      players: { some: { userId } },
    },
    include: { players: true },
  });

/**
 * "Run it back": a member presses Game over with requeue, the other nine
 * join, and the ten form their next game (READY_CHECK) while the first waits
 * on OpenDota.
 */
async function runItBack(players: Player[], lobbyId: string) {
  expect(
    await finishGame(players[0].session, lobbyId, { requeue: true }),
  ).toEqual({ ok: true });
  for (const p of players.slice(1)) {
    expect(await joinQueue(p.session, 3000)).toEqual({ ok: true });
  }
  const next = await liveLobbyOf(players[0].user.id);
  expect(next).not.toBeNull();
  return next!;
}

/**
 * Lock a freshly formed lobby's teams exactly as `like`'s, sides and all: the
 * same ten in a rematch, which is when the previous game's scan could pick
 * the next game up (it passes every roster check).
 */
async function lockTeamsLike(
  lobbyId: string,
  like: { players: { userId: string; team: number | null; isCaptain: boolean }[] },
) {
  for (const p of like.players) {
    // Teams lock only after everyone accepted the ready check.
    await prisma.inhouseLobbyPlayer.updateMany({
      where: { lobbyId, userId: p.userId },
      data: { team: p.team, isCaptain: p.isCaptain, acceptedAt: new Date() },
    });
  }
  await prisma.inhouseLobby.update({
    where: { id: lobbyId },
    data: { status: INHOUSE_STATUS.READY, pickTeam: null, pickEndsAt: null },
  });
}

// ---- lobby bot stub ----------------------------------------------------------

const BOT_ORIGIN = "http://127.0.0.1:8090";
const keyPrefix = LEAGUE_CONFIG.region === "eu" ? "eu:" : "";
const botCalls: { action: string; spec: { key: string } }[] = [];

/** The relay answers every status read with `reply`, or fails with it. */
function stubBot(reply: { state: string; matchId?: string } | Error) {
  vi.stubEnv("DOTA_LOBBY_BOT_URL", BOT_ORIGIN);
  vi.stubEnv("DOTA_LOBBY_BOT_SECRET", "test-game-over-secret-".repeat(3));
  vi.stubEnv("DOTA_INHOUSE_LEAGUE_ID", "54321");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      botCalls.push(JSON.parse(String(init.body)));
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

// ---------------------------------------------------------------------------

describe("inhouse Game over — marking a game over", () => {
  it.each([INHOUSE_STATUS.IN_PROGRESS, INHOUSE_STATUS.READY] as const)(
    "a player moves a %s game past its scan window to AWAITING_RESULT, stamped once",
    async (status) => {
      const players = await makePlayers(INHOUSE.LOBBY_SIZE, `GO-${status}-`);
      const lobby = await playedLobby(players, { status });

      const before = Date.now();
      expect(await finishGame(players[3].session, lobby.id)).toEqual({
        ok: true,
      });
      const after = Date.now();
      const done = await lobbyRow(lobby.id);
      expect(done.status).toBe(INHOUSE_STATUS.AWAITING_RESULT);
      expect(done.finishedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(done.finishedAt!.getTime()).toBeLessThanOrEqual(after);
      // Not a result: nothing about the outcome is written.
      expect(done.winnerTeam).toBeNull();
      expect(done.completedAt).toBeNull();
      expect(done.dotaMatchId).toBeNull();
      // Without requeue nobody is queued.
      expect(await prisma.inhouseQueueEntry.count()).toBe(0);

      // A second press finds the game already over: the same answer as
      // losing the claim (ok, and queued if asked), and the stamp never moves.
      expect(await finishGame(players[4].session, lobby.id)).toEqual({
        ok: true,
      });
      expect(await prisma.inhouseQueueEntry.count()).toBe(0);
      expect(
        await finishGame(players[5].session, lobby.id, { requeue: true }),
      ).toEqual({ ok: true });
      expect(
        await prisma.inhouseQueueEntry.count({
          where: { userId: players[5].user.id },
        }),
      ).toBe(1);
      expect((await lobbyRow(lobby.id)).finishedAt).toEqual(done.finishedAt);
      // Someone who wasn't in it still finds nothing to mark over.
      const outsider = (await makePlayers(1, `GO-${status}-out-`))[0];
      expect(await finishGame(outsider.session, lobby.id)).toEqual({
        ok: false,
        error: NO_GAME_TO_FINISH,
      });
    },
  );

  it("two players pressing it together mark the game over once", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-twice-");
    const lobby = await playedLobby(players);
    const pressers = [players[0], players[6]];

    const results = await raceAll(
      pressers.map(
        (p) => () => finishGame(p.session, lobby.id, { requeue: true }),
      ),
    );
    // Either both got in before the claim (the loser still requeues: the
    // game is over either way) or the second found it already over.
    expect(results).toContainEqual({ ok: true });
    for (const r of results) {
      expect([{ ok: true }, { ok: false, error: NO_GAME_TO_FINISH }]).toContainEqual(r);
    }
    const done = await lobbyRow(lobby.id);
    expect(done.status).toBe(INHOUSE_STATUS.AWAITING_RESULT);
    expect(done.finishedAt).not.toBeNull();
    const queued = new Set(
      (await prisma.inhouseQueueEntry.findMany()).map((q) => q.userId),
    );
    pressers.forEach((p, i) =>
      expect(queued.has(p.user.id)).toBe(results[i].ok),
    );
  });

  it("refuses a player who isn't in the game; an admin may press it and is never queued", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-who-");
    const lobby = await playedLobby(players);
    const outsider = sessionFor(await makeUser("GO outsider"));

    expect(await finishGame(outsider, lobby.id)).toEqual({
      ok: false,
      error: "Only players in the game can mark it over",
    });
    // Without a lobby id an outsider is judged against the one live game.
    expect(await finishGame(outsider)).toEqual({
      ok: false,
      error: "Only players in the game can mark it over",
    });
    expect((await lobbyRow(lobby.id)).status).toBe(INHOUSE_STATUS.IN_PROGRESS);

    const admin = await makeAdmin();
    expect(await finishGame(admin, lobby.id, { requeue: true })).toEqual({
      ok: true,
    });
    expect((await lobbyRow(lobby.id)).status).toBe(
      INHOUSE_STATUS.AWAITING_RESULT,
    );
    // requeue is for the game's own players: the admin played in nothing.
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
  });

  it("refuses before the result scan window opens, and says how long to wait", async () => {
    const ready = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-early-r-");
    const started = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-early-s-");
    // Teams just locked (READY opens DETECT_READY_MIN_MINUTES after
    // formation), and a game just started (IN_PROGRESS opens
    // DETECT_MIN_MINUTES after Start).
    const readyLobby = await playedLobby(ready, {
      status: "READY",
      formedMinutesAgo: 0,
    });
    const startedLobby = await playedLobby(started, {
      status: "IN_PROGRESS",
      slot: 2,
      formedMinutesAgo: 0,
      startedMinutesAgo: 0,
    });

    expect(await finishGame(ready[0].session, readyLobby.id)).toEqual({
      ok: false,
      error: `Too early to mark this game over: try again in ${INHOUSE.DETECT_READY_MIN_MINUTES} min.`,
    });
    expect(await finishGame(started[0].session, startedLobby.id)).toEqual({
      ok: false,
      error: `Too early to mark this game over: try again in ${INHOUSE.DETECT_MIN_MINUTES} min.`,
    });
    // An admin is held to the same floor.
    const admin = await makeAdmin();
    expect(
      (await finishGame(admin, readyLobby.id)) as { ok: false; error: string },
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^Too early/) });
    expect((await lobbyRow(readyLobby.id)).status).toBe(INHOUSE_STATUS.READY);
    expect((await lobbyRow(startedLobby.id)).status).toBe(
      INHOUSE_STATUS.IN_PROGRESS,
    );

    // One minute past the floor it goes through.
    await prisma.inhouseLobby.update({
      where: { id: readyLobby.id },
      data: {
        createdAt: new Date(
          Date.now() - (INHOUSE.DETECT_READY_MIN_MINUTES + 1) * MIN,
        ),
      },
    });
    expect(await finishGame(ready[0].session, readyLobby.id)).toEqual({
      ok: true,
    });
  });

  it.each(["creating", "ready", "starting"])(
    "waits while the lobby bot holds the game's Dota lobby unlaunched (%s)",
    async (state) => {
      const players = await makePlayers(INHOUSE.LOBBY_SIZE, `GO-bot-${state}-`);
      const lobby = await playedLobby(players);
      stubBot({ state });

      expect(await finishGame(players[0].session, lobby.id)).toEqual({
        ok: false,
        error:
          "The lobby bot is still holding this game's Dota lobby. A captain can press “Start game with bot” or “Release bot…” in the bot panel, then mark the game over.",
      });
      expect(await lobbyRow(lobby.id)).toMatchObject({
        status: INHOUSE_STATUS.IN_PROGRESS,
        finishedAt: null,
      });
      // One read-only status call, for THIS game's bot job.
      expect(botCalls).toHaveLength(1);
      expect(botCalls[0].action).toBe("status");
      expect(botCalls[0].spec.key).toBe(`${keyPrefix}inhouse:${lobby.id}:1`);
    },
  );

  it.each([
    ["it launched the game", { state: "started", matchId: "7400000001" }],
    ["it holds nothing", { state: "idle" }],
    ["it released the lobby", { state: "released" }],
    // Also what an offline-from-Steam bot reports, when Release can't work
    // either; admin recovery can let it go once the game is marked over.
    ["it reports blocked", { state: "blocked" }],
    ["it can't be reached", new Error("connect ECONNREFUSED")],
  ] as const)(
    "goes ahead when the bot doesn't hold an unlaunched lobby (%s)",
    async (_label, reply) => {
      const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-bot-ok-");
      const lobby = await playedLobby(players);
      stubBot(reply instanceof Error ? reply : { ...reply });

      expect(await finishGame(players[0].session, lobby.id)).toEqual({
        ok: true,
      });
      expect((await lobbyRow(lobby.id)).status).toBe(
        INHOUSE_STATUS.AWAITING_RESULT,
      );
      expect(botCalls).toHaveLength(1);
    },
  );

  it("frees the slot and the ten at once: requeue queues the presser, the nine can join, and ten form the next game beside it", async () => {
    const group = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-requeue-a-");
    const other = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-requeue-c-");
    // Both slots are taken: game 1 (being played) and game 2.
    const game1 = await playedLobby(group, { slot: 1 });
    const game2 = await playedLobby(other, {
      status: "READY",
      slot: 2,
      formedMinutesAgo: 1,
    });

    // While game 1 is live its players can't queue for the next one.
    expect(await joinQueue(group[1].session, 3000)).toEqual({
      ok: false,
      error: "You're already in a live inhouse",
    });

    expect(
      await finishGame(group[0].session, game1.id, { requeue: true }),
    ).toEqual({ ok: true });
    const queued = await prisma.inhouseQueueEntry.findMany();
    expect(queued.map((q) => q.userId)).toEqual([group[0].user.id]);
    // Their stored MMR came along (the lobby snapshot), not the 0 the press sent.
    expect(queued[0].mmr).toBe(3000);

    for (const p of group.slice(1)) {
      expect(await joinQueue(p.session, 3000)).toEqual({ ok: true });
    }
    // The tenth join formed the next game in the freed slot 1, while game 1
    // still waits for its result and game 2 never moved.
    const live = await prisma.inhouseLobby.findMany({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      orderBy: { slot: "asc" },
      include: { players: true },
    });
    expect(live.map((l) => l.slot)).toEqual([1, 2]);
    const next = live[0];
    expect(next.id).not.toBe(game1.id);
    expect(next.status).toBe(INHOUSE_STATUS.READY_CHECK);
    expect(new Set(next.players.map((p) => p.userId))).toEqual(
      new Set(group.map((p) => p.user.id)),
    );
    expect(live[1].id).toBe(game2.id);
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
    expect(await lobbyRow(game1.id)).toMatchObject({
      status: INHOUSE_STATUS.AWAITING_RESULT,
      slot: 1,
    });

    // The ten are in two lobbies now (one marked over, one live); the live
    // game's own actions find the live one without being told.
    for (const p of group) {
      expect(await acceptMatch(p.session)).toEqual({ ok: true });
    }
    expect((await lobbyRow(next.id)).status).toBe(INHOUSE_STATUS.CAPTAIN_VOTE);
    expect((await lobbyRow(game1.id)).status).toBe(
      INHOUSE_STATUS.AWAITING_RESULT,
    );
  });
});

describe("inhouse Game over — the result is held to its own game", () => {
  /**
   * The same ten mark game A over and run it back as game B, sides and all.
   * OpenDota has both: A's game (started after A formed, before Game over)
   * and B's (started after Game over) — the newest shared game, which is
   * what an un-ceilinged scan of A would take.
   */
  async function rematch(prefix: string) {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, prefix);
    const a = await playedLobby(players);
    const b = await runItBack(players, a.id);
    await lockTeamsLike(b.id, a);
    const { team1, team2 } = sides(players);
    const aGame = fakeMatch({
      matchId: 7400000101,
      team1,
      team2,
      radiantWin: true,
      startTime: seconds(a.createdAt.getTime()) + 12 * 60,
    });
    const bGame = fakeMatch({
      matchId: 7400000102,
      team1,
      team2,
      radiantWin: false,
      startTime: seconds(Date.now()) + 60,
    });
    openDotaHas(aGame, bGame);
    return { players, a, b, aGame, bGame };
  }

  it("the automatic scan records A's own game, never the rematch its ten are playing", async () => {
    const { players, a, b, aGame, bGame } = await rematch("GO-ceil-scan-");
    expect((await lobbyRow(a.id)).finishedAt).not.toBeNull();

    expect(await maybeAutoDetectResult()).toBe(true);
    expect(await lobbyRow(a.id)).toMatchObject({
      status: INHOUSE_STATUS.COMPLETED,
      dotaMatchId: String(aGame.match_id),
      winnerTeam: 1,
    });
    // B's own window hasn't opened, so the pass left it alone.
    expect(await lobbyRow(b.id)).toMatchObject({
      status: INHOUSE_STATUS.READY,
      dotaMatchId: null,
      detectedAt: null,
    });

    // B records its own game later, and it is not "already recorded".
    expect(
      await recordMatch(players[2].session, String(bGame.match_id), b.id),
    ).toEqual({ ok: true });
    expect(await lobbyRow(b.id)).toMatchObject({
      status: INHOUSE_STATUS.COMPLETED,
      dotaMatchId: String(bGame.match_id),
      winnerTeam: 2,
    });
  });

  it("Check now on the marked-over game finds its own game too", async () => {
    const { players, a, b, aGame, bGame } = await rematch("GO-ceil-check-");

    expect(await autoDetectResult(players[3].session, a.id)).toEqual({
      ok: true,
    });
    expect(await lobbyRow(a.id)).toMatchObject({
      status: INHOUSE_STATUS.COMPLETED,
      dotaMatchId: String(aGame.match_id),
    });
    expect(await autoDetectResult(players[4].session, b.id)).toEqual({
      ok: true,
    });
    expect((await lobbyRow(b.id)).dotaMatchId).toBe(String(bGame.match_id));
  });

  it("a pasted id for the next game is refused on the marked-over one, and each game takes its own", async () => {
    const { players, a, b, aGame, bGame } = await rematch("GO-ceil-paste-");

    expect(
      await recordMatch(players[1].session, String(bGame.match_id), a.id),
    ).toEqual({
      ok: false,
      error:
        "That match started after these players' next game formed — is it that game?",
    });
    // The floor still guards the other side: A's game predates B.
    expect(
      await recordMatch(players[5].session, String(aGame.match_id), b.id),
    ).toEqual({
      ok: false,
      error: "That match started before this lobby formed — wrong game?",
    });
    expect((await lobbyRow(a.id)).status).toBe(INHOUSE_STATUS.AWAITING_RESULT);
    expect((await lobbyRow(b.id)).status).toBe(INHOUSE_STATUS.READY);

    expect(
      await recordMatch(players[2].session, String(aGame.match_id), a.id),
    ).toEqual({ ok: true });
    expect(
      await recordMatch(players[4].session, String(bGame.match_id), b.id),
    ).toEqual({ ok: true });
    const done = await prisma.inhouseLobby.findMany({
      where: { id: { in: [a.id, b.id] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, dotaMatchId: true },
    });
    expect(done).toEqual([
      {
        id: a.id,
        status: INHOUSE_STATUS.COMPLETED,
        dotaMatchId: String(aGame.match_id),
      },
      {
        id: b.id,
        status: INHOUSE_STATUS.COMPLETED,
        dotaMatchId: String(bGame.match_id),
      },
    ]);
  });
});

describe("inhouse Game over — a press made too early", () => {
  it("still records the real game that started after the press, while no next game has formed", async () => {
    // A hand-hosted game marked over during set-up (its scan window open, its
    // Dota match not yet started): the ceiling is the players' NEXT game, not
    // the press, so the real game still records.
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-early-");
    const lobby = await playedLobby(players, {
      status: INHOUSE_STATUS.READY,
      formedMinutesAgo: 20,
    });
    expect(await finishGame(players[1].session, lobby.id)).toEqual({
      ok: true,
    });
    const { team1, team2 } = sides(players);
    const real = fakeMatch({
      matchId: 7400000201,
      team1,
      team2,
      radiantWin: true,
      startTime: seconds(Date.now()) + 5 * 60,
    });
    openDotaHas(real);
    expect(await autoDetectResult(players[2].session, lobby.id)).toEqual({
      ok: true,
    });
    expect(await lobbyRow(lobby.id)).toMatchObject({
      status: INHOUSE_STATUS.COMPLETED,
      dotaMatchId: String(real.match_id),
    });
  });

  it("is held by a next game only once it passes its ready check", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-early-rc-");
    const a = await playedLobby(players);
    // The ten form their next game, but it is still in its ready check (or
    // failed it): it never played, so it sets no ceiling, and a match started
    // after its formation is still A's to take.
    const b = await runItBack(players, a.id);
    expect((await lobbyRow(b.id)).status).toBe(INHOUSE_STATUS.READY_CHECK);
    const { team1, team2 } = sides(players);
    const late = fakeMatch({
      matchId: 7400000202,
      team1,
      team2,
      radiantWin: false,
      startTime: seconds(Date.now()) + 60,
    });
    openDotaHas(late);
    expect(
      await recordMatch(players[3].session, String(late.match_id), a.id),
    ).toEqual({ ok: true });
    expect((await lobbyRow(a.id)).dotaMatchId).toBe(String(late.match_id));
  });
});

describe("inhouse Game over — the result and its Elo", () => {
  const history = () =>
    prisma.inhouseLobby.findMany({
      where: { status: INHOUSE_STATUS.COMPLETED },
      select: {
        id: true,
        winnerTeam: true,
        createdAt: true,
        players: {
          select: {
            userId: true,
            team: true,
            user: { select: { name: true, avatar: true } },
          },
        },
      },
    });

  it("a result landing on a marked-over game completes it with its Elo stamp and announcement", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-result-");
    const lobby = await playedLobby(players);
    expect(await finishGame(players[0].session, lobby.id)).toEqual({
      ok: true,
    });
    const marked = await lobbyRow(lobby.id);
    const { team1, team2 } = sides(players);
    openDotaHas(
      fakeMatch({
        matchId: 7400000201,
        team1,
        team2,
        radiantWin: true,
        startTime: seconds(lobby.createdAt.getTime()) + 600,
      }),
    );

    expect(await recordMatch(players[1].session, "7400000201")).toEqual({
      ok: true,
    });
    const done = await lobbyRow(lobby.id);
    expect(done).toMatchObject({
      status: INHOUSE_STATUS.COMPLETED,
      winnerTeam: 1,
      dotaMatchId: "7400000201",
      // The Game over stamp stays: it is when the game was over.
      finishedAt: marked.finishedAt,
    });
    expect(done.completedAt).not.toBeNull();
    const deltas = JSON.parse(done.eloDeltas) as Record<string, number>;
    expect(Object.keys(deltas)).toHaveLength(INHOUSE.LOBBY_SIZE);
    for (const [i, p] of players.entries()) {
      expect(deltas[p.user.id]).toBe(i < INHOUSE.TEAM_SIZE ? 16 : -16);
    }
    expect(
      await prisma.inhouseAnnouncement.count({ where: { lobbyId: lobby.id } }),
    ).toBe(1);

    // The room drops the pending row and shows the result banner.
    const view = await getInhouseState(players[1].session, {
      runMaintenance: false,
      syncBoard: false,
    });
    expect(view.pendingResults).toEqual([]);
    expect(view.lastResult).toMatchObject({
      lobbyId: lobby.id,
      myTeamWon: true,
      eloDelta: 16,
    });
  });

  it("stamps the older game's own swing when the later game its players share completes first", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-elo-");
    const a = await playedLobby(players);
    const b = await runItBack(players, a.id);
    await lockTeamsLike(b.id, a);
    const { team1, team2 } = sides(players);
    // A: team 1 wins. B (the rematch): team 2 wins.
    openDotaHas(
      fakeMatch({
        matchId: 7400000301,
        team1,
        team2,
        radiantWin: true,
        startTime: seconds(a.createdAt.getTime()) + 600,
      }),
      fakeMatch({
        matchId: 7400000302,
        team1,
        team2,
        radiantWin: false,
        startTime: seconds(Date.now()) + 60,
      }),
    );

    // B's result lands first (A's is still on its way), then A's.
    expect(await recordMatch(players[1].session, "7400000302", b.id)).toEqual({
      ok: true,
    });
    expect(await recordMatch(players[2].session, "7400000301", a.id)).toEqual({
      ok: true,
    });

    const rows = await history();
    const aDeltas = JSON.parse((await lobbyRow(a.id)).eloDeltas) as Record<
      string,
      number
    >;
    const bDeltas = JSON.parse((await lobbyRow(b.id)).eloDeltas) as Record<
      string,
      number
    >;
    // A's stamp is A's own swing, rated through A only (A formed first)...
    expect(aDeltas).toEqual(
      inhouseEloDeltasFor(rows.map(toFinishedLobby), a.id),
    );
    // ...which, from an even start, is ±16 with team 1 winning.
    for (const [i, p] of players.entries()) {
      expect(aDeltas[p.user.id]).toBe(i < INHOUSE.TEAM_SIZE ? 16 : -16);
    }
    // The ladder's lastChange is B's swing rated after A (team 2, the lower
    // side, beats team 1): A must not carry it.
    const ladder = new Map(
      summarizeInhouse(rows.map(toFinishedLobby)).map((r) => [
        r.userId,
        r.lastChange,
      ]),
    );
    for (const [i, p] of players.entries()) {
      expect(ladder.get(p.user.id)).toBe(i < INHOUSE.TEAM_SIZE ? -17 : 17);
      expect(aDeltas[p.user.id]).not.toBe(ladder.get(p.user.id));
    }
    // B kept the stamp it got without A (accepted drift, like a void).
    for (const [i, p] of players.entries()) {
      expect(bDeltas[p.user.id]).toBe(i < INHOUSE.TEAM_SIZE ? -16 : 16);
    }
  });
});

describe("inhouse Game over — giving up on a result", () => {
  it("the abandon sweep gives up only ABANDON_AWAITING_RESULT_HOURS after Game over, and queues nobody", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-sweep-");
    // Started long enough ago that the IN_PROGRESS floor would have fired:
    // a game marked over runs from its finish, not its start.
    const lobby = await playedLobby(players, {
      formedMinutesAgo: 9 * 60,
      startedMinutesAgo: 8 * 60,
    });
    expect(await finishGame(players[0].session, lobby.id)).toEqual({
      ok: true,
    });
    // One of the ten queued again for the next game.
    expect(await joinQueue(players[1].session, 3000)).toEqual({ ok: true });
    const queuedBefore = await prisma.inhouseQueueEntry.findMany();

    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        finishedAt: new Date(
          Date.now() - INHOUSE.ABANDON_AWAITING_RESULT_HOURS * HOUR + 10 * MIN,
        ),
      },
    });
    expect(await resolveAbandonedLobby()).toBe(false);
    expect((await lobbyRow(lobby.id)).status).toBe(
      INHOUSE_STATUS.AWAITING_RESULT,
    );

    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        finishedAt: new Date(
          Date.now() - INHOUSE.ABANDON_AWAITING_RESULT_HOURS * HOUR - MIN,
        ),
      },
    });
    expect(await resolveAbandonedLobby()).toBe(true);
    const gaveUp = await lobbyRow(lobby.id);
    expect(gaveUp.status).toBe(INHOUSE_STATUS.CANCELLED);
    expect(gaveUp.endReason).toBe(
      abandonedReason(INHOUSE_STATUS.AWAITING_RESULT),
    );
    expect(gaveUp.endReason).toBe(
      `No result on OpenDota ${INHOUSE.ABANDON_AWAITING_RESULT_HOURS}h after the game ended`,
    );
    // Nobody was requeued, and the one who queued themselves is untouched.
    expect(await prisma.inhouseQueueEntry.findMany()).toEqual(queuedBefore);
    // A second sweep finds nothing.
    expect(await resolveAbandonedLobby()).toBe(false);
  });

  it("an admin gives up on a marked-over game: CANCELLED with its reason, logged, and nobody requeued", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-giveup-");
    const a = await playedLobby(players);
    const b = await runItBack(players, a.id);
    const admin = await makeAdmin("Give-up admin");

    // Giving up can't be undone, so it takes a named game: a cancel naming
    // none reaches live games only (here B, the one live game), never A.
    const unnamed = await prisma.inhouseLobby.findMany({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      select: { id: true },
    });
    expect(unnamed.map((l) => l.id)).toEqual([b.id]);

    // A plain cancel never gives up on a result: it refuses and names the
    // give-up, its own action.
    expect(await cancelLobby(admin, a.id)).toEqual({
      ok: false,
      error: `That game was just marked over, so its players are free already. To give up on its result, use "Admin: give up on #${inhouseLobbyCode(a.id)}'s result".`,
    });
    expect((await lobbyRow(a.id)).status).toBe(INHOUSE_STATUS.AWAITING_RESULT);
    // The give-up names its game.
    expect(await giveUpOnResult(admin)).toEqual({
      ok: false,
      error: "Name the game to give up on",
    });

    expect(await giveUpOnResult(admin, a.id)).toEqual({ ok: true });
    const gaveUp = await lobbyRow(a.id);
    expect(gaveUp.status).toBe(INHOUSE_STATUS.CANCELLED);
    expect(gaveUp.endReason).toBe(
      adminCancelReason(admin.name, INHOUSE_STATUS.AWAITING_RESULT),
    );
    expect(gaveUp.endReason).toBe(
      "Cancelled by admin Give-up admin while waiting for the result",
    );
    const log = await prisma.adminAction.findMany();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      action: "cancelLobby",
      actorId: admin.id,
      summary: `Gave up on the result of inhouse #${inhouseLobbyCode(a.id)} (marked over; nobody requeued)`,
    });
    // Its ten are in the next game; a queue row would put them in two places.
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
    const next = await lobbyRow(b.id);
    expect(next.status).toBe(INHOUSE_STATUS.READY_CHECK);
    expect(
      await prisma.inhouseLobbyPlayer.count({ where: { lobbyId: b.id } }),
    ).toBe(INHOUSE.LOBBY_SIZE);

    // Nothing left to give up on.
    expect(await giveUpOnResult(admin, a.id)).toEqual({
      ok: false,
      error: "That game's result isn't pending",
    });
  });

  it("a player can't give up on their own game's result", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-giveup-p-");
    const lobby = await playedLobby(players);
    expect(await finishGame(players[0].session, lobby.id)).toEqual({
      ok: true,
    });
    expect(await giveUpOnResult(players[0].session, lobby.id)).toEqual({
      ok: false,
      error: "Admins only",
    });
    expect((await lobbyRow(lobby.id)).status).toBe(
      INHOUSE_STATUS.AWAITING_RESULT,
    );
  });

  it("a live cancel that loses to Game over says so, requeues nobody, and a second press gives up", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-cancel-lost-");
    const lobby = await playedLobby(players);
    const admin = await makeAdmin("Late admin");

    // The cancel reads the lobby IN_PROGRESS; Game over commits before its
    // claim (staged at the cancel's roster read, outside any transaction).
    let fired = false;
    let rival: unknown = null;
    beforeCancelPlayersRead = async () => {
      fired = true;
      rival = await finishGame(players[2].session, lobby.id);
    };
    expect(await cancelLobby(admin, lobby.id)).toEqual({
      ok: false,
      error: `That game was just marked over, so its players are free already. To give up on its result, use "Admin: give up on #${inhouseLobbyCode(lobby.id)}'s result".`,
    });
    expect(fired).toBe(true);
    expect(rival).toEqual({ ok: true });
    expect((await lobbyRow(lobby.id)).status).toBe(
      INHOUSE_STATUS.AWAITING_RESULT,
    );
    // The losing cancel requeued no one and logged nothing.
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
    expect(await prisma.adminAction.count()).toBe(0);

    // A stale second cancel (the dialog left open across the press) still
    // refuses: only the give-up gives up.
    expect(await cancelLobby(admin, lobby.id)).toEqual({
      ok: false,
      error: `That game was just marked over, so its players are free already. To give up on its result, use "Admin: give up on #${inhouseLobbyCode(lobby.id)}'s result".`,
    });
    expect((await lobbyRow(lobby.id)).status).toBe(
      INHOUSE_STATUS.AWAITING_RESULT,
    );
    expect(await giveUpOnResult(admin, lobby.id)).toEqual({ ok: true });
    expect(await lobbyRow(lobby.id)).toMatchObject({
      status: INHOUSE_STATUS.CANCELLED,
      endReason: adminCancelReason(admin.name, INHOUSE_STATUS.AWAITING_RESULT),
    });
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
  });
});

// The two new guarded claims. Each seam sits OUTSIDE any transaction, so the
// rival commits on SQLite too. The `fired` flag fails a drifted label.
describe("inhouse Game over — guarded claims lose to a rival that lands first", () => {
  it("finishGame::status — a result recorded between the read and the claim keeps the game COMPLETED", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-seam-result-");
    const lobby = await playedLobby(players);
    const { team1, team2 } = sides(players);
    openDotaHas(
      fakeMatch({
        matchId: 7400000401,
        team1,
        team2,
        radiantWin: true,
        startTime: seconds(lobby.createdAt.getTime()) + 600,
      }),
    );
    let fired = false;
    let rival: unknown = null;
    setRaceHook(
      onceAt("inhouse.finishGame.beforeClaim", async () => {
        fired = true;
        rival = await recordMatch(players[1].session, "7400000401", lobby.id);
      }),
    );

    // The game is over either way, so the presser still queues.
    expect(
      await finishGame(players[0].session, lobby.id, { requeue: true }),
    ).toEqual({ ok: true });
    expect(fired).toBe(true);
    expect(rival).toEqual({ ok: true });
    const done = await lobbyRow(lobby.id);
    expect(done).toMatchObject({
      status: INHOUSE_STATUS.COMPLETED,
      dotaMatchId: "7400000401",
      finishedAt: null,
    });
    expect(Object.keys(JSON.parse(done.eloDeltas))).toHaveLength(
      INHOUSE.LOBBY_SIZE,
    );
    expect(
      (await prisma.inhouseQueueEntry.findMany()).map((q) => q.userId),
    ).toEqual([players[0].user.id]);
  });

  it("finishGame::status — an admin cancel between the read and the claim keeps the game CANCELLED with its requeue", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-seam-cancel-");
    const lobby = await playedLobby(players);
    const admin = await makeAdmin("Seam admin");
    let fired = false;
    let rival: unknown = null;
    setRaceHook(
      onceAt("inhouse.finishGame.beforeClaim", async () => {
        fired = true;
        rival = await cancelLobby(admin, lobby.id);
      }),
    );

    // The game is over either way: a presser who asked to queue again is
    // (already, by the cancel's requeue; a repeat join keeps their place).
    expect(
      await finishGame(players[0].session, lobby.id, { requeue: true }),
    ).toEqual({ ok: true });
    expect(fired).toBe(true);
    expect(rival).toEqual({ ok: true });
    expect(await lobbyRow(lobby.id)).toMatchObject({
      status: INHOUSE_STATUS.CANCELLED,
      finishedAt: null,
      endReason: adminCancelReason(admin.name, INHOUSE_STATUS.IN_PROGRESS),
    });
    // The cancel's requeue of all ten stands, and the press added nothing.
    const queued = await prisma.inhouseQueueEntry.findMany();
    expect(new Set(queued.map((q) => q.userId))).toEqual(
      new Set(players.map((p) => p.user.id)),
    );
  });

  it("a press that loses to the abandon sweep still queues a presser who asked (the sweep requeues nobody)", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-seam-sweep-");
    // Started long enough ago for the abandon sweep to tear it down.
    const lobby = await playedLobby(players, {
      formedMinutesAgo: INHOUSE.ABANDON_IN_PROGRESS_HOURS * 60 + 30,
    });
    let fired = false;
    setRaceHook(
      onceAt("inhouse.finishGame.beforeClaim", async () => {
        fired = true;
        expect(await resolveAbandonedLobby()).toBe(true);
      }),
    );

    expect(
      await finishGame(players[3].session, lobby.id, { requeue: true }),
    ).toEqual({ ok: true });
    expect(fired).toBe(true);
    expect((await lobbyRow(lobby.id)).status).toBe(INHOUSE_STATUS.CANCELLED);
    expect(
      (await prisma.inhouseQueueEntry.findMany()).map((q) => q.userId),
    ).toEqual([players[3].user.id]);
    // Without asking to queue, the press says what happened.
    expect(await finishGame(players[4].session, lobby.id)).toEqual({
      ok: false,
      error: "That game was cancelled",
    });
  });

  it("giveUpOnResult::status — a result landing between the read and the claim survives the give-up", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-seam-giveup-");
    const lobby = await playedLobby(players);
    expect(await finishGame(players[0].session, lobby.id)).toEqual({
      ok: true,
    });
    const { team1, team2 } = sides(players);
    openDotaHas(
      fakeMatch({
        matchId: 7400000501,
        team1,
        team2,
        radiantWin: false,
        startTime: seconds(lobby.createdAt.getTime()) + 600,
      }),
    );
    const admin = await makeAdmin("Give-up seam admin");
    let fired = false;
    let rival: unknown = null;
    setRaceHook(
      onceAt("inhouse.giveUpOnResult.beforeClaim", async () => {
        fired = true;
        rival = await recordMatch(players[1].session, "7400000501", lobby.id);
      }),
    );

    expect(await giveUpOnResult(admin, lobby.id)).toEqual({
      ok: false,
      error:
        "That game's result just came in, so there is nothing to give up on.",
    });
    expect(fired).toBe(true);
    expect(rival).toEqual({ ok: true });
    const done = await lobbyRow(lobby.id);
    expect(done).toMatchObject({
      status: INHOUSE_STATUS.COMPLETED,
      dotaMatchId: "7400000501",
      winnerTeam: 2,
      endReason: null,
    });
    expect(Object.keys(JSON.parse(done.eloDeltas))).toHaveLength(
      INHOUSE.LOBBY_SIZE,
    );
    // A losing give-up logs nothing.
    expect(await prisma.adminAction.count()).toBe(0);
  });
});

describe("inhouse Game over — which game an action means", () => {
  it("a player with a game marked over AND a live one must name the game for a result action", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-which-");
    const a = await playedLobby(players);
    const b = await runItBack(players, a.id);
    await lockTeamsLike(b.id, a);
    const { team1, team2 } = sides(players);
    openDotaHas(
      fakeMatch({
        matchId: 7400000601,
        team1,
        team2,
        radiantWin: true,
        startTime: seconds(a.createdAt.getTime()) + 600,
      }),
      fakeMatch({
        matchId: 7400000602,
        team1,
        team2,
        radiantWin: true,
        startTime: seconds(Date.now()) + 60,
      }),
    );

    expect(await autoDetectResult(players[0].session)).toEqual({
      ok: false,
      error: WHICH_GAME,
    });
    expect(await recordMatch(players[0].session, "7400000601")).toEqual({
      ok: false,
      error: WHICH_GAME,
    });
    // Refused before any claim: no scan stamp, no OpenDota call.
    expect((await lobbyRow(a.id)).detectedAt).toBeNull();
    expect((await lobbyRow(b.id)).detectedAt).toBeNull();
    expect(mockRecent).not.toHaveBeenCalled();
    expect(mockMatch).not.toHaveBeenCalled();
    // Game over only means a game being played: B, whose window is closed.
    expect(
      (await finishGame(players[0].session)) as { ok: false; error: string },
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^Too early/) });

    // Named, each lands on its own game.
    expect(await autoDetectResult(players[0].session, a.id)).toEqual({
      ok: true,
    });
    expect(await lobbyRow(a.id)).toMatchObject({
      status: INHOUSE_STATUS.COMPLETED,
      dotaMatchId: "7400000601",
    });
    expect(await lobbyRow(b.id)).toMatchObject({
      status: INHOUSE_STATUS.READY,
      detectedAt: null,
    });
    // With A done, B is the player's only result game again.
    expect(await recordMatch(players[0].session, "7400000602")).toEqual({
      ok: true,
    });
    expect((await lobbyRow(b.id)).dotaMatchId).toBe("7400000602");
  });
});

describe("inhouse positions", () => {
  const CHOOSE = "Choose your positions from 1 to 5.";
  const storedRoles = async (userId: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
      .inhouseRoles;

  it("setInhouseRoles stores a strict choice in the player's order and refuses anything else untouched", async () => {
    const [p] = await makePlayers(1, "GO-roles-");
    expect(await storedRoles(p.user.id)).toBeNull();

    for (const [input, stored] of [
      [["1", "3"], "1,3"],
      // Most wanted first: the order is the preference.
      [["3", "1"], "3,1"],
      [["5", "4", "3", "2", "1"], "5,4,3,2,1"],
      [[], ""],
    ] as const) {
      expect(await setInhouseRoles(p.session, input)).toEqual({ ok: true });
      expect(await storedRoles(p.user.id)).toBe(stored);
    }

    expect(await setInhouseRoles(p.session, ["2"])).toEqual({ ok: true });
    for (const junk of [
      "2",
      "1,3",
      ["0"],
      ["6"],
      ["1", "1"],
      [1],
      [" 1"],
      ["1", "2", "3", "4", "5", "1"],
      null,
      undefined,
      {},
      { 0: "1" },
    ]) {
      expect(await setInhouseRoles(p.session, junk)).toEqual({
        ok: false,
        error: CHOOSE,
      });
      expect(await storedRoles(p.user.id)).toBe("2");
    }
  });

  it("joinQueue saves roles sent with the join, refuses the join on junk, and keeps the stored choice when none are sent", async () => {
    const [a, b, c] = await makePlayers(3, "GO-roles-join-");
    expect(await joinQueue(a.session, 3000, ["4", "2"])).toEqual({ ok: true });
    expect(await storedRoles(a.user.id)).toBe("4,2");

    expect(await joinQueue(b.session, 3000, ["7"])).toEqual({
      ok: false,
      error: CHOOSE,
    });
    expect(await storedRoles(b.user.id)).toBeNull();
    expect(
      await prisma.inhouseQueueEntry.count({ where: { userId: b.user.id } }),
    ).toBe(0);

    await setInhouseRoles(c.session, ["5"]);
    expect(await joinQueue(c.session, 3000)).toEqual({ ok: true });
    expect(await storedRoles(c.user.id)).toBe("5");
    // A re-join that sends an empty choice means "none", not "unchanged".
    expect(await joinQueue(c.session, 3000, [])).toEqual({ ok: true });
    expect(await storedRoles(c.user.id)).toBe("");
  });

  it("the room shows positions live: own choice, else the newest signup with roles, else none", async () => {
    const older = await makeSeason({ name: "Older season", isActive: false });
    const newer = await makeSeason({ name: "Newer season", isActive: true });
    const [own, signup, choseNone, nothing, skipsBlank] = await makePlayers(
      5,
      "GO-roles-view-",
    );
    const register = (
      seasonId: string,
      userId: string,
      roles: string,
      createdAt: Date,
    ) =>
      prisma.registration.create({
        data: { seasonId, userId, type: "PLAYER", roles, createdAt },
      });
    const t0 = Date.now() - 30 * 24 * HOUR;
    // `own` has a signup too: their inhouse choice wins.
    await register(older.id, own.user.id, "5", new Date(t0));
    // The newest signup wins over an older one.
    await register(older.id, signup.user.id, "5", new Date(t0));
    await register(newer.id, signup.user.id, "2,3", new Date(t0 + HOUR));
    // Chose none in the inhouse: "" beats their signup's roles.
    await register(newer.id, choseNone.user.id, "1", new Date(t0));
    // The newest signup left roles blank: the latest one WITH roles stands in.
    await register(older.id, skipsBlank.user.id, "4", new Date(t0));
    await register(newer.id, skipsBlank.user.id, "", new Date(t0 + HOUR));

    await setInhouseRoles(own.session, ["1"]);
    await setInhouseRoles(choseNone.session, []);
    for (const p of [own, signup, choseNone, nothing, skipsBlank]) {
      expect(await joinQueue(p.session, 3000)).toEqual({ ok: true });
    }

    const view = async (viewer: SessionUser | null) =>
      getInhouseState(viewer, { runMaintenance: false, syncBoard: false });
    const state = await view(own.session);
    const rolesById = new Map(state.queue.map((q) => [q.userId, q.roles]));
    expect(rolesById).toEqual(
      new Map([
        [own.user.id, "1"],
        [signup.user.id, "2,3"],
        [choseNone.user.id, ""],
        [nothing.user.id, ""],
        [skipsBlank.user.id, "4"],
      ]),
    );
    // Only an own inhouse choice is a preference order; a signup's roles
    // (an unordered set) are never shown as ranked.
    const rankedById = new Map(
      state.queue.map((q) => [q.userId, q.rolesRanked]),
    );
    expect(rankedById).toEqual(
      new Map([
        [own.user.id, true],
        [signup.user.id, false],
        [choseNone.user.id, true],
        [nothing.user.id, false],
        [skipsBlank.user.id, false],
      ]),
    );

    expect(state.me.roles).toEqual({ roles: "1", source: "inhouse" });
    expect((await view(signup.session)).me.roles).toEqual({
      roles: "2,3",
      source: "signup",
    });
    expect((await view(choseNone.session)).me.roles).toEqual({
      roles: "",
      source: "inhouse",
    });
    expect((await view(nothing.session)).me.roles).toEqual({
      roles: "",
      source: "none",
    });
    expect((await view(skipsBlank.session)).me.roles).toEqual({
      roles: "4",
      source: "signup",
    });
    expect((await view(null)).me.roles).toBeNull();

    // Live: a change shows on the next read, signup fallback gone.
    await setInhouseRoles(signup.session, ["5"]);
    const after = await view(nothing.session);
    expect(after.queue.find((q) => q.userId === signup.user.id)?.roles).toBe(
      "5",
    );
  });

  it("a lobby's players show their positions live, mid-game", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-roles-lobby-");
    const season = await makeSeason({ name: "Roles season" });
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: players[1].user.id,
        type: "PLAYER",
        roles: "3",
      },
    });
    await setInhouseRoles(players[0].session, ["1", "2"]);
    await playedLobby(players);

    const view = async () =>
      getInhouseState(players[9].session, {
        runMaintenance: false,
        syncBoard: false,
      });
    const rolesIn = (state: Awaited<ReturnType<typeof view>>) =>
      new Map(
        state
          .lobby!.teams.flatMap((t) => [
            ...(t.captain ? [t.captain] : []),
            ...t.players,
          ])
          .map((p) => [p.userId, p.roles]),
      );

    const before = rolesIn(await view());
    expect(before.size).toBe(INHOUSE.LOBBY_SIZE);
    expect(before.get(players[0].user.id)).toBe("1,2");
    expect(before.get(players[1].user.id)).toBe("3");
    expect(before.get(players[2].user.id)).toBe("");

    await setInhouseRoles(players[2].session, ["4"]);
    await setInhouseRoles(players[1].session, []);
    const after = rolesIn(await view());
    expect(after.get(players[2].user.id)).toBe("4");
    expect(after.get(players[1].user.id)).toBe("");
  });
});

describe("inhouse Game over — the room's pending results", () => {
  it("shows a marked-over game to its own players and admins only, never as a live game", async () => {
    const players = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-pending-");
    const others = await makePlayers(INHOUSE.LOBBY_SIZE, "GO-pending-c-");
    const lobby = await playedLobby(players);
    const live = await playedLobby(others, { status: "READY", slot: 2 });
    const outsider = sessionFor(await makeUser("GO pending outsider"));
    const admin = await makeAdmin("Pending admin");
    const view = (viewer: SessionUser | null) =>
      getInhouseState(viewer, { runMaintenance: false, syncBoard: false });

    // Before: the game's players (and only they, of these) may press it.
    const playing = await view(players[1].session);
    expect(playing.lobby?.id).toBe(lobby.id);
    expect(playing.me.canFinish).toBe(true);
    expect((await view(outsider)).me.canFinish).toBe(false);

    expect(await finishGame(players[0].session, lobby.id)).toEqual({
      ok: true,
    });
    const finishedAt = (await lobbyRow(lobby.id)).finishedAt!.getTime();
    const names = (from: number, to: number) =>
      players
        .slice(from, to)
        .map((p) => p.user.name)
        .sort();
    const sorted = (s: { isRadiant: boolean; names: string[] }) => ({
      ...s,
      names: [...s.names].sort(),
    });

    const mine = await view(players[1].session);
    expect(mine.lobby).toBeNull();
    expect(mine.otherLobbies.map((l) => l.id)).toEqual([live.id]);
    expect(mine.liveGames).toBe(1);
    expect(mine.me).toMatchObject({
      inLobby: false,
      canJoin: true,
      canFinish: false,
      canRecord: false,
    });
    expect(mine.pendingResults).toHaveLength(1);
    const [pending] = mine.pendingResults;
    expect({ ...pending, sides: pending.sides.map(sorted) }).toEqual({
      id: lobby.id,
      code: inhouseLobbyCode(lobby.id),
      finishedAt,
      lastCheckedAt: null,
      givesUpAt: finishedAt + INHOUSE.ABANDON_AWAITING_RESULT_HOURS * HOUR,
      sides: [
        { isRadiant: true, names: names(0, INHOUSE.TEAM_SIZE) },
        { isRadiant: false, names: names(INHOUSE.TEAM_SIZE, INHOUSE.LOBBY_SIZE) },
      ],
      mine: true,
      canRecord: true,
      canCancel: false,
    });

    // The other game's players and outsiders don't see it; nor does a
    // signed-out spectator.
    expect((await view(others[0].session)).pendingResults).toEqual([]);
    expect((await view(outsider)).pendingResults).toEqual([]);
    expect((await view(null)).pendingResults).toEqual([]);

    const forAdmin = await view(admin);
    expect(forAdmin.pendingResults).toHaveLength(1);
    expect(forAdmin.pendingResults[0]).toMatchObject({
      id: lobby.id,
      mine: false,
      canRecord: true,
      canCancel: true,
    });
    expect(
      [forAdmin.lobby?.id, ...forAdmin.otherLobbies.map((l) => l.id)],
    ).not.toContain(lobby.id);

    // The last scan shows once one ran.
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { detectedAt: new Date(finishedAt + 1000) },
    });
    expect(
      (await view(players[2].session)).pendingResults[0].lastCheckedAt,
    ).toBe(finishedAt + 1000);
  });
});
