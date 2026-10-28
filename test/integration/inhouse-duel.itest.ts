import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import {
  DUEL_GAME_MODE,
  INHOUSE_DUEL,
  INHOUSE_DUEL_STATUS,
  INHOUSE_STATUS,
} from "@/lib/constants";
import { effectiveDotaAccountId } from "@/lib/dota-account";
import { DUEL_REFUSAL, duelEndReason, type DuelResult } from "@/lib/inhouse-duel";
import type { OpenDotaMatch, OpenDotaRecentMatch } from "@/lib/dota";
import {
  applyDuelResult,
  callOffDuel,
  cancelDuel,
  cancelDuelFromBot,
  endDuelFromBot,
  expireDuelQueue,
  finishDuel,
  giveUpOnDuels,
  joinDuelQueue,
  leaveDuelQueue,
  loadDuelLadder,
  loadDuelRoomRows,
  markDuelStartedFromBot,
  maybeAutoDetectDuelResults,
  pairDuelQueue,
  recordDuelMatch,
  removeFromDuelQueue,
  resetDuelLadderMemoForTests,
  touchDuelQueueHeartbeat,
  voidDuelResult,
} from "@/lib/inhouse-duel-service";
import { makeUser, raceAll, sessionFor } from "./factories";

// The 1v1 mid engine on SQLite. OpenDota is stubbed at its two network calls
// (a player's recent matches and one match). The lobby bot is stage B's: its
// status read answers null here. Raced tests are sequential on SQLite and
// concurrent under `npm run test:pg`.
vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return {
    ...actual,
    fetchRecentMatches: vi.fn(async () => [] as OpenDotaRecentMatch[]),
    fetchOpenDotaMatch: vi.fn(async () => null),
  };
});
import { fetchOpenDotaMatch, fetchRecentMatches } from "@/lib/dota";

// logAdminAction resolves its actor from the session; there is no cookie jar.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSessionUser: vi.fn(async () => null) };
});

const mockRecent = vi.mocked(fetchRecentMatches);
const mockMatch = vi.mocked(fetchOpenDotaMatch);

type U = Awaited<ReturnType<typeof makeUser>>;
const accountOf = (u: U) => effectiveDotaAccountId(u)!;

async function queueRow(
  u: U,
  { joinedAgoS = 60, seenAgoS = 0, expiresInS = 600 } = {},
) {
  const now = Date.now();
  return prisma.inhouseDuelQueueEntry.create({
    data: {
      userId: u.id,
      joinedAt: new Date(now - joinedAgoS * 1000),
      lastSeenAt: new Date(now - seenAgoS * 1000),
      expiresAt: new Date(now + expiresInS * 1000),
    },
  });
}

async function makeDuel(
  radiant: U,
  dire: U,
  status: string = INHOUSE_DUEL_STATUS.READY,
  extra: Partial<{
    createdAt: Date;
    startedAt: Date | null;
    checkedAt: Date | null;
    botMatchId: string | null;
    dotaMatchId: string | null;
    winnerTeam: number | null;
    completedAt: Date | null;
  }> = {},
) {
  return prisma.inhouseDuel.create({
    data: {
      radiantUserId: radiant.id,
      direUserId: dire.id,
      status,
      ...(status === INHOUSE_DUEL_STATUS.PLAYING ? { startedAt: new Date() } : {}),
      ...extra,
    },
  });
}

/** A finished 1v1 Solo Mid match between `radiant` and `dire`. */
function duelMatch(
  radiant: U,
  dire: U,
  { id = 8_100_000_001, radiantWin = true, startAt = Date.now() } = {},
): OpenDotaMatch {
  return {
    match_id: id,
    radiant_win: radiantWin,
    duration: 540,
    start_time: Math.floor(startAt / 1000),
    game_mode: DUEL_GAME_MODE.id,
    players: [
      { account_id: accountOf(radiant), player_slot: 0, hero_id: 11, kills: 2, deaths: 0, assists: 0 },
      { account_id: accountOf(dire), player_slot: 128, hero_id: 74, kills: 0, deaths: 2, assists: 0 },
    ],
  };
}

function resultFor(radiant: U, dire: U, id = "8100000001"): DuelResult {
  return {
    dotaMatchId: id,
    radiantUserId: radiant.id,
    direUserId: dire.id,
    winnerTeam: 1,
    winnerUserId: radiant.id,
    durationSecs: 540,
    radiantHeroId: 11,
    direHeroId: 74,
    startTime: Math.floor(Date.now() / 1000),
  };
}

const statusOf = async (id: string) =>
  (await prisma.inhouseDuel.findUniqueOrThrow({ where: { id } })).status;

