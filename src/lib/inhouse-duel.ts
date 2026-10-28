// Pure rules for the 1v1 mid inhouse ("duel"; docs/features/inhouse-duels.md):
// who a join pairs with, when a duel's clocks run out, whether a Dota match is
// this duel's result, the 1v1 ladder, and the room's duel block. No database
// here; inhouse-duel-service.ts runs these inside its guarded writes.

import {
  DUEL_GAME_MODE,
  INHOUSE_DUEL,
  INHOUSE_DUEL_LIVE_STATUSES,
  INHOUSE_DUEL_RESULT_STATUSES,
  INHOUSE_DUEL_STATUS,
} from "./constants";
import type { OpenDotaMatch, OpenDotaRecentMatch } from "./dota";
import {
  rankInhouse,
  summarizeInhouse,
  type FinishedLobby,
  type RankedInhouse,
} from "./inhouse-stats";

const isOneOf = (list: readonly string[], status: string) =>
  list.includes(status);

/** A duel still holds its players (READY or PLAYING). */
export function duelIsLive(status: string): boolean {
  return isOneOf(INHOUSE_DUEL_LIVE_STATUSES, status);
}

/** A result can still land on it, and the scan may look for one. */
export function duelTakesResult(status: string): boolean {
  return isOneOf(INHOUSE_DUEL_RESULT_STATUSES, status);
}

// ---------- The queue ----------

export type DuelWaiter = {
  id: string;
  userId: string;
  joinedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
};

/** A waiter seen at or after this is present. */
export function duelPresentCutoff(nowMs: number): Date {
  return new Date(nowMs - INHOUSE_DUEL.PRESENT_SECONDS * 1000);
}

/** When a queue row written by a join at `nowMs` expires. */
export function duelQueueExpiresAt(nowMs: number): Date {
  return new Date(nowMs + INHOUSE_DUEL.QUEUE_MINUTES * 60_000);
}

export function duelWaiterPresent(
  w: Pick<DuelWaiter, "lastSeenAt">,
  nowMs: number,
): boolean {
  return w.lastSeenAt.getTime() >= duelPresentCutoff(nowMs).getTime();
}

export function duelWaiterExpired(
  w: Pick<DuelWaiter, "expiresAt">,
  nowMs: number,
): boolean {
  return w.expiresAt.getTime() <= nowMs;
}

