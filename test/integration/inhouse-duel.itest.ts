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
import {
  DUEL_NO_BOT_NOTE,
  DUEL_REFUSAL,
  duelEndReason,
  type DuelResult,
} from "@/lib/inhouse-duel";
import type { OpenDotaMatch, OpenDotaRecentMatch } from "@/lib/dota";
import {
  acceptDuel,
  applyDuelResult,
  callOffDuel,
  cancelDuel,
  cancelDuelFromBot,
  declineDuel,
  endDuelFromBot,
  expireDuelQueue,
  finishDuel,
  giveUpOnDuels,
  joinDuelQueue,
  leaveDuelQueue,
  loadDuelLadder,
  markDuelStartedFromBot,
  maybeAutoDetectDuelResults,
  pairDuelQueue,
  recordDuelMatch,
  removeFromDuelQueue,
  resetDuelLadderMemoForTests,
  settleDuelAccepts,
  touchDuelQueueHeartbeat,
  voidDuelResult,
} from "@/lib/inhouse-duel-service";
import { loadDuelRoomRows } from "@/lib/inhouse-duel-room";
import { makeUser, ON_POSTGRES, raceAll, sessionFor } from "./factories";

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

// Whether a lobby bot can host 1v1s here (a connection and the in-house
// ticket). Mocked on: 1v1s are bot only, so a join is refused without one.
// The bot's own calls stay unconfigured (no connection), so its reads answer
// null and its releases are no-ops, unless a test stubs the env and fetch.
vi.mock("@/lib/dota-lobby-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota-lobby-service")>();
  return { ...actual, inhouseLobbyBotConfigured: vi.fn(() => true) };
});
import { inhouseLobbyBotConfigured } from "@/lib/dota-lobby-service";
const mockBotReady = vi.mocked(inhouseLobbyBotConfigured);

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
    radiantAcceptedAt: Date | null;
    direAcceptedAt: Date | null;
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
  mockBotReady.mockReset().mockReturnValue(true);
  resetDuelLadderMemoForTests();
});

afterEach(() => {
  setRaceHook(null);
});