beforeEach(() => {
  mockRecent.mockReset().mockResolvedValue([]);
  mockMatch.mockReset().mockResolvedValue(null);
  resetDuelLadderMemoForTests();
});

afterEach(() => {
  setRaceHook(null);
});

describe("joining and pairing", () => {
  it("waits with nobody to pair, then pairs the next joiner", async () => {
    const a = await makeUser("Alpha");
    const b = await makeUser("Bravo");
    expect(await joinDuelQueue(sessionFor(a))).toEqual({ ok: true });
    expect(await prisma.inhouseDuel.count()).toBe(0);
    const row = await prisma.inhouseDuelQueueEntry.findUniqueOrThrow({ where: { userId: a.id } });
    expect(row.expiresAt.getTime() - row.joinedAt.getTime()).toBe(
      INHOUSE_DUEL.QUEUE_MINUTES * 60_000,
    );

    expect(await joinDuelQueue(sessionFor(b))).toEqual({ ok: true });
    const duels = await prisma.inhouseDuel.findMany();
    expect(duels).toHaveLength(1);
    expect(duels[0].status).toBe(INHOUSE_DUEL_STATUS.READY);
    expect([duels[0].radiantUserId, duels[0].direUserId].sort()).toEqual([a.id, b.id].sort());
    expect(await prisma.inhouseDuelQueueEntry.count()).toBe(0);
  });

  it("pairs with the oldest present waiter, skipping the away", async () => {
    const away = await makeUser("Away");
    const old = await makeUser("Old");
    const young = await makeUser("Young");
    const joiner = await makeUser("Joiner");
    await queueRow(away, { joinedAgoS: 900, seenAgoS: INHOUSE_DUEL.PRESENT_SECONDS + 30 });
    await queueRow(young, { joinedAgoS: 100 });
    await queueRow(old, { joinedAgoS: 500 });
    await joinDuelQueue(sessionFor(joiner));
    const duel = await prisma.inhouseDuel.findFirstOrThrow();
    expect([duel.radiantUserId, duel.direUserId].sort()).toEqual([old.id, joiner.id].sort());
    expect(
      (await prisma.inhouseDuelQueueEntry.findMany({ orderBy: { userId: "asc" } })).map(
        (r) => r.userId,
      ).sort(),
    ).toEqual([away.id, young.id].sort());
  });

  it("never pairs a waiter who is in a live 5v5 lobby", async () => {
    const busy = await makeUser("Busy");
    const joiner = await makeUser("Joiner");
    await queueRow(busy);
    await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.READY,
        players: { create: [{ userId: busy.id, team: 1 }] },
      },
    });
    await joinDuelQueue(sessionFor(joiner));
    expect(await prisma.inhouseDuel.count()).toBe(0);
    expect(await prisma.inhouseDuelQueueEntry.count()).toBe(2);
  });

  it("refuses a player in a live 5v5, in a live duel, or over the MMR cap", async () => {
    const in5v5 = await makeUser("Five");
    await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.DRAFTING,
        players: { create: [{ userId: in5v5.id }] },
      },
    });
    expect(await joinDuelQueue(sessionFor(in5v5))).toEqual({
      ok: false,
      error: DUEL_REFUSAL.IN_5V5,
    });

    const a = await makeUser("A");
    const b = await makeUser("B");
    await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    expect(await joinDuelQueue(sessionFor(a))).toEqual({
      ok: false,
      error: DUEL_REFUSAL.IN_DUEL,
    });

    const strong = await makeUser("Strong");
    await prisma.user.update({ where: { id: strong.id }, data: { inhouseMmr: 6000 } });
    const capped = await joinDuelQueue(sessionFor(strong));
    expect(capped.ok).toBe(false);
    expect(await prisma.inhouseDuelQueueEntry.count()).toBe(0);
  });

  it("lets a player whose duel is over (awaiting its result) queue again", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    await makeDuel(a, b, INHOUSE_DUEL_STATUS.AWAITING_RESULT);
    expect(await joinDuelQueue(sessionFor(a))).toEqual({ ok: true });
    expect(await prisma.inhouseDuelQueueEntry.count()).toBe(1);
  });

  it("keeps a repeat join's place and refreshes its expiry", async () => {
    const a = await makeUser("A");
    const row = await queueRow(a, { joinedAgoS: 600, seenAgoS: 400, expiresInS: 60 });
    await joinDuelQueue(sessionFor(a));
    const after = await prisma.inhouseDuelQueueEntry.findUniqueOrThrow({ where: { userId: a.id } });
    expect(after.joinedAt.getTime()).toBe(row.joinedAt.getTime());
    expect(after.expiresAt.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(row.lastSeenAt.getTime());
  });

  it("sweeps two waiters left side by side into a duel", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const c = await makeUser("C");
    await queueRow(a, { joinedAgoS: 300 });
    await queueRow(b, { joinedAgoS: 200 });
    await queueRow(c, { joinedAgoS: 100, seenAgoS: INHOUSE_DUEL.PRESENT_SECONDS + 1 });
    expect(await pairDuelQueue()).toBe(1);
    const duel = await prisma.inhouseDuel.findFirstOrThrow();
    expect([duel.radiantUserId, duel.direUserId].sort()).toEqual([a.id, b.id].sort());
    expect((await prisma.inhouseDuelQueueEntry.findMany()).map((r) => r.userId)).toEqual([c.id]);
    expect(await pairDuelQueue()).toBe(0);
  });

  it("expires queue rows past their time", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    await queueRow(a, { expiresInS: -1 });
    await queueRow(b);
    expect(await expireDuelQueue()).toBe(1);
    expect((await prisma.inhouseDuelQueueEntry.findMany()).map((r) => r.userId)).toEqual([b.id]);
  });

  it("never pairs an expired waiter the worker hasn't deleted yet", async () => {
    const stale = await makeUser("Stale");
    const joiner = await makeUser("Joiner");
    await queueRow(stale, { expiresInS: -5 });
    await joinDuelQueue(sessionFor(joiner));
    expect(await prisma.inhouseDuel.count()).toBe(0);
  });
});

