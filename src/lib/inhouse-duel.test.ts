import { describe, expect, it } from "vitest";
import {
  DUEL_GAME_MODE,
  INHOUSE_DUEL,
  INHOUSE_DUEL_STATUS,
} from "./constants";
import type { OpenDotaMatch, OpenDotaRecentMatch } from "./dota";
import {
  DUEL_BOT_SAVED_FOR_5V5,
  DUEL_NO_BOT_NOTE,
  DUEL_REFUSAL,
  DUEL_ROOM_ANCHOR,
  DUEL_SIGN_IN_RETURN,
  DUEL_WAITING_NOTE,
  assignDuelSides,
  duelAdminToolsVisible,
  duelCancelLine,
  duelEndReason,
  duelBotEndedWithoutGame,
  duelBotLobbyMissing,
  duelBotSavedFor5v5,
  buildDuelState,
  duelHeartbeatAction,
  duelJoinRow,
  duelResultCeilingSeconds,
  duelResultLanded,
  duelResultLine,
  duelRoomClocks,
  duelStageLabel,
  duelStake,
  duelWorkerWakeAtMs,
  type DuelMeView,
  type DuelState,
  duelJoinRefusal,
  duelLadder,
  duelMatchFloorSeconds,
  duelNeverPlayedDue,
  duelNextClockMs,
  duelResultGiveUpDue,
  duelBotMatchWaitOver,
  duelScanCutoffFor,
  duelScanDue,
  duelScanDueAtMs,
  duelScanIntervalSeconds,
  duelScanOrder,
  duelToFinishedLobby,
  duelWinnerUserId,
  pickDuelOpponent,
  pickDuelPair,
  sharedDuelMatchIds,
  validateDuelMatch,
  type DuelMatchPlayer,
  type DuelRoomDuelRow,
  type DuelWaiter,
  type FinishedDuelRow,
} from "./inhouse-duel";
import { INHOUSE_ELO, summarizeInhouse } from "./inhouse-stats";
import { sourceFile } from "../../test/support/source-files";
import { INHOUSE_QUEUE_INVITE_PATH } from "./inhouse-queue-invite";

const NOW = Date.UTC(2026, 9, 27, 20, 0, 0);
const sec = (s: number) => new Date(NOW - s * 1000);

function waiter(userId: string, joinedAgoS: number, seenAgoS = 0, expiresInS = 600): DuelWaiter {
  return {
    id: `row-${userId}`,
    userId,
    joinedAt: sec(joinedAgoS),
    lastSeenAt: sec(seenAgoS),
    expiresAt: new Date(NOW + expiresInS * 1000),
  };
}

describe("pairing", () => {
  it("pairs the joiner with the oldest present waiter", () => {
    const ws = [waiter("b", 60), waiter("a", 120), waiter("c", 30)];
    expect(pickDuelOpponent(ws, "me", new Set(), NOW)?.userId).toBe("a");
  });

  it("breaks a joinedAt tie on userId, never row order", () => {
    const ws = [waiter("z", 60), waiter("y", 60)];
    expect(pickDuelOpponent(ws, "me", new Set(), NOW)?.userId).toBe("y");
  });

  it("skips away, expired, busy waiters and the joiner's own row", () => {
    const away = waiter("away", 300, INHOUSE_DUEL.PRESENT_SECONDS + 1);
    const expired = waiter("expired", 290, 0, 0);
    const busy = waiter("busy", 280);
    const me = waiter("me", 270);
    const ok = waiter("ok", 10);
    expect(
      pickDuelOpponent([away, expired, busy, me, ok], "me", new Set(["busy"]), NOW)
        ?.userId,
    ).toBe("ok");
  });

  it("counts a waiter seen exactly PRESENT_SECONDS ago as present", () => {
    const edge = waiter("edge", 300, INHOUSE_DUEL.PRESENT_SECONDS);
    expect(pickDuelOpponent([edge], "me", new Set(), NOW)?.userId).toBe("edge");
  });

  it("waits when nobody can be paired", () => {
    expect(pickDuelOpponent([], "me", new Set(), NOW)).toBeNull();
  });

  it("sweeps the two oldest pairable waiters together", () => {
    const pair = pickDuelPair(
      [waiter("c", 10), waiter("a", 90), waiter("b", 50), waiter("x", 100)],
      new Set(["x"]),
      NOW,
    );
    expect(pair?.map((w) => w.userId)).toEqual(["a", "b"]);
    expect(pickDuelPair([waiter("a", 1)], new Set(), NOW)).toBeNull();
  });

  it("assigns sides at random", () => {
    expect(assignDuelSides("a", "b", () => 0.1)).toEqual({
      radiantUserId: "a",
      direUserId: "b",
    });
    expect(assignDuelSides("a", "b", () => 0.9)).toEqual({
      radiantUserId: "b",
      direUserId: "a",
    });
  });

  it("refuses with the MMR cap first, then a live 5v5, then a live duel", () => {
    expect(duelJoinRefusal({ mmrRefusal: "cap", in5v5: true, inDuel: true })).toBe("cap");
    expect(duelJoinRefusal({ mmrRefusal: null, in5v5: true, inDuel: true })).toBe(
      DUEL_REFUSAL.IN_5V5,
    );
    expect(duelJoinRefusal({ mmrRefusal: null, in5v5: false, inDuel: true })).toBe(
      DUEL_REFUSAL.IN_DUEL,
    );
    expect(duelJoinRefusal({ mmrRefusal: null, in5v5: false, inDuel: false })).toBeNull();
  });
});

