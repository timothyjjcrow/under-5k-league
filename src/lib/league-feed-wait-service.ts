import { cache } from "react";
import { prisma } from "./prisma";
import { getSetting, SETTING_KEYS, setSetting } from "./settings";
import {
  parseLeagueFeedWait,
  serializeLeagueFeedWait,
  stillWaitingRows,
  type LeagueFeedWait,
} from "./league-feed-wait";

/**
 * Record what the automatic league-feed pass stamped `stampMs` waited on, or
 * clear the record when it waited on nothing. Only syncDueMatches calls it,
 * after a pass that ran (not one that couldn't reach OpenDota or ran out of
 * time, which learned nothing). The worker's global lease serializes passes.
 */
export async function recordLeagueFeedWait(
  seasonId: string,
  stampMs: number,
  ids: readonly string[],
): Promise<void> {
  await setSetting(
    SETTING_KEYS.LEAGUE_FEED_WAIT,
    ids.length > 0 ? serializeLeagueFeedWait(seasonId, stampMs, ids) : "",
  );
}

/**
 * The live candidate rows of a recorded wait list. The automation gate and
 * /admin read the same rows, so the gate's retry wake and the admin's
 * "waiting on" line agree about which games still hold the feed. An expired
 * row reads as absent, as it does to syncLeagueGames.
 */
export async function readLeagueFeedWaitRows(
  wait: LeagueFeedWait,
  nowMs: number,
) {
  if (wait.ids.length === 0) return [];
  return prisma.importCandidate.findMany({
    where: {
      seasonId: wait.seasonId,
      dotaMatchId: { in: wait.ids },
      expiresAt: { gt: new Date(nowMs) },
    },
    select: { dotaMatchId: true, status: true, nextAttemptAt: true },
  });
}

/**
 * The feed games automatic feed imports are still waiting on, for /admin
 * (deduplicated per request: the attention list, the Automatic result sync
 * card and Saved import progress all ask).
 */
export const loadLeagueFeedWaiting = cache(async (seasonId: string) => {
  const wait = parseLeagueFeedWait(
    await getSetting(SETTING_KEYS.LEAGUE_FEED_WAIT),
  );
  if (!wait || wait.seasonId !== seasonId) return [];
  return stillWaitingRows(wait, seasonId, await readLeagueFeedWaitRows(wait, Date.now()));
});