describe("leaving and the heartbeat", () => {
  it("leaves the queue; a paired player is told to call it off instead", async () => {
    const a = await makeUser("A");
    await queueRow(a);
    expect(await leaveDuelQueue(sessionFor(a))).toEqual({ ok: true });
    expect(await prisma.inhouseDuelQueueEntry.count()).toBe(0);
    const b = await makeUser("B");
    await makeDuel(a, b);
    const paired = await leaveDuelQueue(sessionFor(b));
    expect(paired.ok).toBe(false);
  });

  it("lets an admin remove a waiter once, and logs it", async () => {
    const admin = await makeUser("Admin", "ADMIN");
    const a = await makeUser("A");
    await queueRow(a);
    expect(await removeFromDuelQueue(sessionFor(a), a.id)).toEqual({
      ok: false,
      error: "Admins only",
    });
    vi.mocked((await import("@/lib/auth")).getSessionUser).mockResolvedValueOnce(
      sessionFor(admin),
    );
    expect(await removeFromDuelQueue(sessionFor(admin), a.id)).toEqual({ ok: true });
    expect((await removeFromDuelQueue(sessionFor(admin), a.id)).ok).toBe(false);
    const log = await prisma.adminAction.findMany({ where: { action: "removeFromDuelQueue" } });
    expect(log).toHaveLength(1);
  });

  it("writes the heartbeat at most once per HEARTBEAT_SECONDS", async () => {
    const a = await makeUser("A");
    const row = await queueRow(a, { seenAgoS: INHOUSE_DUEL.HEARTBEAT_SECONDS - 5 });
    expect(await touchDuelQueueHeartbeat(a.id)).toBe(0);
    const unchanged = await prisma.inhouseDuelQueueEntry.findUniqueOrThrow({ where: { id: row.id } });
    expect(unchanged.lastSeenAt.getTime()).toBe(row.lastSeenAt.getTime());
    await prisma.inhouseDuelQueueEntry.update({
      where: { id: row.id },
      data: { lastSeenAt: new Date(Date.now() - 120_000) },
    });
    expect(await touchDuelQueueHeartbeat(a.id)).toBe(1);
  });
});