describe("clocks", () => {
  const base = { startedAt: null, checkedAt: null };
  const ready = (agoMin: number) => ({
    ...base,
    status: INHOUSE_DUEL_STATUS.READY,
    createdAt: new Date(NOW - agoMin * 60_000),
  });

  it("calls off a READY duel never started at SETUP_MINUTES, not before", () => {
    expect(duelNeverPlayedDue(ready(INHOUSE_DUEL.SETUP_MINUTES), NOW)).toBe(true);
    expect(duelNeverPlayedDue(ready(INHOUSE_DUEL.SETUP_MINUTES - 1), NOW)).toBe(false);
    expect(
      duelNeverPlayedDue(
        { ...ready(60), status: INHOUSE_DUEL_STATUS.PLAYING, startedAt: sec(10) },
        NOW,
      ),
    ).toBe(false);
  });

  it("gives up on a played duel with no result GIVE_UP_HOURS after pairing", () => {
    const at = (status: string, agoMin: number) => ({
      ...base,
      status,
      createdAt: new Date(NOW - agoMin * 60_000),
    });
    const floor = INHOUSE_DUEL.GIVE_UP_HOURS * 60;
    expect(duelResultGiveUpDue(at(INHOUSE_DUEL_STATUS.PLAYING, floor), NOW)).toBe(true);
    expect(duelResultGiveUpDue(at(INHOUSE_DUEL_STATUS.AWAITING_RESULT, floor), NOW)).toBe(
      true,
    );
    expect(duelResultGiveUpDue(at(INHOUSE_DUEL_STATUS.PLAYING, floor - 1), NOW)).toBe(false);
    expect(duelResultGiveUpDue(at(INHOUSE_DUEL_STATUS.READY, floor * 2), NOW)).toBe(false);
  });

  const playing = (agoMin: number, startedAgoMin = agoMin) => ({
    ...base,
    status: INHOUSE_DUEL_STATUS.PLAYING,
    createdAt: new Date(NOW - agoMin * 60_000),
    startedAt: new Date(NOW - startedAgoMin * 60_000),
  });

  it("scans a started game from SCAN_AFTER_MINUTES, then once per SCAN_EVERY_SECONDS, never a closed duel", () => {
    const after = INHOUSE_DUEL.SCAN_AFTER_MINUTES;
    expect(duelScanDue(playing(after - 1), NOW)).toBe(false);
    expect(duelScanDue(playing(after), NOW)).toBe(true);
    expect(
      duelScanDue({ ...playing(20), checkedAt: sec(INHOUSE_DUEL.SCAN_EVERY_SECONDS - 1) }, NOW),
    ).toBe(false);
    expect(
      duelScanDue({ ...playing(20), checkedAt: sec(INHOUSE_DUEL.SCAN_EVERY_SECONDS) }, NOW),
    ).toBe(true);
    const awaiting = { ...playing(20), status: INHOUSE_DUEL_STATUS.AWAITING_RESULT };
    expect(duelScanDue(awaiting, NOW)).toBe(true);
    for (const status of [INHOUSE_DUEL_STATUS.COMPLETED, INHOUSE_DUEL_STATUS.CANCELLED]) {
      expect(duelScanDue({ ...playing(60), status }, NOW)).toBe(false);
      expect(duelNextClockMs({ ...playing(60), status })).toBeNull();
    }
  });

  it("never scans a READY duel: its game never started, so no result exists", () => {
    expect(duelScanDue(ready(60), NOW)).toBe(false);
    expect(duelScanDueAtMs(ready(60))).toBeNull();
  });

  it("stretches the scan interval with the game's age, to SCAN_MAX_SECONDS", () => {
    expect(duelScanIntervalSeconds(0)).toBe(INHOUSE_DUEL.SCAN_EVERY_SECONDS);
    expect(duelScanIntervalSeconds(60 * 60_000)).toBe(180);
    expect(duelScanIntervalSeconds(2 * 3_600_000)).toBe(360);
    expect(duelScanIntervalSeconds(24 * 3_600_000)).toBe(INHOUSE_DUEL.SCAN_MAX_SECONDS);
    // A game two hours in, scanned five minutes ago: its interval is six.
    const old = { ...playing(130, 120), checkedAt: sec(300) };
    expect(duelScanDue(old, NOW)).toBe(false);
    const checkedAgoMs = 300_000;
    const interval = duelScanIntervalSeconds(120 * 60_000 - checkedAgoMs) * 1000;
    expect(duelScanDueAtMs(old)).toBe(NOW - checkedAgoMs + interval);
    // The claim's cutoff admits exactly the stamp judged due.
    const due = { ...playing(130, 120), checkedAt: sec(400) };
    expect(duelScanDue(due, NOW)).toBe(true);
    expect(duelScanCutoffFor(due, NOW).getTime()).toBeGreaterThanOrEqual(due.checkedAt.getTime());
    expect(duelScanCutoffFor(due, NOW).getTime()).toBeLessThan(NOW);
  });

  it("waits BOT_MATCH_WAIT_MINUTES after the game started before reading histories for a bot game", () => {
    const wait = INHOUSE_DUEL.BOT_MATCH_WAIT_MINUTES;
    expect(duelBotMatchWaitOver(playing(wait + 10, wait - 1), NOW)).toBe(false);
    expect(duelBotMatchWaitOver(playing(wait + 10, wait), NOW)).toBe(true);
  });

  it("names the next clock: setup for READY, scan or give-up after", () => {
    const r = ready(0);
    expect(duelNextClockMs(r)).toBe(NOW + INHOUSE_DUEL.SETUP_MINUTES * 60_000);
    const p = playing(0);
    expect(duelNextClockMs(p)).toBe(NOW + INHOUSE_DUEL.SCAN_AFTER_MINUTES * 60_000);
    const checked = { ...playing(179), checkedAt: sec(0) };
    expect(duelNextClockMs(checked)).toBe(
      checked.createdAt.getTime() + INHOUSE_DUEL.GIVE_UP_HOURS * 3_600_000,
    );
  });

  it("orders the scan stalest first", () => {
    const rows = [
      { id: "b", createdAt: sec(100), checkedAt: sec(400) },
      { id: "a", createdAt: sec(50), checkedAt: null },
      { id: "c", createdAt: sec(200), checkedAt: sec(900) },
    ];
    expect(duelScanOrder(rows).map((r) => r.id)).toEqual(["a", "c", "b"]);
  });
});

