// The FULL inhouse ladder (rating / rank / W-L per user), memoised in-process.
//
// The ladder must scan ALL completed lobbies with no take window — Elo is
// path-dependent from game 1 (the rule stated at every existing call site).
// That scan is too heavy to run per /players view, so this borrows the
// loadBoardStats memo shape (inhouse-board-service.ts): module-level
// {at, value} singleton, 60s TTL, a nowMs param so tests can drive the clock,
// and a reset seam. Deliberately NOT unstable_cache — the "games" tag is
// league-import semantics and nothing busts it when an inhouse completes, so
// that cache would serve the wrong staleness contract. 60s is the pinned
// Discord board's already-accepted staleness for exactly this data.
import { prisma } from "./prisma";
import { INHOUSE_STATUS } from "./constants";
import {
  rankInhouse,
  summarizeInhouse,
  toFinishedLobby,
  type RankedInhouse,
} from "./inhouse-stats";

const LADDER_TTL_MS = 60_000;
let cache: { at: number; value: RankedInhouse } | null = null;

export async function loadInhouseLadder(
  nowMs: number = Date.now(),
): Promise<RankedInhouse> {
  if (cache && nowMs - cache.at < LADDER_TTL_MS) return cache.value;
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
  const value = rankInhouse(summarizeInhouse(rows.map(toFinishedLobby)));
  cache = { at: nowMs, value };
  return value;
}

/** Test seam — the memo otherwise leaks state across integration tests. */
export function resetInhouseLadderCache(): void {
  cache = null;
}