describe("transitions", () => {
  it("the bot's launch read starts a READY duel, once, and never a closed one", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await makeDuel(a, b);
    expect(await markDuelStartedFromBot(duel.id, "8100000009")).toBe(true);
    const started = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(started.status).toBe(INHOUSE_DUEL_STATUS.PLAYING);
    expect(started.startedAt).not.toBeNull();
    expect(started.botMatchId).toBe("8100000009");
    // A second read changes nothing, a different id never replaces the first.
    expect(await markDuelStartedFromBot(duel.id, "8100000010")).toBe(false);
    expect((await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } })).botMatchId).toBe(
      "8100000009",
    );

    const closed = await makeDuel(a, b, INHOUSE_DUEL_STATUS.CANCELLED);
    expect(await markDuelStartedFromBot(closed.id, "8100000011")).toBe(false);
    const still = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: closed.id } });
    expect([still.status, still.botMatchId]).toEqual([INHOUSE_DUEL_STATUS.CANCELLED, null]);
  });

  it("stamps the bot's match id alone on a PLAYING duel that lacks one", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    expect(await markDuelStartedFromBot(duel.id, "8100000012")).toBe(false);
    expect((await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } })).botMatchId).toBe(
      "8100000012",
    );
  });

  it("1v1 over: only a PLAYING duel, by a player or admin", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const stranger = await makeUser("C");
    const ready = await makeDuel(a, b);
    expect((await finishDuel(sessionFor(a), ready.id)).ok).toBe(false);
    expect(await statusOf(ready.id)).toBe(INHOUSE_DUEL_STATUS.READY);
    await prisma.inhouseDuel.update({ where: { id: ready.id }, data: { status: INHOUSE_DUEL_STATUS.CANCELLED } });

    const playing = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    expect((await finishDuel(sessionFor(stranger), playing.id)).ok).toBe(false);
    expect(await finishDuel(sessionFor(b), playing.id)).toEqual({ ok: true });
    const over = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: playing.id } });
    expect(over.status).toBe(INHOUSE_DUEL_STATUS.AWAITING_RESULT);
    expect(over.finishedAt).not.toBeNull();
    // A second press is a no-op success.
    expect(await finishDuel(sessionFor(a), playing.id)).toEqual({ ok: true });
  });

  it("1v1 over loses to a cancel that lands after its read", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const admin = await makeUser("Admin", "ADMIN");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.finishDuel.beforeClaim", async () => {
        fired = true;
        expect((await cancelDuel(sessionFor(admin), duel.id)).ok).toBe(true);
      }),
    );
    expect(await finishDuel(sessionFor(a), duel.id)).toEqual({
      ok: false,
      error: "That 1v1 was cancelled",
    });
    expect(fired).toBe(true);
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.CANCELLED);
  });

  it("call it off: a READY duel by one of its players, never a started one", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const stranger = await makeUser("C");
    const duel = await makeDuel(a, b);
    expect((await callOffDuel(sessionFor(stranger), duel.id)).ok).toBe(false);
    expect(await callOffDuel(sessionFor(b), duel.id)).toEqual({ ok: true });
    const off = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(off.status).toBe(INHOUSE_DUEL_STATUS.CANCELLED);
    expect(off.endReason).toBe(duelEndReason.calledOff("B"));

    const playing = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    expect((await callOffDuel(sessionFor(a), playing.id)).ok).toBe(false);
    expect(await statusOf(playing.id)).toBe(INHOUSE_DUEL_STATUS.PLAYING);
  });

  it("call it off loses to the bot's launch read that lands after its read", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await makeDuel(a, b);
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.callOffDuel.beforeClaim", async () => {
        fired = true;
        expect(await markDuelStartedFromBot(duel.id, null)).toBe(true);
      }),
    );
    expect((await callOffDuel(sessionFor(a), duel.id)).ok).toBe(false);
    expect(fired).toBe(true);
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.PLAYING);
  });

  it("admin cancel: any open duel, logged, and it loses to a result", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const admin = await makeUser("Admin", "ADMIN");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.AWAITING_RESULT);
    expect((await cancelDuel(sessionFor(a), duel.id)).ok).toBe(false);
    vi.mocked((await import("@/lib/auth")).getSessionUser).mockResolvedValueOnce(
      sessionFor(admin),
    );
    expect(await cancelDuel(sessionFor(admin), duel.id)).toEqual({ ok: true });
    const cancelled = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(cancelled.endReason).toBe(duelEndReason.adminCancel("Admin"));
    expect(await prisma.adminAction.count({ where: { action: "cancelDuel" } })).toBe(1);

    const raced = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.cancelDuel.beforeClaim", async () => {
        fired = true;
        expect(await applyDuelResult(raced.id, resultFor(a, b))).toBe("recorded");
      }),
    );
    expect((await cancelDuel(sessionFor(admin), raced.id)).ok).toBe(false);
    expect(fired).toBe(true);
    expect(await statusOf(raced.id)).toBe(INHOUSE_DUEL_STATUS.COMPLETED);
    expect(await prisma.adminAction.count({ where: { action: "cancelDuel" } })).toBe(1);
  });

  it("the bot's over read ends a live duel and leaves a closed one", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    expect(await endDuelFromBot(duel.id)).toBe(true);
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.AWAITING_RESULT);
    expect(await endDuelFromBot(duel.id)).toBe(false);
    const done = await makeDuel(a, b, INHOUSE_DUEL_STATUS.COMPLETED, { winnerTeam: 1 });
    expect(await endDuelFromBot(done.id)).toBe(false);
    expect(await statusOf(done.id)).toBe(INHOUSE_DUEL_STATUS.COMPLETED);
  });

  it("a bot game with no result cancels an open duel, never a completed one", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await makeDuel(a, b);
    expect(await cancelDuelFromBot(duel.id, "the launch failed")).toBe(true);
    const off = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
    expect([off.status, off.endReason]).toEqual([
      INHOUSE_DUEL_STATUS.CANCELLED,
      duelEndReason.botCancelled("the launch failed"),
    ]);
    const done = await makeDuel(a, b, INHOUSE_DUEL_STATUS.COMPLETED, { winnerTeam: 2 });
    expect(await cancelDuelFromBot(done.id, "not scored")).toBe(false);
    expect(await statusOf(done.id)).toBe(INHOUSE_DUEL_STATUS.COMPLETED);
  });
});

