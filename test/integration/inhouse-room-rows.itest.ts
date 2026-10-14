import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { INHOUSE, INHOUSE_STATUS } from "@/lib/constants";
import { effectiveInhouseRoles } from "@/lib/roles";
import type { SessionUser } from "@/lib/auth";
import {
  boardInputFrom,
  getInhouseState,
  loadInhouseRoomRows,
  loadViewerExtras,
} from "@/lib/inhouse-service";
import { loadBoardSnapshot } from "@/lib/inhouse-board-service";
import { makeSeason, makeUser, sessionFor } from "./factories";

// The room's rows are read once for every viewer (loadInhouseRoomRows), and
// the two per-viewer reads getInhouseState used to make are now derived from
// them: the post-game banner (lastResult) and the viewer's own positions
// (me.roles). This file pins both to what the per-viewer queries produced,
// by running those queries VERBATIM as oracles against one fixture and
// comparing for every viewer.

const NOW = Date.UTC(2026, 9, 13, 20, 0, 0);
const MIN = 60_000;

/** The per-viewer banner query getInhouseState ran before the split. */
async function oldLastResult(viewer: SessionUser | null, now: number) {
  let lastResult: null | {
    lobbyId: string;
    winnerSide: "Radiant" | "Dire";
    radiantScore: number;
    direScore: number;
    myTeamWon: boolean;
    eloDelta: number;
  } = null;
  if (viewer) {
    const recent = await prisma.inhouseLobby.findFirst({
      where: {
        status: INHOUSE_STATUS.COMPLETED,
        completedAt: { gte: new Date(now - 10 * 60_000) },
        players: { some: { userId: viewer.id } },
      },
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        winnerTeam: true,
        radiantTeam: true,
        radiantScore: true,
        direScore: true,
        eloDeltas: true,
        players: {
          where: { userId: viewer.id },
          select: { userId: true, team: true },
        },
      },
    });
    if (recent && recent.winnerTeam != null) {
      let eloDelta = 0;
      try {
        const map = JSON.parse(recent.eloDeltas) as Record<string, unknown>;
        const v = map[viewer.id];
        if (typeof v === "number" && Number.isFinite(v)) eloDelta = v;
      } catch {
        // Malformed JSON — show the result without a delta.
      }
      const myPlayer = recent.players.find((pl) => pl.userId === viewer.id);
      lastResult = {
        lobbyId: recent.id,
        winnerSide:
          recent.winnerTeam === recent.radiantTeam ? "Radiant" : "Dire",
        radiantScore: recent.radiantScore ?? 0,
        direScore: recent.direScore ?? 0,
        myTeamWon: myPlayer?.team === recent.winnerTeam,
        eloDelta,
      };
    }
  }
  return lastResult;
}

/**
 * The viewer's positions as getInhouseState read them before the split: the
 * viewer's User row beside the queue and live-lobby reads, and ONE signup
 * batch over every null-roles player shown plus the viewer.
 */
async function oldMeRoles(viewer: SessionUser | null) {
  if (!viewer) return null;
  const [queue, lobbyRows, viewerRow] = await Promise.all([
    prisma.inhouseQueueEntry.findMany({
      select: { userId: true, user: { select: { inhouseRoles: true } } },
    }),
    prisma.inhouseLobby.findMany({
      where: {
        status: {
          in: [
            INHOUSE_STATUS.READY_CHECK,
            INHOUSE_STATUS.CAPTAIN_VOTE,
            INHOUSE_STATUS.DRAFTING,
            INHOUSE_STATUS.READY,
            INHOUSE_STATUS.IN_PROGRESS,
          ],
        },
      },
      select: {
        players: {
          select: { userId: true, user: { select: { inhouseRoles: true } } },
        },
      },
    }),
    prisma.user.findUnique({
      where: { id: viewer.id },
      select: { inhouseRoles: true },
    }),
  ]);
  const signupRoles = new Map<string, string>();
  const unset = new Set<string>();
  for (const q of queue) if (q.user.inhouseRoles == null) unset.add(q.userId);
  for (const l of lobbyRows) {
    for (const p of l.players) {
      if (p.user.inhouseRoles == null) unset.add(p.userId);
    }
  }
  if (viewerRow && viewerRow.inhouseRoles == null) unset.add(viewer.id);
  if (unset.size > 0) {
    const regs = await prisma.registration.findMany({
      where: { userId: { in: [...unset] }, roles: { not: "" } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { userId: true, roles: true },
    });
    for (const r of regs) {
      if (!signupRoles.has(r.userId)) signupRoles.set(r.userId, r.roles);
    }
  }
  return viewerRow
    ? effectiveInhouseRoles(viewerRow.inhouseRoles, signupRoles.get(viewer.id))
    : null;
}

async function users(prefix: string, n: number, inhouseRoles: string | null) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = await makeUser(`${prefix}${i}`);
    if (inhouseRoles !== null) {
      await prisma.user.update({ where: { id: u.id }, data: { inhouseRoles } });
    }
    out.push(u);
  }
  return out;
}

