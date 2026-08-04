import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import {
  INHOUSE,
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_STATUS,
} from "@/lib/constants";
import { summarizeInhouse } from "@/lib/inhouse-stats";
import { effectiveDotaAccountId } from "@/lib/dota-account";
import type { SessionUser } from "@/lib/auth";
import {
  acceptMatch,
  cancelLobby,
  voidLastResult,
  castVote,
  declineMatch,
  getInhouseState,
  joinQueue,
  leaveQueue,
  makePick,
  maybeAutoDetectResult,
  recordMatch,
  resolveAbandonedLobby,
  resolveCaptainVote,
  resolveReadyCheck,
  resolveStalledPick,
  autoDetectResult,
  startGame,
} from "@/lib/inhouse-service";
import {
  ON_POSTGRES,
  makeSeason,
  makeUser,
  raceAll,
  raceN,
  sessionFor,
} from "./factories";
import {
  getSetting,
  providerCooldownKey,
  SETTING_KEYS,
  setSetting,
} from "@/lib/settings";
import {
  deliverInhouseAnnouncements,
  INHOUSE_ANNOUNCEMENT_KIND,
  INHOUSE_ANNOUNCEMENT_STATUS,
  reconcileMissingInhouseResultAnnouncements,
} from "@/lib/inhouse-announcement-outbox";

// The inhouse result path only ever touches OpenDota — never a Valve league
// ticket. We stub the two network calls it makes (recent-match lists + a full
// match fetch) and keep everything else (identity fallback, classifyGame) real.
vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return {
    ...actual,
    fetchRecentMatchIds: vi.fn(async () => [] as number[]),
    fetchOpenDotaMatch: vi.fn(async () => null),
  };
});
import { fetchOpenDotaMatch, fetchRecentMatchIds } from "@/lib/dota";

// Discord sends are best-effort network calls — stub the sender (formatters
// stay real) so tests can assert what would have been announced.
vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return { ...actual, sendInhouseDiscordMessage: vi.fn(async () => true) };
});
// Inhouse posts to its OWN webhook (getInhouseWebhookUrl) so a league can
// keep pick-up traffic out of the league-announcement channel.
import { sendInhouseDiscordMessage } from "@/lib/discord";

const mockRecent = vi.mocked(fetchRecentMatchIds);
const mockMatch = vi.mocked(fetchOpenDotaMatch);
const mockSend = vi.mocked(sendInhouseDiscordMessage);

afterEach(() => {
  setRaceHook(null);
  mockRecent.mockReset();
  mockMatch.mockReset();
  mockRecent.mockResolvedValue([]);
  mockMatch.mockResolvedValue(null);
});
beforeEach(() => {
  mockRecent.mockResolvedValue([]);
  mockMatch.mockResolvedValue(null);
  mockSend.mockReset();
  mockSend.mockResolvedValue(true);
});

// ---- helpers ---------------------------------------------------------------

type QueuedUser = {
  user: Awaited<ReturnType<typeof makeUser>>;
  session: SessionUser;
};

/** Register N users and push them through joinQueue; the 10th forms a lobby. */
async function enqueue(
  count: number,
  mmrFor: (i: number) => number,
): Promise<QueuedUser[]> {
  const out: QueuedUser[] = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser(`IH${i}`);
    const session = sessionFor(user);
    await joinQueue(session, mmrFor(i));
    out.push({ user, session });
  }
  return out;
}

async function lobbyByStatus(status: string) {
  return prisma.inhouseLobby.findFirstOrThrow({
    where: { status },
    include: { players: { include: { user: true } } },
    orderBy: { createdAt: "desc" },
  });
}

/** The account ids on each drafted team, mirroring buildResult's own mapping. */
async function teamAccounts(lobbyId: string) {
  const players = await prisma.inhouseLobbyPlayer.findMany({
    where: { lobbyId },
    include: { user: true },
  });
  const acc = (u: {
    dotaAccountIdV2: number | null;
    legacyDotaAccountId: number | null;
    steamId: string;
  }) => effectiveDotaAccountId(u)!;
  return {
    team1: players.filter((p) => p.team === 1).map((p) => acc(p.user)),
    team2: players.filter((p) => p.team === 2).map((p) => acc(p.user)),
  };
}

/** Build an OpenDota match with team1 on Radiant, team2 on Dire (no leagueid). */
function fakeMatch(opts: {
  matchId: number;
  team1: number[];
  team2: number[];
  radiantWin: boolean;
  startTime: number;
  leagueid?: number;
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
    ...(opts.leagueid !== undefined ? { leagueid: opts.leagueid } : {}),
    players: [
      ...opts.team1.map((a, i) => line(a, i, true, i)),
      ...opts.team2.map((a, i) => line(a, 128 + i, false, i)),
    ],
  };
}

/** Everyone presses ACCEPT on the ready check (the last accept opens the vote). */
async function acceptAll(players: QueuedUser[]) {
  for (const p of players) await acceptMatch(p.session);
}

/**
 * Everyone accepts the ready check, then casts the same captain-selection
 * method (last vote resolves it). acceptMatch quietly no-ops when the lobby
 * is already past the ready check.
 */
async function voteAll(
  players: QueuedUser[],
  method: string,
  nomineeId?: string,
) {
  await acceptAll(players);
  for (const p of players) await castVote(p.session, method, nomineeId);
}

/** Admin-drive the draft to READY by always picking the top-MMR pool player. */
async function driveDraftToReady(admin: SessionUser) {
  for (let guard = 0; guard < 30; guard++) {
    const lobby = await prisma.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.DRAFTING },
      include: { players: true },
    });
    if (!lobby) break;
    const pool = lobby.players
      .filter((p) => p.team === null)
      .sort((a, b) => b.mmr - a.mmr);
    if (pool.length === 0) break;
    const r = await makePick(admin, pool[0].userId);
    if (!r.ok) throw new Error(`pick failed: ${r.error}`);
  }
}

/** Full run: queue → MMR captains → draft → start. Returns the IN_PROGRESS lobby. */
async function runToInProgress(admin: SessionUser) {
  const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 5000 - i * 100);
  await voteAll(players, "MMR");
  await driveDraftToReady(admin);
  await startGame(players[0].session);
  const lobby = await lobbyByStatus(INHOUSE_STATUS.IN_PROGRESS);
  return { players, lobby };
}

// ---------------------------------------------------------------------------

describe("inhouse — lobby formation", () => {
  it("does nothing until the queue reaches LOBBY_SIZE, then forms one lobby", async () => {
    await enqueue(INHOUSE.LOBBY_SIZE - 1, () => 3000);
    expect(await prisma.inhouseLobby.count()).toBe(0);
    expect(await prisma.inhouseQueueEntry.count()).toBe(INHOUSE.LOBBY_SIZE - 1);

    await enqueue(1, () => 3000); // the 10th player trips maybeFormLobby
    const lobby = await prisma.inhouseLobby.findFirstOrThrow({
      include: { players: true },
    });
    // The lobby opens in the READY CHECK — everyone must accept before the
    // captain vote begins.
    expect(lobby.status).toBe(INHOUSE_STATUS.READY_CHECK);
    expect(lobby.players).toHaveLength(INHOUSE.LOBBY_SIZE);
    expect(lobby.acceptEndsAt).not.toBeNull();
    expect(lobby.voteEndsAt).toBeNull();
    expect(lobby.radiantTeam).toBe(1);
    // Everyone drained from the queue into the lobby, nobody has accepted yet.
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
    expect(lobby.players.every((p) => p.acceptedAt === null)).toBe(true);
    // Nobody has a team yet — the vote decides captains first.
    expect(lobby.players.every((p) => p.team === null && !p.isCaptain)).toBe(
      true,
    );
  });

  it("keeps a second batch of 10 in the queue while one lobby is active", async () => {
    await enqueue(INHOUSE.LOBBY_SIZE, () => 3000); // forms lobby #1 (READY_CHECK)
    await enqueue(INHOUSE.LOBBY_SIZE, () => 3000); // second batch must wait
    expect(await prisma.inhouseLobby.count()).toBe(1);
    expect(await prisma.inhouseQueueEntry.count()).toBe(INHOUSE.LOBBY_SIZE);
  });
});

describe("inhouse — captain vote", () => {
  it("MMR: installs the two highest-MMR players as captains and opens the draft", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 5000 - i * 100);
    await voteAll(players, "MMR");

    const lobby = await lobbyByStatus(INHOUSE_STATUS.DRAFTING);
    const captains = lobby.players.filter((p) => p.isCaptain);
    expect(captains).toHaveLength(2);
    const cap1 = lobby.players.find((p) => p.team === 1 && p.isCaptain)!;
    const cap2 = lobby.players.find((p) => p.team === 2 && p.isCaptain)!;
    expect(cap1.userId).toBe(players[0].user.id); // 5000 MMR → team 1
    expect(cap2.userId).toBe(players[1].user.id); // 4900 MMR → team 2
    // Lower seed (team 2) is on the clock first, with a running pick timer.
    expect(lobby.pickTeam).toBe(INHOUSE.FIRST_PICK_TEAM);
    expect(lobby.pickEndsAt).not.toBeNull();
    expect(lobby.voteEndsAt).toBeNull();
  });

  it("uses original queue position as the tied-MMR captain tiebreak", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE - 1, () => 3000);
    const base = Date.now() - 60_000;
    for (const [i, p] of players.entries()) {
      await prisma.inhouseQueueEntry.update({
        where: { userId: p.user.id },
        data: { joinedAt: new Date(base + i) },
      });
    }
    const lastUser = await makeUser("IH-last");
    const last = { user: lastUser, session: sessionFor(lastUser) };
    players.push(last);
    expect((await joinQueue(last.session, 3000)).ok).toBe(true);

    const ready = await lobbyByStatus(INHOUSE_STATUS.READY_CHECK);
    const snapshot = new Map(
      ready.players.map((p) => [p.userId, p.queuedAt.getTime()] as const),
    );
    expect(players.slice(0, -1).map((p) => snapshot.get(p.user.id))).toEqual(
      players.slice(0, -1).map((_, i) => base + i),
    );

    await acceptAll(players);
    const voting = await getInhouseState(players[0].session, {
      syncBoard: false,
    });
    const previewQueueTimes = new Map(
      voting.lobby?.vote?.candidates.map((p) => [p.userId, p.joinedAt]) ?? [],
    );
    expect(previewQueueTimes.get(players[0].user.id)).toBe(base);

    await prisma.inhouseLobby.update({
      where: { id: ready.id },
      data: { voteEndsAt: new Date(Date.now() - 1) },
    });
    expect(await resolveCaptainVote()).toBe(true);
    const drafting = await lobbyByStatus(INHOUSE_STATUS.DRAFTING);
    expect(
      drafting.players
        .filter((p) => p.isCaptain)
        .sort((a, b) => (a.team ?? 0) - (b.team ?? 0))
        .map((p) => p.userId),
    ).toEqual([players[0].user.id, players[1].user.id]);
  });

  it("VOTE: the two most-nominated players become captains", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 3000 + i); // low, distinct MMR
    await acceptAll(players);
    // Everyone elects players[7] and players[8] (not the top-MMR pair).
    for (const p of players.slice(0, 5))
      await castVote(p.session, "VOTE", players[7].user.id);
    for (const p of players.slice(5))
      await castVote(p.session, "VOTE", players[8].user.id);

    const lobby = await lobbyByStatus(INHOUSE_STATUS.DRAFTING);
    const capIds = lobby.players
      .filter((p) => p.isCaptain)
      .map((p) => p.userId);
    expect(capIds).toContain(players[7].user.id);
    expect(capIds).toContain(players[8].user.id);
  });

  it("resolves on timeout with no votes cast, defaulting to MMR", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 5000 - i * 100);
    await acceptAll(players);
    const lobby = await lobbyByStatus(INHOUSE_STATUS.CAPTAIN_VOTE);
    // Force the vote clock into the past, then poll (getInhouseState resolves it).
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { voteEndsAt: new Date(Date.now() - 1000) },
    });
    await getInhouseState(players[0].session);

    const drafting = await lobbyByStatus(INHOUSE_STATUS.DRAFTING);
    const cap1 = drafting.players.find((p) => p.team === 1 && p.isCaptain)!;
    expect(cap1.userId).toBe(players[0].user.id); // highest MMR by default
  });

  it("rejects votes from outsiders and invalid methods", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    await acceptAll(players);
    const outsider = sessionFor(await makeUser("Nosy"));
    expect((await castVote(outsider, "MMR")).ok).toBe(false);
    expect((await castVote(players[0].session, "BOGUS")).ok).toBe(false);
    expect((await castVote(players[0].session, "VOTE")).ok).toBe(false); // no nominee
  });

  it("rejects a ballot after the captain-vote deadline", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    await acceptAll(players);
    const lobby = await lobbyByStatus(INHOUSE_STATUS.CAPTAIN_VOTE);
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { voteEndsAt: new Date(Date.now() - 1000) },
    });

    const res = await castVote(players[0].session, "MMR");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/voting.*closed/i);
    expect(
      (
        await prisma.inhouseLobbyPlayer.findFirstOrThrow({
          where: { lobbyId: lobby.id, userId: players[0].user.id },
        })
      ).votedMethod,
    ).toBeNull();
  });
});

