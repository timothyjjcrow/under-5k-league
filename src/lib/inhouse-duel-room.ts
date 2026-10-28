// The room's 1v1 rows (docs/features/inhouse-duels.md): loadInhouseRoomRows
// reads them beside the 5v5's, so one snapshot serves both and
// buildDuelState (inhouse-duel.ts) turns them into the reply's `duel` block.
// Its own module, with no import of the engines: inhouse-service.ts imports
// it, and the duel engine imports inhouse-service.ts.

import { prisma } from "./prisma";
import {
  INHOUSE_DUEL,
  INHOUSE_DUEL_RESULT_STATUSES,
  INHOUSE_DUEL_STATUS,
} from "./constants";
import type { DuelRoomRows } from "./inhouse-duel";

const userDisplay = {
  select: { id: true, name: true, avatar: true, rankTier: true },
} as const;

/**
 * The 1v1 queue (unexpired rows), every duel a result can still land on, and
 * the duels completed or cancelled in the last LAST_RESULT_WINDOW_MS. Display
 * fields only.
 * `nowMs` opens the result window; buildDuelState narrows it with its own
 * clock, so pass a time no later than the build's.
 */
export async function loadDuelRoomRows(nowMs: number = Date.now()): Promise<DuelRoomRows> {
  const [queue, duels] = await Promise.all([
    prisma.inhouseDuelQueueEntry.findMany({
      where: { expiresAt: { gt: new Date(nowMs) } },
      select: {
        userId: true,
        joinedAt: true,
        lastSeenAt: true,
        expiresAt: true,
        user: { select: { name: true, avatar: true } },
      },
      orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
    }),
    prisma.inhouseDuel.findMany({
      where: {
        OR: [
          { status: { in: INHOUSE_DUEL_RESULT_STATUSES } },
          {
            // Closed in the window: a result, or a cancel its players are
            // told about (a closed duel's completedAt is when it closed).
            status: {
              in: [INHOUSE_DUEL_STATUS.COMPLETED, INHOUSE_DUEL_STATUS.CANCELLED],
            },
            completedAt: {
              gte: new Date(nowMs - INHOUSE_DUEL.LAST_RESULT_WINDOW_MS),
            },
          },
        ],
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        completedAt: true,
        winnerTeam: true,
        dotaMatchId: true,
        durationSecs: true,
        radiantHeroId: true,
        direHeroId: true,
        endReason: true,
        radiantUser: userDisplay,
        direUser: userDisplay,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  return { queue, duels };
}
