import { describe, expect, it, vi } from "vitest";

// buildInhouseState is PURE: any database access from it is a bug. The
// service module imports the Prisma client, so replace it with one that
// throws on every touch and let the tests prove the build never reads.
vi.mock("./prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`buildInhouseState touched prisma.${String(prop)}`);
      },
    },
  ),
}));

import { INHOUSE, INHOUSE_STATUS } from "./constants";
import type { SessionUser } from "./auth";
import {
  buildInhouseState,
  type InhouseRoomRows,
  type InhouseViewerExtras,
} from "./inhouse-service";

const NOW = Date.UTC(2026, 9, 13, 20, 0, 0);
const at = (msAgo: number) => new Date(NOW - msAgo);

const session = (id: string, role = "USER"): SessionUser => ({
  id,
  steamId: `steam-${id}`,
  name: id,
  avatar: null,
  role,
});

type LobbyRow = InhouseRoomRows["lobbies"][number];
type LobbyPlayer = LobbyRow["players"][number];

function lobbyPlayer(
  userId: string,
  over: Partial<Omit<LobbyPlayer, "user">> & {
    inhouseRoles?: string | null;
  } = {},
): LobbyPlayer {
  const { inhouseRoles = "1,2", ...rest } = over;
  return {
    userId,
    team: null,
    isCaptain: false,
    pickIndex: null,
    mmr: 3000,
    acceptedAt: null,
    votedMethod: null,
    votedNomineeId: null,
    wins: 0,
    losses: 0,
    games: 0,
    queuedAt: at(60 * 60_000),
    user: { name: userId, avatar: null, rankTier: 50, inhouseRoles },
    ...rest,
  };
}

function lobby(
  id: string,
  slot: number,
  status: string,
  players: LobbyPlayer[],
  over: Partial<Omit<LobbyRow, "players">> = {},
): LobbyRow {
  return {
    id,
    slot,
    status,
    acceptEndsAt: null,
    voteEndsAt: null,
    pickTeam: null,
    pickEndsAt: null,
    radiantTeam: 1,
    winnerTeam: null,
    createdAt: at(5 * 60_000),
    startedAt: null,
    startedBy: null,
    players,
    ...over,
  };
}

const range = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// Game 1: a ready check, three of ten accepted (g1p0 among them).
const g1Ids = range("g1p", 10);
const game1 = () =>
  lobby(
    "lobby-g1",
    1,
    INHOUSE_STATUS.READY_CHECK,
    g1Ids.map((id, i) =>
      lobbyPlayer(id, { acceptedAt: i < 3 ? at(10_000) : null }),
    ),
    { acceptEndsAt: new Date(NOW + 60_000) },
  );

// Game 2: drafting, team 1's captain (g2p0) on the clock. Ballots are still
// on the rows from the vote: g2p0 voted VOTE for g2p5, g2p1 voted MMR.
const g2Ids = range("g2p", 10);
const game2 = () =>
  lobby(
    "lobby-g2",
    2,
    INHOUSE_STATUS.DRAFTING,
    g2Ids.map((id, i) =>
      lobbyPlayer(id, {
        acceptedAt: at(120_000),
        team: i === 0 || i === 2 ? 1 : i === 1 || i === 3 ? 2 : null,
        isCaptain: i === 0 || i === 1,
        pickIndex: i === 2 ? 0 : i === 3 ? 1 : null,
        votedMethod: i === 0 ? "VOTE" : i === 1 ? "MMR" : null,
        votedNomineeId: i === 0 ? "g2p5" : null,
        mmr: 5000 - i * 100,
      }),
    ),
    { pickTeam: 1, pickEndsAt: new Date(NOW + 30_000) },
  );

type PendingRow = InhouseRoomRows["pending"][number];
const pendingGame = (id: string, ids: string[]): PendingRow => ({
  id,
  finishedAt: at(20 * 60_000),
  detectedAt: null,
  radiantTeam: 1,
  players: ids.map((userId, i) => ({
    userId,
    team: i < 5 ? 1 : 2,
    user: { name: userId, inhouseRoles: null },
  })),
});

type RecentRow = InhouseRoomRows["recentResults"][number];
const recentGame = (
  id: string,
  ids: string[],
  completedMsAgo: number,
  over: Partial<RecentRow> = {},
): RecentRow => ({
  id,
  completedAt: at(completedMsAgo),
  winnerTeam: 1,
  radiantTeam: 1,
  radiantScore: 30,
  direScore: 12,
  eloDeltas: JSON.stringify(
    Object.fromEntries(ids.map((u, i) => [u, i < 5 ? 25 : -25])),
  ),
  players: ids.map((userId, i) => ({ userId, team: i < 5 ? 1 : 2 })),
  ...over,
});