describe("inhouse — drafting", () => {
  it("enforces turn order, ownership, and rejects re-picking a taken player", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 5000 - i * 100);
    await voteAll(players, "MMR");
    const cap1 = players[0]; // team 1
    const cap2 = players[1]; // team 2, picks first (FIRST_PICK_TEAM = 2)
    const pool = players.slice(2);

    // Team 1's captain can't pick out of turn.
    expect((await makePick(cap1.session, pool[0].user.id)).ok).toBe(false);
    // A non-captain can't pick at all.
    expect((await makePick(pool[0].session, pool[1].user.id)).ok).toBe(false);
    // The on-clock captain (team 2) can.
    expect((await makePick(cap2.session, pool[0].user.id)).ok).toBe(true);
    // That player is now taken — nobody can pick them again.
    expect((await makePick(cap1.session, pool[0].user.id)).ok).toBe(false);
    // And you can't draft a captain.
    expect((await makePick(cap1.session, cap2.user.id)).ok).toBe(false);
    // The clock has flipped to team 1.
    const lobby = await lobbyByStatus(INHOUSE_STATUS.DRAFTING);
    expect(lobby.pickTeam).toBe(1);
  });

  it("drafts in SNAKE order (2,1,1,2,2,1,1,2) so neither captain is favoured", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 5000 - i * 100);
    await voteAll(players, "MMR"); // captains: players[0] (T1), players[1] (T2)
    await driveDraftToReady(admin);

    // Reconstruct the true draft order from the stored pickIndex (the final
    // player is auto-assigned once the pool is down to one, so it lands in the
    // roster rather than through an on-clock poll).
    const done = await lobbyByStatus(INHOUSE_STATUS.READY);
    const order = done.players
      .filter((p) => !p.isCaptain)
      .sort((a, b) => (a.pickIndex ?? 0) - (b.pickIndex ?? 0))
      .map((p) => p.team);
    // Team 2 (lower seed) opens, then the snake pairs up and closes on team 2.
    expect(order).toEqual([2, 1, 1, 2, 2, 1, 1, 2]);
    expect(order.filter((t) => t === 1)).toHaveLength(4);
    expect(order.filter((t) => t === 2)).toHaveLength(4);
  });

  it("fills both rosters 5v5 and lands in READY", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 5000 - i * 100);
    await voteAll(players, "MMR");
    await driveDraftToReady(admin);

    const lobby = await lobbyByStatus(INHOUSE_STATUS.READY);
    expect(lobby.pickTeam).toBeNull();
    expect(lobby.pickEndsAt).toBeNull();
    expect(lobby.players.filter((p) => p.team === 1)).toHaveLength(
      INHOUSE.TEAM_SIZE,
    );
    expect(lobby.players.filter((p) => p.team === 2)).toHaveLength(
      INHOUSE.TEAM_SIZE,
    );
    expect(lobby.players.filter((p) => p.team === null)).toHaveLength(0);
    // Draft order was recorded for each non-captain pick.
    const picks = lobby.players.filter((p) => !p.isCaptain);
    expect(picks.every((p) => p.pickIndex !== null)).toBe(true);
  });

  it("auto-picks the top pool player when a captain lets the clock run out", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 5000 - i * 100);
    await voteAll(players, "MMR");
    const lobby = await lobbyByStatus(INHOUSE_STATUS.DRAFTING);
    const topPool = players[2]; // 4800 MMR, highest remaining in the pool

    // Stall: shove the pick clock into the past, then poll.
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { pickEndsAt: new Date(Date.now() - 1000) },
    });
    await getInhouseState(players[0].session);

    const drafted = await prisma.inhouseLobbyPlayer.findFirstOrThrow({
      where: { lobbyId: lobby.id, userId: topPool.user.id },
    });
    expect(drafted.team).not.toBeNull(); // was auto-drafted onto the stalled team
  });

  it("auto-picks the earliest queued player when the top pool MMR is tied", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE - 1, () => 3000);
    const base = Date.now() - 60_000;
    for (const [i, p] of players.entries()) {
      await prisma.inhouseQueueEntry.update({
        where: { userId: p.user.id },
        data: { joinedAt: new Date(base + i) },
      });
    }
    const lastUser = await makeUser("IH-autopick-last");
    players.push({ user: lastUser, session: sessionFor(lastUser) });
    expect((await joinQueue(sessionFor(lastUser), 3000)).ok).toBe(true);
    await voteAll(players, "MMR");

    const lobby = await lobbyByStatus(INHOUSE_STATUS.DRAFTING);
    const expected = players[2]; // first two queue positions became captains
    const decoy = players[3];
    // Make the row insertion clock say the opposite. createdAt used to drive
    // this tiebreak even though queuedAt is the user-visible queue contract.
    await prisma.inhouseLobbyPlayer.updateMany({
      where: { lobbyId: lobby.id, team: null },
      data: { createdAt: new Date(base + 10_000) },
    });
    await prisma.inhouseLobbyPlayer.update({
      where: {
        lobbyId_userId: { lobbyId: lobby.id, userId: decoy.user.id },
      },
      data: { createdAt: new Date(base - 10_000) },
    });
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { pickEndsAt: new Date(Date.now() - 1) },
    });

    expect(await resolveStalledPick()).toBe(true);
    expect(
      (
        await prisma.inhouseLobbyPlayer.findUniqueOrThrow({
          where: {
            lobbyId_userId: {
              lobbyId: lobby.id,
              userId: expected.user.id,
            },
          },
        })
      ).team,
    ).not.toBeNull();
    expect(
      (
        await prisma.inhouseLobbyPlayer.findUniqueOrThrow({
          where: {
            lobbyId_userId: {
              lobbyId: lobby.id,
              userId: decoy.user.id,
            },
          },
        })
      ).team,
    ).toBeNull();
  });
});

describe("inhouse — starting the game", () => {
  it("only a lobby member (or admin) can start, flipping READY → IN_PROGRESS", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 5000 - i * 100);
    await voteAll(players, "MMR");
    await driveDraftToReady(admin);

    const outsider = sessionFor(await makeUser("Rando"));
    expect((await startGame(outsider)).ok).toBe(false);
    expect((await startGame(players[3].session)).ok).toBe(true);

    const lobby = await lobbyByStatus(INHOUSE_STATUS.IN_PROGRESS);
    expect(lobby.startedById).toBe(players[3].user.id);
    expect(lobby.startedAt).not.toBeNull();
  });
});

describe("inhouse — finding + recording the game (NO league ticket)", () => {
  it("auto-detects a plain public-lobby match from players' recent games and scores it", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);
    const MATCH_ID = 7000000001;
    const startTime = Math.floor(lobby.createdAt.getTime() / 1000) + 120;

    // Every player's recent-match list contains the shared game...
    mockRecent.mockResolvedValue([MATCH_ID]);
    // ...and the match itself is an ordinary lobby game — NO leagueid at all.
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: MATCH_ID,
        team1,
        team2,
        radiantWin: true,
        startTime,
      }),
    );

    const res = await autoDetectResult(players[0].session);
    expect(res.ok).toBe(true);

    const done = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(done.status).toBe(INHOUSE_STATUS.COMPLETED);
    expect(done.completedAt).not.toBeNull();
    expect(done.winnerTeam).toBe(1); // team 1 was Radiant and Radiant won
    expect(done.radiantTeam).toBe(1);
    expect(done.dotaMatchId).toBe(String(MATCH_ID));
    expect(done.durationSecs).toBe(2400);

    // The full per-player box score was captured for scoring.
    const box = JSON.parse(done.boxScore) as {
      userId: string | null;
      team: number | null;
    }[];
    expect(box).toHaveLength(10);
    expect(box.filter((b) => b.team === 1)).toHaveLength(5);
    expect(box.filter((b) => b.team === 2)).toHaveLength(5);
    expect(box.every((b) => b.userId !== null)).toBe(true); // all 10 mapped to users
  });

  it("records the game from a pasted match id, with no league ticket involved", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);
    const MATCH_ID = 7000000002;

    // leagueid: 0 is exactly what a normal (non-ticketed) public lobby reports.
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: MATCH_ID,
        team1,
        team2,
        radiantWin: false, // Dire (team 2) wins this time
        startTime: Math.floor(Date.now() / 1000),
        leagueid: 0,
      }),
    );

    const res = await recordMatch(
      players[2].session,
      `https://www.opendota.com/matches/${MATCH_ID}`,
    );
    expect(res.ok).toBe(true);

    const done = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(done.status).toBe(INHOUSE_STATUS.COMPLETED);
    expect(done.winnerTeam).toBe(2);
  });

  it("elects one exact-ID lookup when a player races different IDs", async () => {
    const admin = sessionFor(await makeUser("AdminExactIdRace", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    mockMatch.mockResolvedValue(null);

    const results = await raceAll([
      () => recordMatch(players[0].session, "7000000901"),
      () => recordMatch(players[0].session, "7000000902"),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: false,
          error: expect.stringMatching(/couldn't fetch/i),
        }),
        expect.objectContaining({
          ok: false,
          error: expect.stringMatching(/wait about a minute/i),
        }),
      ]),
    );
    expect(mockMatch).toHaveBeenCalledTimes(1);
    expect(
      await prisma.setting.findUnique({
        where: {
          key: providerCooldownKey(
            "open-dota-match-import",
            players[0].session.id,
            `inhouse:${lobby.id}`,
          ),
        },
      }),
    ).not.toBeNull();
  });

  it("auto-detects on poll once the game has run long enough (maybeAutoDetectResult)", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);
    const MATCH_ID = 7000000003;

    mockRecent.mockResolvedValue([MATCH_ID]);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: MATCH_ID,
        team1,
        team2,
        radiantWin: true,
        startTime: Math.floor(lobby.createdAt.getTime() / 1000) + 60,
      }),
    );

    // Too early: a game that "just started" isn't scanned yet.
    expect(await maybeAutoDetectResult()).toBe(false);

    // Backdate the start past the detect floor, then poll again.
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        startedAt: new Date(
          Date.now() - (INHOUSE.DETECT_MIN_MINUTES + 1) * 60_000,
        ),
      },
    });
    // getInhouseState runs maybeAutoDetectResult as part of a normal poll.
    await getInhouseState(players[0].session);

    const done = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(done.status).toBe(INHOUSE_STATUS.COMPLETED);
    expect(done.winnerTeam).toBe(1);
  });

  it("restores the exact automatic detection claim when its worker is aborted", async () => {
    const admin = sessionFor(await makeUser("AdminAbortDetect", "ADMIN"));
    const { lobby } = await runToInProgress(admin);
    const previousDetectedAt = new Date(Date.now() - 60 * 60_000);
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        startedAt: new Date(
          Date.now() - (INHOUSE.DETECT_MIN_MINUTES + 1) * 60_000,
        ),
        detectedAt: previousDetectedAt,
      },
    });

    const controller = new AbortController();
    mockRecent.mockImplementation(async () => {
      controller.abort();
      return [];
    });
    mockMatch.mockClear();

    expect(await maybeAutoDetectResult({ signal: controller.signal })).toEqual({
      recorded: false,
      deadlineReached: true,
    });
    expect(mockMatch).not.toHaveBeenCalled();
    expect(
      (
        await prisma.inhouseLobby.findUniqueOrThrow({
          where: { id: lobby.id },
          select: { detectedAt: true },
        })
      ).detectedAt,
    ).toEqual(previousDetectedAt);
  });

  it("does not rewind a newer detection cursor when an older worker aborts", async () => {
    const admin = sessionFor(await makeUser("AdminAbortDetectRace", "ADMIN"));
    const { lobby } = await runToInProgress(admin);
    const previousDetectedAt = new Date(Date.now() - 60 * 60_000);
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        startedAt: new Date(
          Date.now() - (INHOUSE.DETECT_MIN_MINUTES + 1) * 60_000,
        ),
        detectedAt: previousDetectedAt,
      },
    });

    const controller = new AbortController();
    mockRecent.mockImplementation(async () => {
      controller.abort();
      return [];
    });
    const newerDetectedAt = new Date(Date.now() + 60_000);
    let fired = false;
    setRaceHook(
      onceAt("inhouse.autoDetect.beforeDeadlineRollback", async () => {
        fired = true;
        // A newer poll owns this cursor now. The aborted worker may restore
        // only the exact timestamp it claimed, never rewind this successor.
        await prisma.inhouseLobby.update({
          where: { id: lobby.id },
          data: { detectedAt: newerDetectedAt },
        });
      }),
    );

    expect(await maybeAutoDetectResult({ signal: controller.signal })).toEqual({
      recorded: false,
      deadlineReached: true,
    });
    expect(fired).toBe(true);
    expect(
      (
        await prisma.inhouseLobby.findUniqueOrThrow({
          where: { id: lobby.id },
          select: { detectedAt: true },
        })
      ).detectedAt,
    ).toEqual(newerDetectedAt);

    // The preserved successor cursor also prevents an immediate duplicate
    // OpenDota fan-out after the timed-out request returns.
    mockRecent.mockClear();
    expect(await maybeAutoDetectResult()).toBe(false);
    expect(mockRecent).not.toHaveBeenCalled();
  });

  it("rejects a match that isn't between these two teams", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const MATCH_ID = 7000000004;

    // Ten unrelated accounts — none of our players are in it.
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: MATCH_ID,
        team1: [900001, 900002, 900003, 900004, 900005],
        team2: [900006, 900007, 900008, 900009, 900010],
        radiantWin: true,
        startTime: Math.floor(Date.now() / 1000),
      }),
    );
    const res = await recordMatch(players[0].session, String(MATCH_ID));
    expect(res.ok).toBe(false);

    const still = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(still.status).toBe(INHOUSE_STATUS.IN_PROGRESS); // untouched
  });

  it("reports a friendly error when the game can't be found yet", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { players } = await runToInProgress(admin);
    mockRecent.mockResolvedValue([]); // nobody has public data / game not indexed
    const res = await autoDetectResult(players[0].session);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Expose Public Match Data/);
  });

  it("blames OpenDota, not privacy settings, when every fetch fails", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { players } = await runToInProgress(admin);
    mockRecent.mockResolvedValue(null); // unreachable: 429/5xx/timeout
    const res = await autoDetectResult(players[0].session);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/didn't respond/i);
      expect(res.error).not.toMatch(/Expose Public Match Data/);
    }
  });

  it("won't let a non-participant record the result", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: 7000000005,
        team1,
        team2,
        radiantWin: true,
        startTime: Math.floor(Date.now() / 1000),
      }),
    );
    const outsider = sessionFor(await makeUser("Rando"));
    expect((await recordMatch(outsider, "7000000005")).ok).toBe(false);
    expect(mockMatch).not.toHaveBeenCalled();
    expect(
      await prisma.setting.findUnique({
        where: {
          key: providerCooldownKey(
            "open-dota-match-import",
            outsider.id,
            `inhouse:${lobby.id}`,
          ),
        },
      }),
    ).toBeNull();
  });
});