function match(over: Partial<OpenDotaMatch> = {}): OpenDotaMatch {
  return {
    match_id: 8_000_000_001,
    radiant_win: true,
    duration: 600,
    start_time: Math.floor(NOW / 1000) + 60,
    game_mode: DUEL_GAME_MODE.id,
    players: [
      { account_id: 11, player_slot: 0, hero_id: 1, kills: 2, deaths: 0, assists: 0 },
      { account_id: 22, player_slot: 128, hero_id: 2, kills: 0, deaths: 2, assists: 0 },
    ],
    ...over,
  };
}

const duel: { createdAtMs: number; players: DuelMatchPlayer[]; ceilingSeconds?: number | null } = {
  createdAtMs: NOW,
  players: [
    { userId: "A", accountId: 22 },
    { userId: "B", accountId: 11 },
  ],
};

describe("validateDuelMatch", () => {
  it("reads the winner from the side each player actually played", () => {
    const r = validateDuelMatch(match(), duel);
    expect(r).toEqual({
      ok: true,
      result: {
        dotaMatchId: "8000000001",
        radiantUserId: "B",
        direUserId: "A",
        winnerTeam: 1,
        winnerUserId: "B",
        durationSecs: 600,
        radiantHeroId: 1,
        direHeroId: 2,
        startTime: match().start_time,
      },
    });
    const dire = validateDuelMatch(match({ radiant_win: false }), duel);
    expect(dire.ok && dire.result.winnerUserId).toBe("A");
  });

  it("trusts isRadiant over the slot", () => {
    const m = match();
    m.players[0].isRadiant = false;
    m.players[1].isRadiant = true;
    const r = validateDuelMatch(m, duel);
    expect(r.ok && r.result.radiantUserId).toBe("A");
  });

  it("refuses everything that isn't this duel's finished 1v1", () => {
    const reason = (m: OpenDotaMatch, d = duel) => {
      const r = validateDuelMatch(m, d);
      return r.ok ? "ok" : r.reason;
    };
    expect(reason(match({ game_mode: 2 }))).toBe("wrong-mode");
    expect(reason(match({ game_mode: undefined }))).toBe("wrong-mode");
    expect(reason(match({ players: match().players.slice(0, 1) }))).toBe("not-two-players");
    expect(reason(match({ start_time: duelMatchFloorSeconds(NOW) - 1 }))).toBe("before-duel");
    expect(reason(match({ start_time: duelMatchFloorSeconds(NOW) }))).toBe("ok");
    // A later 1v1 of either player was paired: a match from then on is its.
    const start = match().start_time;
    expect(reason(match(), { ...duel, ceilingSeconds: start })).toBe("after-next-duel");
    expect(reason(match(), { ...duel, ceilingSeconds: start + 1 })).toBe("ok");
    expect(reason(match(), { ...duel, ceilingSeconds: null })).toBe("ok");
    expect(
      reason(match(), { ...duel, players: [duel.players[0], { userId: "B", accountId: 99 }] }),
    ).toBe("not-these-players");
    expect(
      reason(match(), { ...duel, players: [duel.players[0], { userId: "B", accountId: null }] }),
    ).toBe("not-these-players");
    const sameSide = match();
    sameSide.players[1].player_slot = 1;
    expect(reason(sameSide)).toBe("same-side");
    expect(reason(match({ duration: 0 }))).toBe("unfinished");
    expect(reason(match({ radiant_win: undefined as unknown as boolean }))).toBe("unfinished");
  });

  it("maps a stored winnerTeam to its player", () => {
    const d = { radiantUserId: "r", direUserId: "d" };
    expect(duelWinnerUserId({ ...d, winnerTeam: 1 })).toBe("r");
    expect(duelWinnerUserId({ ...d, winnerTeam: 2 })).toBe("d");
    expect(duelWinnerUserId({ ...d, winnerTeam: null })).toBeNull();
  });
});

describe("sharedDuelMatchIds", () => {
  const recent = (
    id: number,
    start: number,
    slot: number | null,
    mode: number | null = DUEL_GAME_MODE.id,
  ): OpenDotaRecentMatch => ({
    match_id: id,
    start_time: start,
    game_mode: mode,
    lobby_type: 1,
    player_slot: slot,
  });

  it("keeps 1v1 matches both played, on opposite sides, since the floor, oldest first", () => {
    const a = [
      recent(1, 100, 0),
      recent(2, 300, 0),
      recent(3, 200, 0, 22),
      recent(4, 50, 0),
      recent(5, 250, 0),
      recent(6, 260, null),
    ];
    const b = [
      recent(1, 100, 128),
      recent(2, 300, 128),
      recent(3, 200, 128, 22),
      recent(4, 50, 128),
      recent(5, 250, 1),
      recent(6, 260, 128),
    ];
    expect(sharedDuelMatchIds(a, b, 80)).toEqual([1, 6, 2]);
    // A later 1v1 of either player was paired at 260: its game (and later)
    // is never this duel's.
    expect(sharedDuelMatchIds(a, b, 80, 260)).toEqual([1]);
    expect(sharedDuelMatchIds(a, b, 80, null)).toEqual([1, 6, 2]);
  });

  it("refuses a match that started at or after a later 1v1's pairing", () => {
    expect(duelResultCeilingSeconds(null)).toBeNull();
    expect(duelResultCeilingSeconds(1_000_999)).toBe(1000);
  });
});

const user = (id: string) => ({ id, name: `name-${id}`, avatar: null, rankTier: null });