type QueueRow = InhouseRoomRows["queue"][number];
const queued = (
  userId: string,
  lastSeenMsAgo: number,
  inhouseRoles: string | null = "3",
): QueueRow => ({
  userId,
  mmr: 2500,
  joinedAt: at(30 * 60_000),
  lastSeenAt: at(lastSeenMsAgo),
  idleExpiresAt: new Date(NOW + 3 * 3_600_000),
  user: { name: userId, avatar: null, rankTier: 40, inhouseRoles },
});

const AWAY_MS = INHOUSE.QUEUE_AWAY_SECONDS * 1000;
const pendIds = range("pend", 10);

function rows(over: Partial<InhouseRoomRows> = {}): InhouseRoomRows {
  return {
    // q0 present, q1 exactly at the presence cutoff (present), q2 away, q3
    // never chose roles (a signup fills them).
    queue: [
      queued("q0", 5_000),
      queued("q1", AWAY_MS),
      queued("q2", AWAY_MS + 1),
      queued("q3", 1_000, null),
    ],
    lobbies: [game1(), game2()],
    pending: [pendingGame("pending-1", pendIds)],
    recentResults: [],
    signupRoles: [{ userId: "q3", roles: "4,5" }],
    duel: { queue: [], duels: [] },
    ...over,
  };
}

const extrasFor = (inhouseRoles: string | null): InhouseViewerExtras => ({
  inhouseRoles,
  signupRoles: undefined,
});

const build = (
  viewer: SessionUser | null,
  r: InhouseRoomRows = rows(),
  extras: InhouseViewerExtras = viewer ? extrasFor("1") : null,
  nowMs = NOW,
) => buildInhouseState(viewer, r, extras, nowMs);

describe("buildInhouseState: which game is the viewer's", () => {
  it("gives a game-1 player game 1 as the lobby and game 2 beside it", () => {
    const s = build(session("g1p0"));
    expect(s.lobby?.id).toBe("lobby-g1");
    expect(s.otherLobbies.map((l) => l.id)).toEqual(["lobby-g2"]);
  });

  it("gives the game-2 captain game 2 and game 1 beside it", () => {
    const s = build(session("g2p0"));
    expect(s.lobby?.id).toBe("lobby-g2");
    expect(s.otherLobbies.map((l) => l.id)).toEqual(["lobby-g1"]);
  });

  it("gives a queued player, outsiders and the signed out no lobby", () => {
    for (const v of [
      session("q0"),
      session("admin", "ADMIN"),
      session("outsider"),
      null,
    ]) {
      const s = build(v);
      expect(s.lobby).toBeNull();
      expect(s.otherLobbies.map((l) => l.id)).toEqual([
        "lobby-g1",
        "lobby-g2",
      ]);
    }
  });

  it("counts the live games for everyone", () => {
    expect(build(null).liveGames).toBe(2);
    expect(build(null).maxLiveGames).toBe(INHOUSE.MAX_LIVE_GAMES);
  });
});

