import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { heroById } from "./heroes";
import { HONOR_WEEK_STATE, type HonorWeekReadiness } from "./honors-readiness";
import { getSeasonHonorReadiness } from "./honors-readiness-service";
import { weeklyHonors, type WeeklyHonors } from "./honors";
import { prisma } from "./prisma";
import {
  ANNOUNCE_FAILED_PREFIX,
  HONORS_ANNOUNCED_PREFIX,
  honorsAnnouncedKey,
} from "./settings";
import {
  getWebhookUrl,
  sendDiscordMessage,
  weeklyHonorsMessage,
} from "./discord";

const HONORS_STALE_PREFIX = "stale:";
const HONORS_CLAIM_PREFIX = "claim:honors:";
const HONORS_FAILED_INITIAL_PREFIX = `${ANNOUNCE_FAILED_PREFIX}honors:initial:`;
const HONORS_FAILED_CORRECTED_PREFIX = `${ANNOUNCE_FAILED_PREFIX}honors:corrected:`;

type HonorAnnouncementMode = "initial" | "corrected";

function honorsFor(readiness: HonorWeekReadiness): WeeklyHonors {
  // Readiness requires every line to retain its import-time teamId, so the
  // live-roster fallback is deliberately empty: roster churn cannot rewrite a
  // historical award.
  return weeklyHonors(readiness.games, new Map());
}

function honorDigest(honors: WeeklyHonors): string {
  return Buffer.from(JSON.stringify(honors)).toString("base64url");
}

async function readyWeek(seasonId: string, week: number) {
  const readiness = (await getSeasonHonorReadiness(seasonId, week)).find(
    (candidate) => candidate.week === week,
  );
  return readiness?.state === HONOR_WEEK_STATE.READY ? readiness : null;
}

/** Compute one week's honors only after the shared publication gate passes. */
export async function getWeekHonors(
  seasonId: string,
  week: number,
): Promise<WeeklyHonors> {
  const readiness = await readyWeek(seasonId, week);
  return readiness ? honorsFor(readiness) : { player: null, team: null };
}

/**
 * Result repair invalidates an already-published award without deleting its
 * history. Updating the marker inside the same result transaction ensures the
 * next ready slate is announced as a correction, not silently swallowed as a
 * duplicate. With no marker there was no prior announcement, so updateMany is
 * intentionally a no-op.
 */
export async function markWeekHonorsStale(
  tx: Pick<Prisma.TransactionClient, "setting">,
  seasonId: string,
  week: number,
): Promise<void> {
  await tx.setting.updateMany({
    where: { key: honorsAnnouncedKey(seasonId, week) },
    data: { value: `${HONORS_STALE_PREFIX}${new Date().toISOString()}` },
  });
}

async function claimHonorAnnouncement(
  marker: string,
): Promise<{ mode: HonorAnnouncementMode; value: string } | null> {
  const initialValue = `${HONORS_CLAIM_PREFIX}initial:${randomUUID()}`;
  try {
    await prisma.setting.create({
      data: { key: marker, value: initialValue },
    });
    return { mode: "initial", value: initialValue };
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
  }

  const current = await prisma.setting.findUnique({ where: { key: marker } });
  if (!current) return null;
  const mode: HonorAnnouncementMode | null =
    current.value.startsWith(HONORS_STALE_PREFIX) ||
    current.value.startsWith(HONORS_FAILED_CORRECTED_PREFIX)
      ? "corrected"
      : current.value.startsWith(HONORS_FAILED_INITIAL_PREFIX)
        ? "initial"
        : null;
  if (!mode) return null;

  const value = `${HONORS_CLAIM_PREFIX}${mode}:${randomUUID()}`;
  const claimed = await prisma.setting.updateMany({
    where: { key: marker, value: current.value },
    data: { value },
  });
  return claimed.count === 1 ? { mode, value } : null;
}