describe("the accept step", () => {
  const acceptingDuel = (
    radiant: U,
    dire: U,
    extra: Parameters<typeof makeDuel>[3] = {},
  ) => makeDuel(radiant, dire, INHOUSE_DUEL_STATUS.ACCEPTING, extra);
  const lateBy = (s: number) =>
    new Date(Date.now() - (INHOUSE_DUEL.ACCEPT_SECONDS + s) * 1000);

  it("pairs into ACCEPTING, and only both accepts make it READY", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    await joinDuelQueue(sessionFor(a));
    await joinDuelQueue(sessionFor(b));
    const duel = await prisma.inhouseDuel.findFirstOrThrow();
    expect(duel.status).toBe(INHOUSE_DUEL_STATUS.ACCEPTING);
    // Paired players can't queue again meanwhile.
    expect(await joinDuelQueue(sessionFor(a))).toEqual({ ok: false, error: DUEL_REFUSAL.IN_DUEL });

    expect(await acceptDuel(sessionFor(a), duel.id)).toEqual({ ok: true });
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.ACCEPTING);
    expect(await acceptDuel(sessionFor(b), duel.id)).toEqual({ ok: true });
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.READY);
    // A press after it went through is fine and changes nothing.
    expect(await acceptDuel(sessionFor(a), duel.id)).toEqual({ ok: true });
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.READY);
  });

  for (const side of ["radiant", "dire"] as const) {
    it(`one accept (${side}) leaves it ACCEPTING, and a second press keeps the first stamp`, async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      const duel = await acceptingDuel(a, b);
      const player = side === "radiant" ? a : b;
      expect(await acceptDuel(sessionFor(player), duel.id)).toEqual({ ok: true });
      const first = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
      expect(first.status).toBe(INHOUSE_DUEL_STATUS.ACCEPTING);
      const stamp = side === "radiant" ? first.radiantAcceptedAt : first.direAcceptedAt;
      expect(stamp).not.toBeNull();
      await new Promise((r) => setTimeout(r, 5));
      expect(await acceptDuel(sessionFor(player), duel.id)).toEqual({ ok: true });
      const again = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
      expect(side === "radiant" ? again.radiantAcceptedAt : again.direAcceptedAt).toEqual(stamp);
      expect(again.status).toBe(INHOUSE_DUEL_STATUS.ACCEPTING);
    });

    it(`refuses a late accept (${side}) and writes nothing`, async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      const duel = await acceptingDuel(a, b, { createdAt: lateBy(1) });
      const player = side === "radiant" ? a : b;
      expect(await acceptDuel(sessionFor(player), duel.id)).toEqual({
        ok: false,
        error: "Too late: the time to accept this 1v1 ran out.",
      });
      const row = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
      expect([row.radiantAcceptedAt, row.direAcceptedAt]).toEqual([null, null]);
    });
  }

  it("is only the two players' to accept or decline, never an admin's or a stranger's", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const admin = await makeUser("Admin", "ADMIN");
    const duel = await acceptingDuel(a, b);
    expect((await acceptDuel(sessionFor(admin), duel.id)).ok).toBe(false);
    expect((await declineDuel(sessionFor(admin), duel.id)).ok).toBe(false);
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.ACCEPTING);
    // A READY duel has nothing to decline.
    const ready = await makeDuel(a, b);
    expect((await declineDuel(sessionFor(a), ready.id)).ok).toBe(false);
  });

  it("a decline cancels it, drops the decliner and puts the other back at the front", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const older = await makeUser("Older");
    const duel = await acceptingDuel(a, b, { createdAt: new Date(Date.now() - 20_000) });
    // Someone who joined after the pairing waits behind the one put back.
    await queueRow(older, { joinedAgoS: 5 });
    expect(await declineDuel(sessionFor(a), duel.id)).toEqual({ ok: true });
    const closed = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(closed.status).toBe(INHOUSE_DUEL_STATUS.CANCELLED);
    expect(closed.endReason).toBe(duelEndReason.declined("A"));
    expect(closed.completedAt).not.toBeNull();
    expect(await prisma.inhouseDuelQueueEntry.findUnique({ where: { userId: a.id } })).toBeNull();
    const back = await prisma.inhouseDuelQueueEntry.findUniqueOrThrow({ where: { userId: b.id } });
    expect(back.joinedAt).toEqual(closed.createdAt);
    // The next joiner pairs with the one put back, not the later joiner.
    const next = await makeUser("Next");
    await joinDuelQueue(sessionFor(next));
    const paired = await prisma.inhouseDuel.findFirstOrThrow({
      where: { status: INHOUSE_DUEL_STATUS.ACCEPTING },
    });
    expect([paired.radiantUserId, paired.direUserId].sort()).toEqual([b.id, next.id].sort());
  });

  it("the worker closes an unaccepted duel: whoever accepted goes back, whoever didn't is dropped", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const c = await makeUser("C");
    const d = await makeUser("D");
    const oneAccepted = await acceptingDuel(a, b, {
      createdAt: lateBy(5),
      radiantAcceptedAt: lateBy(-10),
    });
    const noneAccepted = await acceptingDuel(c, d, { createdAt: lateBy(5) });
    const fresh = await acceptingDuel(await makeUser("E"), await makeUser("F"));
    expect(await settleDuelAccepts()).toEqual({ readied: 0, expired: 2 });
    const closed = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: oneAccepted.id } });
    expect(closed.status).toBe(INHOUSE_DUEL_STATUS.CANCELLED);
    expect(closed.endReason).toBe(duelEndReason.notAccepted(["B"]));
    expect(
      (await prisma.inhouseDuelQueueEntry.findMany()).map((q) => q.userId),
    ).toEqual([a.id]);
    expect((await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: noneAccepted.id } })).endReason).toBe(
      duelEndReason.notAccepted(["C", "D"]),
    );
    expect(await statusOf(fresh.id)).toBe(INHOUSE_DUEL_STATUS.ACCEPTING);
  });

  it("the worker makes READY a duel both accepted whose promote never ran", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await acceptingDuel(a, b, {
      radiantAcceptedAt: new Date(),
      direAcceptedAt: new Date(),
    });
    expect(await settleDuelAccepts()).toEqual({ readied: 1, expired: 0 });
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.READY);
  });

  it("an admin can cancel an accepting duel, and nobody is put back", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const admin = await makeUser("Admin", "ADMIN");
    const duel = await acceptingDuel(a, b, { radiantAcceptedAt: new Date() });
    vi.mocked((await import("@/lib/auth")).getSessionUser).mockResolvedValueOnce(
      sessionFor(admin),
    );
    expect(await cancelDuel(sessionFor(admin), duel.id)).toEqual({ ok: true });
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.CANCELLED);
    expect(await prisma.inhouseDuelQueueEntry.count()).toBe(0);
  });

  it("the room shows an accepting duel and its stamps", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await acceptingDuel(a, b, { direAcceptedAt: new Date() });
    const rows = await loadDuelRoomRows();
    const row = rows.duels.find((d) => d.id === duel.id);
    expect(row?.status).toBe(INHOUSE_DUEL_STATUS.ACCEPTING);
    expect(row?.radiantAcceptedAt).toBeNull();
    expect(row?.direAcceptedAt).not.toBeNull();
  });

  it("raced accepts from both players make it READY exactly once", async () => {
    for (let i = 0; i < 4; i += 1) {
      const a = await makeUser(`A${i}`);
      const b = await makeUser(`B${i}`);
      const duel = await acceptingDuel(a, b);
      const results = await raceAll([
        () => acceptDuel(sessionFor(a), duel.id),
        () => acceptDuel(sessionFor(b), duel.id),
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.READY);
    }
  });

  it("an accept loses to a decline that lands after its read", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await acceptingDuel(a, b);
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.acceptDuel.beforeClaim", async () => {
        fired = true;
        expect(await declineDuel(sessionFor(b), duel.id)).toEqual({ ok: true });
      }),
    );
    expect(await acceptDuel(sessionFor(a), duel.id)).toEqual({
      ok: false,
      error: "That 1v1 was called off before it started.",
    });
    expect(fired).toBe(true);
    const row = await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(row.status).toBe(INHOUSE_DUEL_STATUS.CANCELLED);
    expect(row.radiantAcceptedAt).toBeNull();
  });

  it("a decline loses to the accept that made it READY after its read", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await acceptingDuel(a, b, { radiantAcceptedAt: new Date() });
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.declineDuel.beforeClaim", async () => {
        fired = true;
        expect(await acceptDuel(sessionFor(b), duel.id)).toEqual({ ok: true });
      }),
    );
    expect((await declineDuel(sessionFor(a), duel.id)).ok).toBe(false);
    expect(fired).toBe(true);
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.READY);
    expect(await prisma.inhouseDuelQueueEntry.count()).toBe(0);
  });

  it("the promote never brings back a duel cancelled after its read", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const admin = await makeUser("Admin", "ADMIN");
    const duel = await acceptingDuel(a, b, {
      radiantAcceptedAt: new Date(),
      direAcceptedAt: new Date(),
    });
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.promoteAcceptedDuel.beforeClaim", async () => {
        fired = true;
        expect(await cancelDuel(sessionFor(admin), duel.id)).toEqual({ ok: true });
      }),
    );
    expect(await settleDuelAccepts()).toEqual({ readied: 0, expired: 0 });
    expect(fired).toBe(true);
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.CANCELLED);
  });

  it("the expiry loses to an accept that completed the pair after its read", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await acceptingDuel(a, b, { radiantAcceptedAt: new Date() });
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.settleDuelAccepts.beforeExpireClaim", async () => {
        fired = true;
        // In real time the accept is still in time; the worker judged a
        // later clock.
        expect(await acceptDuel(sessionFor(b), duel.id)).toEqual({ ok: true });
      }),
    );
    const later = Date.now() + (INHOUSE_DUEL.ACCEPT_SECONDS + 5) * 1000;
    expect(await settleDuelAccepts(later)).toEqual({ readied: 0, expired: 0 });
    expect(fired).toBe(true);
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.READY);
    expect(await prisma.inhouseDuelQueueEntry.count()).toBe(0);
  });

  it("the expiry never closes a pair whose second stamp landed after its read, before the promote", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const duel = await acceptingDuel(a, b, { radiantAcceptedAt: new Date() });
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.settleDuelAccepts.beforeExpireClaim", async () => {
        fired = true;
        // An accept's own write, its promote still to come.
        await prisma.inhouseDuel.update({
          where: { id: duel.id },
          data: { direAcceptedAt: new Date() },
        });
      }),
    );
    const later = Date.now() + (INHOUSE_DUEL.ACCEPT_SECONDS + 5) * 1000;
    expect(await settleDuelAccepts(later)).toEqual({ readied: 0, expired: 0 });
    expect(fired).toBe(true);
    expect(await statusOf(duel.id)).toBe(INHOUSE_DUEL_STATUS.ACCEPTING);
    // The next pass makes it READY.
    expect(await settleDuelAccepts()).toEqual({ readied: 1, expired: 0 });
  });
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
    expect(duels[0].status).toBe(INHOUSE_DUEL_STATUS.ACCEPTING);
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

  it("refuses every join while no lobby bot can host 1v1s here: a pair could never play", async () => {
    const waiter = await makeUser("W");
    await queueRow(waiter);
    mockBotReady.mockReturnValue(false);
    expect(await joinDuelQueue(sessionFor(await makeUser("J")))).toEqual({
      ok: false,
      error: DUEL_NO_BOT_NOTE,
    });
    expect(await prisma.inhouseDuel.count()).toBe(0);
    expect(await prisma.inhouseDuelQueueEntry.count()).toBe(1);
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

  it("never takes a rematch's match: a later 1v1 of the same players caps the earlier duel's result", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const first = await makeDuel(a, b, INHOUSE_DUEL_STATUS.AWAITING_RESULT, {
      createdAt: new Date(Date.now() - 40 * 60_000),
      startedAt: new Date(Date.now() - 38 * 60_000),
    });
    // They ran it back: the second 1v1 paired ten minutes ago.
    const secondAt = Date.now() - 10 * 60_000;
    const second = await makeDuel(b, a, INHOUSE_DUEL_STATUS.PLAYING, {
      createdAt: new Date(secondAt),
      startedAt: new Date(secondAt + 60_000),
      checkedAt: new Date(),
    });
    // Only the rematch's match is on OpenDota yet.
    const rematchS = Math.floor(secondAt / 1000) + 120;
    mockRecent.mockImplementation(async (account) => [
      recent(8_100_000_602, rematchS, account === accountOf(a) ? 128 : 0),
    ]);
    mockMatch.mockResolvedValue(duelMatch(b, a, { id: 8_100_000_602, startAt: rematchS * 1000 }));
    await maybeAutoDetectDuelResults();
    expect(await statusOf(first.id)).toBe(INHOUSE_DUEL_STATUS.AWAITING_RESULT);
    // The scan never even fetched it for the earlier duel.
    expect(mockMatch).not.toHaveBeenCalled();
    // Pasted onto the earlier duel, it is refused and named.
    const pasted = await recordDuelMatch(sessionFor(a), "8100000602", first.id);
    expect(pasted.ok).toBe(false);
    expect(!pasted.ok && pasted.error).toMatch(/later 1v1/);
    expect(await statusOf(first.id)).toBe(INHOUSE_DUEL_STATUS.AWAITING_RESULT);
    // The rematch takes it.
    expect(await recordDuelMatch(sessionFor(a), "8100000602", second.id)).toEqual({ ok: true });
  });

  it("takes the oldest shared match after pairing, never a newer one", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const createdAt = new Date(Date.now() - 30 * 60_000);
    const duel = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING, {
      createdAt,
      startedAt: createdAt,
    });
    const s0 = Math.floor(createdAt.getTime() / 1000);
    mockRecent.mockImplementation(async (account) => {
      const slot = account === accountOf(a) ? 0 : 128;
      return [recent(8_100_000_702, s0 + 900, slot), recent(8_100_000_701, s0 + 60, slot)];
    });
    mockMatch.mockImplementation(async (id) =>
      duelMatch(a, b, { id: Number(id), startAt: (Number(id) === 8_100_000_701 ? s0 + 60 : s0 + 900) * 1000 }),
    );
    await maybeAutoDetectDuelResults();
    expect(mockMatch).toHaveBeenNthCalledWith(1, "8100000701", expect.anything());
    expect(
      (await prisma.inhouseDuel.findUniqueOrThrow({ where: { id: duel.id } })).dotaMatchId,
    ).toBe("8100000701");
  });

  it("while OpenDota lacks the bot's match, reads only that match until BOT_MATCH_WAIT_MINUTES", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const young = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING, {
      createdAt: new Date(Date.now() - 20 * 60_000),
      startedAt: new Date(Date.now() - 18 * 60_000),
      botMatchId: "8100000801",
    });
    await maybeAutoDetectDuelResults();
    expect(mockMatch).toHaveBeenCalledWith("8100000801", expect.anything());
    expect(mockRecent).not.toHaveBeenCalled();
    expect(await statusOf(young.id)).toBe(INHOUSE_DUEL_STATUS.PLAYING);
    // Past the wait, the histories are read as well.
    const wait = INHOUSE_DUEL.BOT_MATCH_WAIT_MINUTES;
    await prisma.inhouseDuel.update({
      where: { id: young.id },
      data: {
        createdAt: new Date(Date.now() - (wait + 5) * 60_000),
        startedAt: new Date(Date.now() - wait * 60_000),
        checkedAt: null,
      },
    });
    await maybeAutoDetectDuelResults();
    expect(mockRecent).toHaveBeenCalledTimes(2);
  });

  it("stops the pass when OpenDota is unreachable", async () => {
    const users = await Promise.all(Array.from({ length: 4 }, (_, i) => makeUser(`U${i}`)));
    const old = new Date(Date.now() - 30 * 60_000);
    const first = await makeDuel(users[0], users[1], INHOUSE_DUEL_STATUS.PLAYING, {
      createdAt: old,
      checkedAt: new Date(Date.now() - 20 * 60_000),
    });
    const second = await makeDuel(users[2], users[3], INHOUSE_DUEL_STATUS.PLAYING, {
      createdAt: old,
      checkedAt: new Date(Date.now() - 10 * 60_000),
    });
    mockRecent.mockResolvedValue(null);
    await maybeAutoDetectDuelResults();
    expect(mockRecent).toHaveBeenCalledTimes(2);
    const after = await prisma.inhouseDuel.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { id: true, checkedAt: true },
    });
    const stamped = (id: string) =>
      (after.find((d) => d.id === id)?.checkedAt?.getTime() ?? 0) > Date.now() - 5_000;
    expect(stamped(first.id)).toBe(true);
    expect(stamped(second.id)).toBe(false);
  });

  it("backs off a long game's scan as it ages, and never scans a READY duel", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    // Two hours into its game, scanned five minutes ago: its interval is six.
    const long = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING, {
      createdAt: new Date(Date.now() - 125 * 60_000),
      startedAt: new Date(Date.now() - 120 * 60_000),
      checkedAt: new Date(Date.now() - 5 * 60_000),
    });
    // A READY duel well past SCAN_AFTER_MINUTES: no game, so no scan.
    const ready = await makeDuel(a, b, INHOUSE_DUEL_STATUS.READY, {
      createdAt: new Date(Date.now() - 20 * 60_000),
    });
    await maybeAutoDetectDuelResults();
    expect(mockRecent).not.toHaveBeenCalled();
    const rows = await prisma.inhouseDuel.findMany({
      where: { id: { in: [long.id, ready.id] } },
      select: { id: true, checkedAt: true },
    });
    expect(rows.find((r) => r.id === ready.id)?.checkedAt).toBeNull();
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
    // No bot that hosts 1v1s: the setup clock alone calls it off.
    mockBotReady.mockReturnValue(false);
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

  describe("with a lobby bot that hosts 1v1s", () => {
    beforeEach(() => {
      vi.stubEnv("DOTA_LOBBY_BOT_URL", "http://127.0.0.1:8090");
      vi.stubEnv("DOTA_LOBBY_BOT_SECRET", "test-lobby-secret-".repeat(4));
      vi.stubEnv("DOTA_INHOUSE_LEAGUE_ID", "54321");
    });
    afterEach(async () => {
      const { settleInhouseBotReleases } = await import("@/lib/lobby-bot-releases");
      await settleInhouseBotReleases();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it("calls off a never-played duel only on this pass's bot read showing no game starting", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ state: "idle" })));
      const a = await makeUser("A");
      const b = await makeUser("B");
      const stale = await makeDuel(a, b, INHOUSE_DUEL_STATUS.READY, {
        createdAt: new Date(Date.now() - (INHOUSE_DUEL.SETUP_MINUTES + 1) * 60_000),
      });
      // Not read this pass (its deadline, an unreachable bot): it waits.
      expect(await giveUpOnDuels(Date.now())).toBe(0);
      expect(await giveUpOnDuels(Date.now(), new Map([[stale.id, null]]))).toBe(0);
      // A launch the site hasn't seen yet: it waits for that read to land.
      for (const state of ["started", "starting"] as const) {
        expect(await giveUpOnDuels(Date.now(), new Map([[stale.id, { state }]]))).toBe(0);
      }
      expect(await statusOf(stale.id)).toBe(INHOUSE_DUEL_STATUS.READY);
      // Read this pass with no game starting: called off.
      expect(await giveUpOnDuels(Date.now(), new Map([[stale.id, { state: "ready" }]]))).toBe(1);
      expect(await statusOf(stale.id)).toBe(INHOUSE_DUEL_STATUS.CANCELLED);
    });

    it("closes an unread never-played duel GIVE_UP_HOURS after pairing regardless", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ state: "idle" })));
      const a = await makeUser("A");
      const b = await makeUser("B");
      const ancient = await makeDuel(a, b, INHOUSE_DUEL_STATUS.READY, {
        createdAt: new Date(Date.now() - (INHOUSE_DUEL.GIVE_UP_HOURS * 60 + 1) * 60_000),
      });
      expect(await giveUpOnDuels(Date.now())).toBe(1);
      expect(await statusOf(ancient.id)).toBe(INHOUSE_DUEL_STATUS.CANCELLED);
    });

    it("the worker passes its own reads: a launch read near the deadline is never cancelled", async () => {
      const { runDuelWorkerSteps } = await import("@/lib/inhouse-duel-service");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as { action: string };
          if (body.action === "health")
            return Response.json({ online: true, steamId: null, activeKey: null });
          return Response.json({ state: "starting" });
        }),
      );
      const a = await makeUser("A");
      const b = await makeUser("B");
      const stale = await makeDuel(a, b, INHOUSE_DUEL_STATUS.READY, {
        createdAt: new Date(Date.now() - (INHOUSE_DUEL.SETUP_MINUTES + 1) * 60_000),
      });
      await runDuelWorkerSteps();
      expect(await statusOf(stale.id)).toBe(INHOUSE_DUEL_STATUS.READY);
    });
  });

  it("the never-played call-off loses to a launch landing after its read", async () => {
    // No bot that hosts 1v1s: the setup clock alone calls it off.
    mockBotReady.mockReturnValue(false);
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
    await makeDuel(a, b, INHOUSE_DUEL_STATUS.CANCELLED, {
      completedAt: new Date(Date.now() - INHOUSE_DUEL.LAST_RESULT_WINDOW_MS - 60_000),
    });
    // A 1v1 called off just now: its players are told, so the rows carry it.
    const calledOff = await makeDuel(a, b, INHOUSE_DUEL_STATUS.READY);
    expect(await callOffDuel(sessionFor(a), calledOff.id)).toEqual({ ok: true });
    const rows = await loadDuelRoomRows();
    expect(rows.queue.map((q) => q.userId)).toEqual([a.id]);
    expect(rows.duels.map((d) => d.id).sort()).toEqual(
      [open.id, recentDone.id, calledOff.id].sort(),
    );
    expect(rows.duels.find((d) => d.id === calledOff.id)?.endReason).toBe(
      duelEndReason.calledOff("A"),
    );
  });

  it("stamps when each close happened, so its players are told", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const admin = sessionFor(await makeUser("Admin", "ADMIN"));
    const before = Date.now() - 1000;
    const closedAt = async (id: string) =>
      (await prisma.inhouseDuel.findUniqueOrThrow({ where: { id } })).completedAt?.getTime() ?? 0;
    const called = await makeDuel(a, b);
    await callOffDuel(sessionFor(a), called.id);
    const cancelled = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    await cancelDuel(admin, cancelled.id);
    const botEnded = await makeDuel(a, b, INHOUSE_DUEL_STATUS.PLAYING);
    await cancelDuelFromBot(botEnded.id, "not scored");
    mockBotReady.mockReturnValue(false);
    const stale = await makeDuel(a, b, INHOUSE_DUEL_STATUS.READY, {
      createdAt: new Date(Date.now() - (INHOUSE_DUEL.SETUP_MINUTES + 1) * 60_000),
    });
    const lost = await makeDuel(a, b, INHOUSE_DUEL_STATUS.AWAITING_RESULT, {
      createdAt: new Date(Date.now() - (INHOUSE_DUEL.GIVE_UP_HOURS * 60 + 1) * 60_000),
    });
    expect(await giveUpOnDuels()).toBe(2);
    const done = await makeDuel(a, b, INHOUSE_DUEL_STATUS.COMPLETED, {
      winnerTeam: 1,
      dotaMatchId: "8100000999",
      completedAt: new Date(Date.now() - 3_600_000),
    });
    await voidDuelResult(admin, done.id);
    for (const d of [called, cancelled, botEnded, stale, lost, done]) {
      expect(await closedAt(d.id), d.id).toBeGreaterThan(before);
    }
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

// The pair claim's count check (claimPair) is a deleteMany guard the mutation
// ratchet can't see. This stages its one interleaving: the joiner's
// transaction has judged the waiter pairable, then the waiter's row goes
// (they left) before the claim. In-transaction seam: Postgres only (on
// SQLite the rival waits on the open transaction's lock).
describe.skipIf(!ON_POSTGRES)("the pair claim on Postgres", () => {
  it("a waiter who leaves between the pairing read and the claim is never paired, and the joiner queues", async () => {
    const waiter = await makeUser("Waiter");
    const joiner = await makeUser("Joiner");
    await queueRow(waiter);
    let fired = false;
    setRaceHook(
      onceAt("inhouseDuel.joinDuelQueue.beforePairClaim", async () => {
        fired = true;
        const left = await prisma.inhouseDuelQueueEntry.deleteMany({
          where: { userId: waiter.id },
        });
        expect(left.count).toBe(1);
      }),
    );
    expect(await joinDuelQueue(sessionFor(joiner))).toEqual({ ok: true });
    expect(fired).toBe(true);
    // One outcome, no half state: no duel, the waiter gone, the joiner waiting.
    expect(await prisma.inhouseDuel.count()).toBe(0);
    expect(
      (await prisma.inhouseDuelQueueEntry.findMany({ select: { userId: true } })).map(
        (q) => q.userId,
      ),
    ).toEqual([joiner.id]);
  });
});