describe("inhouse — scoring feeds ranking across games", () => {
  it("a completed game's winners rank first by record in the next lobby's vote", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));

    // ---- GAME 1: run it end to end and record team 1 as the winner ----
    const g1 = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(g1.lobby.id);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: 7100000001,
        team1,
        team2,
        radiantWin: true, // team 1 wins
        startTime: Math.floor(Date.now() / 1000),
      }),
    );
    expect((await recordMatch(g1.players[0].session, "7100000001")).ok).toBe(
      true,
    );

    const winners = new Set(
      (
        await prisma.inhouseLobbyPlayer.findMany({
          where: { lobbyId: g1.lobby.id, team: 1 },
        })
      ).map((p) => p.userId),
    );
    expect(winners.size).toBe(INHOUSE.TEAM_SIZE);

    // The pure leaderboard agrees: each winner shows a 1-0 record.
    const completed = await prisma.inhouseLobby.findMany({
      where: { status: INHOUSE_STATUS.COMPLETED },
      include: { players: { include: { user: true } } },
    });
    const board = summarizeInhouse(
      completed.map((l) => ({
        id: l.id,
        winnerTeam: l.winnerTeam,
        createdAt: l.createdAt,
        players: l.players.map((p) => ({
          userId: p.userId,
          name: p.user.name,
          avatar: p.user.avatar,
          team: p.team,
        })),
      })),
    );
    for (const w of winners) {
      expect(board.find((r) => r.userId === w)).toMatchObject({
        wins: 1,
        losses: 0,
      });
    }

    // ---- GAME 2: same 10 requeue and vote RECORD → captains come from the winners ----
    const g1Users = g1.players.map((p) => p.user);
    for (const u of g1Users) await joinQueue(sessionFor(u), 3000);
    const lobby2 = await lobbyByStatus(INHOUSE_STATUS.READY_CHECK);
    const sessById = new Map(g1Users.map((u) => [u.id, sessionFor(u)]));
    for (const p of lobby2.players) await acceptMatch(sessById.get(p.userId)!);
    for (const p of lobby2.players)
      await castVote(sessById.get(p.userId)!, "RECORD");

    const drafting2 = await lobbyByStatus(INHOUSE_STATUS.DRAFTING);
    const newCaps = drafting2.players
      .filter((p) => p.isCaptain)
      .map((p) => p.userId);
    expect(newCaps).toHaveLength(2);
    // Best inhouse record (1-0) belongs to game-1's winners → both captains are winners.
    for (const c of newCaps) expect(winners.has(c)).toBe(true);
  });

  it("snapshots a player's full career after more than 500 completed games", async () => {
    const veteran = await makeUser("Long Career Winner");
    const rival = await makeUser("Long Career Rival");
    const prefix = `career-${veteran.id}`;
    const count = 501;
    const createdAt = Date.now() - count * 60_000;
    const lobbies = Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i}`,
      status: INHOUSE_STATUS.COMPLETED,
      radiantTeam: 1,
      winnerTeam: 1,
      createdAt: new Date(createdAt + i * 60_000),
    }));
    const rows = lobbies.flatMap((lobby) => [
      { lobbyId: lobby.id, userId: veteran.id, team: 1 },
      { lobbyId: lobby.id, userId: rival.id, team: 2 },
    ]);
    // Keep batches under conservative SQLite parameter limits while retaining
    // a fast, real-database proof of the former 500-lobby truncation.
    for (let i = 0; i < lobbies.length; i += 100) {
      await prisma.inhouseLobby.createMany({ data: lobbies.slice(i, i + 100) });
    }
    for (let i = 0; i < rows.length; i += 100) {
      await prisma.inhouseLobbyPlayer.createMany({
        data: rows.slice(i, i + 100),
      });
    }

    const cohort = [veteran, rival];
    for (let i = 0; i < INHOUSE.LOBBY_SIZE - 2; i++) {
      cohort.push(await makeUser(`Career Newcomer ${i}`));
    }
    for (const user of cohort) {
      expect((await joinQueue(sessionFor(user), 3000)).ok).toBe(true);
    }

    const formed = await lobbyByStatus(INHOUSE_STATUS.READY_CHECK);
    const snapshots = new Map(
      formed.players.map((p) => [p.userId, p] as const),
    );
    expect(snapshots.get(veteran.id)).toMatchObject({
      games: count,
      wins: count,
      losses: 0,
    });
    expect(snapshots.get(rival.id)).toMatchObject({
      games: count,
      wins: 0,
      losses: count,
    });
  });
});

describe("inhouse — misc guards", () => {
  it("blocks joining the queue while already in a live lobby, and admin can cancel", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);

    // A player already in the active (READY_CHECK) lobby can't re-queue.
    expect((await joinQueue(players[0].session, 3000)).ok).toBe(false);

    // A non-admin can't cancel; the admin can, freeing the slot.
    expect((await cancelLobby(players[0].session)).ok).toBe(false);
    expect((await cancelLobby(admin)).ok).toBe(true);
    const lobby = await prisma.inhouseLobby.findFirstOrThrow();
    expect(lobby.status).toBe(INHOUSE_STATUS.CANCELLED);

    // Cancelling puts everyone back in the queue…
    expect(await prisma.inhouseQueueEntry.count()).toBe(INHOUSE.LOBBY_SIZE);
    // …but with backdated heartbeats, so a bystander's poll must NOT
    // instantly re-form the same (possibly ghost-ridden) lobby.
    await getInhouseState(admin);
    expect(
      await prisma.inhouseLobby.count({
        where: { status: INHOUSE_STATUS.READY_CHECK },
      }),
    ).toBe(0);
    // Once the players' own polls re-confirm presence, a fresh check forms.
    for (const p of players) await getInhouseState(p.session);
    expect(
      await prisma.inhouseLobby.count({
        where: { status: INHOUSE_STATUS.READY_CHECK },
      }),
    ).toBe(1);
  });

  it("leaveQueue removes a waiting player", async () => {
    const players = await enqueue(3, () => 3000);
    expect((await leaveQueue(players[0].session)).ok).toBe(true);
    expect(await prisma.inhouseQueueEntry.count()).toBe(2);
  });
});

describe("inhouse — discord announcements", () => {
  const queuePings = () =>
    mockSend.mock.calls.filter(([m]) => m.includes("Inhouse queue")).length;

  it("announces the formed lobby once, with the players and link", async () => {
    await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    const lobbyPings = mockSend.mock.calls.filter(([m]) =>
      m.includes("Inhouse match found"),
    );
    expect(lobbyPings).toHaveLength(1);
    expect(lobbyPings[0][0]).toContain("IH0");
    expect(lobbyPings[0][0]).toContain("IH9");
    expect(lobbyPings[0][0]).toContain("/inhouse");
  });

  it("pings the milestone once — leave/rejoin churn can't spam it", async () => {
    const players = await enqueue(INHOUSE.QUEUE_PING_AT, () => 3000);
    expect(queuePings()).toBe(1);

    // Dip below the milestone and rejoin — crosses again, but throttled.
    await leaveQueue(players[0].session);
    await joinQueue(players[0].session, 3000);
    expect(queuePings()).toBe(1);
  });

  it("stays quiet below the milestone", async () => {
    await enqueue(INHOUSE.QUEUE_PING_AT - 1, () => 3000);
    expect(queuePings()).toBe(0);
  });

  it("pings the configured role, and mentions the ten by verified id", async () => {
    await setSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID, "555000111222333444");
    // One player links Discord BEFORE the lobby forms — maybeFormLobby reads
    // discordId in the same transaction that empties the queue.
    const first = await makeUser("Linked");
    await prisma.user.update({
      where: { id: first.id },
      data: { discordId: "777000111222333444" },
    });
    await joinQueue(sessionFor(first), 3000);
    await enqueue(INHOUSE.LOBBY_SIZE - 1, () => 3000);

    const lobby = mockSend.mock.calls.find(([m]) =>
      m.includes("Inhouse match found"),
    );
    expect(lobby).toBeTruthy();
    const [content, mentions] = lobby!;
    expect(content).toContain("<@&555000111222333444>");
    expect(content).toContain("<@777000111222333444>");
    // Unlinked players are still named, just not pinged.
    expect(content).toContain("IH1");
    // Only ids the SERVER chose may ring anyone.
    expect(mentions).toEqual({
      roles: ["555000111222333444"],
      users: ["777000111222333444"],
    });
  });

  it("pings nobody when no role is configured — the old behaviour", async () => {
    await enqueue(INHOUSE.QUEUE_PING_AT, () => 3000);
    const ping = mockSend.mock.calls.find(([m]) => m.includes("Inhouse queue"));
    expect(ping![0]).not.toContain("<@&");
    expect(ping![1]).toEqual({ roles: [] });
  });

  it("pings at a threshold the queue can actually reach on its own", async () => {
    // It used to be LOBBY_SIZE-2 = 8, which the queue can essentially never
    // climb to unaided: the first person to queue is invisible to everyone not
    // already on the site, so the ping meant to pull people in sat downstream
    // of the problem it exists to solve.
    expect(INHOUSE.QUEUE_PING_AT).toBeLessThan(INHOUSE.LOBBY_SIZE / 2 + 1);
    expect(INHOUSE.QUEUE_PING_AT).toBeGreaterThan(1);
  });
});

describe("inhouse — queue presence", () => {
  const backdate = (userId: string, secondsAgo: number) =>
    prisma.inhouseQueueEntry.update({
      where: { userId },
      data: { lastSeenAt: new Date(Date.now() - secondsAgo * 1000) },
    });

  it("away players don't count toward forming; their own poll re-confirms them", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE - 1, () => 3000);
    // One of the nine stops polling long enough to go "away"…
    await backdate(players[0].user.id, INHOUSE.QUEUE_AWAY_SECONDS + 5);

    // …so a tenth join only makes 9 present — no lobby forms.
    const tenth = sessionFor(await makeUser("IH-tenth"));
    await joinQueue(tenth, 3000);
    expect(
      await prisma.inhouseLobby.count({
        where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      }),
    ).toBe(0);

    // The away player is flagged for everyone and excluded from the count.
    const state = await getInhouseState(tenth);
    expect(state.queue.find((q) => q.userId === players[0].user.id)?.away).toBe(
      true,
    );
    expect(state.needed).toBe(1);

    // Their own next poll heartbeats them back — and the lobby forms.
    await getInhouseState(players[0].session);
    expect(
      await prisma.inhouseLobby.count({
        where: { status: INHOUSE_STATUS.READY_CHECK },
      }),
    ).toBe(1);
  });

  it("entries silent past the drop window are pruned on the next poll", async () => {
    const players = await enqueue(3, () => 3000);
    await backdate(players[1].user.id, INHOUSE.QUEUE_DROP_SECONDS + 5);

    const state = await getInhouseState(players[0].session);
    expect(state.queue.map((q) => q.userId)).not.toContain(players[1].user.id);
    expect(await prisma.inhouseQueueEntry.count()).toBe(2);
  });

  it("throttles the heartbeat to one write per interval", async () => {
    const [p] = await enqueue(1, () => 3000);

    // A fresh entry isn't touched by a poll (write throttled)…
    await backdate(p.user.id, 5);
    const before = await prisma.inhouseQueueEntry.findUniqueOrThrow({
      where: { userId: p.user.id },
    });
    await getInhouseState(p.session);
    const afterFresh = await prisma.inhouseQueueEntry.findUniqueOrThrow({
      where: { userId: p.user.id },
    });
    expect(afterFresh.lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime());

    // …but once past the throttle window the next poll refreshes it.
    await backdate(p.user.id, INHOUSE.QUEUE_HEARTBEAT_SECONDS + 5);
    await getInhouseState(p.session);
    const afterStale = await prisma.inhouseQueueEntry.findUniqueOrThrow({
      where: { userId: p.user.id },
    });
    expect(afterStale.lastSeenAt.getTime()).toBeGreaterThan(
      before.lastSeenAt.getTime(),
    );
  });

  it("a cancelled lobby's ghosts drop out instead of re-forming it", async () => {
    const admin = sessionFor(await makeUser("AdminPresence", "ADMIN"));
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    expect((await cancelLobby(admin)).ok).toBe(true);

    // Nine re-confirm by polling; the tenth is a ghost — their backdated
    // requeue heartbeat never refreshes and ages past the drop window.
    for (const p of players.slice(1)) await getInhouseState(p.session);
    await backdate(players[0].user.id, INHOUSE.QUEUE_DROP_SECONDS + 5);

    await getInhouseState(admin);
    expect(await prisma.inhouseQueueEntry.count()).toBe(INHOUSE.LOBBY_SIZE - 1);
    expect(
      await prisma.inhouseLobby.count({
        where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The ready check: a filled lobby opens as an accept gate — all ten must
// press ACCEPT before the captain vote begins, so an AFK player is dropped
// instead of drafted.

describe("inhouse — ready check", () => {
  it("opens the captain vote only when all ten accept", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);

    // Nine accepts aren't enough.
    for (const p of players.slice(0, 9)) {
      expect((await acceptMatch(p.session)).ok).toBe(true);
    }
    expect(
      (await lobbyByStatus(INHOUSE_STATUS.READY_CHECK)).players.filter(
        (p) => p.acceptedAt,
      ),
    ).toHaveLength(9);

    // The tenth accept flips READY_CHECK → CAPTAIN_VOTE and starts the clock.
    expect((await acceptMatch(players[9].session)).ok).toBe(true);
    const voting = await lobbyByStatus(INHOUSE_STATUS.CAPTAIN_VOTE);
    expect(voting.voteEndsAt).not.toBeNull();
    expect(voting.acceptEndsAt).toBeNull();
  });

  it("double-accept is one accept; outsiders can't accept", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    expect((await acceptMatch(players[0].session)).ok).toBe(true);
    expect((await acceptMatch(players[0].session)).ok).toBe(true); // quiet no-op
    const outsider = sessionFor(await makeUser("Lurker"));
    expect((await acceptMatch(outsider)).ok).toBe(false);
    const lobby = await lobbyByStatus(INHOUSE_STATUS.READY_CHECK);
    expect(lobby.players.filter((p) => p.acceptedAt)).toHaveLength(1);
  });

  it("accepting a lobby cancelled BEFORE the call is refused at the read", async () => {
    // Staging the cancel up front only covers the EARLY-OUT: acceptMatch's
    // opening findFirst({ status: READY_CHECK }) finds nothing and returns
    // before the claim ever runs. Asserting the exact message keeps this
    // honest about which branch it covers — it is NOT race coverage, and the
    // relation-filter guard on the claim has its own test below.
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    const lobby = await lobbyByStatus(INHOUSE_STATUS.READY_CHECK);
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { status: INHOUSE_STATUS.CANCELLED },
    });
    const res = await acceptMatch(players[0].session);
    expect(res).toEqual({ ok: false, error: "No match to accept" });
    // No acceptedAt was stamped on the dead lobby.
    const row = await prisma.inhouseLobbyPlayer.findFirstOrThrow({
      where: { lobbyId: lobby.id, userId: players[0].user.id },
    });
    expect(row.acceptedAt).toBeNull();
  });

  it("an accept racing a decline never lands on the cancelled lobby", async () => {
    // THE guard: the accept claim carries `lobby: { status: READY_CHECK }` as
    // a relation filter, so a decline committing between the accepter's read
    // and their write cannot leave acceptedAt stamped on a dead lobby (and the
    // accepter falsely told they're in). Reaching it needs a real race — every
    // staged version short-circuits at the read above.
    for (let run = 0; run < 6; run++) {
      await prisma.inhouseLobbyPlayer.deleteMany();
      await prisma.inhouseLobby.deleteMany();
      await prisma.inhouseQueueEntry.deleteMany();
      const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
      const lobby = await lobbyByStatus(INHOUSE_STATUS.READY_CHECK);

      const [accepted] = await raceAll([
        () => acceptMatch(players[0].session),
        () => declineMatch(players[9].session),
      ]);

      const after = await prisma.inhouseLobby.findUniqueOrThrow({
        where: { id: lobby.id },
        include: { players: true },
      });
      // Whatever the interleaving: an accept is never both REPORTED ok and
      // stamped on a lobby that ended up cancelled.
      const mine = after.players.find((p) => p.userId === players[0].user.id)!;
      if (after.status === INHOUSE_STATUS.CANCELLED && accepted.ok) {
        expect(mine.acceptedAt).not.toBeNull(); // it really did land in time
      }
      if (!accepted.ok) expect(mine.acceptedAt).toBeNull();
    }
  });

  it("a decline fails the match NOW: decliner dropped, accepters keep their spot + MMR", async () => {
    // Distinct MMRs so a requeue that dropped the snapshot to 0 would show.
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 3000 + i * 100);
    for (const p of players.slice(0, 8)) await acceptMatch(p.session);

    // players[8] declines; players[9] never responded.
    expect((await declineMatch(players[8].session)).ok).toBe(true);
    const lobby = await prisma.inhouseLobby.findFirstOrThrow();
    expect(lobby.status).toBe(INHOUSE_STATUS.CANCELLED);

    const queued = await prisma.inhouseQueueEntry.findMany();
    const byId = new Map(queued.map((q) => [q.userId, q]));
    // The decliner is out entirely.
    expect(byId.has(players[8].user.id)).toBe(false);
    const now = Date.now();
    for (const [i, p] of players.slice(0, 8).entries()) {
      const q = byId.get(p.user.id)!;
      // The eight accepters re-queued with LIVE heartbeats (instantly present)…
      expect(now - q.lastSeenAt.getTime()).toBeLessThan(
        INHOUSE.QUEUE_AWAY_SECONDS * 1000,
      );
      // …and their MMR snapshot survived the round-trip.
      expect(q.mmr).toBe(3000 + i * 100);
    }
    // …while the still-pending player re-queued BACKDATED but INSIDE the drop
    // window: away (won't re-form) yet not pruned, so their own next poll can
    // re-confirm them (the cancelLobby pattern).
    const pending = byId.get(players[9].user.id)!;
    const age = now - pending.lastSeenAt.getTime();
    expect(age).toBeGreaterThan(INHOUSE.QUEUE_AWAY_SECONDS * 1000);
    expect(age).toBeLessThan(INHOUSE.QUEUE_DROP_SECONDS * 1000);
    // Their own poll re-confirms them (heartbeat refreshes → present).
    await getInhouseState(players[9].session);
    const reconfirmed = await prisma.inhouseQueueEntry.findUniqueOrThrow({
      where: { userId: players[9].user.id },
    });
    expect(Date.now() - reconfirmed.lastSeenAt.getTime()).toBeLessThan(
      INHOUSE.QUEUE_AWAY_SECONDS * 1000,
    );
  });

  it("re-queued accepters keep priority over players who joined during the check", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    for (const p of players.slice(0, 9)) await acceptMatch(p.session);
    const lobby = await lobbyByStatus(INHOUSE_STATUS.READY_CHECK);
    const accepterIds = new Set(players.slice(0, 9).map((p) => p.user.id));
    const expected = lobby.players
      .filter((p) => accepterIds.has(p.userId))
      .sort(
        (a, b) =>
          a.queuedAt.getTime() - b.queuedAt.getTime() ||
          a.userId.localeCompare(b.userId),
      );
    // A spectator joins the queue mid-check (behind the ten in the lobby).
    const latecomer = sessionFor(await makeUser("Latecomer"));
    await joinQueue(latecomer, 3000);
    // Put them inside the millisecond range the old `lobby.createdAt + i`
    // approximation assigned to accepters. They still joined after formation,
    // so exact queuedAt restoration must keep every accepter ahead of them.
    await prisma.inhouseQueueEntry.update({
      where: { userId: latecomer.id },
      data: { joinedAt: new Date(lobby.createdAt.getTime() + 1) },
    });

    // players[9] never accepts → the check times out.
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { acceptEndsAt: new Date(Date.now() - 1000) },
    });
    await getInhouseState(players[0].session);

    // Queue order: the nine accepters (anchored to formation) BEFORE the
    // latecomer who joined during the check.
    const queued = await prisma.inhouseQueueEntry.findMany({
      orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
    });
    const order = queued.map((q) => q.userId);
    expect(order.slice(0, expected.length)).toEqual(
      expected.map((p) => p.userId),
    );
    expect(order.indexOf(latecomer.id)).toBe(expected.length);
    const byId = new Map(queued.map((q) => [q.userId, q] as const));
    for (const p of expected) {
      expect(byId.get(p.userId)?.joinedAt.getTime()).toBe(p.queuedAt.getTime());
    }
  });

  it("an expired check cancels the lobby and drops the no-shows", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    for (const p of players.slice(0, 7)) await acceptMatch(p.session);
    const lobby = await lobbyByStatus(INHOUSE_STATUS.READY_CHECK);
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { acceptEndsAt: new Date(Date.now() - 1000) },
    });

    // Any poll resolves it lazily.
    await getInhouseState(players[0].session);
    expect((await prisma.inhouseLobby.findFirstOrThrow()).status).toBe(
      INHOUSE_STATUS.CANCELLED,
    );

    // Only the seven accepters are back in the queue, present.
    const queued = await prisma.inhouseQueueEntry.findMany();
    expect(queued).toHaveLength(7);
    const ids = queued.map((q) => q.userId);
    for (const p of players.slice(0, 7)) expect(ids).toContain(p.user.id);
    for (const p of players.slice(7)) expect(ids).not.toContain(p.user.id);
  });

  it("resolveReadyCheck rescues a stuck all-accepted lobby (the concurrent-final-accept race)", async () => {
    // Simulate the Postgres race: two final accepts each saw the other's write
    // uncommitted, so NEITHER flipped — all ten accepted but status is still
    // READY_CHECK. resolveReadyCheck's all-accepted branch must rescue it, even
    // before the clock expires.
    await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    const lobby = await lobbyByStatus(INHOUSE_STATUS.READY_CHECK);
    await prisma.inhouseLobbyPlayer.updateMany({
      where: { lobbyId: lobby.id },
      data: { acceptedAt: new Date() },
    });
    // Clock still in the future — only the all-accepted branch can flip it.
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { acceptEndsAt: new Date(Date.now() + 60_000) },
    });

    expect(await resolveReadyCheck()).toBe(true);
    const voting = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(voting.status).toBe(INHOUSE_STATUS.CAPTAIN_VOTE);
    expect(voting.voteEndsAt).not.toBeNull();
  });

  it("a failed check re-forms and pings again when the queue refills", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    const lobby = await lobbyByStatus(INHOUSE_STATUS.READY_CHECK);
    for (const p of players.slice(0, 9)) await acceptMatch(p.session);
    mockSend.mockClear();

    // players[9] declines → 9 accepters re-queue present.
    await declineMatch(players[9].session);
    // The failure itself announces nothing.
    expect(
      mockSend.mock.calls.filter(([m]) => m.includes("Inhouse match found")),
    ).toHaveLength(0);

    // One fresh join refills to ten → a NEW lobby forms and pings again
    // (players must accept the new match).
    const refill = sessionFor(await makeUser("Refill"));
    await joinQueue(refill, 3000);
    expect(
      mockSend.mock.calls.filter(([m]) => m.includes("Inhouse match found")),
    ).toHaveLength(1);
    // A genuinely NEW lobby, not the cancelled one resurrected. (This used to
    // compare the lobby's id to a USER's id — two cuids from different tables,
    // which can never be equal, so the assertion could not fail.)
    const reformed = await prisma.inhouseLobby.findFirstOrThrow({
      where: { status: INHOUSE_STATUS.READY_CHECK },
    });
    expect(reformed.id).not.toBe(lobby.id);
    expect(
      await prisma.inhouseLobby.count({
        where: { status: INHOUSE_STATUS.CANCELLED },
      }),
    ).toBe(1);
  });

  it("state.lobby.readyCheck reports the count, pending-first order, and clock", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    await acceptMatch(players[0].session);
    await acceptMatch(players[1].session);

    const state = await getInhouseState(players[0].session);
    const rc = state.lobby?.readyCheck;
    expect(rc).not.toBeNull();
    expect(rc!.acceptedCount).toBe(2);
    expect(rc!.total).toBe(INHOUSE.LOBBY_SIZE);
    // Pending players sort ahead of accepted ones (they're the holdup).
    const firstAcceptedIdx = rc!.players.findIndex((p) => p.accepted);
    const lastPendingIdx = rc!.players
      .map((p) => p.accepted)
      .lastIndexOf(false);
    expect(lastPendingIdx).toBeLessThan(firstAcceptedIdx);
    // The accept clock is serialized as an epoch, and the viewer's own flags.
    expect(typeof state.lobby?.acceptEndsAt).toBe("number");
    expect(state.me.canAccept).toBe(true);
    expect(state.me.hasAccepted).toBe(true);
  });

  it("admin can cancel a stuck ready check (everyone re-queues backdated)", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    await acceptMatch(players[0].session);
    expect((await cancelLobby(admin)).ok).toBe(true);
    expect((await prisma.inhouseLobby.findFirstOrThrow()).status).toBe(
      INHOUSE_STATUS.CANCELLED,
    );
    expect(await prisma.inhouseQueueEntry.count()).toBe(INHOUSE.LOBBY_SIZE);
  });
});

// ---------------------------------------------------------------------------
// The status-guard races: a result landing and an admin cancel can genuinely
// collide (the OpenDota fetch takes seconds, the confirm dialog takes longer)
// — whichever transition claims the row first must win, permanently.

describe("inhouse — result vs cancel race guards", () => {
  async function primeResult(lobbyId: string, matchId: number) {
    const { team1, team2 } = await teamAccounts(lobbyId);
    const lobby = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobbyId },
    });
    mockRecent.mockResolvedValue([matchId]);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId,
        team1,
        team2,
        radiantWin: true,
        startTime: Math.floor(lobby.createdAt.getTime() / 1000) + 120,
      }),
    );
  }

  it("cancel loses once the result is in — the game keeps its result, nobody re-queues", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    await primeResult(lobby.id, 7000000010);
    expect((await recordMatch(players[0].session, "7000000010")).ok).toBe(true);

    // Sequentially the read already sees no active lobby; in the true race
    // the in-tx claim refuses instead. Either way: cancel loses.
    const res = await cancelLobby(admin);
    expect(res.ok).toBe(false);

    const kept = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(kept.status).toBe(INHOUSE_STATUS.COMPLETED);
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
  });

  it("a fetched result can't resurrect a cancelled lobby as COMPLETED", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { lobby } = await runToInProgress(admin);
    await primeResult(lobby.id, 7000000011);

    // The cancel lands first (mid-"fetch" from the racing recorder's view).
    expect((await cancelLobby(admin)).ok).toBe(true);

    // Backdate past the detect floor so the background scan would fire if it
    // could; the guarded applyResult must refuse the terminal flip.
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        startedAt: new Date(
          Date.now() - (INHOUSE.DETECT_MIN_MINUTES + 1) * 60_000,
        ),
      },
    });
    expect(await maybeAutoDetectResult()).toBe(false);

    const still = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(still.status).toBe(INHOUSE_STATUS.CANCELLED);
    expect(still.winnerTeam).toBeNull();
  });

  it("a cancel landing DURING the OpenDota fetch keeps the lobby cancelled", async () => {
    // The two tests above never actually reach applyResult's claim: both
    // cancel FIRST, so the callers' own opening `findFirst({ status:
    // IN_PROGRESS })` returns nothing and they bail long before the
    // `updateMany({ where: { id, status: IN_PROGRESS } })` runs. Delete that
    // predicate and they both still pass — which left the guard that stops a
    // CANCELLED lobby being resurrected as COMPLETED (with Elo stamped and a
    // Discord result sent) with no coverage at all.
    //
    // Cancelling from INSIDE the mocked fetch puts the cancel exactly where it
    // happens in life — mid-round-trip, after the status was read — and is
    // deterministic on both engines.
    const admin = sessionFor(await makeUser("AdminMidFetch", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);

    let cancelledDuringFetch = false;
    mockMatch.mockImplementation(async () => {
      if (!cancelledDuringFetch) {
        cancelledDuringFetch = (await cancelLobby(admin)).ok;
      }
      return fakeMatch({
        matchId: 7000000099,
        team1,
        team2,
        radiantWin: true,
        startTime: Math.floor(Date.now() / 1000),
      }) as never;
    });

    const res = await recordMatch(players[0].session, "7000000099");
    expect(cancelledDuringFetch).toBe(true);
    expect(res.ok).toBe(false);

    const after = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(after.status).toBe(INHOUSE_STATUS.CANCELLED);
    expect(after.winnerTeam).toBeNull();
    // No Elo stamped and no result announced for a game that was cancelled.
    expect(after.eloDeltas).toBe("{}");
    expect(
      mockSend.mock.calls.filter(([m]) => m.includes("Inhouse result")),
    ).toHaveLength(0);
  });

  it("a void after completion but before finalization cannot restore Elo or publish a stale result", async () => {
    const admin = sessionFor(await makeUser("AdminMidFinalize", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    await primeResult(lobby.id, 7000000100);
    mockSend.mockClear();

    let voided = false;
    setRaceHook(
      onceAt("inhouse.applyResult.beforeFinalizationClaim", async () => {
        const res = await voidLastResult(admin, lobby.id);
        voided = res.ok;
      }),
    );

    const res = await recordMatch(players[0].session, "7000000100");
    expect(voided).toBe(true); // the seam fired; this is not a staged pre-call
    expect(res.ok).toBe(false);

    const after = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(after.status).toBe(INHOUSE_STATUS.CANCELLED);
    expect(after.eloDeltas).toBe("{}");
    const messages = mockSend.mock.calls.map(([message]) => message);
    expect(
      messages.filter((message) => message.includes("Inhouse result:")),
    ).toEqual([]);
    expect(
      messages.filter((message) => message.includes("result has been voided")),
    ).toHaveLength(1);
  });

  it("finalization re-asserts COMPLETED even when the rival preserves the match id", async () => {
    // The real void race above changes BOTH guard columns: status becomes
    // CANCELLED and dotaMatchId becomes null. That means the match-id predicate
    // alone can keep it green if the status predicate is deleted. This
    // status-only rival is the mutation tripwire for the independent invariant.
    const admin = sessionFor(await makeUser("AdminStatusTripwire", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    await primeResult(lobby.id, 7000000101);
    mockSend.mockClear();

    let fired = false;
    setRaceHook(
      onceAt("inhouse.applyResult.beforeFinalizationClaim", async () => {
        fired = true;
        await prisma.inhouseLobby.update({
          where: { id: lobby.id },
          data: { status: INHOUSE_STATUS.CANCELLED },
        });
      }),
    );

    const res = await recordMatch(players[0].session, "7000000101");
    expect(fired).toBe(true);
    expect(res.ok).toBe(false);

    const after = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(after.status).toBe(INHOUSE_STATUS.CANCELLED);
    expect(after.dotaMatchId).toBe("7000000101");
    expect(after.completedAt).not.toBeNull();
    expect(after.eloDeltas).toBe("{}");
    expect(
      mockSend.mock.calls.filter(([message]) =>
        String(message).includes("Inhouse result:"),
      ),
    ).toHaveLength(0);
  });

  it("rejects a pasted match that started before this lobby formed", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);
    // Same ten players, right rosters — but yesterday's game.
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: 7000000012,
        team1,
        team2,
        radiantWin: true,
        startTime: Math.floor(lobby.createdAt.getTime() / 1000) - 3600,
      }),
    );
    const res = await recordMatch(players[0].session, "7000000012");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/before this lobby/i);
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: lobby.id } }))
        .status,
    ).toBe(INHOUSE_STATUS.IN_PROGRESS);
  });

  it("accepts a pasted match where only two players per side have public data", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);

    // Anonymize all but two per side (private profiles report no account_id).
    const od = fakeMatch({
      matchId: 7000000013,
      team1,
      team2,
      radiantWin: true,
      startTime: Math.floor(lobby.createdAt.getTime() / 1000) + 120,
    });
    const keep = new Set([...team1.slice(0, 2), ...team2.slice(0, 2)]);
    for (const p of od.players as { account_id: number | null }[]) {
      if (p.account_id != null && !keep.has(p.account_id)) p.account_id = null;
    }
    mockMatch.mockResolvedValue(od);

    const res = await recordMatch(players[0].session, "7000000013");
    expect(res.ok).toBe(true);
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: lobby.id } }))
        .status,
    ).toBe(INHOUSE_STATUS.COMPLETED);
  });
});