describe("the 1v1 ladder", () => {
  const finished = (
    id: string,
    agoMin: number,
    radiant: string,
    dire: string,
    winnerTeam: number,
  ): FinishedDuelRow => ({
    id,
    winnerTeam,
    createdAt: new Date(NOW - agoMin * 60_000),
    radiantUserId: radiant,
    direUserId: dire,
    radiantUser: user(radiant),
    direUser: user(dire),
  });

  it("rates sides of one as plain one-on-one Elo", () => {
    const rows = summarizeInhouse([duelToFinishedLobby(finished("d1", 10, "a", "b", 1))]);
    const a = rows.find((r) => r.userId === "a")!;
    const b = rows.find((r) => r.userId === "b")!;
    // Equal ratings: expected 0.5, so the winner gains K/2 and the loser drops it.
    expect(a.rating).toBe(INHOUSE_ELO.START + INHOUSE_ELO.K / 2);
    expect(b.rating).toBe(INHOUSE_ELO.START - INHOUSE_ELO.K / 2);
    expect([a.wins, a.losses, b.wins, b.losses]).toEqual([1, 0, 0, 1]);
  });

  it("splits provisional players from the ranked block, in [createdAt, id] order", () => {
    const duels = Array.from({ length: 5 }, (_, i) =>
      finished(`d${i}`, 100 - i, i % 2 ? "a" : "b", i % 2 ? "b" : "a", 1),
    );
    duels.push(finished("dx", 1, "c", "a", 2));
    const ladder = duelLadder(duels);
    expect(ladder.ranked.map((r) => r.userId).sort()).toEqual(["a", "b"]);
    expect(ladder.provisional.map((r) => r.userId)).toEqual(["c"]);
    const a = ladder.ranked.find((r) => r.userId === "a")!;
    expect(a.games).toBe(6);
    expect(a.form[0]).toBe("W"); // the newest duel, dx, which a won as Dire
  });
});