/** Queue order: [joinedAt, userId], never row order. */
function byQueueOrder(a: DuelWaiter, b: DuelWaiter): number {
  return (
    a.joinedAt.getTime() - b.joinedAt.getTime() ||
    (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
  );
}

/**
 * The waiters a pairing may take, oldest first: present, not expired, not
 * `busy` (in a live 5v5 lobby or a live duel), never `excludeUserId`.
 */
export function pairableDuelWaiters(
  waiters: DuelWaiter[],
  busyUserIds: ReadonlySet<string>,
  nowMs: number,
  excludeUserId?: string,
): DuelWaiter[] {
  return waiters
    .filter(
      (w) =>
        w.userId !== excludeUserId &&
        !busyUserIds.has(w.userId) &&
        duelWaiterPresent(w, nowMs) &&
        !duelWaiterExpired(w, nowMs),
    )
    .sort(byQueueOrder);
}

/** Who a join pairs with: the oldest pairable waiter, or null to wait. */
export function pickDuelOpponent(
  waiters: DuelWaiter[],
  viewerId: string,
  busyUserIds: ReadonlySet<string>,
  nowMs: number,
): DuelWaiter | null {
  return pairableDuelWaiters(waiters, busyUserIds, nowMs, viewerId)[0] ?? null;
}

/**
 * The worker's sweep: the two oldest pairable waiters, for two who were both
 * left waiting (one was away or in a 5v5 when the other joined). Null when
 * fewer than two can be paired.
 */
export function pickDuelPair(
  waiters: DuelWaiter[],
  busyUserIds: ReadonlySet<string>,
  nowMs: number,
): [DuelWaiter, DuelWaiter] | null {
  const [a, b] = pairableDuelWaiters(waiters, busyUserIds, nowMs);
  return a && b ? [a, b] : null;
}

/** Random sides for a new duel. `random` in [0, 1) is injectable for tests. */
export function assignDuelSides(
  firstUserId: string,
  secondUserId: string,
  random: () => number = Math.random,
): { radiantUserId: string; direUserId: string } {
  return random() < 0.5
    ? { radiantUserId: firstUserId, direUserId: secondUserId }
    : { radiantUserId: secondUserId, direUserId: firstUserId };
}

export const DUEL_REFUSAL = {
  IN_5V5: "You're in a live 5v5 inhouse. Join the 1v1 queue once it's over.",
  IN_DUEL: "You're already in a 1v1.",
} as const;

/**
 * Why a player can't join the 1v1 queue, or null. The MMR cap is the 5v5
 * queue's own (`inhouseJoinRefusalBeforeTyping`; a duel has no typed MMR),
 * judged first so its words win.
 */
export function duelJoinRefusal({
  mmrRefusal,
  in5v5,
  inDuel,
}: {
  mmrRefusal: string | null;
  in5v5: boolean;
  inDuel: boolean;
}): string | null {
  if (mmrRefusal) return mmrRefusal;
  if (in5v5) return DUEL_REFUSAL.IN_5V5;
  if (inDuel) return DUEL_REFUSAL.IN_DUEL;
  return null;
}

// ---------- Clocks ----------

export type DuelClockInput = {
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  checkedAt: Date | null;
};

/** When a READY duel with no started game is called off ("never-played"). */
export function duelSetupEndsAtMs(d: Pick<DuelClockInput, "createdAt">): number {
  return d.createdAt.getTime() + INHOUSE_DUEL.SETUP_MINUTES * 60_000;
}

/** When a played duel with no result is given up on. */
export function duelGiveUpAtMs(d: Pick<DuelClockInput, "createdAt">): number {
  return d.createdAt.getTime() + INHOUSE_DUEL.GIVE_UP_HOURS * 3_600_000;
}

/** READY, never started, past its setup window. */
export function duelNeverPlayedDue(d: DuelClockInput, nowMs: number): boolean {
  return (
    d.status === INHOUSE_DUEL_STATUS.READY &&
    d.startedAt === null &&
    duelSetupEndsAtMs(d) <= nowMs
  );
}

/** PLAYING or AWAITING_RESULT with no result, past the give-up floor. */
export function duelResultGiveUpDue(d: DuelClockInput, nowMs: number): boolean {
  return (
    (d.status === INHOUSE_DUEL_STATUS.PLAYING ||
      d.status === INHOUSE_DUEL_STATUS.AWAITING_RESULT) &&
    duelGiveUpAtMs(d) <= nowMs
  );
}

/** A scan stamped before this may run again. */
export function duelScanCutoff(nowMs: number): Date {
  return new Date(nowMs - INHOUSE_DUEL.SCAN_EVERY_SECONDS * 1000);
}

/** When the scan may next look at this duel (null: never, it's closed). */
export function duelScanDueAtMs(d: DuelClockInput): number | null {
  if (!duelTakesResult(d.status)) return null;
  const opens = d.createdAt.getTime() + INHOUSE_DUEL.SCAN_AFTER_MINUTES * 60_000;
  const backoff = d.checkedAt
    ? d.checkedAt.getTime() + INHOUSE_DUEL.SCAN_EVERY_SECONDS * 1000
    : 0;
  return Math.max(opens, backoff);
}

export function duelScanDue(d: DuelClockInput, nowMs: number): boolean {
  const at = duelScanDueAtMs(d);
  return at !== null && at <= nowMs;
}

/**
 * The next moment this duel needs the worker: its scan, its never-played
 * call-off or its give-up. Null for a closed duel. The automation gate's wake
 * (stage C) is the earliest of these over every open duel.
 */
export function duelNextClockMs(d: DuelClockInput): number | null {
  if (!duelTakesResult(d.status)) return null;
  const clocks = [duelScanDueAtMs(d) ?? Infinity];
  if (d.status === INHOUSE_DUEL_STATUS.READY && d.startedAt === null) {
    clocks.push(duelSetupEndsAtMs(d));
  } else {
    clocks.push(duelGiveUpAtMs(d));
  }
  return Math.min(...clocks);
}

/** Stalest scan first (never scanned first), then oldest, then id. */
export function duelScanOrder<T extends { id: string; createdAt: Date; checkedAt: Date | null }>(
  duels: T[],
): T[] {
  return [...duels].sort(
    (a, b) =>
      (a.checkedAt?.getTime() ?? 0) - (b.checkedAt?.getTime() ?? 0) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// ---------- End reasons ----------

export const duelEndReason = {
  calledOff: (name: string) => `Called off by ${name} before the game started`,
  neverPlayed: () =>
    `Never played: no game started within ${INHOUSE_DUEL.SETUP_MINUTES} minutes`,
  resultNeverShowed: () =>
    `Result never showed: nothing on OpenDota ${INHOUSE_DUEL.GIVE_UP_HOURS} hours after pairing`,
  botCancelled: (why: string) => `The lobby bot's game ended with no result: ${why}`,
  adminCancel: (name: string) => `Cancelled by admin ${name}`,
  voided: (name: string, dotaMatchId: string | null) =>
    `Result voided by admin ${name}${dotaMatchId ? ` (match ${dotaMatchId})` : ""}`,
} as const;

// ---------- Results ----------

/** The side a match player played: Radiant when isRadiant or slot < 128. */
function playedRadiant(p: { isRadiant?: boolean; player_slot: number }): boolean {
  return typeof p.isRadiant === "boolean" ? p.isRadiant : p.player_slot < 128;
}

export type DuelMatchPlayer = { userId: string; accountId: number | null };

export type DuelResult = {
  dotaMatchId: string;
  /** The sides as the match had them (a result rewrites the duel's). */
  radiantUserId: string;
  direUserId: string;
  /** 1 = Radiant won, 2 = Dire won. */
  winnerTeam: 1 | 2;
  winnerUserId: string;
  durationSecs: number;
  radiantHeroId: number | null;
  direHeroId: number | null;
  /** Valve's start_time, in seconds. */
  startTime: number;
};

export type DuelMatchRefusal =
  | "wrong-mode"
  | "not-two-players"
  | "before-duel"
  | "not-these-players"
  | "same-side"
  | "unfinished";

/** The floor a match's start_time must reach to be this duel's, in seconds. */
export function duelMatchFloorSeconds(createdAtMs: number): number {
  return Math.floor(createdAtMs / 1000) - INHOUSE_DUEL.START_GRACE_SECONDS;
}

/**
 * Is this Dota match the duel's result? Exactly two players, 1v1 Solo Mid,
 * both duel players' linked accounts in it on opposite sides, started no
 * earlier than the duel's pairing (less START_GRACE_SECONDS), and finished
 * (a duration and a boolean radiant_win). The winner is whoever's side won.
 * Used for the bot's match id, a pasted id and the scan's candidates alike.
 */
export function validateDuelMatch(
  od: OpenDotaMatch,
  duel: { createdAtMs: number; players: DuelMatchPlayer[] },
): { ok: true; result: DuelResult } | { ok: false; reason: DuelMatchRefusal } {
  if (od.game_mode !== DUEL_GAME_MODE.id) return { ok: false, reason: "wrong-mode" };
  if (!Array.isArray(od.players) || od.players.length !== 2) {
    return { ok: false, reason: "not-two-players" };
  }
  if (!(od.start_time >= duelMatchFloorSeconds(duel.createdAtMs))) {
    return { ok: false, reason: "before-duel" };
  }
  if (duel.players.length !== 2) return { ok: false, reason: "not-these-players" };
  const seats = duel.players.map((pl) => {
    const found =
      pl.accountId == null
        ? undefined
        : od.players.find((p) => p.account_id === pl.accountId);
    return found ? { ...pl, radiant: playedRadiant(found), heroId: found.hero_id } : null;
  });
  if (seats.some((s) => s === null)) return { ok: false, reason: "not-these-players" };
  const [a, b] = seats as NonNullable<(typeof seats)[number]>[];
  if (a.radiant === b.radiant) return { ok: false, reason: "same-side" };
  if (
    typeof od.radiant_win !== "boolean" ||
    !(Number.isFinite(od.duration) && od.duration > 0)
  ) {
    return { ok: false, reason: "unfinished" };
  }
  const radiant = a.radiant ? a : b;
  const dire = a.radiant ? b : a;
  const heroId = (h: unknown) =>
    typeof h === "number" && Number.isFinite(h) && h > 0 ? h : null;
  return {
    ok: true,
    result: {
      dotaMatchId: String(od.match_id),
      radiantUserId: radiant.userId,
      direUserId: dire.userId,
      winnerTeam: od.radiant_win ? 1 : 2,
      winnerUserId: od.radiant_win ? radiant.userId : dire.userId,
      durationSecs: Math.round(od.duration),
      radiantHeroId: heroId(radiant.heroId),
      direHeroId: heroId(dire.heroId),
      startTime: od.start_time,
    },
  };
}

/** The winner of a stored duel, from its (match-true) sides. */
export function duelWinnerUserId(d: {
  winnerTeam: number | null;
  radiantUserId: string;
  direUserId: string;
}): string | null {
  if (d.winnerTeam === 1) return d.radiantUserId;
  if (d.winnerTeam === 2) return d.direUserId;
  return null;
}

/**
 * The scan's candidates from the two players' recent matches: ids in BOTH
 * lists, in 1v1 Solo Mid, started at or after `floorSeconds`, where the two
 * played opposite sides (when both slots are known). Newest first. The full
 * match is still fetched and checked with validateDuelMatch.
 */
export function sharedDuelMatchIds(
  a: OpenDotaRecentMatch[],
  b: OpenDotaRecentMatch[],
  floorSeconds: number,
): number[] {
  const fits = (m: OpenDotaRecentMatch) =>
    m.game_mode === DUEL_GAME_MODE.id && m.start_time >= floorSeconds;
  const bById = new Map(b.filter(fits).map((m) => [m.match_id, m]));
  const side = (slot: number | null) => (slot === null ? null : slot < 128);
  return a
    .filter(fits)
    .filter((m) => {
      const other = bById.get(m.match_id);
      if (!other) return false;
      const sa = side(m.player_slot);
      const sb = side(other.player_slot);
      return sa === null || sb === null || sa !== sb;
    })
    .sort((x, y) => y.start_time - x.start_time || y.match_id - x.match_id)
    .map((m) => m.match_id);
}

// ---------- The 1v1 ladder ----------

export type FinishedDuelRow = {
  id: string;
  winnerTeam: number | null;
  createdAt: Date;
  radiantUserId: string;
  direUserId: string;
  radiantUser: { name: string; avatar: string | null };
  direUser: { name: string; avatar: string | null };
};

/**
 * A completed duel as a two-sided lobby with sides of one: team 1 is the
 * Radiant player, team 2 the Dire player, so the stored winnerTeam (1 =
 * Radiant) reads unchanged. summarizeInhouse's team Elo over sides of one is
 * plain one-on-one Elo.
 */
export function duelToFinishedLobby(d: FinishedDuelRow): FinishedLobby {
  return {
    id: d.id,
    winnerTeam: d.winnerTeam,
    createdAt: d.createdAt,
    players: [
      {
        userId: d.radiantUserId,
        name: d.radiantUser.name,
        avatar: d.radiantUser.avatar,
        team: 1,
      },
      {
        userId: d.direUserId,
        name: d.direUser.name,
        avatar: d.direUser.avatar,
        team: 2,
      },
    ],
  };
}

/** The 1v1 ladder: derived from every completed duel, never stored. */
export function duelLadder(duels: FinishedDuelRow[]): RankedInhouse {
  return rankInhouse(summarizeInhouse(duels.map(duelToFinishedLobby)));
}

// ---------- The room's duel block ----------

type DuelUserView = { id: string; name: string; avatar: string | null };

export type DuelRoomQueueRow = {
  userId: string;
  joinedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  user: { name: string; avatar: string | null };
};

export type DuelRoomDuelRow = {
  id: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  completedAt: Date | null;
  winnerTeam: number | null;
  dotaMatchId: string | null;
  durationSecs: number | null;
  radiantHeroId: number | null;
  direHeroId: number | null;
  radiantUser: DuelUserView;
  direUser: DuelUserView;
};

/**
 * What the room needs about duels: the queue, every duel a result can still
 * land on, and the duels completed inside LAST_RESULT_WINDOW_MS
 * (loadDuelRoomRows). Display fields only.
 */
export type DuelRoomRows = {
  queue: DuelRoomQueueRow[];
  duels: DuelRoomDuelRow[];
};

export type DuelGameView = {
  id: string;
  status: string;
  radiant: DuelUserView;
  dire: DuelUserView;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** READY with no started game: when it is called off. */
  setupEndsAt: number | null;
  /** PLAYING or AWAITING_RESULT: when it is given up on. */
  giveUpAt: number | null;
  /** The viewer plays in it. */
  mine: boolean;
  /** Admin: "Cancel this 1v1" (any duel a result can still land on). */
  canCancel: boolean;
};

export type DuelResultView = {
  id: string;
  radiant: DuelUserView;
  dire: DuelUserView;
  winnerUserId: string | null;
  dotaMatchId: string | null;
  durationSecs: number | null;
  radiantHeroId: number | null;
  direHeroId: number | null;
  completedAt: number;
  /** Admin: "Void this 1v1 result". */
  canVoid: boolean;
};

export type DuelMeView = {
  inQueue: boolean;
  queuedAt: number | null;
  queueExpiresAt: number | null;
  /** The viewer's open duel (a result can still land on it), if any. */
  duelId: string | null;
  joinRefusal: string | null;
  canJoin: boolean;
  canLeave: boolean;
  /** Fallback "1v1 over" for a bot game whose end the bot missed. */
  canOver: boolean;
  /** "Call it off": READY, no started game. */
  canCallOff: boolean;
  /** "Record by match ID". */
  canRecord: boolean;
  /** The viewer's newest result inside LAST_RESULT_WINDOW_MS. */
  lastResult: { duelId: string; won: boolean; opponentName: string } | null;
};

export type DuelState = {
  queue: {
    present: number;
    players: {
      userId: string;
      name: string;
      avatar: string | null;
      present: boolean;
      joinedAt: number;
    }[];
  };
  games: DuelGameView[];
  results: DuelResultView[];
  me: DuelMeView | null;
  /** Admin: remove a player from the 1v1 queue. */
  canRemoveFromQueue: boolean;
};

/**
 * The room's `duel` block, from the snapshot's rows, the viewer (null =
 * signed out) and two facts about them the duel rows don't hold: whether
 * they are in a live 5v5 lobby, and the MMR cap's refusal (both read with
 * the 5v5's own helpers). Pure, so a cached snapshot serves every viewer.
 */
export function buildDuelState(
  viewer: { id: string; role: string } | null,
  rows: DuelRoomRows,
  extras: { in5v5: boolean; mmrRefusal: string | null },
  nowMs: number,
): DuelState {
  const isAdmin = viewer?.role === "ADMIN";
  const queue = rows.queue
    .filter((q) => !duelWaiterExpired(q, nowMs))
    .sort(
      (a, b) =>
        a.joinedAt.getTime() - b.joinedAt.getTime() ||
        (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );
  const players = queue.map((q) => ({
    userId: q.userId,
    name: q.user.name,
    avatar: q.user.avatar,
    present: duelWaiterPresent(q, nowMs),
    joinedAt: q.joinedAt.getTime(),
  }));
  const byNewest = [...rows.duels].sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  const isMine = (d: DuelRoomDuelRow) =>
    !!viewer && (d.radiantUser.id === viewer.id || d.direUser.id === viewer.id);

  const games: DuelGameView[] = byNewest
    .filter((d) => duelTakesResult(d.status))
    .map((d) => {
      const unstarted =
        d.status === INHOUSE_DUEL_STATUS.READY && d.startedAt === null;
      return {
        id: d.id,
        status: d.status,
        radiant: d.radiantUser,
        dire: d.direUser,
        createdAt: d.createdAt.getTime(),
        startedAt: d.startedAt?.getTime() ?? null,
        finishedAt: d.finishedAt?.getTime() ?? null,
        setupEndsAt: unstarted ? duelSetupEndsAtMs(d) : null,
        giveUpAt: unstarted ? null : duelGiveUpAtMs(d),
        mine: isMine(d),
        canCancel: isAdmin,
      };
    });

  const windowStart = nowMs - INHOUSE_DUEL.LAST_RESULT_WINDOW_MS;
  const recent = rows.duels
    .filter(
      (d) =>
        d.status === INHOUSE_DUEL_STATUS.COMPLETED &&
        d.completedAt !== null &&
        d.completedAt.getTime() >= windowStart,
    )
    .sort(
      (a, b) =>
        (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
  const results: DuelResultView[] = recent.map((d) => ({
    id: d.id,
    radiant: d.radiantUser,
    dire: d.direUser,
    winnerUserId: duelWinnerUserId({
      winnerTeam: d.winnerTeam,
      radiantUserId: d.radiantUser.id,
      direUserId: d.direUser.id,
    }),
    dotaMatchId: d.dotaMatchId,
    durationSecs: d.durationSecs,
    radiantHeroId: d.radiantHeroId,
    direHeroId: d.direHeroId,
    completedAt: d.completedAt?.getTime() ?? 0,
    canVoid: isAdmin,
  }));

  let me: DuelMeView | null = null;
  if (viewer) {
    const own = queue.find((q) => q.userId === viewer.id) ?? null;
    const myDuel = byNewest.find((d) => isMine(d) && duelTakesResult(d.status));
    const inLiveDuel = byNewest.some((d) => isMine(d) && duelIsLive(d.status));
    const joinRefusal = duelJoinRefusal({
      mmrRefusal: extras.mmrRefusal,
      in5v5: extras.in5v5,
      inDuel: inLiveDuel,
    });
    const last = results.find(
      (r) => r.radiant.id === viewer.id || r.dire.id === viewer.id,
    );
    me = {
      inQueue: own !== null,
      queuedAt: own?.joinedAt.getTime() ?? null,
      queueExpiresAt: own?.expiresAt.getTime() ?? null,
      duelId: myDuel?.id ?? null,
      joinRefusal,
      canJoin: own === null && joinRefusal === null,
      canLeave: own !== null,
      canOver: myDuel?.status === INHOUSE_DUEL_STATUS.PLAYING,
      canCallOff:
        myDuel?.status === INHOUSE_DUEL_STATUS.READY &&
        myDuel.startedAt === null,
      canRecord: !!myDuel,
      lastResult: last
        ? {
            duelId: last.id,
            won: last.winnerUserId === viewer.id,
            opponentName:
              last.radiant.id === viewer.id ? last.dire.name : last.radiant.name,
          }
        : null,
    };
  }

  return {
    queue: {
      present: players.filter((p) => p.present).length,
      players,
    },
    games,
    results,
    me,
    canRemoveFromQueue: isAdmin,
  };
}