async function completedGame(
  ten: { id: string }[],
  completedAt: Date | null,
  over: {
    id?: string;
    status?: string;
    winnerTeam?: number | null;
    radiantTeam?: number;
    eloDeltas?: string;
    radiantScore?: number | null;
  } = {},
) {
  return prisma.inhouseLobby.create({
    data: {
      id: over.id,
      status: over.status ?? INHOUSE_STATUS.COMPLETED,
      completedAt,
      winnerTeam: over.winnerTeam === undefined ? 1 : over.winnerTeam,
      radiantTeam: over.radiantTeam ?? 1,
      radiantScore: over.radiantScore === undefined ? 31 : over.radiantScore,
      direScore: 17,
      eloDeltas:
        over.eloDeltas ??
        JSON.stringify(
          Object.fromEntries(ten.map((u, i) => [u.id, i < 5 ? 21 : -21])),
        ),
      players: {
        create: ten.map((u, i) => ({ userId: u.id, team: i < 5 ? 1 : 2 })),
      },
    },
  });
}

describe("inhouse room rows: the per-viewer reads they replaced", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lastResult matches the per-viewer findFirst for every viewer", async () => {
    const a = await users("a", 10, "1");
    const b = await users("b", 10, "2");
    const edge = await users("edge", 10, null);
    const past = await users("past", 10, null);
    const tie = await users("tie", 10, "3");
    const outsider = await makeUser("outsider");
    const admin = await makeUser("admin", "ADMIN");

    // a: won three minutes ago (the banner), and an older game before it.
    await completedGame(a, new Date(NOW - 8 * MIN), { winnerTeam: 2 });
    await completedGame(a, new Date(NOW - 3 * MIN), { radiantTeam: 2 });
    // b's first five also played a NEWER game with no winner: no banner, and
    // no fallback to the game before it.
    await completedGame(b, new Date(NOW - 4 * MIN));
    await completedGame(
      [...b.slice(0, 5), ...a.slice(0, 5)],
      new Date(NOW - 1 * MIN),
      { winnerTeam: null },
    );
    // The window's edge is inclusive; 1ms past it is out.
    await completedGame(edge, new Date(NOW - INHOUSE.LAST_RESULT_WINDOW_MS), {
      eloDeltas: "{broken",
      radiantScore: null,
    });
    await completedGame(
      past,
      new Date(NOW - INHOUSE.LAST_RESULT_WINDOW_MS - 1),
    );
    // Two games completed in the same millisecond: the higher id wins.
    await completedGame(tie, new Date(NOW - 2 * MIN), { id: "tie-a" });
    await completedGame(tie, new Date(NOW - 2 * MIN), {
      id: "tie-z",
      winnerTeam: 2,
    });
    // Not COMPLETED, or never stamped: never a banner.
    await completedGame(past, new Date(NOW - 30_000), {
      status: INHOUSE_STATUS.CANCELLED,
    });
    await completedGame(past, null);

    const viewers: (SessionUser | null)[] = [
      ...[...a, ...b, ...edge, ...past, ...tie].map(sessionFor),
      sessionFor(outsider),
      sessionFor(admin),
      null,
    ];
    let shown = 0;
    for (const viewer of viewers) {
      const expected = await oldLastResult(viewer, NOW);
      const state = await getInhouseState(viewer, {
        runMaintenance: false,
        syncBoard: false,
        detectResults: false,
      });
      expect(state.now).toBe(NOW);
      expect(state.lastResult, viewer?.name ?? "signed out").toEqual(expected);
      if (expected) shown++;
    }
    // The fixture exercised real banners, not a table of nulls: a's back
    // five, b's back five, all of edge and all of tie.
    expect(shown).toBe(5 + 5 + 10 + 10);
  });

  it("me.roles matches the old viewer read and signup batch for every viewer", async () => {
    const season = await makeSeason({ isActive: false });
    const older = await makeSeason({ isActive: false });
    const register = (
      seasonId: string,
      userId: string,
      roles: string,
      createdAt: Date,
    ) =>
      prisma.registration.create({
        data: { seasonId, userId, roles, createdAt },
      });

    // Queued: one chose, one never did (signup fills), one with no signup.
    const [qChose] = await users("qChose", 1, "4,1");
    const [qSignup, qNone] = await users("qNull", 2, null);
    await register(season.id, qSignup.id, "2,3", new Date(NOW - 60 * MIN));
    for (const u of [qChose, qSignup, qNone]) {
      await prisma.inhouseQueueEntry.create({
        data: { userId: u.id, mmr: 3000, lastSeenAt: new Date(NOW) },
      });
    }
    // A live game: half never chose; one has an older signup with roles and a
    // NEWER one with none (the newest NON-EMPTY signup counts).
    const live = [
      ...(await users("liveChose", 5, "5")),
      ...(await users("liveNull", 5, null)),
    ];
    await register(older.id, live[5].id, "1", new Date(NOW - 90 * MIN));
    await register(season.id, live[5].id, "", new Date(NOW - 30 * MIN));
    await register(season.id, live[6].id, "3,4", new Date(NOW - 30 * MIN));
    await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.READY_CHECK,
        slot: 1,
        acceptEndsAt: new Date(NOW + 60_000),
        players: { create: live.map((u) => ({ userId: u.id })) },
      },
    });
    // A game marked over: its players are free, never chose, and signed up.
    const pend = await users("pend", 10, null);
    await register(season.id, pend[0].id, "1,5", new Date(NOW - 20 * MIN));
    await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.AWAITING_RESULT,
        slot: 2,
        finishedAt: new Date(NOW - 10 * MIN),
        players: {
          create: pend.map((u, i) => ({ userId: u.id, team: i < 5 ? 1 : 2 })),
        },
      },
    });
    // Outsiders: chose, signup only (two seasons; the newest wins), nothing.
    const [oChose] = await users("oChose", 1, "2");
    const [oSignup, oNone] = await users("oNull", 2, null);
    await register(older.id, oSignup.id, "5", new Date(NOW - 120 * MIN));
    await register(season.id, oSignup.id, "1,2", new Date(NOW - 5 * MIN));

    const viewers: (SessionUser | null)[] = [
      qChose,
      qSignup,
      qNone,
      ...live,
      ...pend,
      oChose,
      oSignup,
      oNone,
    ].map(sessionFor);
    viewers.push(null);
    // A session whose user row is gone shows no roles.
    viewers.push({ ...sessionFor(oNone), id: "deleted-user" });

    const sources = new Set<string>();
    for (const viewer of viewers) {
      const expected = await oldMeRoles(viewer);
      const state = await getInhouseState(viewer, {
        runMaintenance: false,
        syncBoard: false,
        detectResults: false,
      });
      expect(state.me.roles, viewer?.name ?? "signed out").toEqual(expected);
      if (expected) sources.add(expected.source);
    }
    expect([...sources].sort()).toEqual(["inhouse", "none", "signup"]);
  });

  it("reads nothing more for a viewer the rows already hold", async () => {
    const [queuedNull] = await users("queued", 1, null);
    const season = await makeSeason({ isActive: false });
    await prisma.registration.create({
      data: { seasonId: season.id, userId: queuedNull.id, roles: "3" },
    });
    await prisma.inhouseQueueEntry.create({
      data: { userId: queuedNull.id, lastSeenAt: new Date(NOW) },
    });
    const pend = await users("pend", 10, null);
    await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.AWAITING_RESULT,
        finishedAt: new Date(NOW - MIN),
        players: { create: pend.map((u) => ({ userId: u.id, team: 1 })) },
      },
    });
    const outsider = await makeUser("outsider");

    const rows = await loadInhouseRoomRows(NOW);
    const findUser = vi.spyOn(prisma.user, "findUnique");
    const findReg = vi.spyOn(prisma.registration, "findFirst");

    expect(await loadViewerExtras(sessionFor(queuedNull), rows)).toEqual({
      inhouseRoles: null,
      signupRoles: "3",
    });
    expect(await loadViewerExtras(sessionFor(pend[3]), rows)).toEqual({
      inhouseRoles: null,
      signupRoles: undefined,
    });
    expect(await loadViewerExtras(null, rows)).toBeNull();
    expect(findUser).not.toHaveBeenCalled();
    expect(findReg).not.toHaveBeenCalled();

    // Outside the rows: the User row, then (never chose) the signup.
    expect(await loadViewerExtras(sessionFor(outsider), rows)).toEqual({
      inhouseRoles: null,
      signupRoles: undefined,
    });
    expect(findUser).toHaveBeenCalledTimes(1);
    expect(findReg).toHaveBeenCalledTimes(1);
  });

  it("feeds the board the same input loadBoardSnapshot reads", async () => {
    const present = await users("present", 3, "1");
    const [away] = await users("away", 1, "1");
    for (const u of present) {
      await prisma.inhouseQueueEntry.create({
        data: { userId: u.id, lastSeenAt: new Date(NOW - MIN) },
      });
    }
    await prisma.inhouseQueueEntry.create({
      data: {
        userId: away.id,
        lastSeenAt: new Date(NOW - INHOUSE.QUEUE_AWAY_SECONDS * 1000 - 1),
      },
    });
    const g1 = await users("g1", 10, "2");
    const g2 = await users("g2", 10, "2");
    await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.IN_PROGRESS,
        slot: 2,
        startedAt: new Date(NOW - 20 * MIN),
        players: {
          create: g2.map((u) => ({ userId: u.id, acceptedAt: new Date(NOW) })),
        },
      },
    });
    await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.READY_CHECK,
        slot: 1,
        acceptEndsAt: new Date(NOW + MIN),
        players: {
          create: g1.map((u, i) => ({
            userId: u.id,
            acceptedAt: i < 4 ? new Date(NOW) : null,
          })),
        },
      },
    });

    const input = boardInputFrom(await loadInhouseRoomRows(NOW), NOW);
    expect(input).toEqual(await loadBoardSnapshot(NOW));
    expect(input.presentNames).toHaveLength(3);
    expect(input.awayCount).toBe(1);
    expect(input.lobbies.map((l) => l.slot)).toEqual([1, 2]);
  });
});