describe("buildDuelState", () => {
  const duelRow = (
    id: string,
    status: string,
    radiant: string,
    dire: string,
    over: Partial<DuelRoomDuelRow> = {},
  ): DuelRoomDuelRow => ({
    id,
    status,
    createdAt: new Date(NOW - 60_000),
    startedAt: null,
    finishedAt: null,
    completedAt: null,
    winnerTeam: null,
    dotaMatchId: null,
    durationSecs: null,
    radiantHeroId: null,
    direHeroId: null,
    endReason: null,
    radiantUser: user(radiant),
    direUser: user(dire),
    ...over,
  });
  const queueRow = (userId: string, joinedAgoS: number, seenAgoS = 0, expiresInS = 600) => ({
    userId,
    joinedAt: sec(joinedAgoS),
    lastSeenAt: sec(seenAgoS),
    expiresAt: new Date(NOW + expiresInS * 1000),
    user: { name: `name-${userId}`, avatar: null },
  });
  const noExtras = { in5v5: false, mmrRefusal: null };

  it("shows a signed-out viewer the queue and games with no me-flags", () => {
    const s = buildDuelState(
      null,
      {
        queue: [queueRow("q2", 10), queueRow("q1", 20, INHOUSE_DUEL.PRESENT_SECONDS + 5), queueRow("gone", 30, 0, -1)],
        duels: [duelRow("d", INHOUSE_DUEL_STATUS.READY, "a", "b")],
      },
      noExtras,
      NOW,
    );
    expect(s.me).toBeNull();
    expect(s.queue.players.map((p) => [p.userId, p.present])).toEqual([
      ["q1", false],
      ["q2", true],
    ]);
    expect(s.queue.present).toBe(1);
    expect(s.games).toHaveLength(1);
    expect(s.games[0].canCancel).toBe(false);
    expect(s.games[0].setupEndsAt).toBe(NOW - 60_000 + INHOUSE_DUEL.SETUP_MINUTES * 60_000);
    expect(s.canRemoveFromQueue).toBe(false);
  });

  it("lets a free viewer join, a queued one leave", () => {
    const viewer = { id: "v", role: "USER" };
    const free = buildDuelState(viewer, { queue: [], duels: [] }, noExtras, NOW).me!;
    expect([free.canJoin, free.canLeave]).toEqual([true, false]);
    const queued = buildDuelState(
      viewer,
      { queue: [queueRow("v", 30)], duels: [] },
      noExtras,
      NOW,
    ).me!;
    expect([queued.inQueue, queued.canJoin, queued.canLeave]).toEqual([true, false, true]);
    const in5v5 = buildDuelState(viewer, { queue: [], duels: [] }, { in5v5: true, mmrRefusal: null }, NOW).me!;
    expect([in5v5.canJoin, in5v5.joinRefusal]).toEqual([false, DUEL_REFUSAL.IN_5V5]);
    const capped = buildDuelState(viewer, { queue: [], duels: [] }, { in5v5: false, mmrRefusal: "cap" }, NOW).me!;
    expect([capped.canJoin, capped.joinRefusal]).toEqual([false, "cap"]);
  });

  it("gives a paired player Call it off while READY, 1v1 over while PLAYING", () => {
    const viewer = { id: "a", role: "USER" };
    const ready = buildDuelState(
      viewer,
      { queue: [], duels: [duelRow("d", INHOUSE_DUEL_STATUS.READY, "a", "b")] },
      noExtras,
      NOW,
    ).me!;
    expect(ready).toMatchObject({
      duelId: "d",
      canJoin: false,
      joinRefusal: DUEL_REFUSAL.IN_DUEL,
      canCallOff: true,
      canOver: false,
      canRecord: true,
    });
    const playing = buildDuelState(
      viewer,
      {
        queue: [],
        duels: [duelRow("d", INHOUSE_DUEL_STATUS.PLAYING, "a", "b", { startedAt: sec(30) })],
      },
      noExtras,
      NOW,
    ).me!;
    expect(playing).toMatchObject({ canCallOff: false, canOver: true, canRecord: true });
    const awaiting = buildDuelState(
      viewer,
      { queue: [], duels: [duelRow("d", INHOUSE_DUEL_STATUS.AWAITING_RESULT, "a", "b")] },
      noExtras,
      NOW,
    ).me!;
    // Over: free to queue again while the result is on its way.
    expect(awaiting).toMatchObject({ canJoin: true, canOver: false, canRecord: true });
  });

  it("shows the viewer's last result for LAST_RESULT_WINDOW_MS, and admins their controls", () => {
    const done = (agoMs: number) =>
      duelRow("d", INHOUSE_DUEL_STATUS.COMPLETED, "a", "b", {
        winnerTeam: 2,
        completedAt: new Date(NOW - agoMs),
      });
    const fresh = buildDuelState({ id: "a", role: "USER" }, { queue: [], duels: [done(1000)] }, noExtras, NOW);
    expect(fresh.me!.lastResult).toEqual({ duelId: "d", won: false, opponentName: "name-b" });
    expect(fresh.results[0].winnerUserId).toBe("b");
    expect(fresh.results[0].canVoid).toBe(false);
    const stale = buildDuelState(
      { id: "a", role: "USER" },
      { queue: [], duels: [done(INHOUSE_DUEL.LAST_RESULT_WINDOW_MS + 1)] },
      noExtras,
      NOW,
    );
    expect(stale.me!.lastResult).toBeNull();
    const admin = buildDuelState(
      { id: "x", role: "ADMIN" },
      {
        queue: [],
        duels: [done(1000), duelRow("live", INHOUSE_DUEL_STATUS.PLAYING, "c", "e")],
      },
      noExtras,
      NOW,
    );
    expect(admin.canRemoveFromQueue).toBe(true);
    expect(admin.results[0].canVoid).toBe(true);
    expect(admin.games.map((g) => [g.id, g.canCancel, g.mine])).toEqual([["live", true, false]]);
  });

  it("tells the viewer their 1v1 was cancelled, and why, for LAST_RESULT_WINDOW_MS", () => {
    const off = (id: string, agoMs: number, endReason: string, createdAgoMs = agoMs + 60_000) =>
      duelRow(id, INHOUSE_DUEL_STATUS.CANCELLED, "a", "b", {
        createdAt: new Date(NOW - createdAgoMs),
        completedAt: new Date(NOW - agoMs),
        endReason,
      });
    const me = (duels: DuelRoomDuelRow[], id = "a") =>
      buildDuelState({ id, role: "USER" }, { queue: [], duels }, noExtras, NOW).me!;
    expect(me([off("c", 1000, duelEndReason.calledOff("name-b"))]).lastCancelled).toEqual({
      duelId: "c",
      line: "Your 1v1 was called off.",
    });
    const lines: [string, string][] = [
      [duelEndReason.adminCancel("Admin"), "Your 1v1 was called off."],
      [
        duelEndReason.neverPlayed(),
        `No game started within ${INHOUSE_DUEL.SETUP_MINUTES} minutes, so the 1v1 was cancelled.`,
      ],
      [duelEndReason.botCancelled("not scored"), "The game didn't start, so the 1v1 was cancelled."],
      [duelEndReason.resultNeverShowed(), "No result showed on OpenDota, so the 1v1 was cancelled."],
      [duelEndReason.voided("Admin", "81"), "An admin voided your 1v1 result."],
    ];
    for (const [reason, line] of lines) {
      expect(duelCancelLine(reason), reason).toBe(line);
      expect(me([off("c", 1000, reason)]).lastCancelled?.line, reason).toBe(line);
    }
    // Only the players, only inside the window.
    expect(me([off("c", 1000, duelEndReason.neverPlayed())], "z").lastCancelled).toBeNull();
    expect(
      me([off("c", INHOUSE_DUEL.LAST_RESULT_WINDOW_MS + 1, duelEndReason.neverPlayed())])
        .lastCancelled,
    ).toBeNull();
    // A newer result, or a newer 1v1 of theirs, says more.
    const won = duelRow("w", INHOUSE_DUEL_STATUS.COMPLETED, "a", "b", {
      winnerTeam: 1,
      completedAt: new Date(NOW - 500),
    });
    expect(me([off("c", 1000, duelEndReason.neverPlayed()), won]).lastCancelled).toBeNull();
    const again = duelRow("n", INHOUSE_DUEL_STATUS.READY, "a", "e", {
      createdAt: new Date(NOW - 500),
    });
    expect(me([off("c", 1000, duelEndReason.neverPlayed()), again]).lastCancelled).toBeNull();
    // An older result than the cancel: the cancel shows.
    const older = duelRow("o", INHOUSE_DUEL_STATUS.COMPLETED, "a", "b", {
      winnerTeam: 1,
      completedAt: new Date(NOW - 5000),
    });
    expect(me([off("c", 1000, duelEndReason.neverPlayed()), older]).lastCancelled?.duelId).toBe("c");
  });
});

