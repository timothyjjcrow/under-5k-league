import { prisma } from "./prisma";
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

/**
 * Read-only public heartbeat state.
 *
 * Browser polling must never be an automation trigger: visitors can disappear,
 * multiply across tabs, or intentionally hammer a public URL. The durable
 * worker owns all writes; this snapshot only tells clients whether to poll
 * quickly and whether a completed worker moved the result cursor.
 */
export async function getResultSyncSnapshot(
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