describe("results", () => {
  it("records a pasted match, with the sides the match had", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    // Paired a on Radiant, but the match had b on Radiant, and Radiant won.
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    mockMatch.mockResolvedValue(duelMatch(b, a, { id: 8_100_000_123 }));
    expect(await recordDuelMatch(sessionFor(a), "8100000123", duel.id)).toEqual({ ok: true });
    const done = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(done).toMatchObject({
      status: INHOUSE_DUEL_STATUS.COMPLETED,
      dotaMatchId: "8100000123",
      radiantUserId: b.id,
      direUserId: a.id,
      winnerTeam: 1,
      durationSecs: 540,
      radiantHeroId: 11,
      direHeroId: 74,
    });
    expect(done.completedAt).not.toBeNull();
  });

  it("refuses a match that isn't the duel's, and one already recorded", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const c = await makeUser("C");
    const first = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    const second = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    const third = await makeDuel(a, c, INHOUSE_DUEL_STATUS.PLAYING);

    mockMatch.mockResolvedValue({ ...duelMatch(a, b), game_mode: 2 });
    expect((await recordDuelMatch(sessionFor(a), "8100000001", first.id)).ok).toBe(false);
    mockMatch.mockResolvedValue(duelMatch(a, b));
    expect((await recordDuelMatch(sessionFor(a), "8100000001", third.id)).ok).toBe(false);
    expect(await statusOf(third.id)).toBe(INHOUSE_DUEL_STATUS.PLAYING);

    expect(await applyDuelResult(first.id, resultFor(a, b))).toBe("recorded");
    expect(await applyDuelResult(second.id, resultFor(a, b))).toBe("duplicate");
    expect(await statusOf(second.id)).toBe(INHOUSE_DUEL_STATUS.PLAYING);
  });

  it("never completes a closed duel", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.CANCELLED);
    expect(await applyDuelResult(duel.id, resultFor(a, b))).toBe("closed");
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.CANCELLED);
  });

  it("voids a result once, with its AdminAction, and the ladder drops it", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const admin = await makeUser("Admin", "ADMIN");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    await applyDuelResult(duel.id, resultFor(a, b));
    expect((await loadDuelLadder()).provisional.map((r) => r.userId).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect((await voidDuelResult(sessionFor(a), duel.id)).ok).toBe(false);
    expect(await voidDuelResult(sessionFor(admin), duel.id)).toEqual({ ok: true });
    const voided = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(voided).toMatchObject({
      status: INHOUSE_DUEL_STATUS.CANCELLED,
      dotaMatchId: null,
      winnerTeam: null,
      endReason: duelEndReason.voided("Admin", "8100000001"),
    });
    const log = await prisma.adminAction.findMany({ where: { action: "voidDuelResult" } });
    expect(log).toHaveLength(1);
    expect(log[0].summary).toContain("8100000001");
    expect((await voidDuelResult(sessionFor(admin), duel.id)).ok).toBe(false);
    expect((await loadDuelLadder()).provisional).toEqual([]);
  });

  it("a void that loses to another void writes no second AdminAction", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const admin = await makeUser("Admin", "ADMIN");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    await applyDuelResult(duel.id, resultFor(a, b));
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.voidDuelResult.beforeClaim", async () => {
        fired = true;
        expect(await voidDuelResult(sessionFor(admin), duel.id)).toEqual({ ok: true });
      }),
    );
    expect(await voidDuelResult(sessionFor(admin), duel.id)).toEqual({
      ok: false,
      error: "That 1v1 result was already voided",
    });
    expect(fired).toBe(true);
    expect(await prisma.adminAction.count({ where: { action: "voidDuelResult" } })).toBe(1);
  });
});

