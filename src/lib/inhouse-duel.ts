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
  INHOUSE_STATUS,
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

// ---------- The lobby bot ----------

/**
 * The 5v5 statuses that save the one bot: a game forming (ready check,
 * captain vote, draft) or set up and not yet started (READY with no
 * startedAt). A 1v1's lobby made then could hold the bot through the 5v5's
 * whole setup. The service's query reads these, then duelBotSavedFor5v5.
 */
export const DUEL_BOT_SAVING_5V5_STATUSES: readonly string[] = [
  INHOUSE_STATUS.READY_CHECK,
  INHOUSE_STATUS.CAPTAIN_VOTE,
  INHOUSE_STATUS.DRAFTING,
  INHOUSE_STATUS.READY,
];

/** What a duel create refuses while the bot is saved for a 5v5. */
export const DUEL_BOT_SAVED_FOR_5V5 = "The bot is saved for the 5v5 being set up";

/**
 * Is the bot saved for a 5v5 of this league (each league has its own
 * database, so these are its games only)? True while any 5v5 game is in
 * READY_CHECK, CAPTAIN_VOTE or DRAFTING, or READY with no started game. A
 * 1v1's create waits then: the join's create and the worker's retry skip
 * it, and the panel's Create is refused with DUEL_BOT_SAVED_FOR_5V5.
 */
export function duelBotSavedFor5v5(
  lobbies: readonly { status: string; startedAt: Date | null }[],
): boolean {
  return lobbies.some(
    (l) =>
      DUEL_BOT_SAVING_5V5_STATUSES.includes(l.status) &&
      (l.status !== INHOUSE_STATUS.READY || l.startedAt === null),
  );
}

/** Did this duel's game ever start (the bot saw it launch)? */
export function duelHadGame(duel: { status: string; startedAt: Date | null }): boolean {
  return (
    duel.status === INHOUSE_DUEL_STATUS.PLAYING ||
    duel.status === INHOUSE_DUEL_STATUS.AWAITING_RESULT ||
    duel.startedAt !== null
  );
}

/**
 * Which bot reads end a duel with no result to wait for: a job `released`
 * (a failed launch, a game Dota ended as not scored) that Dota never showed
 * over, for a duel whose game had started (duelHadGame). A READY duel with no
 * started game is never ended by a `released` read: that read is as likely
 * to be transient (the Game Coordinator dropped the Create, a lobby gone
 * after a reconnect, a player's Release before the start) and reads like
 * `idle`: the worker asks for a fresh lobby (retryDuelBotCreate), and
 * SETUP_MINUTES still bounds the wait. Null for anything else: no answer, a
 * lobby still being set up, a running game (`started`, also one the bot has
 * `left`), a blocked or offline bot. Returns the reason the duel's endReason
 * carries.
 */
export function duelBotEndedWithoutGame(
  status: { state: string; over?: true } | null,
  duel: { status: string; startedAt: Date | null },
): string | null {
  if (!status || status.over || status.state !== "released") return null;
  if (!duelHadGame(duel)) return null;
  return "the game ended before a result (a failed launch, or not scored)";
}

/**
 * Does this bot read leave a READY duel's lobby to make (no lobby, or one
 * released before any game)? The worker's create retry asks only then.
 */