describe("the lobby bot", () => {
  const at = new Date("2026-10-27T12:00:00Z");
  it("is saved for a 5v5 forming, drafting, or set up and not started", () => {
    expect(DUEL_BOT_SAVED_FOR_5V5).toBe("The bot is saved for the 5v5 being set up");
    for (const status of ["READY_CHECK", "CAPTAIN_VOTE", "DRAFTING", "READY"])
      expect(duelBotSavedFor5v5([{ status, startedAt: null }])).toBe(true);
    // Started: the 5v5 has (or had) its lobby; the bot can host a 1v1 next.
    expect(duelBotSavedFor5v5([{ status: "READY", startedAt: at }])).toBe(false);
    for (const status of ["IN_PROGRESS", "AWAITING_RESULT", "COMPLETED", "CANCELLED"])
      expect(duelBotSavedFor5v5([{ status, startedAt: null }])).toBe(false);
    expect(duelBotSavedFor5v5([])).toBe(false);
    expect(
      duelBotSavedFor5v5([
        { status: "IN_PROGRESS", startedAt: at },
        { status: "DRAFTING", startedAt: null },
      ]),
    ).toBe(true);
  });

  it("ends a duel only on a job released after its game started", () => {
    const playing = { status: "PLAYING", startedAt: new Date() };
    const awaiting = { status: "AWAITING_RESULT", startedAt: null };
    const unstarted = { status: "READY", startedAt: null };
    expect(duelBotEndedWithoutGame({ state: "released" }, playing)).toMatch(/not scored/);
    expect(duelBotEndedWithoutGame({ state: "released" }, awaiting)).toMatch(/not scored/);
    expect(
      duelBotEndedWithoutGame({ state: "released" }, { status: "READY", startedAt: new Date() }),
    ).toMatch(/not scored/);
    // A READY duel whose game never started: a released read is transient
    // (a dropped Create, a lobby gone after a reconnect, a player's Release),
    // so it reads like idle and the worker makes a fresh lobby.
    expect(duelBotEndedWithoutGame({ state: "released" }, unstarted)).toBeNull();
    expect(duelBotLobbyMissing({ state: "released" })).toBe(true);
    expect(duelBotLobbyMissing({ state: "idle" })).toBe(true);
    expect(duelBotLobbyMissing({ state: "released", over: true })).toBe(false);
    for (const state of ["creating", "ready", "starting", "started", "blocked"])
      expect(duelBotLobbyMissing({ state })).toBe(false);
    expect(duelBotLobbyMissing(null)).toBe(false);
    expect(duelBotEndedWithoutGame({ state: "released", over: true }, playing)).toBeNull();
    for (const state of ["idle", "creating", "ready", "starting", "started", "blocked"])
      expect(duelBotEndedWithoutGame({ state }, playing)).toBeNull();
    // A running game the bot has left is running, never a failed launch.
    const left = { state: "started", left: true as const, matchId: "8123456789" };
    expect(duelBotEndedWithoutGame(left, playing)).toBeNull();
    expect(duelBotEndedWithoutGame(null, playing)).toBeNull();
  });
});

describe("the room poll's 1v1 heartbeat", () => {
  const BEAT = INHOUSE_DUEL.HEARTBEAT_SECONDS;
  it("skips a viewer with no 1v1 queue row, or one seen inside the throttle", () => {
    expect(duelHeartbeatAction(null, null, NOW)).toBe("skip");
    expect(duelHeartbeatAction({ lastSeenAt: sec(BEAT) }, null, NOW)).toBe("skip");
    // A heartbeat this server wrote since the rows were read counts too.
    expect(duelHeartbeatAction({ lastSeenAt: sec(BEAT + 5) }, NOW - 1000, NOW)).toBe("skip");
  });

  it("writes past the throttle (touchDuelQueueHeartbeat's strict lt), and refreshes an away waiter", () => {
    expect(duelHeartbeatAction({ lastSeenAt: sec(BEAT + 1) }, null, NOW)).toBe("write");
    expect(
      duelHeartbeatAction({ lastSeenAt: sec(INHOUSE_DUEL.PRESENT_SECONDS) }, null, NOW),
    ).toBe("write");
    expect(
      duelHeartbeatAction({ lastSeenAt: sec(INHOUSE_DUEL.PRESENT_SECONDS + 1) }, null, NOW),
    ).toBe("writeAndRefresh");
  });
});

describe("the 1v1 block's clocks (the long-poll's wake)", () => {
  it("names each moment buildDuelState reads differently with no write", () => {
    const expiresAt = new Date(NOW + 10 * 60_000);
    const lastSeenAt = sec(10);
    const completedAt = sec(30);
    const clocks = duelRoomClocks({
      queue: [{ lastSeenAt, expiresAt }],
      duels: [
        { status: INHOUSE_DUEL_STATUS.COMPLETED, completedAt },
        { status: INHOUSE_DUEL_STATUS.PLAYING, completedAt: null },
        { status: INHOUSE_DUEL_STATUS.CANCELLED, completedAt: sec(40) },
      ],
    });
    const resultEnds = completedAt.getTime() + INHOUSE_DUEL.LAST_RESULT_WINDOW_MS + 1;
    // A cancel's line leaves the card when its window ends too.
    const cancelEnds = sec(40).getTime() + INHOUSE_DUEL.LAST_RESULT_WINDOW_MS + 1;
    const awayAt = lastSeenAt.getTime() + INHOUSE_DUEL.PRESENT_SECONDS * 1000 + 1;
    expect(clocks.sort()).toEqual([expiresAt.getTime(), awayAt, resultEnds, cancelEnds].sort());

    // Each is a real boundary of the reply.
    const viewer = { id: "v", role: "USER" };
    const rows = {
      queue: [{ userId: "q", joinedAt: sec(60), lastSeenAt, expiresAt, user: { name: "q", avatar: null } }],
      duels: [] as DuelRoomDuelRow[],
    };
    const noExtras = { in5v5: false, mmrRefusal: null };
    expect(buildDuelState(viewer, rows, noExtras, awayAt - 1).queue.present).toBe(1);
    expect(buildDuelState(viewer, rows, noExtras, awayAt).queue.present).toBe(0);
    expect(buildDuelState(viewer, rows, noExtras, expiresAt.getTime() - 1).queue.players).toHaveLength(1);
    expect(buildDuelState(viewer, rows, noExtras, expiresAt.getTime()).queue.players).toHaveLength(0);
  });
});