describe("the result scan", () => {
  const recent = (id: number, startS: number, slot: number): OpenDotaRecentMatch => ({
    match_id: id,
    start_time: startS,
    game_mode: DUEL_GAME_MODE.id,
    lobby_type: 1,
    player_slot: slot,
  });

  it("finds the match both players share and records it, then never scans it again", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const createdAt = new Date(Date.now() - 10 * 60_000);
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING, { createdAt });
    const startS = Math.floor(createdAt.getTime() / 1000) + 60;
    mockRecent.mockImplementation(async (account) =>
      account === accountOf(a)
        ? [recent(8_100_000_500, startS, 0), recent(8_100_000_400, startS - 9999, 0)]
        : [recent(8_100_000_500, startS, 128)],
    );
    mockMatch.mockResolvedValue(
      duelMatch(a, b, { id: 8_100_000_500, radiantWin: false, startAt: startS * 1000 }),
    );
    expect(await maybeAutoDetectDuelResults()).toEqual({ recorded: true, deadlineReached: false });
    const done = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
    expect([done.status, done.dotaMatchId, done.winnerTeam]).toEqual([
      INHOUSE_DUEL_STATUS.COMPLETED,
      "8100000500",
      2,
    ]);
    expect(mockMatch).toHaveBeenCalledTimes(1);
    mockRecent.mockClear();
    await maybeAutoDetectDuelResults();
    expect(mockRecent).not.toHaveBeenCalled();
  });

  it("checks the bot's match id first", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const createdAt = new Date(Date.now() - 10 * 60_000);
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.AWAITING_RESULT, {
      createdAt,
      botMatchId: "8100000777",
    });
    mockMatch.mockResolvedValue(duelMatch(a, b, { id: 8_100_000_777, startAt: createdAt.getTime() }));
    await maybeAutoDetectDuelResults();
    expect(mockMatch).toHaveBeenCalledWith("8100000777", expect.anything());
    expect(mockRecent).not.toHaveBeenCalled();
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.COMPLETED);
  });

  it("waits SCAN_AFTER_MINUTES, backs off SCAN_EVERY_SECONDS, never scans a closed duel", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    await makeDuel(a, b, INHOUSE_DUEL_STATUS.READY, {
      createdAt: new Date(Date.now() - (INHOUSE_DUEL.SCAN_AFTER_MINUTES - 1) * 60_000),
    });
    const old = new Date(Date.now() - 60 * 60_000);
    await makeDuel(a, b, INHOUSE_DUEL_STATUS.CANCELLED, { createdAt: old });
    await makeDuel(a, b, INHOUSE_DUEL_STATUS.COMPLETED, { createdAt: old, winnerTeam: 1 });
    const checked = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING, {
      createdAt: old,
      checkedAt: new Date(Date.now() - 60_000),
    });
    await maybeAutoDetectDuelResults();
    expect(mockRecent).not.toHaveBeenCalled();
    expect(await statusOf(checked.id)).toBe(INHOUSE_DUEL_STATUS.PLAYING);
  });

  it("scans at most SCAN_PER_PASS duels, stalest first", async () => {
    const users = await Promise.all(Array.from({ length: 8 }, (_, i) => makeUser(`P${i}`)));
    const old = new Date(Date.now() - 30 * 60_000);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const d = await makeDuel(users[2 * i], users[2 * i + 1], INHOUSE_DUEL_STATUS.PLAYING, {
        createdAt: old,
        checkedAt: new Date(Date.now() - (10 + i) * 60_000),
      });
      ids.push(d.id);
    }
    await maybeAutoDetectDuelResults();
    const stamped = await prisma.inhouseDuel.findMany({
      where: { checkedAt: { gte: new Date(Date.now() - 5_000) } },
      select: { id: true },
    });
    expect(stamped.map((d) => d.id).sort()).toEqual(ids.slice(1).sort());
    expect(mockRecent).toHaveBeenCalledTimes(2 * INHOUSE_DUEL.SCAN_PER_PASS);
  });

  it("never claims a duel cancelled after the read that judged it due", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING, {
      createdAt: new Date(Date.now() - 20 * 60_000),
    });
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.autoDetect.beforeClaim", async () => {
        fired = true;
        expect(await cancelDuelFromBot(duel.id, "test")).toBe(true);
      }),
    );
    await maybeAutoDetectDuelResults();
    expect(fired).toBe(true);
    const after = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
    expect([after.status, after.checkedAt]).toEqual([INHOUSE_DUEL_STATUS.CANCELLED, null]);
  });

  it("a scan cut off by its deadline restores only its own claim", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING, {
      createdAt: new Date(Date.now() - 20 * 60_000),
    });
    const controller = new AbortController();
    mockRecent.mockImplementation(async () => {
      controller.abort();
      return [];
    });
    const rival = new Date(Date.now() + 1234);
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.autoDetect.beforeDeadlineRollback", async () => {
        fired = true;
        await prisma.inhouseDuel.update({ where: { id: duel.id }, data: { checkedAt: rival } });
      }),
    );
    expect(await maybeAutoDetectDuelResults({ signal: controller.signal })).toEqual({
      recorded: false,
      deadlineReached: true,
    });
    expect(fired).toBe(true);
    const after = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(after.checkedAt?.getTime()).toBe(rival.getTime());
  });

  it("a deadline with no rival puts the claim back", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING, {
      createdAt: new Date(Date.now() - 20 * 60_000),
    });
    const controller = new AbortController();
    mockRecent.mockImplementation(async () => {
      controller.abort();
      return [];
    });
    await maybeAutoDetectDuelResults({ signal: controller.signal });
    expect((await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } })).checkedAt).toBeNull();
  });
});