describe("buildInhouseState: every me.* flag", () => {
  const base = {
    isAdmin: false,
    inQueue: false,
    inLobby: false,
    myTeam: null,
    isCaptain: false,
    isOnClock: false,
    canVote: false,
    myVote: null,
    canAccept: false,
    hasAccepted: false,
    canJoin: false,
    canStart: false,
    canRecord: false,
    canFinish: false,
    canCancel: false,
  };

  it("a game-1 player who accepted", () => {
    expect(build(session("g1p0")).me).toEqual({
      ...base,
      userId: "g1p0",
      isLoggedIn: true,
      inLobby: true,
      canAccept: true,
      hasAccepted: true,
      roles: { roles: "1", source: "inhouse" },
    });
  });

  it("a game-1 player who has not accepted yet", () => {
    const me = build(session("g1p9")).me;
    expect(me.canAccept).toBe(true);
    expect(me.hasAccepted).toBe(false);
  });

  it("the game-2 captain on the clock", () => {
    expect(build(session("g2p0")).me).toEqual({
      ...base,
      userId: "g2p0",
      isLoggedIn: true,
      inLobby: true,
      myTeam: 1,
      isCaptain: true,
      isOnClock: true,
      myVote: { method: "VOTE", nomineeId: "g2p5" },
      hasAccepted: true,
      roles: { roles: "1", source: "inhouse" },
    });
  });

  it("the other game-2 captain is a captain but not on the clock", () => {
    const me = build(session("g2p1")).me;
    expect(me.isCaptain).toBe(true);
    expect(me.myTeam).toBe(2);
    expect(me.isOnClock).toBe(false);
    expect(me.myVote).toEqual({ method: "MMR", nomineeId: null });
  });

  it("a queued player", () => {
    expect(build(session("q0")).me).toEqual({
      ...base,
      userId: "q0",
      isLoggedIn: true,
      inQueue: true,
      roles: { roles: "1", source: "inhouse" },
    });
  });

  it("an admin outsider: may cancel nothing without a lobby, may join", () => {
    expect(build(session("admin", "ADMIN")).me).toEqual({
      ...base,
      userId: "admin",
      isLoggedIn: true,
      isAdmin: true,
      canJoin: true,
      roles: { roles: "1", source: "inhouse" },
    });
  });

  it("a plain outsider whose roles come from a signup", () => {
    const s = build(session("outsider"), rows(), {
      inhouseRoles: null,
      signupRoles: "2,4",
    });
    expect(s.me).toEqual({
      ...base,
      userId: "outsider",
      isLoggedIn: true,
      canJoin: true,
      roles: { roles: "2,4", source: "signup" },
    });
  });

  it("a signed-in viewer whose user row is gone shows no roles", () => {
    expect(build(session("ghost"), rows(), null).me.roles).toBeNull();
  });

  it("signed out", () => {
    expect(build(null).me).toEqual({
      ...base,
      userId: null,
      isLoggedIn: false,
      roles: null,
    });
  });

  it("READY and IN_PROGRESS: start, record and finish for players and admins", () => {
    for (const status of [INHOUSE_STATUS.READY, INHOUSE_STATUS.IN_PROGRESS]) {
      const r = rows({
        lobbies: [{ ...game1(), status }, game2()],
      });
      const player = build(session("g1p3"), r).me;
      expect(player.canStart).toBe(status === INHOUSE_STATUS.READY);
      expect(player.canRecord).toBe(true);
      expect(player.canFinish).toBe(true);
      expect(player.canCancel).toBe(false);
      expect(player.canAccept).toBe(false);
    }
  });

  it("an admin in a game may cancel it", () => {
    const me = build(session("g1p0", "ADMIN")).me;
    expect(me.isAdmin).toBe(true);
    expect(me.canCancel).toBe(true);
  });
});

describe("buildInhouseState: ballots", () => {
  const voteRows = () => {
    const g1 = game1();
    return rows({
      lobbies: [
        {
          ...g1,
          status: INHOUSE_STATUS.CAPTAIN_VOTE,
          voteEndsAt: new Date(NOW + 20_000),
          players: g1.players.map((p, i) => ({
            ...p,
            votedMethod: i < 3 ? "VOTE" : i === 3 ? "RECORD" : null,
            votedNomineeId: i < 3 ? "g1p9" : null,
          })),
        },
        game2(),
      ],
    });
  };

  it("sends myVote only to the voter", () => {
    expect(build(session("g1p0"), voteRows()).me.myVote).toEqual({
      method: "VOTE",
      nomineeId: "g1p9",
    });
    expect(build(session("g1p3"), voteRows()).me.myVote).toEqual({
      method: "RECORD",
      nomineeId: null,
    });
    expect(build(session("g1p5"), voteRows()).me.myVote).toBeNull();
    expect(build(session("q0"), voteRows()).me.myVote).toBeNull();
    expect(build(null, voteRows()).me.myVote).toBeNull();
  });

  it("shows the vote as tallies and canVote to its players", () => {
    const s = build(session("g1p5"), voteRows());
    expect(s.me.canVote).toBe(true);
    expect(s.lobby?.vote).toMatchObject({
      methodTallies: { VOTE: 3, MMR: 0, RECORD: 1 },
      votedCount: 4,
      voterCount: 10,
    });
    expect(
      s.lobby?.vote?.candidates.find((c) => c.userId === "g1p9")?.nominations,
    ).toBe(3);
    // Spectating the vote: the tallies, never a vote.
    const outsider = build(session("q0"), voteRows());
    expect(outsider.me.canVote).toBe(false);
    expect(outsider.otherLobbies[0].vote?.methodTallies.VOTE).toBe(3);
  });

  it("never serializes a raw ballot key, for any viewer", () => {
    for (const v of [
      session("g1p0"),
      session("g1p5"),
      session("g2p0"),
      session("q0"),
      session("admin", "ADMIN"),
      session("outsider"),
      null,
    ]) {
      for (const r of [rows(), voteRows()]) {
        const json = JSON.stringify(build(v, r));
        expect(json).not.toContain("votedMethod");
        expect(json).not.toContain("votedNomineeId");
      }
    }
  });
});