describe("inhouse — Elo deltas + result announcement", () => {
  async function leaveResultAfterPrimaryCommit(matchId: number) {
    const admin = sessionFor(await makeUser(`AdminCrash${matchId}`, "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId,
        team1,
        team2,
        radiantWin: true,
        startTime: Math.floor(lobby.createdAt.getTime() / 1000) + 120,
      }),
    );
    setRaceHook(
      onceAt("inhouse.applyResult.afterPrimaryCommit", async () => {
        throw new Error("simulated process death after result commit");
      }),
    );
    try {
      await expect(
        recordMatch(players[0].session, String(matchId)),
      ).rejects.toThrow("simulated process death after result commit");
    } finally {
      setRaceHook(null);
    }
    return { players, lobby };
  }

  it("stamps per-player Elo deltas at completion and serves them via lastResult", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: 7000000020,
        team1,
        team2,
        radiantWin: true, // team 1 wins
        startTime: Math.floor(lobby.createdAt.getTime() / 1000) + 120,
      }),
    );
    expect((await recordMatch(players[0].session, "7000000020")).ok).toBe(true);

    const done = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
      include: { players: true },
    });
    const deltas = JSON.parse(done.eloDeltas) as { [id: string]: number };
    expect(Object.keys(deltas)).toHaveLength(INHOUSE.LOBBY_SIZE);
    for (const p of done.players) {
      const d = deltas[p.userId];
      expect(typeof d).toBe("number");
      if (p.team === 1) expect(d).toBeGreaterThan(0);
      else expect(d).toBeLessThan(0);
    }

    // The room's post-game banner reads the stamped delta, not a rescan.
    const winner = done.players.find((p) => p.team === 1)!;
    const winnerSession = players.find(
      (p) => p.user.id === winner.userId,
    )!.session;
    const state = await getInhouseState(winnerSession);
    expect(state.lastResult).not.toBeNull();
    expect(state.lastResult!.myTeamWon).toBe(true);
    expect(state.lastResult!.eloDelta).toBe(deltas[winner.userId]);
  });

  it("announces the result to Discord exactly once, with the score and MVP", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: 7000000021,
        team1,
        team2,
        radiantWin: true,
        startTime: Math.floor(lobby.createdAt.getTime() / 1000) + 120,
      }),
    );
    expect((await recordMatch(players[0].session, "7000000021")).ok).toBe(true);
    // A second record attempt loses the claim — no double announcement.
    expect((await recordMatch(players[1].session, "7000000021")).ok).toBe(
      false,
    );

    const resultSends = mockSend.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("Inhouse result"));
    expect(resultSends).toHaveLength(1);
    expect(resultSends[0]).toMatch(/Radiant win 30–20/);
    expect(resultSends[0]).toMatch(/MVP:/);
    expect(resultSends[0]).toContain("opendota.com/matches/7000000021");
    expect(
      await prisma.inhouseAnnouncement.findUnique({
        where: {
          lobbyId_kind: {
            lobbyId: lobby.id,
            kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
          },
        },
      }),
    ).toMatchObject({
      status: INHOUSE_ANNOUNCEMENT_STATUS.SENT,
      attempts: 1,
      resultMatchId: "7000000021",
    });
  });

  it("keeps a rejected result send durable and retries it on a later heartbeat", async () => {
    const admin = sessionFor(await makeUser("AdminRetry", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: 7000000022,
        team1,
        team2,
        radiantWin: true,
        startTime: Math.floor(lobby.createdAt.getTime() / 1000) + 120,
      }),
    );
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    // Discord rejects the immediate post-commit attempt, but recording the
    // game still succeeds and the exact payload remains durable.
    expect((await recordMatch(players[0].session, "7000000022")).ok).toBe(true);
    const pending = await prisma.inhouseAnnouncement.findUniqueOrThrow({
      where: {
        lobbyId_kind: {
          lobbyId: lobby.id,
          kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        },
      },
    });
    expect(pending).toMatchObject({
      status: INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
      attempts: 1,
    });
    expect(mockSend).toHaveBeenCalledTimes(1);

    const retry = await deliverInhouseAnnouncements({
      lobbyId: lobby.id,
      now: new Date(pending.availableAt.getTime() + 1),
    });
    expect(retry).toEqual({ attempted: 1, delivered: 1, pending: false });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(
      await prisma.inhouseAnnouncement.findUniqueOrThrow({
        where: { id: pending.id },
      }),
    ).toMatchObject({
      status: INHOUSE_ANNOUNCEMENT_STATUS.SENT,
      attempts: 2,
    });
  });

  it("recovers Elo and a missing result event after process death past the primary commit", async () => {
    const oldCursor = "2000-01-01T00:00:00.000Z";
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, oldCursor);
    const { lobby } = await leaveResultAfterPrimaryCommit(7000000120);

    const committed = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(committed).toMatchObject({
      status: INHOUSE_STATUS.COMPLETED,
      dotaMatchId: "7000000120",
      eloDeltas: "{}",
    });
    const baseEvent = await prisma.inhouseAnnouncement.findUniqueOrThrow({
      where: {
        lobbyId_kind: {
          lobbyId: lobby.id,
          kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        },
      },
    });
    expect(baseEvent).toMatchObject({
      status: INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
      resultMatchId: "7000000120",
    });
    expect(baseEvent.content).toMatch(/Radiant win 30–20/);
    expect(await getSetting(SETTING_KEYS.RESULT_CHANGED_AT)).not.toBe(
      oldCursor,
    );

    // Model the row-less state an older binary left in this crash window.
    await prisma.inhouseAnnouncement.delete({ where: { id: baseEvent.id } });
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, oldCursor);
    await expect(reconcileMissingInhouseResultAnnouncements()).resolves.toEqual(
      { scanned: 1, created: 1 },
    );

    const repaired = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
      include: { players: true },
    });
    const deltas = JSON.parse(repaired.eloDeltas) as Record<string, number>;
    expect(Object.keys(deltas)).toHaveLength(INHOUSE.LOBBY_SIZE);
    expect(await getSetting(SETTING_KEYS.RESULT_CHANGED_AT)).not.toBe(
      oldCursor,
    );
    const recoveredEvent = await prisma.inhouseAnnouncement.findUniqueOrThrow({
      where: {
        lobbyId_kind: {
          lobbyId: lobby.id,
          kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        },
      },
    });
    expect(recoveredEvent.content).toMatch(/Radiant win 30–20/);
    expect(recoveredEvent.content).toContain("opendota.com/matches/7000000120");
    await expect(reconcileMissingInhouseResultAnnouncements()).resolves.toEqual(
      { scanned: 0, created: 0 },
    );
    await expect(
      deliverInhouseAnnouncements({ lobbyId: lobby.id }),
    ).resolves.toEqual({ attempted: 1, delivered: 1, pending: false });
  });

  it("lets only one concurrent SQLite reconciler create a missing result event", async () => {
    const { lobby } = await leaveResultAfterPrimaryCommit(7000000121);
    await prisma.inhouseAnnouncement.deleteMany({
      where: {
        lobbyId: lobby.id,
        kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
      },
    });

    const outcomes = await Promise.all([
      reconcileMissingInhouseResultAnnouncements(),
      reconcileMissingInhouseResultAnnouncements(),
    ]);
    expect(outcomes.reduce((sum, result) => sum + result.created, 0)).toBe(1);
    expect(
      await prisma.inhouseAnnouncement.count({
        where: {
          lobbyId: lobby.id,
          kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        },
      }),
    ).toBe(1);
    const repaired = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(Object.keys(JSON.parse(repaired.eloDeltas))).toHaveLength(
      INHOUSE.LOBBY_SIZE,
    );
  });

  it("never rewrites a result payload after its send lease is live", async () => {
    const { lobby } = await leaveResultAfterPrimaryCommit(7000000122);
    const frozenContent = "frozen payload already handed to Discord";
    const event = await prisma.inhouseAnnouncement.update({
      where: {
        lobbyId_kind: {
          lobbyId: lobby.id,
          kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        },
      },
      data: { content: frozenContent },
    });

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const send = vi.fn(async () => {
      entered();
      await gate;
      return true;
    });
    const delivery = deliverInhouseAnnouncements({
      lobbyId: lobby.id,
      now: new Date(event.availableAt.getTime() + 1),
      send,
      limit: 1,
    });
    await sendStarted;

    try {
      await expect(
        reconcileMissingInhouseResultAnnouncements(),
      ).resolves.toEqual({ scanned: 1, created: 0 });
      expect(
        await prisma.inhouseAnnouncement.findUniqueOrThrow({
          where: { id: event.id },
        }),
      ).toMatchObject({
        status: INHOUSE_ANNOUNCEMENT_STATUS.SENDING,
        content: frozenContent,
      });
    } finally {
      // Mutation failures must still release the webhook seam so the worker
      // cannot leak into teardown or leave this test hanging.
      release();
      await delivery;
    }
    expect(send).toHaveBeenCalledWith(frozenContent);
    expect(
      await prisma.inhouseAnnouncement.findUniqueOrThrow({
        where: { id: event.id },
      }),
    ).toMatchObject({
      status: INHOUSE_ANNOUNCEMENT_STATUS.SENT,
      attempts: 1,
    });
  });

  it("leases one pending announcement to only one concurrent worker", async () => {
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.COMPLETED,
        winnerTeam: 1,
        dotaMatchId: "7000000023",
        completedAt: new Date(),
      },
    });
    const event = await prisma.inhouseAnnouncement.create({
      data: {
        lobbyId: lobby.id,
        kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        sequence: 1,
        content: "durable result",
        resultMatchId: "7000000023",
      },
    });

    let release!: (accepted: boolean) => void;
    let started!: () => void;
    const inFlight = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const send = vi.fn(async () => {
      started();
      return inFlight;
    });
    const now = new Date();

    const first = deliverInhouseAnnouncements({
      lobbyId: lobby.id,
      now,
      send,
    });
    await sendStarted;
    const rival = await deliverInhouseAnnouncements({
      lobbyId: lobby.id,
      now,
      send,
    });
    expect(rival).toEqual({ attempted: 0, delivered: 0, pending: true });
    expect(send).toHaveBeenCalledTimes(1);

    release(true);
    expect(await first).toEqual({ attempted: 1, delivered: 1, pending: false });
    expect(
      await prisma.inhouseAnnouncement.findUniqueOrThrow({
        where: { id: event.id },
      }),
    ).toMatchObject({
      status: INHOUSE_ANNOUNCEMENT_STATUS.SENT,
      attempts: 1,
    });
  });

  it("does not lease a result after its lobby changes behind the candidate snapshot", async () => {
    const lobby = await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.COMPLETED,
        winnerTeam: 1,
        dotaMatchId: "7000000024",
        completedAt: new Date(),
      },
    });
    const event = await prisma.inhouseAnnouncement.create({
      data: {
        lobbyId: lobby.id,
        kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        sequence: 1,
        content: "now stale result",
        resultMatchId: "7000000024",
      },
    });
    const originalFind = prisma.inhouseAnnouncement.findMany.bind(
      prisma.inhouseAnnouncement,
    );
    let moved = false;
    const candidateSpy = vi
      .spyOn(prisma.inhouseAnnouncement, "findMany")
      .mockImplementation((async (args: Parameters<typeof originalFind>[0]) => {
        const candidates = await originalFind(args);
        if (!moved && candidates.length > 0) {
          moved = true;
          await prisma.inhouseLobby.update({
            where: { id: lobby.id },
            data: { status: INHOUSE_STATUS.CANCELLED, dotaMatchId: null },
          });
        }
        return candidates;
      }) as never);

    let first: Awaited<ReturnType<typeof deliverInhouseAnnouncements>>;
    try {
      first = await deliverInhouseAnnouncements({ lobbyId: lobby.id });
    } finally {
      candidateSpy.mockRestore();
    }

    expect(moved).toBe(true);
    expect(first).toEqual({ attempted: 0, delivered: 0, pending: true });
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      await prisma.inhouseAnnouncement.findUniqueOrThrow({
        where: { id: event.id },
      }),
    ).toMatchObject({
      status: INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
      attempts: 0,
    });

    // A fresh candidate snapshot sees the cancellation and retires the stale
    // result without spending a webhook attempt.
    await expect(
      deliverInhouseAnnouncements({ lobbyId: lobby.id }),
    ).resolves.toEqual({ attempted: 0, delivered: 0, pending: false });
    expect(
      await prisma.inhouseAnnouncement.findUniqueOrThrow({
        where: { id: event.id },
      }),
    ).toMatchObject({ status: INHOUSE_ANNOUNCEMENT_STATUS.CANCELLED });
  });
});