describe("give-up clocks", () => {
  it("calls off READY at SETUP_MINUTES and gives up a played duel at GIVE_UP_HOURS", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    const stale = await makeDuel(a, b, INHOUSE_DUEL_STATUS.READY, {
      createdAt: ago(INHOUSE_DUEL.SETUP_MINUTES + 1),
    });
    const fresh = await makeDuel(a, b, INHOUSE_DUEL_STATUS.READY, {
      createdAt: ago(INHOUSE_DUEL.SETUP_MINUTES - 1),
    });
    const hours = INHOUSE_DUEL.GIVE_UP_HOURS * 60;
    const lost = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING, { createdAt: ago(hours + 1) });
    const waiting = await makeDuel(a, b, INHOUSE_DUEL_STATUS.AWAITING_RESULT, {
      createdAt: ago(hours + 1),
    });
    const young = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING, { createdAt: ago(hours - 1) });
    const done = await makeDuel(a, b, INHOUSE_DUEL_STATUS.COMPLETED, {
      createdAt: ago(hours * 2),
      winnerTeam: 1,
    });
    expect(await giveUpOnDuels()).toBe(3);
    const reason = async (id: string) =>
      (await prisma.inhouseDuel.findUniqueOrThrow({ where: { id } })).endReason;
    expect(await statusOf(stale.id)).toBe(INHOUSE_DUEL_STATUS.CANCELLED);
    expect(await reason(stale.id)).toBe(duelEndReason.neverPlayed());
    expect(await statusOf(lost.id)).toBe(INHOUSE_DUEL_STATUS.CANCELLED);
    expect(await reason(waiting.id)).toBe(duelEndReason.resultNeverShowed());
    expect(await statusOf(fresh.id)).toBe(INHOUSE_DUEL_STATUS.READY);
    expect(await statusOf(young.id)).toBe(INHOUSE_DUEL_STATUS.PLAYING);
    expect(await statusOf(done.id)).toBe(INHOUSE_DUEL_STATUS.COMPLETED);
  });

  it("the never-played call-off loses to a launch landing after its read", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.READY, {
      createdAt: new Date(Date.now() - (INHOUSE_DUEL.SETUP_MINUTES + 5) * 60_000),
    });
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.giveUpOnDuels.beforeClaim", async () => {
        fired = true;
        expect(await markDuelStartedFromBot(duel.id, null)).toBe(true);
      }),
    );
    expect(await giveUpOnDuels()).toBe(0);
    expect(fired).toBe(true);
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.PLAYING);
  });

  it("the result give-up loses to a result landing after its read", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.AWAITING_RESULT, {
      createdAt: new Date(Date.now() - (INHOUSE_DUEL.GIVE_UP_HOURS * 60 + 5) * 60_000),
    });
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.giveUpOnDuels.beforeClaim", async () => {
        fired = true;
        expect(await applyDuelResult(duel.id, resultFor(a, b))).toBe("recorded");
      }),
    );
    expect(await giveUpOnDuels()).toBe(0);
    expect(fired).toBe(true);
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.COMPLETED);
  });
});

