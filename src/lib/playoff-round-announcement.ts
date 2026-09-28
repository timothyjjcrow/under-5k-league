import { prisma } from "./prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "./constants";
import {
  getWebhookUrl,
  playoffRoundSetMessage,
  sendDiscordMessage,
} from "./discord";
import { mentionUsers } from "./discord-mentions";
import { playoffTotalRounds, roundName, slotRound } from "./schedule";
import { playoffRoundAnnouncedKey } from "./settings";
import {
  announcementDedupeKey,
  claimAnnouncementMarker,
  markAnnouncementFailed,
  markAnnouncementSent,
  releaseAnnouncementClaim,
} from "./announcement-marker";

/**
 * Post "<season> <round> is set" once for a playoff round that
 * advancePlayoffBracket has just built and COMMITTED — never from inside the
 * build, so a build that rolls back can't announce a round that doesn't exist.
 *
 * A Reset playoffs after this runs deletes the round's marker along with the
 * round (removePostseason), and the outbox drops a queued post whose marker is
 * gone, so a rebuilt bracket can't be announced with the old pairings. The
 * rows are re-read here for the same reason: a round deleted between the
 * build and this call releases the claim and says nothing.
 *
 * No webhook burns no marker (the announceChampionOnce rule). A post that
 * could not be queued is marked failed, and retryFailedAnnouncements picks it
 * up on the next worker pass.
 */
export async function announcePlayoffRoundOnce(
  seasonId: string,
  round: number,
): Promise<boolean> {
  if (!(await getWebhookUrl())) return false;
  const claim = await claimAnnouncementMarker(
    playoffRoundAnnouncedKey(seasonId, round),
  );
  if (!claim) return false;

  const [season, playoff] = await Promise.all([
    prisma.season.findUnique({
      where: { id: seasonId },
      select: { name: true, isActive: true, status: true },
    }),
    prisma.match.findMany({
      where: {
        seasonId,
        phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
      },
      select: {
        phase: true,
        bracketSlot: true,
        status: true,
        scheduledAt: true,
        homeTeam: { select: { name: true, captainId: true } },
        awayTeam: { select: { name: true, captainId: true } },
      },
    }),
  ]);
  const fixtures = playoff
    .filter(
      (m) =>
        /^R\d+M\d+$/.test(m.bracketSlot ?? "") &&
        slotRound(m.bracketSlot) === round,
    )
    .sort((a, b) => (a.bracketSlot ?? "").localeCompare(b.bracketSlot ?? ""));
  // Nothing true to say: the round was reset away, the season moved on, or
  // (on a late retry) the round has already been played out.
  if (
    !season?.isActive ||
    season.status !== SEASON_STATUS.PLAYOFFS ||
    fixtures.length === 0 ||
    fixtures.every((m) => m.status === MATCH_STATUS.COMPLETED)
  ) {
    await releaseAnnouncementClaim(claim);
    return false;
  }

  const kickoffs = fixtures
    .map((m) => m.scheduledAt?.getTime())
    .filter((ms): ms is number => ms != null);
  const sent = await sendDiscordMessage(
    playoffRoundSetMessage({
      seasonName: season.name,
      seasonId,
      roundName: roundName(round, playoffTotalRounds(playoff)),
      fixtures: fixtures.map((m) => ({
        home: m.homeTeam.name,
        away: m.awayTeam.name,
        whenMs: m.scheduledAt?.getTime() ?? null,
      })),
    }),
    // The captains of the new fixtures: they have a match night to line up.
    await mentionUsers(
      fixtures.flatMap((m) => [m.homeTeam.captainId, m.awayTeam.captainId]),
    ),
    {
      dedupeKey: announcementDedupeKey("round", claim),
      marker: { key: claim.key, eventId: claim.eventId },
      // News until the round starts; stuck behind a webhook outage past its
      // first kickoff, it is dropped rather than posted late.
      ...(kickoffs.length > 0
        ? { expiresAt: new Date(Math.min(...kickoffs)) }
        : {}),
    },
  );
  if (!sent) {
    await markAnnouncementFailed(claim);
    return false;
  }
  return markAnnouncementSent(claim);
}