describe("inhouse — draft QoL", () => {
  it("auto-assigns the final pool player instead of running another clock", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 5000 - i * 100);
    await voteAll(players, "MMR");

    // Make the 7 human picks; the 8th (last pool player) must self-assign.
    for (let pick = 0; pick < 7; pick++) {
      const lobby = await prisma.inhouseLobby.findFirstOrThrow({
        where: { status: INHOUSE_STATUS.DRAFTING },
        include: { players: true },
      });
      const pool = lobby.players
        .filter((p) => p.team === null)
        .sort((a, b) => b.mmr - a.mmr);
      expect((await makePick(admin, pool[0].userId)).ok).toBe(true);
    }

    const ready = await lobbyByStatus(INHOUSE_STATUS.READY);
    expect(ready.players.filter((p) => p.team === 1)).toHaveLength(5);
    expect(ready.players.filter((p) => p.team === 2)).toHaveLength(5);
    expect(ready.players.every((p) => p.team !== null)).toBe(true);
  });
});

describe("inhouse — queue MMR trust", () => {
  it("prefers the league registration MMR over the typed value", async () => {
    const user = await makeUser("Registered");
    const season = await prisma.season.create({
      data: { name: "IH Trust", status: "REGULAR_SEASON", isActive: false },
    });
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        mmr: 4321,
        status: "ACTIVE",
      },
    });
    // The client claims 12000 — the league-trusted number wins.
    expect((await joinQueue(sessionFor(user), 12000)).ok).toBe(true);
    const entry = await prisma.inhouseQueueEntry.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(entry.mmr).toBe(4321);
  });

  it("falls back to the clamped typed value for never-registered players", async () => {
    const user = await makeUser("Unregistered");
    expect((await joinQueue(sessionFor(user), 99999)).ok).toBe(true);
    const entry = await prisma.inhouseQueueEntry.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(entry.mmr).toBe(12000); // clamped, not trusted verbatim
  });

  it("a blank re-join reuses the last lobby's MMR snapshot (Run it back)", async () => {
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: 7000000030,
        team1,
        team2,
        radiantWin: true,
        startTime: Math.floor(lobby.createdAt.getTime() / 1000) + 120,
      }),
    );
    expect((await recordMatch(players[0].session, "7000000030")).ok).toBe(true);

    // players[3] queued at 4700 originally; the one-tap re-join sends mmr 0.
    expect((await joinQueue(players[3].session, 0)).ok).toBe(true);
    const entry = await prisma.inhouseQueueEntry.findUniqueOrThrow({
      where: { userId: players[3].user.id },
    });
    expect(entry.mmr).toBe(4700);
  });
});