describe("room rows and the ladder", () => {
  it("loads the queue, open duels and recent results only", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    await queueRow(a);
    const open = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    const recentDone = await makeDuel(a, b, INHOUSE_DUEL_STATUS.COMPLETED, {
      winnerTeam: 1,
      completedAt: new Date(Date.now() - 60_000),
    });
    await makeDuel(a, b, INHOUSE_DUEL_STATUS.COMPLETED, {
      winnerTeam: 1,
      completedAt: new Date(Date.now() - INHOUSE_DUEL.LAST_RESULT_WINDOW_MS - 60_000),
    });
    await makeDuel(a, b, INHOUSE_DUEL_STATUS.CANCELLED);
    const rows = await loadDuelRoomRows();
    expect(rows.queue.map((q) => q.userId)).toEqual([a.id]);
    expect(rows.duels.map((d) => d.id).sort()).toEqual([open.id, recentDone.id].sort());
  });

  it("rates completed duels and refreshes the memo when a result lands", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const first = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    await applyDuelResult(first.id, resultFor(a, b, "8100000201"));
    const one = await loadDuelLadder();
    const second = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    await applyDuelResult(second.id, resultFor(b, a, "8100000202"));
    const two = await loadDuelLadder();
    expect(one.provisional.find((r) => r.userId === a.id)?.games).toBe(1);
    expect(two.provisional.find((r) => r.userId === a.id)).toMatchObject({ wins: 1, losses: 1 });
  });
});

describe("raced", () => {
  it("three simultaneous joins form exactly one duel", async () => {
    for (let round = 0; round < 3; round += 1) {
      await prisma.inhouseDuel.deleteMany();
      await prisma.inhouseDuelQueueEntry.deleteMany();
      const us = await Promise.all([1, 2, 3].map((i) => makeUser(`R${round}-${i}`)));
      const results = await raceAll(us.map((u) => () => joinDuelQueue(sessionFor(u))));
      expect(results.every((r) => r.ok)).toBe(true);
      const duels = await prisma.inhouseDuel.findMany();
      const queued = await prisma.inhouseDuelQueueEntry.findMany();
      expect(duels).toHaveLength(1);
      expect(queued).toHaveLength(1);
      const placed = [duels[0].radiantUserId, duels[0].direUserId, queued[0].userId].sort();
      expect(placed).toEqual(us.map((u) => u.id).sort());
    }
  });

  it("a join racing a waiter's leave never pairs a player who left", async () => {
    for (let round = 0; round < 3; round += 1) {
      await prisma.inhouseDuel.deleteMany();
      await prisma.inhouseDuelQueueEntry.deleteMany();
      const waiter = await makeUser(`W${round}`);
      const joiner = await makeUser(`J${round}`);
      await queueRow(waiter);
      const [joined, left] = await raceAll([
        () => joinDuelQueue(sessionFor(joiner)),
        () => leaveDuelQueue(sessionFor(waiter)),
      ]);
      expect(joined.ok).toBe(true);
      const duel = await prisma.inhouseDuel.findFirst();
      if (duel) {
        // The pairing won: the leave says so instead of claiming to leave.
        expect(left.ok).toBe(false);
        expect(await prisma.inhouseDuelQueueEntry.count()).toBe(0);
      } else {
        expect(left.ok).toBe(true);
        expect((await prisma.inhouseDuelQueueEntry.findMany()).map((r) => r.userId)).toEqual([
          joiner.id,
        ]);
      }
    }
  });

  it("two results for one duel record exactly one", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    const outcomes = await raceAll([
      () => applyDuelResult(duel.id, resultFor(a, b, "8100000301")),
      () => applyDuelResult(duel.id, resultFor(b, a, "8100000302")),
    ]);
    expect(outcomes.filter((o) => o === "recorded")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "closed")).toHaveLength(1);
  });

  it("one match raced onto two duels records exactly one", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const d1 = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    const d2 = await makeDuel(a, b, INHOUSE_DUEL_STATUS.AWAITING_RESULT);
    const outcomes = await raceAll([
      () => applyDuelResult(d1.id, resultFor(a, b)),
      () => applyDuelResult(d2.id, resultFor(a, b)),
    ]);
    expect(outcomes.sort()).toEqual(["duplicate", "recorded"]);
    expect(await prisma.inhouseDuel.count({ where: { dotaMatchId: "8100000001" } })).toBe(1);
  });

  it("a void racing a late result leaves the duel voided", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const admin = await makeUser("Admin", "ADMIN");
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    await applyDuelResult(duel.id, resultFor(a, b, "8100000401"));
    const [voided, late] = await raceAll<unknown>([
      () => voidDuelResult(sessionFor(admin), duel.id),
      () => applyDuelResult(duel.id, resultFor(b, a, "8100000402")),
    ]);
    expect(voided).toEqual({ ok: true });
    expect(late).toBe("closed");
    const after = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
    expect([after.status, after.dotaMatchId]).toEqual([INHOUSE_DUEL_STATUS.CANCELLED, null]);
  });
});