function failedValue(mode: HonorAnnouncementMode): string {
  return `${
    mode === "corrected"
      ? HONORS_FAILED_CORRECTED_PREFIX
      : HONORS_FAILED_INITIAL_PREFIX
  }${new Date().toISOString()}`;
}

/**
 * Announce a week's honors exactly once after its results AND box scores are
 * publication-ready. Stale and failed states are reclaimed with an exact-value
 * compare-and-swap, so concurrent imports/heartbeats cannot double-post.
 */
export async function maybeAnnounceWeekHonors(
  seasonId: string,
  week: number,
): Promise<void> {
  const readiness = await readyWeek(seasonId, week);
  if (!readiness) return;
  const honors = honorsFor(readiness);

  // No webhook means no claim: wiring Discord later must not burn the award.
  if (!(await getWebhookUrl())) return;
  const marker = honorsAnnouncedKey(seasonId, week);
  const claim = await claimHonorAnnouncement(marker);
  if (!claim) return;

  // An all-forfeit week has no award to announce initially. A correction is
  // different: Discord must be told that the previous award was withdrawn.
  if (!honors.player && !honors.team && claim.mode === "initial") {
    await prisma.setting.deleteMany({
      where: { key: marker, value: claim.value },
    });
    return;
  }

  // The slate can be reopened after the first read but before Discord I/O.
  // Re-check it and the winner digest while we own the claim; if either moved,
  // convert our exact claim to stale and let the corrected state announce.
  const currentReadiness = await readyWeek(seasonId, week);
  const currentHonors = currentReadiness ? honorsFor(currentReadiness) : null;
  if (!currentHonors || honorDigest(currentHonors) !== honorDigest(honors)) {
    await prisma.setting.updateMany({
      where: { key: marker, value: claim.value },
      data: { value: `${HONORS_STALE_PREFIX}${new Date().toISOString()}` },
    });
    return;
  }

  const [playerUser, team] = await Promise.all([
    honors.player
      ? prisma.user.findUnique({ where: { id: honors.player.userId } })
      : null,
    honors.team
      ? prisma.team.findUnique({ where: { id: honors.team.teamId } })
      : null,
  ]);
  const sent = await sendDiscordMessage(
    weeklyHonorsMessage({
      week,
      playerName: playerUser?.name ?? null,
      playerPoints: honors.player?.points ?? 0,
      heroName:
        honors.player?.heroId != null
          ? (heroById(honors.player.heroId)?.name ?? null)
          : null,
      teamName: team?.name ?? null,
      teamGameWins: honors.team?.gameWins ?? 0,
      corrected: claim.mode === "corrected",
    }),
  );
  if (!sent) {
    await prisma.setting.updateMany({
      where: { key: marker, value: claim.value },
      data: { value: failedValue(claim.mode) },
    });
    return;
  }
  await prisma.setting.updateMany({
    where: { key: marker, value: claim.value },
    data: {
      value: `sent:${honorDigest(honors)}:${new Date().toISOString()}`,
    },
  });
}

/** Drain a bounded set of failed/stale honors from the ordinary site heartbeat. */
export async function retryPendingHonorAnnouncements(): Promise<void> {
  const pending = await prisma.setting.findMany({
    where: {
      key: { startsWith: HONORS_ANNOUNCED_PREFIX },
      OR: [
        { value: { startsWith: HONORS_STALE_PREFIX } },
        { value: { startsWith: HONORS_FAILED_INITIAL_PREFIX } },
        { value: { startsWith: HONORS_FAILED_CORRECTED_PREFIX } },
      ],
    },
    take: 4,
  });
  for (const row of pending) {
    const suffix = row.key.slice(HONORS_ANNOUNCED_PREFIX.length);
    const split = suffix.lastIndexOf(":");
    const seasonId = suffix.slice(0, split);
    const week = Number(suffix.slice(split + 1));
    if (seasonId && Number.isSafeInteger(week) && week > 0) {
      await maybeAnnounceWeekHonors(seasonId, week);
    }
  }
}