// Medal MMR validation: joinQueue snaps whatever the trust chain resolved —
// typed value, stale registration, or lobby snapshot — to the OpenDota
// medal's plausible window (clampMmrToRank), so captain selection and the
// balance meter can't be gamed by a typed number the medal contradicts.
describe("inhouse — medal MMR validation on joinQueue", () => {
  async function medaledUser(name: string, rankTier: number | null) {
    const user = await makeUser(name);
    if (rankTier != null) {
      await prisma.user.update({ where: { id: user.id }, data: { rankTier } });
    }
    return user;
  }

  async function queuedMmr(userId: string) {
    return (
      await prisma.inhouseQueueEntry.findUniqueOrThrow({ where: { userId } })
    ).mmr;
  }

  it("snaps an inflated typed MMR to the medal window's floor", async () => {
    // Legend 4 (tier 54) window is 3119–4118; an Immortal-sized claim lies.
    const user = await medaledUser("Inflated", 54);
    expect((await joinQueue(sessionFor(user), 6800)).ok).toBe(true);
    expect(await queuedMmr(user.id)).toBe(3119);
  });

  it("keeps a typed MMR the medal finds plausible", async () => {
    const user = await medaledUser("Honest", 54);
    await joinQueue(sessionFor(user), 4000);
    expect(await queuedMmr(user.id)).toBe(4000);
  });

  it("seeds a blank join from the medal floor instead of unknown", async () => {
    const user = await medaledUser("Blank", 54);
    await joinQueue(sessionFor(user), 0);
    expect(await queuedMmr(user.id)).toBe(3119);
  });

  it("trusts a registration MMR as-is — even outside the medal window", async () => {
    // Registration MMRs are league-approved: clamped at their own save, or
    // deliberately set by an admin override (the stale-medal escape hatch,
    // which this path must not silently undo).
    const season = await makeSeason();
    const user = await medaledUser("AdminFixed", 11); // Herald 1: window 0–576
    await prisma.registration.create({
      data: { seasonId: season.id, userId: user.id, mmr: 4800 },
    });
    await joinQueue(sessionFor(user), 0);
    expect(await queuedMmr(user.id)).toBe(4800);
  });

  it("clamps an out-of-window lobby-snapshot fallback on a blank re-join", async () => {
    // No registration; the last lobby's snapshot (self-reported back then)
    // still gets the medal check.
    const user = await medaledUser("OldSnapshot", 54);
    const lobby = await prisma.inhouseLobby.create({
      data: { status: INHOUSE_STATUS.COMPLETED, radiantTeam: 1, winnerTeam: 1 },
    });
    await prisma.inhouseLobbyPlayer.create({
      data: { lobbyId: lobby.id, userId: user.id, mmr: 6000, team: 1 },
    });
    await joinQueue(sessionFor(user), 0);
    expect(await queuedMmr(user.id)).toBe(3119);
  });

  it("leaves the typed value alone when there's no medal on file", async () => {
    const user = await medaledUser("NoMedal", null);
    await joinQueue(sessionFor(user), 3000);
    expect(await queuedMmr(user.id)).toBe(3000);
  });
});

describe("inhouse — an admin can void a wrong result", () => {
  it("removes it from the ladder and recomputes everyone's record", async () => {
    const admin = sessionFor(await makeUser("Void Admin", "ADMIN"));
    const g = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(g.lobby.id);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: 7200000001,
        team1,
        team2,
        radiantWin: true,
        startTime: Math.floor(Date.now() / 1000),
      }),
    );
    expect((await recordMatch(g.players[0].session, "7200000001")).ok).toBe(
      true,
    );

    const ladder = async () => {
      const completed = await prisma.inhouseLobby.findMany({
        where: { status: INHOUSE_STATUS.COMPLETED },
        include: { players: { include: { user: true } } },
      });
      return summarizeInhouse(
        completed.map((l) => ({
          id: l.id,
          winnerTeam: l.winnerTeam,
          createdAt: l.createdAt,
          players: l.players.map((p) => ({
            userId: p.userId,
            name: p.user.name,
            avatar: p.user.avatar,
            team: p.team,
          })),
        })),
      );
    };
    expect((await ladder()).some((r) => r.wins === 1)).toBe(true);

    // Players can't do this.
    expect((await voidLastResult(g.players[0].session)).ok).toBe(false);

    expect((await voidLastResult(admin)).ok).toBe(true);

    const after = await prisma.inhouseLobby.findUnique({
      where: { id: g.lobby.id },
    });
    expect(after?.status).toBe(INHOUSE_STATUS.CANCELLED);
    expect(after?.winnerTeam).toBeNull();
    expect(after?.dotaMatchId).toBeNull();
    expect(after?.eloDeltas).toBe("{}");

    // The Elo swing is gone with it — the ladder is computed from the
    // surviving COMPLETED lobbies, so nobody carries a phantom win.
    expect(await ladder()).toEqual([]);

    // Voiding twice is a no-op, not a double-apply.
    expect((await voidLastResult(admin)).ok).toBe(false);
  });

  it("bare void prefers the newest stamped result, then falls back to legacy null timestamps", async () => {
    const admin = sessionFor(await makeUser("Legacy Void Admin", "ADMIN"));
    const legacy = await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.COMPLETED,
        radiantTeam: 1,
        winnerTeam: 1,
        createdAt: new Date(Date.now() - 60_000),
        completedAt: null,
      },
    });
    const stamped = await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.COMPLETED,
        radiantTeam: 1,
        winnerTeam: 2,
        completedAt: new Date(),
      },
    });

    // PostgreSQL puts nulls first for DESC while SQLite puts them last. The
    // explicit non-null query must therefore choose the stamped row on both.
    expect((await voidLastResult(admin)).ok).toBe(true);
    expect(
      (
        await prisma.inhouseLobby.findUniqueOrThrow({
          where: { id: stamped.id },
        })
      ).status,
    ).toBe(INHOUSE_STATUS.CANCELLED);
    expect(
      (
        await prisma.inhouseLobby.findUniqueOrThrow({
          where: { id: legacy.id },
        })
      ).status,
    ).toBe(INHOUSE_STATUS.COMPLETED);

    // Pre-migration history remains recoverable once no stamped result remains.
    expect((await voidLastResult(admin)).ok).toBe(true);
    expect(
      (
        await prisma.inhouseLobby.findUniqueOrThrow({
          where: { id: legacy.id },
        })
      ).status,
    ).toBe(INHOUSE_STATUS.CANCELLED);
  });

  it("voids the NAMED game when a lobbyId is given, not the newest", async () => {
    // The /inhouse/history control targets a specific row — a result landing
    // between the admin's look and their click must never redirect the void.
    const admin = sessionFor(await makeUser("Targeted Void Admin", "ADMIN"));
    const older = await prisma.inhouseLobby.create({
      data: { status: INHOUSE_STATUS.COMPLETED, radiantTeam: 1, winnerTeam: 1 },
    });
    const newer = await prisma.inhouseLobby.create({
      data: { status: INHOUSE_STATUS.COMPLETED, radiantTeam: 1, winnerTeam: 2 },
    });

    expect((await voidLastResult(admin, older.id)).ok).toBe(true);

    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: older.id } }))
        .status,
    ).toBe(INHOUSE_STATUS.CANCELLED);
    // The newest result — which the bare form would have voided — survives.
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: newer.id } }))
        .status,
    ).toBe(INHOUSE_STATUS.COMPLETED);

    // A named target that isn't a completed result is refused, not redirected.
    const again = await voidLastResult(admin, older.id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/already be voided/i);
  });
});

// ---------------------------------------------------------------------------
// Recovery from the two states that used to need an admin
// ---------------------------------------------------------------------------

describe("inhouse — abandoned lobby teardown", () => {
  /** Backdate the field the abandonment floor is measured from. */
  const age = (
    lobbyId: string,
    field: "updatedAt" | "startedAt",
    hours: number,
  ) =>
    prisma.inhouseLobby.update({
      where: { id: lobbyId },
      data: { [field]: new Date(Date.now() - hours * 3_600_000) },
    });

  it("keeps an anonymous spectator snapshot side-effect-free", async () => {
    const admin = sessionFor(await makeUser("AdminSpectator", "ADMIN"));
    const { lobby } = await runToInProgress(admin);
    await age(lobby.id, "startedAt", INHOUSE.ABANDON_IN_PROGRESS_HOURS + 1);

    await getInhouseState(null, {
      runMaintenance: false,
      syncBoard: false,
    });
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: lobby.id } }))
        .status,
    ).toBe(INHOUSE_STATUS.IN_PROGRESS);

    await getInhouseState(null, { syncBoard: false });
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: lobby.id } }))
        .status,
    ).toBe(INHOUSE_STATUS.CANCELLED);
  });

  it("scraps a READY lobby nobody ever started, and frees its players + the slot", async () => {
    const admin = sessionFor(await makeUser("AdminAB", "ADMIN"));
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 4000 - i * 50);
    await voteAll(players, "MMR");
    await driveDraftToReady(admin);
    const ready = await lobbyByStatus(INHOUSE_STATUS.READY);

    // While it's fresh, nothing touches it — a group can legitimately sit in
    // READY for a long time hosting the in-client lobby.
    await getInhouseState(null);
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: ready.id } }))
        .status,
    ).toBe(INHOUSE_STATUS.READY);
    // …and its players are still locked out of the queue, correctly.
    expect((await joinQueue(players[0].session, 3000)).ok).toBe(false);

    await age(ready.id, "updatedAt", INHOUSE.ABANDON_READY_HOURS + 1);
    await getInhouseState(null); // any page view, by anyone, signed out included

    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: ready.id } }))
        .status,
    ).toBe(INHOUSE_STATUS.CANCELLED);
    // The single active-lobby slot is free again, so the feature works: the
    // ten who were stranded can queue, and a fresh lobby can form.
    expect(
      await prisma.inhouseLobby.count({
        where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      }),
    ).toBe(0);
    expect((await joinQueue(players[0].session, 3000)).ok).toBe(true);
  });

  it("scraps an IN_PROGRESS lobby whose result never landed", async () => {
    const admin = sessionFor(await makeUser("AdminAB2", "ADMIN"));
    const { lobby } = await runToInProgress(admin);

    // Inside the window it's left alone — the game may still be running, and
    // Start can be pressed late, so the floor has to be generous.
    await age(lobby.id, "startedAt", INHOUSE.ABANDON_IN_PROGRESS_HOURS - 1);
    await getInhouseState(null);
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: lobby.id } }))
        .status,
    ).toBe(INHOUSE_STATUS.IN_PROGRESS);

    await age(lobby.id, "startedAt", INHOUSE.ABANDON_IN_PROGRESS_HOURS + 1);
    await getInhouseState(null);
    const after = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(after.status).toBe(INHOUSE_STATUS.CANCELLED);
    // Cancelled, not COMPLETED: there is no result, so nothing may reach the
    // ladder and no Discord result may be announced.
    expect(after.winnerTeam).toBeNull();
  });

  it("loses to a result that lands first — a played game is never scrapped", async () => {
    const admin = sessionFor(await makeUser("AdminAB3", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: 991001,
        team1,
        team2,
        radiantWin: true,
        startTime: Math.floor(Date.now() / 1000),
      }) as never,
    );
    expect((await recordMatch(players[0].session, "991001")).ok).toBe(true);

    // Backdating a COMPLETED lobby must not resurrect the teardown: the
    // resolver's OR only matches READY/IN_PROGRESS.
    await age(lobby.id, "startedAt", INHOUSE.ABANDON_IN_PROGRESS_HOURS + 5);
    await getInhouseState(null);
    expect(
      (await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: lobby.id } }))
        .status,
    ).toBe(INHOUSE_STATUS.COMPLETED);
  });
});

