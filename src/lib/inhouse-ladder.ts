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
  toFinishedLobby,
  type InhouseRecord,
  type RankedInhouse,
} from "./inhouse-stats";
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

/** Test seam — the memo otherwise leaks state across integration tests. */
export function resetInhouseLadderCache(): void {
  cache = null;
  inFlight = null;
  generation += 1;
}
