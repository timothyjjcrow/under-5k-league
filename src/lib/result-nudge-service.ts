import { prisma } from "./prisma";
import { AUTO_SYNC, MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "./constants";
import {
  getWebhookUrl,
  resultNudgeMessage,
  sendDiscordMessage,
} from "./discord";
import { mentionUsers } from "./discord-mentions";
import { isPlayoffPhase, matchResultsOpen } from "./league-lifecycle";
import { RESULT_NUDGE, resultNudgeReason } from "./result-nudge";
import { matchRoundLabel, playoffTotalRounds } from "./schedule";
import { raceHook } from "./race-hook";
import { singleActiveSeason } from "./season";
import { resultNudgeKey } from "./settings";
import {
  announcementDedupeKey,
  claimAnnouncementMarker,
  markAnnouncementFailed,
  markAnnouncementSent,
  recoverableAnnouncementMarker,
  releaseAnnouncementClaim,
} from "./announcement-marker";

const HOUR_MS = 3_600_000;
/** Nudges one worker pass may post; the rest wait for the next pass. */
const MAX_PER_PASS = 4;

const nudgeSelect = {
  id: true,
  seasonId: true,
  week: true,
  phase: true,
  bracketSlot: true,
  status: true,
  scheduledAt: true,
  scheduleRevision: true,
  homeScore: true,
  awayScore: true,
  games: { select: { startTime: true, durationSecs: true, fetchedAt: true } },
} as const;

/**
 * Automatic import gives up quietly: when it finds nothing for a fixture
 * (private match data, a lobby without the league ticket) it backs off and
 * stops after its window, and only the admin's Needs attention list ever
 * shows it. The captains can report the games themselves in one click, so
 * the worker tells them: once per fixture and kickoff, several hours after
 * kickoff with no games found, or once a part-played series has sat still
 * for hours (resultNudgeReason). The post mentions the two captains only.
 *
 * Runs from the automation worker, like the match-night reminder. Each nudge
 * claims its own marker before anything is sent, re-reads the fixture after
 * the claim (a result can land in between) and releases the claim when there
 * is nothing left to ask for. No webhook claims nothing. A post that could not
 * be queued is marked failed and the next pass tries it again. A post still
 * waiting in the outbox when a game or result lands, or the fixture is moved,
 * is dropped: those transactions call invalidateResultNudges.
 *
 * Returns how many nudges were queued.
 */
export async function maybeNudgeMissingResults(
  options: { nowMs?: number; shouldContinue?: () => boolean } = {},
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const shouldContinue = options.shouldContinue ?? (() => true);
  if (!(await getWebhookUrl())) return 0;
  const season = singleActiveSeason(
    await prisma.season.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, status: true },
    }),
  );
  if (
    season?.status !== SEASON_STATUS.REGULAR_SEASON &&
    season?.status !== SEASON_STATUS.PLAYOFFS
  ) {
    return 0;
  }

  const open = await prisma.match.findMany({
    where: {
      seasonId: season.id,
      status: { not: MATCH_STATUS.COMPLETED },
      scheduledAt: {
        gte: new Date(nowMs - AUTO_SYNC.WINDOW_HOURS * HOUR_MS),
        lte: new Date(nowMs - RESULT_NUDGE.HOURS_AFTER_KICKOFF * HOUR_MS),
      },
    },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    select: nudgeSelect,
  });
  // Captains can only report a fixture whose result can still change in this
  // phase: a regular week left open once the playoffs start is not theirs.
  const due = open.filter(
    (m) =>
      matchResultsOpen(season.status, m.phase) &&
      resultNudgeReason(m, nowMs) !== null,
  );
  if (due.length === 0) return 0;
  const markers = new Map(
    (
      await prisma.setting.findMany({
        where: {
          key: { in: due.map((m) => resultNudgeKey(m.id, m.scheduleRevision)) },
        },
        select: { key: true, value: true },
      })
    ).map((row) => [row.key, row.value]),
  );
  const pending = due.filter((m) => {
    const value = markers.get(resultNudgeKey(m.id, m.scheduleRevision));
    return value === undefined || recoverableAnnouncementMarker(value, nowMs);
  });

  let queued = 0;
  for (const candidate of pending.slice(0, MAX_PER_PASS)) {
    if (!shouldContinue()) break;
    if (await nudgeFixture(season, candidate.id, candidate.scheduleRevision, nowMs)) {
      queued += 1;
    }
  }
  return queued;
}

async function nudgeFixture(
  season: { id: string; status: string },
  matchId: string,
  scheduleRevision: number,
  nowMs: number,
): Promise<boolean> {
  const claim = await claimAnnouncementMarker(
    resultNudgeKey(matchId, scheduleRevision),
    nowMs,
  );
  if (!claim) return false;
  // Test seam: a result landing between the probe and this re-read.
  await raceHook("resultNudge.nudgeFixture.afterClaim");

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      ...nudgeSelect,
      homeTeam: { select: { name: true, captainId: true } },
      awayTeam: { select: { name: true, captainId: true } },
    },
  });
  // Re-judged after the claim: a result may have landed, or the fixture been
  // moved, since the probe. Same predicates as the probe, so a released
  // fixture is not picked again until it qualifies again.
  if (
    !match ||
    match.seasonId !== season.id ||
    match.scheduleRevision !== scheduleRevision ||
    !matchResultsOpen(season.status, match.phase) ||
    resultNudgeReason(match, nowMs) === null
  ) {
    await releaseAnnouncementClaim(claim);
    return false;
  }

  const playoffRounds = isPlayoffPhase(match.phase)
    ? playoffTotalRounds(
        await prisma.match.findMany({
          where: {
            seasonId: season.id,
            phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
          },
          select: { phase: true, bracketSlot: true },
        }),
      )
    : 0;
  const sent = await sendDiscordMessage(
    resultNudgeMessage({
      matchId: match.id,
      homeName: match.homeTeam.name,
      awayName: match.awayTeam.name,
      label: matchRoundLabel(match, playoffRounds),
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      gamesFound: match.games.length,
    }),
    // The two captains, and nobody else: they are the ones who can report.
    await mentionUsers([match.homeTeam.captainId, match.awayTeam.captainId]),
    {
      dedupeKey: announcementDedupeKey("nudge", claim),
      marker: { key: claim.key, eventId: claim.eventId },
      expiresAt: new Date(nowMs + RESULT_NUDGE.EXPIRES_AFTER_HOURS * HOUR_MS),
    },
  );
  if (!sent) {
    await markAnnouncementFailed(claim);
    return false;
  }
  return markAnnouncementSent(claim);
}