export function duelBotLobbyMissing(
  status: { state: string; over?: true } | null,
): boolean {
  return !!status && !status.over && (status.state === "idle" || status.state === "released");
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

/** The clock a duel's scan interval and bot-match wait run on: its game's start. */
export function duelScanClockMs(d: Pick<DuelClockInput, "createdAt" | "startedAt">): number {
  return (d.startedAt ?? d.createdAt).getTime();
}

/**
 * Seconds between scans of a duel whose game started `elapsedMs` ago: the
 * base SCAN_EVERY_SECONDS while the game is normal-length, then 1/20 of its
 * age, capped at SCAN_MAX_SECONDS (the 5v5's detectIntervalSeconds), so a
 * game whose result never comes decays to one scan per half hour.
 */
export function duelScanIntervalSeconds(elapsedMs: number): number {
  const grown = Math.floor(elapsedMs / 20 / 1000);
  return Math.min(
    Math.max(INHOUSE_DUEL.SCAN_EVERY_SECONDS, grown),
    INHOUSE_DUEL.SCAN_MAX_SECONDS,
  );
}

/** The scan interval due after this duel's last scan (`checkedAt`). */
function duelScanIntervalMs(d: DuelClockInput): number {
  const at = d.checkedAt?.getTime() ?? duelScanClockMs(d);
  return duelScanIntervalSeconds(at - duelScanClockMs(d)) * 1000;
}

/**
 * The scan's claim cutoff for this duel at `nowMs`: a `checkedAt` at or
 * before it is the stamp duelScanDue judged due (checkedAt + interval <=
 * now), and a rival's fresher stamp is after it.
 */
export function duelScanCutoffFor(d: DuelClockInput, nowMs: number): Date {
  return new Date(nowMs - duelScanIntervalMs(d));
}

/**
 * When the scan may next look at this duel; null for one whose game never
 * started (READY: no game can exist, so no result) or a closed one.
 */
export function duelScanDueAtMs(d: DuelClockInput): number | null {
  if (!duelTakesResult(d.status)) return null;
  if (d.status === INHOUSE_DUEL_STATUS.READY && d.startedAt === null) return null;
  const opens = d.createdAt.getTime() + INHOUSE_DUEL.SCAN_AFTER_MINUTES * 60_000;
  const backoff = d.checkedAt ? d.checkedAt.getTime() + duelScanIntervalMs(d) : 0;
  return Math.max(opens, backoff);
}

export function duelScanDue(d: DuelClockInput, nowMs: number): boolean {
  const at = duelScanDueAtMs(d);
  return at !== null && at <= nowMs;
}

/**
 * While OpenDota lacks the bot's match id, does the scan read the players'
 * histories too? Only BOT_MATCH_WAIT_MINUTES after the game started:
 * before that a game OpenDota hasn't published is in no history either.
 */
export function duelBotMatchWaitOver(
  d: Pick<DuelClockInput, "createdAt" | "startedAt">,
  nowMs: number,
): boolean {
  return nowMs - duelScanClockMs(d) >= INHOUSE_DUEL.BOT_MATCH_WAIT_MINUTES * 60_000;
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
  | "after-next-duel"
  | "not-these-players"
  | "same-side"
  | "unfinished";

/** The floor a match's start_time must reach to be this duel's, in seconds. */
export function duelMatchFloorSeconds(createdAtMs: number): number {
  return Math.floor(createdAtMs / 1000) - INHOUSE_DUEL.START_GRACE_SECONDS;
}

/**
 * The latest Dota start time (epoch seconds, exclusive) a result for this duel
 * may have: when a later 1v1 with either of its players was paired (the 5v5's
 * inhouseResultCeilingSeconds). Players freed by "1v1 over" often run it
 * back at once, so the newest shared match would be the rematch's. Null when
 * no later 1v1 exists.
 */
export function duelResultCeilingSeconds(nextDuelCreatedAtMs: number | null): number | null {
  return nextDuelCreatedAtMs == null ? null : Math.floor(nextDuelCreatedAtMs / 1000);
}

/**
 * Is this Dota match the duel's result? Exactly two players, 1v1 Solo Mid,
 * both duel players' linked accounts in it on opposite sides, started no
 * earlier than the duel's pairing (less START_GRACE_SECONDS) and before a
 * later 1v1 of either player was paired (`ceilingSeconds`,
 * duelResultCeilingSeconds), and finished (a duration and a boolean
 * radiant_win). The winner is whoever's side won. Used for the bot's match
 * id, a pasted id and the scan's candidates alike.
 */
export function validateDuelMatch(
  od: OpenDotaMatch,
  duel: {
    createdAtMs: number;
    players: DuelMatchPlayer[];
    ceilingSeconds?: number | null;
  },
): { ok: true; result: DuelResult } | { ok: false; reason: DuelMatchRefusal } {
  if (od.game_mode !== DUEL_GAME_MODE.id) return { ok: false, reason: "wrong-mode" };
  if (!Array.isArray(od.players) || od.players.length !== 2) {
    return { ok: false, reason: "not-two-players" };
  }
  if (!(od.start_time >= duelMatchFloorSeconds(duel.createdAtMs))) {
    return { ok: false, reason: "before-duel" };
  }
  if (duel.ceilingSeconds != null && od.start_time >= duel.ceilingSeconds) {
    return { ok: false, reason: "after-next-duel" };
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
 * lists, in 1v1 Solo Mid, started at or after `floorSeconds` and before
 * `ceilingSeconds` (a later 1v1's pairing, duelResultCeilingSeconds), where
 * the two played opposite sides (when both slots are known). Oldest first:
 * the duel's own game is the first one the two played after pairing, never a
 * rematch. The full match is still fetched and checked with
 * validateDuelMatch.
 */
export function sharedDuelMatchIds(
  a: OpenDotaRecentMatch[],
  b: OpenDotaRecentMatch[],
  floorSeconds: number,
  ceilingSeconds: number | null = null,
): number[] {
  const fits = (m: OpenDotaRecentMatch) =>
    m.game_mode === DUEL_GAME_MODE.id &&
    m.start_time >= floorSeconds &&
    (ceilingSeconds == null || m.start_time < ceilingSeconds);
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
    .sort((x, y) => x.start_time - y.start_time || x.match_id - y.match_id)
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

type DuelUserView = {
  id: string;
  name: string;
  avatar: string | null;
  /** The player's medal (the card shows it beside the opponent). */
  rankTier: number | null;
};

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
  /** Why a CANCELLED duel ended (duelEndReason); null otherwise. */
  endReason: string | null;
  radiantUser: DuelUserView;
  direUser: DuelUserView;
};

/**
 * What the room needs about duels: the queue, every duel a result can still
 * land on, and the duels completed or cancelled inside LAST_RESULT_WINDOW_MS
 * (loadDuelRoomRows; a closed duel's completedAt is when it closed). Display
 * fields only.
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
  /**
   * The viewer's newest 1v1 that ended without a result inside
   * LAST_RESULT_WINDOW_MS, in plain words (duelCancelLine), so it never just
   * vanishes from the card. Null when a newer result or a newer 1v1 of theirs
   * is on the card.
   */
  lastCancelled: { duelId: string; line: string } | null;
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
    // Their newest 1v1 called off or cancelled inside the window, unless a
    // newer result or a newer 1v1 of theirs says more.
    const cancelled = rows.duels
      .filter(
        (d) =>
          isMine(d) &&
          d.status === INHOUSE_DUEL_STATUS.CANCELLED &&
          d.completedAt !== null &&
          d.completedAt.getTime() >= windowStart,
      )
      .sort(
        (a, b) =>
          (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0) ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )[0];
    const cancelledAt = cancelled?.completedAt?.getTime() ?? null;
    const lastCancelled =
      cancelled &&
      cancelledAt !== null &&
      !(last && last.completedAt > cancelledAt) &&
      !(myDuel && myDuel.createdAt.getTime() > cancelled.createdAt.getTime())
        ? { duelId: cancelled.id, line: duelCancelLine(cancelled.endReason) }
        : null;
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
      lastCancelled,
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

// ---------- The room poll and the worker's wake ----------

export type DuelHeartbeatAction = "skip" | "write" | "writeAndRefresh";

/**
 * What the polling viewer's 1v1 queue heartbeat needs (the 5v5's
 * roomHeartbeatAction, for the 1v1 queue). `row` is their 1v1 queue row
 * (null when not queued); `seenAtMs` a later heartbeat this server already
 * wrote for them, if it knows one.
 *
 * - skip: not queued, or seen within HEARTBEAT_SECONDS. That mirrors
 *   touchDuelQueueHeartbeat's strict `lastSeenAt < now - 30s` WHERE, so the
 *   skipped statement would have matched no row.
 * - write: queued, present and due a heartbeat. Presence doesn't change.
 * - writeAndRefresh: the rows show them away. After the write they are
 *   present (and can be paired), so the poll publishes and re-reads.
 */
export function duelHeartbeatAction(
  row: { lastSeenAt: Date } | null,
  seenAtMs: number | null,
  nowMs: number,
): DuelHeartbeatAction {
  if (!row) return "skip";
  const seen = Math.max(row.lastSeenAt.getTime(), seenAtMs ?? -Infinity);
  if (seen >= nowMs - INHOUSE_DUEL.HEARTBEAT_SECONDS * 1000) return "skip";
  return duelWaiterPresent(row, nowMs) ? "write" : "writeAndRefresh";
}

/**
 * The moments the room's duel block reads differently with no write
 * (buildDuelState's own boundaries): a queue row dropping out at its expiry,
 * a waiter turning away, a result or a cancel leaving the 10-minute window. The held
 * long-poll wakes for them (inhouseRoomWakeAt). The duels' own clocks (the
 * setup call-off, the give-up) change the reply only through the worker's
 * writes, which publish.
 */
export function duelRoomClocks(rows: {
  queue: readonly { lastSeenAt: Date; expiresAt: Date }[];
  duels: readonly { status: string; completedAt: Date | null }[];
}): number[] {
  const clocks: number[] = [];
  for (const q of rows.queue) {
    // duelWaiterExpired: expiresAt <= now.
    clocks.push(q.expiresAt.getTime());
    // duelWaiterPresent: lastSeenAt >= now - PRESENT_SECONDS, so away 1ms past.
    clocks.push(q.lastSeenAt.getTime() + INHOUSE_DUEL.PRESENT_SECONDS * 1000 + 1);
  }
  for (const d of rows.duels) {
    if (
      (d.status === INHOUSE_DUEL_STATUS.COMPLETED ||
        d.status === INHOUSE_DUEL_STATUS.CANCELLED) &&
      d.completedAt
    ) {
      clocks.push(d.completedAt.getTime() + INHOUSE_DUEL.LAST_RESULT_WINDOW_MS + 1);
    }
  }
  return clocks;
}

/**
 * When the one-minute worker next has 1v1 work (runDuelWorkerSteps), for
 * the automation gate; null when there is none. Now while a duel is live
 * (READY or PLAYING: the worker reads the bot every pass, retries a READY
 * duel's lobby create, and the scan and the give-up follow), or while two
 * present waiters sit in the queue (the worker's pairing sweep); otherwise
 * the earliest queue expiry and each open duel's next clock
 * (duelNextClockMs: its scan, its setup call-off, its give-up).
 */
export function duelWorkerWakeAtMs(
  input: {
    queue: readonly { lastSeenAt: Date; expiresAt: Date }[];
    duels: readonly DuelClockInput[];
  },
  nowMs: number,
): number | null {
  let next = Infinity;
  let present = 0;
  for (const q of input.queue) {
    // expireDuelQueue deletes rows with expiresAt <= now.
    next = Math.min(next, q.expiresAt.getTime());
    if (duelWaiterPresent(q, nowMs) && !duelWaiterExpired(q, nowMs)) present += 1;
  }
  if (present >= 2) next = Math.min(next, nowMs);
  for (const d of input.duels) {
    if (duelIsLive(d.status)) next = Math.min(next, nowMs);
    const clock = duelNextClockMs(d);
    if (clock !== null) next = Math.min(next, clock);
  }
  return next === Infinity ? null : next;
}

// ---------- The 1v1 card (src/components/inhouse/duel-*.tsx) ----------

/** The 1v1 card's intro: what a 1v1 is, shown to everyone. */
export const DUEL_CARD_INTRO =
  "Play a quick 1v1 Solo Mid. First to two kills or a tower. Wins count on the 1v1 leaderboard.";

/** The 1v1 card's section id: its anchor, and where its sign-in returns. */
export const DUEL_ROOM_ANCHOR = "inhouse-1v1-room";

/**
 * Where "Sign in to play 1v1" returns: the 1v1 card itself. Never the 5v5
 * queue's invite path (`/inhouse?join=1`), which joins the 5v5 queue on
 * arrival.
 */
export const DUEL_SIGN_IN_RETURN = `/inhouse#${DUEL_ROOM_ANCHOR}`;

/**
 * Join's place while the lobby bot can't host this league's 1v1s (no bot, or
 * no in-house ticket: inhouseLobbyBotConfigured). 1v1s are bot only, so a
 * pair could never play; joinDuelQueue refuses with the same words.
 */
export const DUEL_NO_BOT_NOTE = "1v1s start once the lobby bot can host here.";

/**
 * A 1v1 whose bot panel answers that the bot can't host here (`off`): it can't
 * start, and the setup clock calls it off.
 */
export const DUEL_BOT_OFF_NOTE =
  "The lobby bot can't host 1v1s here right now. Call it off, or it's called off by itself when the setup time runs out.";

/**
 * What the card's join row offers the viewer: sign in, Join 1v1, Leave 1v1,
 * a refusal in Join's place, the no-bot line, or nothing (their own 1v1 is on
 * the card). `pageRefusal` is the page's MMR-cap refusal (the 5v5 queue's own
 * rule, which joinDuelQueue applies too), judged first so its words win, as
 * in duelJoinRefusal. `botReady`: the lobby bot can host 1v1s here
 * (inhouseLobbyBotConfigured); without it nobody is offered Join or sign in,
 * but a queue row from before can still be left.
 */
export type DuelJoinRow =
  | { kind: "sign-in" }
  | { kind: "join" }
  | { kind: "leave" }
  | { kind: "refused"; reason: string }
  | { kind: "no-bot" }
  | { kind: "none" };

export function duelJoinRow(
  me: DuelMeView | null,
  pageRefusal: string | null,
  botReady: boolean,
): DuelJoinRow {
  if (!me) return botReady ? { kind: "sign-in" } : { kind: "no-bot" };
  if (me.inQueue) return { kind: "leave" };
  if (me.joinRefusal === DUEL_REFUSAL.IN_DUEL) return { kind: "none" };
  if (!botReady) return { kind: "no-bot" };
  if (pageRefusal) return { kind: "refused", reason: pageRefusal };
  if (me.joinRefusal) return { kind: "refused", reason: me.joinRefusal };
  return me.canJoin ? { kind: "join" } : { kind: "none" };
}

/**
 * The waiting line beside "Leave 1v1": pairing happens at a join, and a
 * waiter counts only while their page is open (present).
 */
export const DUEL_WAITING_NOTE =
  "Waiting for an opponent: the next player to join plays you while this page is open.";

/**
 * Whether the admin rows on the 1v1 card have anything to show: a waiter to
 * remove, a 1v1 to cancel or a result to void. Never an empty "Admin · 1v1"
 * box.
 */
export function duelAdminToolsVisible(duel: DuelState): boolean {
  return (
    (duel.canRemoveFromQueue && duel.queue.players.length > 0) ||
    duel.games.some((g) => g.canCancel) ||
    duel.results.some((r) => r.canVoid)
  );
}

/** "You beat X" / "X won": the viewer's last 1v1, for 10 minutes. */
export function duelResultLine(r: { won: boolean; opponentName: string }): string {
  return r.won ? `You beat ${r.opponentName}` : `${r.opponentName} won`;
}

/**
 * A 1v1 that ended without a result, in plain words for its players, from its
 * endReason (duelEndReason): called off (by a player or an admin), never
 * started in time, the bot's game ended with no result, no result on
 * OpenDota, or an admin voided its result.
 */
export function duelCancelLine(endReason: string | null): string {
  const r = endReason ?? "";
  if (r.startsWith(duelEndReason.voided("", null).trim())) {
    return "An admin voided your 1v1 result.";
  }
  if (r === duelEndReason.neverPlayed()) {
    return `No game started within ${INHOUSE_DUEL.SETUP_MINUTES} minutes, so the 1v1 was cancelled.`;
  }
  if (r.startsWith(duelEndReason.botCancelled(""))) {
    return "The game didn't start, so the 1v1 was cancelled.";
  }
  if (r === duelEndReason.resultNeverShowed()) {
    return "No result showed on OpenDota, so the 1v1 was cancelled.";
  }
  return "Your 1v1 was called off.";
}

/** A duel's stage, in a word or three, for its one-line listing. */
export function duelStageLabel(status: string): string {
  switch (status) {
    case INHOUSE_DUEL_STATUS.READY:
      return "Setting up";
    case INHOUSE_DUEL_STATUS.PLAYING:
      return "Playing";
    case INHOUSE_DUEL_STATUS.AWAITING_RESULT:
      return "Waiting for OpenDota";
    default:
      return "Over";
  }
}

/**
 * Whether the viewer has a 1v1 stake the room must keep polling for while
 * its tab is hidden: a queue row (whose presence a pairing needs) or a duel
 * a result can still land on.
 */
export function duelStake(me: DuelMeView | null): boolean {
  return !!me && (me.inQueue || me.duelId !== null);
}

/**
 * Whether a room reply brought a 1v1 result the last one didn't show: the
 * room then refreshes the server-rendered 1v1 leaderboard below it. Null
 * `prev` (the first reply) is never news.
 */
export function duelResultLanded(
  prev: readonly string[] | null,
  cur: readonly string[],
): boolean {
  if (prev === null) return false;
  const seen = new Set(prev);
  return cur.some((id) => !seen.has(id));
}
