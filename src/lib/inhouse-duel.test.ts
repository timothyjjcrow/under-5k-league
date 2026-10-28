import { describe, expect, it } from "vitest";
import {
  DUEL_GAME_MODE,
  INHOUSE_DUEL,
  INHOUSE_DUEL_STATUS,
} from "./constants";
import type { OpenDotaMatch, OpenDotaRecentMatch } from "./dota";
import {
  DUEL_REFUSAL,
  assignDuelSides,
  buildDuelState,
  duelJoinRefusal,
  duelLadder,
  duelMatchFloorSeconds,
  duelNeverPlayedDue,
  duelNextClockMs,
  duelResultGiveUpDue,
  duelScanDue,
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

  it("scans from SCAN_AFTER_MINUTES, then once per SCAN_EVERY_SECONDS, never a closed duel", () => {
    const after = INHOUSE_DUEL.SCAN_AFTER_MINUTES;
    expect(duelScanDue(ready(after - 1), NOW)).toBe(false);
    expect(duelScanDue(ready(after), NOW)).toBe(true);
    expect(
      duelScanDue({ ...ready(20), checkedAt: sec(INHOUSE_DUEL.SCAN_EVERY_SECONDS - 1) }, NOW),
    ).toBe(false);
    expect(
      duelScanDue({ ...ready(20), checkedAt: sec(INHOUSE_DUEL.SCAN_EVERY_SECONDS) }, NOW),
    ).toBe(true);
    for (const status of [INHOUSE_DUEL_STATUS.COMPLETED, INHOUSE_DUEL_STATUS.CANCELLED]) {
      expect(duelScanDue({ ...ready(60), status }, NOW)).toBe(false);
      expect(duelNextClockMs({ ...ready(60), status })).toBeNull();
    }
  });

  it("names the next clock: scan or setup for READY, scan or give-up after", () => {
    const r = ready(0);
    expect(duelNextClockMs(r)).toBe(NOW + INHOUSE_DUEL.SCAN_AFTER_MINUTES * 60_000);
    const checked = { ...ready(29), checkedAt: sec(0) };
    expect(duelNextClockMs(checked)).toBe(
      checked.createdAt.getTime() + INHOUSE_DUEL.SETUP_MINUTES * 60_000,
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

const duel: { createdAtMs: number; players: DuelMatchPlayer[] } = {
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

  it("keeps 1v1 matches both played, on opposite sides, since the floor, newest first", () => {
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
    expect(sharedDuelMatchIds(a, b, 80)).toEqual([2, 6, 1]);
  });
});

const user = (id: string) => ({ id, name: `name-${id}`, avatar: null });

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
});