describe("inhouse — the draft can't be left off the clock", () => {
  it("puts a DRAFTING lobby that lost its pickTeam back on the clock", async () => {
    const admin = sessionFor(await makeUser("AdminLC", "ADMIN"));
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 4500 - i * 100);
    await voteAll(players, "MMR");
    const drafting = await lobbyByStatus(INHOUSE_STATUS.DRAFTING);

    // The frozen state: pickTeam is nulled for a few statements as applyPick's
    // turn claim, so anything that commits in between used to strand the draft
    // where NO resolver looks (resolveStalledPick filters pickTeam not-null,
    // makePick bails on !pickTeam) — a dead clock for all ten until an admin
    // cancelled. applyPick now throws so the claim rolls back; this is the
    // belt-and-braces that makes the state unreachable rather than just fixed.
    await prisma.inhouseLobby.update({
      where: { id: drafting.id },
      data: { pickTeam: null, pickEndsAt: new Date(Date.now() - 60_000) },
    });
    // Nothing that looks for a stalled clock can see it in this state — that
    // is the whole reason it was terminal. (Don't assert this via makePick:
    // makePick runs resolveStalledPick first, so it now heals the lobby and
    // legitimately succeeds, and WHICH player id you hand it depends on row
    // order — an accidentally-passing, order-dependent assertion.)
    expect(
      await prisma.inhouseLobby.count({
        where: { status: INHOUSE_STATUS.DRAFTING, pickTeam: { not: null } },
      }),
    ).toBe(0);

    await getInhouseState(null); // any poll, by anyone
    const back = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: drafting.id },
    });
    expect(back.status).toBe(INHOUSE_STATUS.DRAFTING);
    // Recomputed from the rosters, so it's the turn the snake actually owes:
    // no picks made yet, so it's still the first-pick team's.
    expect(back.pickTeam).toBe(INHOUSE.FIRST_PICK_TEAM);
    expect(back.pickEndsAt!.getTime()).toBeGreaterThan(Date.now());

    // And the draft simply carries on from there.
    await driveDraftToReady(admin);
    expect((await lobbyByStatus(INHOUSE_STATUS.READY)).id).toBe(drafting.id);
  });

  it("flips to READY if the rosters were already full when the turn was lost", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 4500 - i * 100);
    await voteAll(players, "MMR");
    const drafting = await lobbyByStatus(INHOUSE_STATUS.DRAFTING);
    // Fill both sides behind the draft's back, then drop the clock.
    const pool = drafting.players.filter((p) => !p.isCaptain);
    for (const [i, p] of pool.entries()) {
      await prisma.inhouseLobbyPlayer.update({
        where: { id: p.id },
        data: { team: i % 2 === 0 ? 1 : 2, pickIndex: i },
      });
    }
    await prisma.inhouseLobby.update({
      where: { id: drafting.id },
      data: { pickTeam: null, pickEndsAt: new Date(Date.now() - 60_000) },
    });

    await getInhouseState(null);
    expect(
      (
        await prisma.inhouseLobby.findUniqueOrThrow({
          where: { id: drafting.id },
        })
      ).status,
    ).toBe(INHOUSE_STATUS.READY);
  });

  it("survives concurrent auto-picks at a SNAKE PAIR BOUNDARY", async () => {
    // The one interleaving that actually froze the draft, and it needs the
    // exact setup below — a generic "fire N picks at once" version passes even
    // against the broken code, which is how this survived the first audit.
    //
    // The snake is 2,1,1,2,2,1,1,2, so picks 1 and 2 are BOTH team 1. When the
    // clock expires there, every poller calls resolveStalledPick and they all
    // target the same top-MMR pool player. The winner assigns them and
    // advances pickTeam back to 1; a loser that was blocked on the winner's
    // row lock then re-evaluates `pickTeam: 1`, MATCHES, and nulls it — and
    // before the fix its `return` committed that, leaving the lobby DRAFTING
    // and off the clock, which nothing in the system can move.
    //
    // Verified to reproduce: against the pre-fix service on real Postgres this
    // ends `status=DRAFTING pickTeam=null` every run. SQLite serializes
    // writers so it can't interleave — `npm run test:pg` is what makes this
    // test mean anything.
    const admin = sessionFor(await makeUser("AdminRace", "ADMIN"));
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 4500 - i * 100);
    await voteAll(players, "MMR");
    const drafting = await lobbyByStatus(INHOUSE_STATUS.DRAFTING);

    // Take pick 0 (the first-pick team's single) so the next two picks — the
    // pair — both belong to the other team.
    const pool0 = drafting.players
      .filter((p) => p.team === null)
      .sort((a, b) => b.mmr - a.mmr);
    expect((await makePick(admin, pool0[0].userId)).ok).toBe(true);
    const onClock = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: drafting.id },
    });
    const pairTeam = onClock.pickTeam;
    expect(pairTeam).not.toBeNull();

    // Run the clock out and let every poller hit it together.
    await prisma.inhouseLobby.update({
      where: { id: drafting.id },
      data: { pickEndsAt: new Date(Date.now() - 5_000) },
    });
    await raceN(8, () => resolveStalledPick());

    const after = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: drafting.id },
      include: { players: true },
    });
    // THE invariant: a DRAFTING lobby is always on the clock. Off it, no
    // resolver and no captain can ever move the draft again — ten players
    // watching a dead timer with an admin cancel as the only exit.
    expect(
      after.status === INHOUSE_STATUS.DRAFTING && after.pickTeam === null,
    ).toBe(false);
    // And the turn was consumed once, not once per racer.
    const drafted = after.players.filter(
      (p) => p.team !== null && !p.isCaptain,
    );
    expect(new Set(drafted.map((p) => p.userId)).size).toBe(drafted.length);
    expect(drafted.length).toBeLessThanOrEqual(3); // pick 0 + at most the pair
  });
});

describe("inhouse — the played game is the truth", () => {
  it("credits a side-swapped player with the side they ACTUALLY played", async () => {
    const admin = sessionFor(await makeUser("AdminSwap", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);

    // Nothing enforces sides in the manually hosted Dota lobby — players click
    // their own slots. One from each drafted team swaps: the last of team 1
    // plays Dire, the first of team 2 plays Radiant. classifyGame's majority
    // vote absorbs that (4 of 5 on each side), so the game imports normally.
    const radiantSide = [...team1.slice(0, 4), team2[0]];
    const direSide = [...team2.slice(1), team1[4]];
    const swappedOut = team1[4]; // drafted team 1, actually played (and lost) Dire
    const swappedIn = team2[0]; // drafted team 2, actually played (and won) Radiant

    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: 992002,
        team1: radiantSide,
        team2: direSide,
        radiantWin: true,
        startTime: Math.floor(Date.now() / 1000),
      }) as never,
    );
    expect((await recordMatch(players[0].session, "992002")).ok).toBe(true);

    const done = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
      include: { players: { include: { user: true } } },
    });
    expect(done.winnerTeam).toBe(1);
    expect(done.radiantTeam).toBe(1);

    const accOf = (p: (typeof done.players)[number]) =>
      effectiveDotaAccountId(p.user)!;
    const rowFor = (acc: number) => done.players.find((p) => accOf(p) === acc)!;

    // Rosters follow the game, not the draft — otherwise the ladder credits a
    // win to the five who lost.
    expect(rowFor(swappedOut).team).toBe(2);
    expect(rowFor(swappedIn).team).toBe(1);
    expect(done.players.filter((p) => p.team === 1)).toHaveLength(5);
    expect(done.players.filter((p) => p.team === 2)).toHaveLength(5);

    // The stored box score agrees with the roster it's rendered beside — the
    // result card groups lines by the game's real isRadiant.
    const box = JSON.parse(done.boxScore) as {
      userId: string | null;
      team: number | null;
      isRadiant: boolean;
    }[];
    for (const line of box.filter((l) => l.userId)) {
      expect(line.team).toBe(line.isRadiant ? 1 : 2);
    }

    // And the Elo swing lands on the players who actually won.
    const deltas = JSON.parse(done.eloDeltas) as Record<string, number>;
    expect(deltas[rowFor(swappedIn).userId]).toBeGreaterThan(0);
    expect(deltas[rowFor(swappedOut).userId]).toBeLessThan(0);
  });

  it("leaves an unswapped game's rosters exactly as drafted", async () => {
    const admin = sessionFor(await makeUser("AdminNoSwap", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const before = await teamAccounts(lobby.id);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: 992003,
        team1: before.team1,
        team2: before.team2,
        radiantWin: false,
        startTime: Math.floor(Date.now() / 1000),
      }) as never,
    );
    expect((await recordMatch(players[0].session, "992003")).ok).toBe(true);
    const after = await teamAccounts(lobby.id);
    expect(new Set(after.team1)).toEqual(new Set(before.team1));
    expect(new Set(after.team2)).toEqual(new Set(before.team2));
  });
});

describe("inhouse — auto-detect blames the right thing", () => {
  it("says OpenDota was unreachable when too many lookups failed to be conclusive", async () => {
    const admin = sessionFor(await makeUser("AdminUR", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1 } = await teamAccounts(lobby.id);

    // Three lookups survive a rate-limit burst and all three DO contain the
    // game — but a candidate needs four votes, so detection is structurally
    // impossible. Blaming that on privacy settings sends ten players hunting
    // through Dota's options for a problem they don't have.
    const alive = new Set(team1.slice(0, 3));
    mockRecent.mockImplementation(async (acc: number) =>
      alive.has(acc) ? [993004] : null,
    );

    const res = await autoDetectResult(players[0].session);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/OpenDota didn't respond/);
    // It never even spent a match fetch on an unwinnable scan.
    expect(mockMatch).not.toHaveBeenCalled();
  });

  it("still blames privacy settings when every lookup answered", async () => {
    const admin = sessionFor(await makeUser("AdminPriv", "ADMIN"));
    const { players } = await runToInProgress(admin);
    mockRecent.mockResolvedValue([]); // all reachable, nobody's game is public

    const res = await autoDetectResult(players[0].session);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/Expose Public Match Data/);
  });
});

// ---------------------------------------------------------------------------
// Claim guards: each of these deletes to a BLIND write, and the only thing that
// notices is contention. Every one is "race N callers, exactly one may win" —
// with the guard removed, all N win, which is the assertion. They interleave
// only under `npm run test:pg` (raceN is sequential on SQLite, where Prisma's
// single connection would queue rather than race); the mutation guard in CI
// runs there, which is what keeps these honest.
// ---------------------------------------------------------------------------

describe("inhouse — guarded claims fire exactly once under contention", () => {
  it("startGame: only one of N simultaneous starts may launch the game", async () => {
    const admin = sessionFor(await makeUser("AdminSG", "ADMIN"));
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 4000 - i * 50);
    await voteAll(players, "MMR");
    await driveDraftToReady(admin);
    const lobby = await lobbyByStatus(INHOUSE_STATUS.READY);

    const res = await raceN(4, () => startGame(players[0].session));
    expect(res.filter((r) => r.ok)).toHaveLength(1);

    const after = await prisma.inhouseLobby.findUniqueOrThrow({
      where: { id: lobby.id },
    });
    expect(after.status).toBe(INHOUSE_STATUS.IN_PROGRESS);
  });

  it("cancelLobby: only one of N simultaneous admin cancels may scrap it", async () => {
    const admin = sessionFor(await makeUser("AdminCL", "ADMIN"));
    await voteAll(
      await enqueue(INHOUSE.LOBBY_SIZE, (i) => 4000 - i * 50),
      "MMR",
    );

    const res = await raceN(4, () => cancelLobby(admin));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(
      await prisma.inhouseLobby.count({
        where: { status: INHOUSE_STATUS.CANCELLED },
      }),
    ).toBe(1);
  });

  it("voidLastResult: only one of N simultaneous voids may undo the result", async () => {
    const admin = sessionFor(await makeUser("AdminVD", "ADMIN"));
    const { players, lobby } = await runToInProgress(admin);
    const { team1, team2 } = await teamAccounts(lobby.id);
    mockMatch.mockResolvedValue(
      fakeMatch({
        matchId: 7100001,
        team1,
        team2,
        radiantWin: true,
        startTime: Math.floor(Date.now() / 1000),
      }) as never,
    );
    expect((await recordMatch(players[0].session, "7100001")).ok).toBe(true);

    const res = await raceN(4, () => voidLastResult(admin));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
  });

  it("resolveAbandonedLobby: only one of N pollers may tear down the dead lobby", async () => {
    const admin = sessionFor(await makeUser("AdminAB4", "ADMIN"));
    const { lobby } = await runToInProgress(admin);
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        startedAt: new Date(
          Date.now() - (INHOUSE.ABANDON_IN_PROGRESS_HOURS + 1) * 3_600_000,
        ),
      },
    });

    const res = await raceN(4, () => resolveAbandonedLobby());
    expect(res.filter(Boolean)).toHaveLength(1);
  });

  it("resolveCaptainVote: only one of N pollers may install captains", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 4000 - i * 50);
    await acceptAll(players);
    // Everyone votes but the last, so the vote is ripe without having been
    // resolved inline by castVote.
    for (const p of players.slice(0, INHOUSE.LOBBY_SIZE - 1)) {
      await castVote(p.session, "MMR");
    }
    const lobby = await lobbyByStatus(INHOUSE_STATUS.CAPTAIN_VOTE);
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: { voteEndsAt: new Date(Date.now() - 1000) },
    });

    const res = await raceN(4, () => resolveCaptainVote());
    expect(res.filter(Boolean)).toHaveLength(1);
    // Exactly two captains, not two per resolver that ran.
    const caps = await prisma.inhouseLobbyPlayer.count({
      where: { lobbyId: lobby.id, isCaptain: true },
    });
    expect(caps).toBe(2);
  });

  it("failReadyCheck: only one of N simultaneous declines may fail the check", async () => {
    const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
    const res = await raceAll([
      () => declineMatch(players[8].session),
      () => declineMatch(players[9].session),
      () => declineMatch(players[7].session),
    ]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(
      await prisma.inhouseLobby.count({
        where: { status: INHOUSE_STATUS.CANCELLED },
      }),
    ).toBe(1);
  });

  it("autoDetectResult: N impatient players cost ONE OpenDota scan, not N", async () => {
    // The documented API-budget guard: each press is ~16 OpenDota calls, and
    // ten players hammering the button after a game once drained the shared
    // budget and took LEAGUE result sync down with it. The throttle claim is
    // the only thing bounding it.
    const admin = sessionFor(await makeUser("AdminDT", "ADMIN"));
    const { players } = await runToInProgress(admin);
    mockRecent.mockResolvedValue([]); // reachable, but nobody's game is public
    mockRecent.mockClear();

    const res = await raceN(4, () => autoDetectResult(players[0].session));
    expect(res.filter((r) => r.ok)).toHaveLength(0); // no game to find
    // Exactly one caller won the claim, so exactly one fan-out happened.
    expect(mockRecent.mock.calls.length).toBe(INHOUSE.LOBBY_SIZE);
  });

  it("maybeAutoDetectResult: N concurrent pollers cost ONE background scan", async () => {
    // Same budget guard on the POLL path, where the contention is routine
    // rather than exceptional: every open /inhouse tab and every sitewide
    // /api/sync ping calls this.
    const admin = sessionFor(await makeUser("AdminMD", "ADMIN"));
    const { lobby } = await runToInProgress(admin);
    await prisma.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        startedAt: new Date(
          Date.now() - (INHOUSE.DETECT_MIN_MINUTES + 1) * 60_000,
        ),
      },
    });
    mockRecent.mockResolvedValue([]);
    mockRecent.mockClear();

    const res = await raceN(4, () => maybeAutoDetectResult());
    expect(res.filter(Boolean)).toHaveLength(0); // nothing found
    expect(mockRecent.mock.calls.length).toBe(INHOUSE.LOBBY_SIZE);
  });
});

// ---------------------------------------------------------------------------
// FAULT-INJECTED claims. These four need one exact interleaving — the caller
// READS, a rival COMMITS, the caller WRITES — which Promise.all cannot steer.
// The service yields at a labelled seam (src/lib/race-hook.ts) and the test
// commits the rival there, making the ordering deterministic instead of
// hoped-for. Postgres only: the rival runs on a second connection, and SQLite
// pins one, so a rival issued inside an open transaction would HANG.
// ---------------------------------------------------------------------------