describe("the worker's 1v1 wake (the automation gate)", () => {
  const MIN = 60_000;
  const open = (status: string, over: Partial<{ startedAt: Date | null; checkedAt: Date | null }> = {}) => ({
    status,
    createdAt: new Date(NOW - 20 * MIN),
    startedAt: null,
    checkedAt: new Date(NOW - MIN),
    ...over,
  });
  const queued = (seenAgoS: number, expiresInMin: number) => ({
    lastSeenAt: sec(seenAgoS),
    expiresAt: new Date(NOW + expiresInMin * MIN),
  });

  it("has nothing to do with no queue and no open duel", () => {
    expect(duelWorkerWakeAtMs({ queue: [], duels: [] }, NOW)).toBeNull();
  });

  it("runs every pass while a duel is live", () => {
    for (const status of [INHOUSE_DUEL_STATUS.READY, INHOUSE_DUEL_STATUS.PLAYING]) {
      expect(duelWorkerWakeAtMs({ queue: [], duels: [open(status)] }, NOW)).toBe(NOW);
    }
  });

  it("sleeps an awaiting duel to its scan (duelNextClockMs), and a lone waiter to their expiry", () => {
    const awaiting = open(INHOUSE_DUEL_STATUS.AWAITING_RESULT, { startedAt: sec(1000) });
    expect(duelWorkerWakeAtMs({ queue: [], duels: [awaiting] }, NOW)).toBe(
      duelNextClockMs(awaiting),
    );
    expect(duelWorkerWakeAtMs({ queue: [queued(5, 12)], duels: [] }, NOW)).toBe(NOW + 12 * MIN);
  });

  it("wakes at once for two present waiters, not for one present and one away", () => {
    expect(
      duelWorkerWakeAtMs({ queue: [queued(5, 12), queued(20, 25)], duels: [] }, NOW),
    ).toBe(NOW);
    expect(
      duelWorkerWakeAtMs(
        { queue: [queued(5, 12), queued(INHOUSE_DUEL.PRESENT_SECONDS + 1, 25)], duels: [] },
        NOW,
      ),
    ).toBe(NOW + 12 * MIN);
  });
});

describe("the 1v1 card's rules", () => {
  const me = (over: Partial<DuelMeView> = {}): DuelMeView => ({
    inQueue: false,
    queuedAt: null,
    queueExpiresAt: null,
    duelId: null,
    joinRefusal: null,
    canJoin: true,
    canLeave: false,
    canOver: false,
    canCallOff: false,
    canRecord: false,
    lastResult: null,
    lastCancelled: null,
    ...over,
  });

  it("offers sign in, Join, Leave, a refusal in Join's place, or nothing beside the viewer's own 1v1", () => {
    expect(duelJoinRow(null, null, true)).toEqual({ kind: "sign-in" });
    expect(duelJoinRow(me(), null, true)).toEqual({ kind: "join" });
    expect(duelJoinRow(me({ inQueue: true, canJoin: false, canLeave: true }), null, true)).toEqual({
      kind: "leave",
    });
    // The page's MMR-cap refusal wins, as duelJoinRefusal judges it first.
    expect(duelJoinRow(me(), "over the cap", true)).toEqual({ kind: "refused", reason: "over the cap" });
    expect(
      duelJoinRow(me({ canJoin: false, joinRefusal: DUEL_REFUSAL.IN_5V5 }), "over the cap", true),
    ).toEqual({ kind: "refused", reason: "over the cap" });
    expect(duelJoinRow(me({ canJoin: false, joinRefusal: DUEL_REFUSAL.IN_5V5 }), null, true)).toEqual({
      kind: "refused",
      reason: DUEL_REFUSAL.IN_5V5,
    });
    // In a live 1v1: the card shows it, not a refusal.
    expect(
      duelJoinRow(me({ canJoin: false, duelId: "d", joinRefusal: DUEL_REFUSAL.IN_DUEL }), null, true),
    ).toEqual({ kind: "none" });
  });

  it("offers no Join and no sign in while no lobby bot can host 1v1s here", () => {
    expect(duelJoinRow(null, null, false)).toEqual({ kind: "no-bot" });
    expect(duelJoinRow(me(), null, false)).toEqual({ kind: "no-bot" });
    expect(duelJoinRow(me(), "over the cap", false)).toEqual({ kind: "no-bot" });
    // A row from before can still be left, and a live 1v1 still shows.
    expect(duelJoinRow(me({ inQueue: true, canLeave: true }), null, false)).toEqual({
      kind: "leave",
    });
    expect(
      duelJoinRow(me({ canJoin: false, duelId: "d", joinRefusal: DUEL_REFUSAL.IN_DUEL }), null, false),
    ).toEqual({ kind: "none" });
    expect(DUEL_NO_BOT_NOTE).toBe("1v1s start once the lobby bot can host here.");
  });

  it("returns sign in to the 1v1 card, never the 5v5 queue's invite (which joins the 5v5 queue)", () => {
    expect(DUEL_SIGN_IN_RETURN).toBe(`/inhouse#${DUEL_ROOM_ANCHOR}`);
    expect(DUEL_SIGN_IN_RETURN).not.toContain(INHOUSE_QUEUE_INVITE_PATH);
    expect(DUEL_SIGN_IN_RETURN).not.toMatch(/[?&]join=/);
  });

  it("tells a waiter pairing needs their page open", () => {
    expect(DUEL_WAITING_NOTE).toBe(
      "Waiting for an opponent: the next player to join plays you while this page is open.",
    );
  });

  it("words the last result, and each stage", () => {
    expect(duelResultLine({ won: true, opponentName: "Ana" })).toBe("You beat Ana");
    expect(duelResultLine({ won: false, opponentName: "Ana" })).toBe("Ana won");
    expect(duelStageLabel(INHOUSE_DUEL_STATUS.READY)).toBe("Setting up");
    expect(duelStageLabel(INHOUSE_DUEL_STATUS.PLAYING)).toBe("Playing");
    expect(duelStageLabel(INHOUSE_DUEL_STATUS.AWAITING_RESULT)).toBe("Waiting for OpenDota");
  });

  it("counts a 1v1 queue row or an open 1v1 as a stake for a hidden tab", () => {
    expect(duelStake(null)).toBe(false);
    expect(duelStake(me())).toBe(false);
    expect(duelStake(me({ inQueue: true }))).toBe(true);
    expect(duelStake(me({ duelId: "d" }))).toBe(true);
  });

  it("shows the admin rows only when there is something to act on", () => {
    const empty: DuelState = {
      queue: { present: 0, players: [] },
      games: [],
      results: [],
      me: null,
      canRemoveFromQueue: true,
    };
    expect(duelAdminToolsVisible(empty)).toBe(false);
    expect(duelAdminToolsVisible({ ...empty, canRemoveFromQueue: false })).toBe(false);
    const waiterRow = { userId: "u", name: "U", avatar: null, present: true, joinedAt: NOW };
    expect(
      duelAdminToolsVisible({ ...empty, queue: { present: 1, players: [waiterRow] } }),
    ).toBe(true);
    // A player (not an admin) never sees them.
    expect(
      duelAdminToolsVisible({
        ...empty,
        canRemoveFromQueue: false,
        queue: { present: 1, players: [waiterRow] },
      }),
    ).toBe(false);
    const user = { id: "a", name: "A", avatar: null, rankTier: null };
    const game = {
      id: "g", status: "READY", radiant: user, dire: { ...user, id: "b" }, createdAt: NOW,
      startedAt: null, finishedAt: null, setupEndsAt: NOW, giveUpAt: null, mine: false, canCancel: true,
    };
    expect(duelAdminToolsVisible({ ...empty, games: [game] })).toBe(true);
    expect(duelAdminToolsVisible({ ...empty, games: [{ ...game, canCancel: false }] })).toBe(false);
  });

  it("calls a result news only when a reply adds one", () => {
    expect(duelResultLanded(null, ["a"])).toBe(false);
    expect(duelResultLanded(["a"], ["a"])).toBe(false);
    expect(duelResultLanded(["a"], [])).toBe(false);
    expect(duelResultLanded(["a"], ["b", "a"])).toBe(true);
  });
});

