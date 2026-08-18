import { unstable_cache } from "next/cache";
import { prisma } from "./prisma";
import {
  AUTOMATION_GATE_TAG,
  AUTOMATION_GATE_VERSION,
} from "./automation-gate-constants";
import {
  AUTO_SYNC,
  DRAFT_STATUS,
  INHOUSE_ACTIVE_STATUSES,
  MATCH_STATUS,
  SEASON_STATUS,
} from "./constants";
import { queuePresentCutoff } from "./inhouse";
import { INHOUSE_ANNOUNCEMENT_STATUS } from "./inhouse-announcement-outbox";
import { LEAGUE_ANNOUNCEMENT_STATUS } from "./league-announcement-outbox";
import { getSetting, SETTING_KEYS } from "./settings";
import { singleActiveSeason } from "./season";

export type ResultSyncSnapshot = {
  watch: boolean;
  cursor: string | null;
};

// Follow the gate generation so a future deadline/tag contract cannot leave a
// status entry stranded under the previous generation after deployment.
export const RESULT_SYNC_STATUS_CACHE_KEY =
  `result-sync-status-v${AUTOMATION_GATE_VERSION}`;

/**
 * Read-only public heartbeat state.
 *
 * Browser polling must never be an automation trigger: visitors can disappear,
 * multiply across tabs, or intentionally hammer a public URL. The durable
 * worker owns all writes; this snapshot only tells clients whether to poll
 * quickly and whether a completed worker moved the result cursor.
 */
export async function loadResultSyncSnapshot(
  nowMs = Date.now(),
): Promise<ResultSyncSnapshot> {
  const season = singleActiveSeason(
    await prisma.season.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: {
        id: true,
        status: true,
        draft: { select: { status: true } },
      },
    }),
  );

  const leagueIsLive =
    season?.status === SEASON_STATUS.REGULAR_SEASON ||
    season?.status === SEASON_STATUS.PLAYOFFS;
  const draftIsLive =
    season?.status === SEASON_STATUS.DRAFT &&
    season.draft?.status === DRAFT_STATUS.IN_PROGRESS;

  const [
    dueMatch,
    activeLobby,
    presentQueue,
    pendingInhouseAnnouncement,
    pendingLeagueAnnouncement,
    cursor,
  ] = await Promise.all([
    leagueIsLive
      ? prisma.match.findFirst({
          where: {
            seasonId: season.id,
            status: { not: MATCH_STATUS.COMPLETED },
            scheduledAt: {
              gte: new Date(nowMs - AUTO_SYNC.WINDOW_HOURS * 3600_000),
              lte: new Date(
                nowMs - AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF * 60_000,
              ),
            },
          },
          select: { id: true },
        })
      : Promise.resolve(null),
    prisma.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      select: { id: true },
    }),
    prisma.inhouseQueueEntry.findFirst({
      where: { lastSeenAt: { gte: queuePresentCutoff(nowMs) } },
      select: { id: true },
    }),
    prisma.inhouseAnnouncement.findFirst({
      where: {
        status: {
          in: [
            INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
            INHOUSE_ANNOUNCEMENT_STATUS.SENDING,
          ],
        },
      },
      select: { id: true },
    }),
    prisma.leagueAnnouncement.findFirst({
      where: {
        status: {
          in: [
            LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
            LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
          ],
        },
      },
      select: { id: true },
    }),
    getSetting(SETTING_KEYS.RESULT_CHANGED_AT),
  ]);

  return {
    watch:
      draftIsLive ||
      !!dueMatch ||
      !!activeLobby ||
      !!presentQueue ||
      !!pendingInhouseAnnouncement ||
      !!pendingLeagueAnnouncement,
    cursor,
  };
}

// The public browser heartbeat is intentionally frequent enough to refresh a
// parked match page, but a quiet visible tab must not become a Neon keepalive.
// Share the automation gate's invalidation signal because this snapshot reads
// the same season/match/draft/inhouse/outbox state. Domain mutations and every
// owned worker pass already expire that tag; the worker's immutable hard wake
// remains the fallback if a best-effort invalidation is ever missed.
//
// Keep this loader zero-argument. Passing Date.now() from each browser request
// would create a fresh unstable_cache key and silently restore one database
// read set every five minutes.
const loadCachedResultSyncSnapshot = unstable_cache(
  () => loadResultSyncSnapshot(),
  [RESULT_SYNC_STATUS_CACHE_KEY],
  {
    tags: [AUTOMATION_GATE_TAG],
    revalidate: false,
  },
);

export async function getResultSyncSnapshot(): Promise<ResultSyncSnapshot> {
  return loadCachedResultSyncSnapshot();
}