describe.skipIf(!ON_POSTGRES)(
  "inhouse — claims that need a staged interleaving",
  () => {
    afterEach(() => setRaceHook(null));

    /** Ten players, voted through to a live draft. */
    async function draftingLobby(tag: string) {
      const admin = sessionFor(await makeUser(`AdminFI${tag}`, "ADMIN"));
      const players = await enqueue(INHOUSE.LOBBY_SIZE, (i) => 4500 - i * 100);
      await voteAll(players, "MMR");
      const lobby = await lobbyByStatus(INHOUSE_STATUS.DRAFTING);
      return { admin, players, lobby };
    }

    it("refuses a ballot whose deadline expires between validation and the player write", async () => {
      const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
      await acceptAll(players);
      const lobby = await lobbyByStatus(INHOUSE_STATUS.CAPTAIN_VOTE);

      let fired = false;
      setRaceHook(
        onceAt("inhouse.castVote.beforeClaim", async () => {
          fired = true;
          await prisma.inhouseLobby.update({
            where: { id: lobby.id },
            data: { voteEndsAt: new Date(Date.now() - 1000) },
          });
        }),
      );

      const res = await castVote(players[0].session, "MMR");
      expect(fired).toBe(true);
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toMatch(/voting.*closed/i);
      expect(
        (
          await prisma.inhouseLobbyPlayer.findFirstOrThrow({
            where: { lobbyId: lobby.id, userId: players[0].user.id },
          })
        ).votedMethod,
      ).toBeNull();
    });

    it("orders a void behind an in-flight result publication", async () => {
      const admin = sessionFor(await makeUser("AdminFIPublish", "ADMIN"));
      const { players, lobby } = await runToInProgress(admin);
      const { team1, team2 } = await teamAccounts(lobby.id);
      mockMatch.mockResolvedValue(
        fakeMatch({
          matchId: 994001,
          team1,
          team2,
          radiantWin: true,
          startTime: Math.floor(Date.now() / 1000),
        }),
      );
      mockSend.mockClear();

      const messages: string[] = [];
      let releaseResult!: (accepted: boolean) => void;
      let markResultStarted!: () => void;
      const heldResult = new Promise<boolean>((resolve) => {
        releaseResult = resolve;
      });
      const resultStarted = new Promise<void>((resolve) => {
        markResultStarted = resolve;
      });
      mockSend.mockImplementation(async (message) => {
        messages.push(message);
        if (message.includes("Inhouse result:")) {
          markResultStarted();
          return heldResult;
        }
        return true;
      });

      const pendingRecord = recordMatch(players[0].session, "994001");
      await resultStarted;

      let voided!: Awaited<ReturnType<typeof voidLastResult>>;
      let messagesBeforeResultRelease: string[] = [];
      let statusesBeforeResultRelease: string[] = [];
      try {
        // The RESULT row owns a SENDING lease here. The void transaction may
        // cancel only a still-PENDING result; its correction must remain
        // PENDING behind this in-flight sequence until the send resolves.
        voided = await voidLastResult(admin, lobby.id);
        messagesBeforeResultRelease = [...messages];
        statusesBeforeResultRelease = (
          await prisma.inhouseAnnouncement.findMany({
            where: { lobbyId: lobby.id },
            orderBy: { sequence: "asc" },
            select: { status: true },
          })
        ).map((event) => event.status);
      } finally {
        // Always settle the parked worker, including when an assertion or the
        // void path throws, so this interleaving cannot leak into later tests.
        releaseResult(true);
      }

      expect((await pendingRecord).ok).toBe(true);
      // The original worker normally observes sequence 2 after completing
      // sequence 1; this explicit drain also proves no durable work is left if
      // that implementation detail changes.
      await deliverInhouseAnnouncements({ lobbyId: lobby.id });

      expect(voided.ok).toBe(true);
      expect(messagesBeforeResultRelease).toHaveLength(1);
      expect(messagesBeforeResultRelease[0]).toContain("Inhouse result:");
      expect(statusesBeforeResultRelease).toEqual([
        INHOUSE_ANNOUNCEMENT_STATUS.SENDING,
        INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
      ]);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain("Inhouse result:");
      expect(messages[1]).toContain("result has been voided");
      expect(
        (
          await prisma.inhouseLobby.findUniqueOrThrow({
            where: { id: lobby.id },
          })
        ).status,
      ).toBe(INHOUSE_STATUS.CANCELLED);
    });

    it("refuses a pick whose TURN moved on, even to the same team", async () => {
      // The snake repeats a team across consecutive picks, so `pickTeam` alone
      // does not identify a turn — `pickEndsAt` does. The rival below completes
      // the previous turn and hands the SAME team the next one with a fresh
      // deadline; without that clause in the claim, this caller's stale read
      // wins a turn that was never its own and two players land on one pick.
      const { admin, lobby } = await draftingLobby("Turn");
      // One real pick so the next two turns both belong to the same team.
      const pool0 = lobby.players
        .filter((p) => p.team === null)
        .sort((a, b) => b.mmr - a.mmr);
      expect((await makePick(admin, pool0[0].userId)).ok).toBe(true);

      const live = await prisma.inhouseLobby.findUniqueOrThrow({
        where: { id: lobby.id },
        include: { players: true },
      });
      const onClock = live.pickTeam!;
      const pool = live.players.filter((p) => p.team === null);
      const [target, rivalPick] = pool;

      let fired = false;
      setRaceHook(
        onceAt("inhouse.applyPick.beforeTurnClaim", async () => {
          fired = true;
          // The rival's pick lands and the turn advances to the SAME team with a
          // NEW deadline. Two rows, neither written by the open transaction.
          await prisma.inhouseLobbyPlayer.update({
            where: { id: rivalPick.id },
            data: { team: onClock, pickIndex: 1 },
          });
          await prisma.inhouseLobby.update({
            where: { id: lobby.id },
            data: {
              pickTeam: onClock,
              pickEndsAt: new Date(Date.now() + 60_000),
            },
          });
        }),
      );

      const res = await makePick(admin, target.userId);
      expect(fired).toBe(true); // the seam was reached — not a vacuous pass
      expect(res.ok).toBe(false);
      expect(
        (
          await prisma.inhouseLobbyPlayer.findUniqueOrThrow({
            where: { id: target.id },
          })
        ).team,
      ).toBeNull();
      // One turn consumed one player: the first real pick plus the rival's.
      expect(
        await prisma.inhouseLobbyPlayer.count({
          where: { lobbyId: lobby.id, isCaptain: false, team: { not: null } },
        }),
      ).toBe(2);
    });

    it("refuses a pick whose TARGET was drafted between the read and the claim", async () => {
      const { admin, lobby } = await draftingLobby("Target");
      const pool = lobby.players.filter((p) => p.team === null);
      const target = pool[0];

      let fired = false;
      setRaceHook(
        onceAt("inhouse.applyPick.beforePlayerClaim", async () => {
          fired = true;
          // A rival takes the very player being drafted. Player row only — the
          // open transaction has written the lobby row, not this one.
          await prisma.inhouseLobbyPlayer.update({
            where: { id: target.id },
            data: { team: 1, pickIndex: 0 },
          });
        }),
      );

      const res = await makePick(admin, target.userId);
      expect(fired).toBe(true);
      expect(res.ok).toBe(false);
      // AND the turn claim rolled back — the draft is still on the clock, not
      // frozen with pickTeam null (the PickRaceError contract).
      const after = await prisma.inhouseLobby.findUniqueOrThrow({
        where: { id: lobby.id },
      });
      expect(after.status).toBe(INHOUSE_STATUS.DRAFTING);
      expect(after.pickTeam).not.toBeNull();
    });

    it("puts a lost pick turn back exactly once when two pollers restore it", async () => {
      const { lobby } = await draftingLobby("Restore");
      await prisma.inhouseLobby.update({
        where: { id: lobby.id },
        data: { pickTeam: null, pickEndsAt: new Date(Date.now() - 60_000) },
      });

      let fired = false;
      setRaceHook(
        onceAt("inhouse.restoreLostPickTurn.beforeClaim", async () => {
          fired = true;
          // Another poller got there first and put the lobby back on the clock.
          await prisma.inhouseLobby.update({
            where: { id: lobby.id },
            data: { pickTeam: 1, pickEndsAt: new Date(Date.now() + 60_000) },
          });
        }),
      );

      await resolveStalledPick();
      expect(fired).toBe(true);
      const after = await prisma.inhouseLobby.findUniqueOrThrow({
        where: { id: lobby.id },
      });
      // The rival's restore stands; ours must not have overwritten its deadline.
      expect(after.pickTeam).toBe(1);
      expect(after.pickEndsAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it("won't auto-assign the last pool player if a rival took them first", async () => {
      // The last-pick auto-assign skips a pointless 60s clock when one player
      // remains. Its claim is what stops it assigning someone a rival already
      // took — which would put a player on BOTH sides of the roster count.
      const { admin, lobby } = await draftingLobby("Last");
      // Drive to exactly two pool players, so the NEXT pick triggers the
      // auto-assign of the final one.
      for (let guard = 0; guard < 20; guard++) {
        const live = await prisma.inhouseLobby.findUniqueOrThrow({
          where: { id: lobby.id },
          include: { players: true },
        });
        const pool = live.players
          .filter((p) => p.team === null)
          .sort((a, b) => b.mmr - a.mmr);
        if (pool.length <= 2) break;
        expect((await makePick(admin, pool[0].userId)).ok).toBe(true);
      }
      const live = await prisma.inhouseLobby.findUniqueOrThrow({
        where: { id: lobby.id },
        include: { players: true },
      });
      const pool = live.players
        .filter((p) => p.team === null)
        .sort((a, b) => b.mmr - a.mmr);
      expect(pool).toHaveLength(2);
      const [target, last] = pool;

      let fired = false;
      setRaceHook(
        onceAt("inhouse.applyPick.beforeLastAssign", async () => {
          fired = true;
          // A rival grabs the final player before the auto-assign can.
          await prisma.inhouseLobbyPlayer.update({
            where: { id: last.id },
            data: { team: 1, pickIndex: 99 },
          });
        }),
      );

      const res = await makePick(admin, target.userId);
      expect(fired).toBe(true);
      expect(res.ok).toBe(true); // the caller's OWN pick still lands

      // The rival's assignment stands — the auto-assign did not overwrite it,
      // and nobody was counted onto a side twice.
      const after = await prisma.inhouseLobbyPlayer.findUniqueOrThrow({
        where: { id: last.id },
      });
      expect(after.team).toBe(1);
      expect(after.pickIndex).toBe(99);
    });

    it("an accept lands on nothing when the check is cancelled mid-call", async () => {
      // The relation filter's whole job: a decline committing between the
      // accepter's read and their write must not leave acceptedAt stamped on a
      // dead lobby AND report success to the player.
      const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
      const lobby = await lobbyByStatus(INHOUSE_STATUS.READY_CHECK);

      let fired = false;
      setRaceHook(
        onceAt("inhouse.acceptMatch.beforeClaim", async () => {
          fired = true;
          await prisma.inhouseLobby.update({
            where: { id: lobby.id },
            data: { status: INHOUSE_STATUS.CANCELLED },
          });
        }),
      );

      const res = await acceptMatch(players[0].session);
      expect(fired).toBe(true);
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toMatch(/cancelled/i);
      expect(
        (
          await prisma.inhouseLobbyPlayer.findFirstOrThrow({
            where: { lobbyId: lobby.id, userId: players[0].user.id },
          })
        ).acceptedAt,
      ).toBeNull();
    });

    it("does not resurrect a cancelled check when the last accept opens the vote", async () => {
      // The accept path counts pending players and, on zero, flips the lobby to
      // CAPTAIN_VOTE. Both happen inside one transaction but on a per-statement
      // snapshot, so a decline can CANCEL the lobby in between — and a blind
      // flip then reopens a dead match: ten players pulled back into a vote they
      // were already told was off, while their queue entries (written by the
      // decline) sit alongside a live lobby, which is the one thing
      // joinQueue/maybeFormLobby assume can never happen.
      const players = await enqueue(INHOUSE.LOBBY_SIZE, () => 3000);
      const lobby = await lobbyByStatus(INHOUSE_STATUS.READY_CHECK);
      // Nine accepts, so the tenth is the one that trips the flip.
      for (const p of players.slice(0, INHOUSE.LOBBY_SIZE - 1)) {
        expect((await acceptMatch(p.session)).ok).toBe(true);
      }

      let fired = false;
      setRaceHook(
        onceAt("inhouse.startCaptainVote.beforeFlip", async () => {
          fired = true;
          // A tenth-second too late, one of the nine changes their mind. The
          // decline writes the lobby row and the queue rows — neither touched
          // yet by the open transaction, which has written only its own
          // acceptedAt (so this cannot deadlock).
          expect((await declineMatch(players[0].session)).ok).toBe(true);
        }),
      );

      await acceptMatch(players[INHOUSE.LOBBY_SIZE - 1].session);

      expect(fired).toBe(true); // the seam was reached — not a vacuous pass
      const after = await prisma.inhouseLobby.findUniqueOrThrow({
        where: { id: lobby.id },
      });
      expect(after.status).toBe(INHOUSE_STATUS.CANCELLED);
      // No vote was ever started, so no vote clock: a resurrected lobby would
      // carry one, and resolveCaptainVote would go on to install captains.
      expect(after.voteEndsAt).toBeNull();
      // The decline's requeue stands, and it is NOT shadowed by a live lobby:
      // the decliner dropped, the other nine back in line.
      expect(await prisma.inhouseQueueEntry.count()).toBe(
        INHOUSE.LOBBY_SIZE - 1,
      );
      expect(
        await prisma.inhouseLobby.count({
          where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
        }),
      ).toBe(0);
    });

    it("the DRAFTING re-assert cannot be falsified — the turn claim holds the row", async () => {
      // applyPick's LAST write re-asserts `status: DRAFTING`, and the mutation
      // guard reports that predicate as an equivalent mutant: no test kills it.
      // That is a claim about the code, so pin it rather than trust it. The turn
      // claim a few statements earlier UPDATEs this very row, so from that moment
      // the transaction holds its row lock and nothing — not an admin cancel, not
      // a landed result — can move the status before the advance.
      //
      // NOWAIT is what makes this safe to assert: an ordinary rival UPDATE here
      // would BLOCK on the lock while the transaction waits on the seam, which is
      // a hung suite rather than a failing test. NOWAIT turns "would block" into
      // an immediate error, so the two outcomes are one statement apart.
      //
      // If this goes red, the equivalence justification in
      // scripts/mutation-guard.mjs has expired and the claim needs a real test.
      const { admin, lobby } = await draftingLobby("Lock");
      const target = lobby.players.find((p) => p.team === null)!;
      const takeTheRow = () =>
        prisma.$queryRawUnsafe(
          `SELECT id FROM "InhouseLobby" WHERE id = $1 FOR UPDATE NOWAIT`,
          lobby.id,
        );

      // Positive control FIRST: with no transaction open the same statement
      // succeeds. Without it, a typo'd table name would throw inside the seam and
      // be read as proof of a lock — the test would "pass" having measured
      // nothing, which is the exact failure mode this whole ratchet exists for.
      await takeTheRow();

      let fired = false;
      let rivalCouldTakeTheRow: boolean | null = null;
      let rivalError = "";
      setRaceHook(
        onceAt("inhouse.applyPick.beforeAdvance", async () => {
          fired = true;
          try {
            await takeTheRow();
            rivalCouldTakeTheRow = true;
          } catch (e) {
            rivalCouldTakeTheRow = false;
            rivalError = String((e as Error).message);
          }
        }),
      );

      expect((await makePick(admin, target.userId)).ok).toBe(true);
      expect(fired).toBe(true); // the seam was reached — not a vacuous pass
      expect(rivalCouldTakeTheRow).toBe(false);
      // …and refused for the RIGHT reason (55P03 lock_not_available).
      expect(rivalError).toMatch(/could not obtain lock/i);
    });
  },
);