describe("the 1v1 card's source", () => {
  const code = (path: string) =>
    sourceFile(path)
      .text.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
  const section = code("src/components/inhouse/duel-section.tsx");
  const card = code("src/components/inhouse/duel-game-card.tsx");
  const admin = code("src/components/inhouse/duel-admin-tools.tsx");

  it("decides through the pure rules, and acts only through the room's act()", () => {
    for (const call of ["duelJoinRow(me, joinRefusal, botReady)", "duelResultLine(", "duelResultLanded(", "DUEL_CARD_INTRO"]) {
      expect(section, call).toContain(call);
    }
    expect(admin).toContain("if (!duelAdminToolsVisible(duel)) return null;");
    for (const src of [section, card, admin]) {
      expect(src).not.toMatch(/\bfetch\(/);
      expect(src).not.toContain("playChime(");
    }
    // Every 1v1 action the route takes is wired somewhere on the card.
    const all = section + card + admin;
    for (const action of ["duelJoin", "duelLeave", "duelOver", "duelCallOff", "duelRecord", "duelCancel", "duelRemove", "duelVoid"]) {
      expect(all, action).toContain(`action: "${action}"`);
    }
  });

  it("shows the lobby bot's panel for the viewer's 1v1, or the waiting note: never by-hand steps", () => {
    expect(card).toMatch(/<DotaLobbyControls\s+key=\{game\.id\}\s+kind="duel"/);
    expect(card).toContain("DUEL_BOT_WAITING_NOTE");
    // A panel answering that the bot can't host here gets its own line.
    expect(card).toMatch(/availability === "off"\s*\?\s*DUEL_BOT_OFF_NOTE/);
  });

  it("signs in back to the 1v1 card, never through the 5v5 queue's invite", () => {
    expect(section).toContain("signInHref(DUEL_SIGN_IN_RETURN)");
    expect(section).toContain("id={DUEL_ROOM_ANCHOR}");
    for (const src of [section, card, admin]) {
      expect(src).not.toContain("INHOUSE_QUEUE_INVITE_PATH");
      expect(src).not.toContain("join=1");
    }
  });

  it("offers Join only where the lobby bot can host 1v1s: the page passes it, the room hands it on", () => {
    const page = code("src/app/inhouse/page.tsx");
    const room = code("src/components/inhouse-room.tsx");
    expect(page).toContain("duelBotReady={inhouseLobbyBotConfigured()}");
    expect(room).toContain("botReady={duelBotReady}");
    expect(section).toContain("DUEL_NO_BOT_NOTE");
    expect(section).toContain("DUEL_WAITING_NOTE");
  });

  it("names no control like a 5v5 one", () => {
    const all = section + card + admin;
    for (const name of [
      "Join queue",
      "Leave queue",
      "ACCEPT MATCH",
      "Game over — queue again",
      "Get into the Dota lobby",
      "Your side",
      "Record by match ID",
      "Result on the way",
      ">Remove<",
      ">Record<",
    ]) {
      expect(all, name).not.toContain(name);
    }
    expect(all).not.toMatch(/>\s*MMR\s*</);
  });

  it("the room renders it below every 5v5 card", () => {
    const room = code("src/components/inhouse-room.tsx");
    const last5v5 = room.indexOf("{otherLobbies.map(otherGame)}");
    const duel = room.indexOf("<DuelSection");
    expect(last5v5).toBeGreaterThan(-1);
    expect(duel).toBeGreaterThan(last5v5);
    expect(room.slice(duel, duel + 300)).toContain("act={act}");
  });
});
