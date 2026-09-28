import { prisma } from "./prisma";
import { SEASON_STATUS } from "./constants";
import {
  getWebhookUrl,
  sendDiscordMessage,
  signupsOpenMessage,
} from "./discord";
import { announcedMatchNight } from "./match-night";
import { signupsOpenAnnouncedKey } from "./settings";
import {
  announcementDedupeKey,
  claimAnnouncementMarker,
  markAnnouncementSent,
  releaseAnnouncementClaim,
} from "./announcement-marker";

/**
 * Post "<season> signups are open" once, after createSeason has committed.
 *
 * Opening a season used to post nothing: until an admin wrote a news post or
 * set a draft night, the season's first automatic line in the channel was the
 * first player's own signup. The marker makes a replayed or retried call a
 * no-op. No webhook, or a send that could not even be queued, releases the
 * claim instead of burning it (the announceChampionOnce rule); nothing retries
 * this post automatically, because once the queue has it the outbox owns
 * delivery.
 */
export async function announceSignupsOpenOnce(
  seasonId: string,
): Promise<boolean> {
  if (!(await getWebhookUrl())) return false;
  const claim = await claimAnnouncementMarker(signupsOpenAnnouncedKey(seasonId));
  if (!claim) return false;
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: {
      name: true,
      isActive: true,
      status: true,
      matchSchedule: true,
      matches: { select: { scheduledAt: true, status: true } },
    },
  });
  // Archived, deleted or already past signups by the time this ran: the
  // news is no longer true, so say nothing.
  if (!season?.isActive || season.status !== SEASON_STATUS.SIGNUPS) {
    await releaseAnnouncementClaim(claim);
    return false;
  }
  const sent = await sendDiscordMessage(
    signupsOpenMessage(season.name, announcedMatchNight(season, season.matches)),
    undefined,
    {
      dedupeKey: announcementDedupeKey("signups", claim),
      marker: { key: claim.key, eventId: claim.eventId },
    },
  );
  if (!sent) {
    await releaseAnnouncementClaim(claim);
    return false;
  }
  return markAnnouncementSent(claim);
}