describe("buildInhouseState: pending results", () => {
  it("shows a player their own game marked over", () => {
    const s = build(session("pend2"));
    expect(s.pendingResults.map((p) => p.id)).toEqual(["pending-1"]);
    expect(s.pendingResults[0]).toMatchObject({
      mine: true,
      canRecord: true,
      canCancel: false,
    });
  });

  it("shows an admin every game marked over", () => {
    const r = rows({
      pending: [
        pendingGame("pending-1", pendIds),
        pendingGame("pending-2", range("other", 10)),
      ],
    });
    const s = build(session("admin", "ADMIN"), r);
    expect(s.pendingResults.map((p) => p.id)).toEqual([
      "pending-1",
      "pending-2",
    ]);
    expect(s.pendingResults.every((p) => !p.mine && p.canCancel)).toBe(true);
    // A player sees only theirs.
    expect(build(session("pend0"), r).pendingResults.map((p) => p.id)).toEqual(
      ["pending-1"],
    );
  });

  it("shows outsiders and the signed out none, but every id", () => {
    for (const v of [session("outsider"), session("q0"), null]) {
      const s = build(v);
      expect(s.pendingResults).toEqual([]);
      expect(s.pendingResultIds).toEqual(["pending-1"]);
    }
  });
});

describe("buildInhouseState: lastResult", () => {
  const W = INHOUSE.LAST_RESULT_WINDOW_MS;
  const ten = range("done", 10);

  it("shows the newest game the viewer played", () => {
    const r = rows({
      recentResults: [
        recentGame("newest-not-mine", range("x", 10), 1_000),
        recentGame("mine", ten, 60_000, { winnerTeam: 2 }),
        recentGame("older-mine", ten, 120_000),
      ],
    });
    expect(build(session("done0"), r).lastResult).toEqual({
      lobbyId: "mine",
      winnerSide: "Dire",
      radiantScore: 30,
      direScore: 12,
      myTeamWon: false,
      eloDelta: 25,
    });
    expect(build(session("done7"), r).lastResult?.myTeamWon).toBe(true);
  });

  it("includes a game completed exactly at the window's edge, not 1ms before", () => {
    const edge = rows({ recentResults: [recentGame("edge", ten, W)] });
    expect(build(session("done0"), edge).lastResult?.lobbyId).toBe("edge");
    const past = rows({ recentResults: [recentGame("past", ten, W + 1)] });
    expect(build(session("done0"), past).lastResult).toBeNull();
  });

  it("narrows the window to the build's own clock", () => {
    const r = rows({ recentResults: [recentGame("g", ten, W)] });
    expect(
      buildInhouseState(session("done0"), r, extrasFor("1"), NOW + 1)
        .lastResult,
    ).toBeNull();
  });

  it("shows nothing when the newest game has no winner, with no fallback", () => {
    const r = rows({
      recentResults: [
        recentGame("no-winner", ten, 1_000, { winnerTeam: null }),
        recentGame("older", ten, 60_000),
      ],
    });
    expect(build(session("done0"), r).lastResult).toBeNull();
  });

  it("shows a zero delta for malformed or missing Elo, and zero scores for null", () => {
    const r = rows({
      recentResults: [
        recentGame("bad", ten, 1_000, {
          eloDeltas: "{not json",
          radiantScore: null,
          direScore: null,
        }),
      ],
    });
    expect(build(session("done0"), r).lastResult).toMatchObject({
      eloDelta: 0,
      radiantScore: 0,
      direScore: 0,
    });
  });

  it("is null signed out", () => {
    const r = rows({ recentResults: [recentGame("g", ten, 1_000)] });
    expect(build(null, r).lastResult).toBeNull();
  });
});

describe("buildInhouseState: the queue at nowMs", () => {
  it("marks away past the cutoff and counts only the present toward needed", () => {
    const s = build(null);
    expect(s.queue.map((q) => [q.userId, q.away])).toEqual([
      ["q0", false],
      ["q1", false],
      ["q2", true],
      ["q3", false],
    ]);
    expect(s.needed).toBe(INHOUSE.LOBBY_SIZE - 3);
  });

  it("evaluates presence at the nowMs passed in, not the wall clock", () => {
    const later = buildInhouseState(null, rows(), null, NOW + 1);
    expect(later.now).toBe(NOW + 1);
    expect(later.queue.find((q) => q.userId === "q1")?.away).toBe(true);
    expect(later.needed).toBe(INHOUSE.LOBBY_SIZE - 2);
  });

  it("fills a never-chosen player's roles from the signup batch", () => {
    const q3 = build(null).queue.find((q) => q.userId === "q3");
    expect(q3).toMatchObject({ roles: "4,5", rolesRanked: false });
    const q0 = build(null).queue.find((q) => q.userId === "q0");
    expect(q0).toMatchObject({ roles: "3", rolesRanked: true });
  });

  it("stamps now from nowMs", () => {
    expect(build(null).now).toBe(NOW);
  });
});
