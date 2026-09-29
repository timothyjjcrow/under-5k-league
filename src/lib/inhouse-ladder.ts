// The FULL inhouse ladder (rating / rank / W-L per user), shared by the room,
// Discord board and player lists, memoised in-process.
//
// The ladder must scan ALL completed lobbies with no take window — Elo is
// path-dependent from game 1 (the rule stated at every existing call site).
// A cheap result cursor read invalidates completed/voided games immediately;
// the 60s TTL bounds out-of-band changes such as player names. Shared promises
// collapse concurrent cold reads. Scheduler preflight can explicitly bypass
// both the cache and older in-flight work before deciding the worker may sleep.
import { prisma } from "./prisma";
import { INHOUSE_STATUS } from "./constants";
import {
  rankInhouse,
  summarizeInhouse,
  summarizeInhouseMonth,
  toFinishedLobby,
  toMonthLobby,
  type InhouseMonthBoard,
  type InhouseRecord,
  type RankedInhouse,
} from "./inhouse-stats";
import { leagueMonthWindow } from "./schedule";
import { getSetting, SETTING_KEYS } from "./settings";

const LADDER_TTL_MS = 60_000;
export type InhouseLadderSummary = {
  records: InhouseRecord[];
  ladder: RankedInhouse;
  completedCount: number;
};
let cache: {
  at: number;
  cursor: string | null;
  value: InhouseLadderSummary;
} | null = null;
let inFlight: {
  cursor: string | null;
  promise: Promise<InhouseLadderSummary>;
} | null = null;
let generation = 0;

export async function loadInhouseLadder(
  nowMs: number = Date.now(),
): Promise<RankedInhouse> {
  return (await loadInhouseLadderSummary(nowMs)).ladder;
}

export async function loadInhouseLadderSummary(
  nowMs: number = Date.now(),
  options: { fresh?: boolean } = {},
): Promise<InhouseLadderSummary> {
  const cursor = await getSetting(SETTING_KEYS.RESULT_CHANGED_AT);
  if (!options.fresh) {
    if (
      cache &&
      cache.cursor === cursor &&
      nowMs >= cache.at &&
      nowMs - cache.at < LADDER_TTL_MS
    ) {
      return cache.value;
    }
    if (inFlight?.cursor === cursor) return inFlight.promise;
  }

  const readGeneration = ++generation;
  const promise = readSummary();
  inFlight = { cursor, promise };
  try {
    const value = await promise;
    if (readGeneration === generation) cache = { at: nowMs, cursor, value };
    return value;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

async function readSummary(): Promise<InhouseLadderSummary> {
  const rows = await prisma.inhouseLobby.findMany({
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
  const records = summarizeInhouse(rows.map(toFinishedLobby));
  return { records, ladder: rankInhouse(records), completedCount: rows.length };
}

// ---------- This month's board ----------
//
// Windowed on the immutable `completedAt` (indexed with status), so it never
// touches the full-history scan above: the month runs no Elo, it sums the
// swings each game stamped (see summarizeInhouseMonth). Same memo contract as
// the career ladder: the result cursor invalidates at once, the TTL bounds
// out-of-band name changes, and concurrent cold reads share one promise. The
// month itself is part of the key, so the 1st rolls the board over without
// waiting out a TTL.

export type InhouseMonthLadder = InhouseMonthBoard & {
  startMs: number;
  endMs: number;
  /** "September 2026", on the league's clock. */
  label: string;
};
let monthCache: {
  at: number;
  cursor: string | null;
  startMs: number;
  endMs: number;
  value: InhouseMonthLadder;
} | null = null;
let monthInFlight: {
  cursor: string | null;
  startMs: number;
  endMs: number;
  promise: Promise<InhouseMonthLadder>;
} | null = null;
let monthGeneration = 0;

export async function loadInhouseMonthLadder(
  nowMs: number = Date.now(),
  /** The league clock by default; tests pass a zone (or null for UTC). */
  timeZone?: string | null,
): Promise<InhouseMonthLadder> {
  const window =
    timeZone === undefined
      ? leagueMonthWindow(nowMs)
      : leagueMonthWindow(nowMs, timeZone);
  const startMs = window.start.getTime();
  const endMs = window.end.getTime();
  const cursor = await getSetting(SETTING_KEYS.RESULT_CHANGED_AT);
  const sameKey = (entry: {
    cursor: string | null;
    startMs: number;
    endMs: number;
  }) =>
    entry.cursor === cursor &&
    entry.startMs === startMs &&
    entry.endMs === endMs;
  if (
    monthCache &&
    sameKey(monthCache) &&
    nowMs >= monthCache.at &&
    nowMs - monthCache.at < LADDER_TTL_MS
  ) {
    return monthCache.value;
  }
  if (monthInFlight && sameKey(monthInFlight)) return monthInFlight.promise;

  const readGeneration = ++monthGeneration;
  const promise = readMonth(startMs, endMs, window.label);
  monthInFlight = { cursor, startMs, endMs, promise };
  try {
    const value = await promise;
    if (readGeneration === monthGeneration) {
      monthCache = { at: nowMs, cursor, startMs, endMs, value };
    }
    return value;
  } finally {
    if (monthInFlight?.promise === promise) monthInFlight = null;
  }
}

async function readMonth(
  startMs: number,
  endMs: number,
  label: string,
): Promise<InhouseMonthLadder> {
  const rows = await prisma.inhouseLobby.findMany({
    where: {
      status: INHOUSE_STATUS.COMPLETED,
      completedAt: { gte: new Date(startMs), lt: new Date(endMs) },
    },
    select: {
      id: true,
      winnerTeam: true,
      completedAt: true,
      eloDeltas: true,
      players: {
        select: {
          userId: true,
          team: true,
          user: { select: { name: true, avatar: true } },
        },
      },
    },
  });
  const board = summarizeInhouseMonth(rows.map(toMonthLobby), {
    startMs,
    endMs,
  });
  return { ...board, startMs, endMs, label };
}

/** Test seam — the memo otherwise leaks state across integration tests. */
export function resetInhouseLadderCache(): void {
  cache = null;
  inFlight = null;
  generation += 1;
  monthCache = null;
  monthInFlight = null;
  monthGeneration += 1;
}
