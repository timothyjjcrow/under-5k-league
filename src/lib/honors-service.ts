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
import { announcementDedupeKey } from "./announcement-marker";
import { singleActiveSeason } from "./season";
import { raceHook } from "./race-hook";

const HONORS_STALE_PREFIX = "stale:";
const HONORS_CLAIM_PREFIX = "claim:honors:";
const HONORS_CLAIM_V2_PREFIX = `${HONORS_CLAIM_PREFIX}v2:`;
const HONORS_FAILED_INITIAL_PREFIX = `${ANNOUNCE_FAILED_PREFIX}honors:initial:`;
const HONORS_FAILED_CORRECTED_PREFIX = `${ANNOUNCE_FAILED_PREFIX}honors:corrected:`;
const HONORS_CLAIM_LEASE_MS = 90_000;
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const HONORS_CLAIM_PATTERN = new RegExp(
  `^claim:honors:v2:(\\d{1,16}):(${UUID}):(${UUID}):(initial|corrected)$`,
  "i",
);
const HONORS_FAILED_PATTERN = new RegExp(
  `^failed:honors:(initial|corrected):v2:(${UUID}):\\d{1,16}$`,
  "i",
);

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
  nowMs = Date.now(),
): Promise<{
  mode: HonorAnnouncementMode;
  value: string;
  eventId: string;
} | null> {
  const initialEventId = randomUUID();
  const makeClaim = (mode: HonorAnnouncementMode, eventId: string) =>
    `${HONORS_CLAIM_V2_PREFIX}${nowMs + HONORS_CLAIM_LEASE_MS}:${eventId}:${randomUUID()}:${mode}`;
  const initialValue = makeClaim("initial", initialEventId);
  const created = await prisma.$executeRaw`
    INSERT INTO "Setting" ("key", "value")
    VALUES (${marker}, ${initialValue})
    ON CONFLICT ("key") DO NOTHING
  `;
  if (created > 0) {
    return {
      mode: "initial",
      value: initialValue,
      eventId: initialEventId,
    };
  }

  const current = await prisma.setting.findUnique({ where: { key: marker } });
  if (!current) return null;
  const activeClaim = HONORS_CLAIM_PATTERN.exec(current.value);
  const failed = HONORS_FAILED_PATTERN.exec(current.value);
  const oldClaim =
    current.value.startsWith(HONORS_CLAIM_PREFIX) && !activeClaim;
  const mode: HonorAnnouncementMode | null = activeClaim
    ? Number(activeClaim[1]) <= nowMs
      ? (activeClaim[4].toLowerCase() as HonorAnnouncementMode)
      : null
    : current.value.startsWith(HONORS_STALE_PREFIX) ||
        current.value.startsWith(HONORS_FAILED_CORRECTED_PREFIX)
      ? "corrected"
      : current.value.startsWith(HONORS_FAILED_INITIAL_PREFIX)
        ? "initial"
        : oldClaim
          ? current.value.includes("corrected")
            ? "corrected"
            : "initial"
          : null;
  if (!mode) return null;

  // Preserve a v2 generation across a process death after durable enqueue.
  // Legacy claim/failed rows have no generation id, so the first v2 recovery
  // assigns one; their old webhook attempt could not have reached this outbox.
  const eventId = activeClaim?.[2] ?? failed?.[2] ?? randomUUID();
  const value = makeClaim(mode, eventId);
  const claimed = await prisma.setting.updateMany({
    where: { key: marker, value: current.value },
    data: { value },
  });
  return claimed.count === 1 ? { mode, value, eventId } : null;
}

function failedValue(mode: HonorAnnouncementMode, eventId: string): string {
  return `${
    mode === "corrected"
      ? HONORS_FAILED_CORRECTED_PREFIX
      : HONORS_FAILED_INITIAL_PREFIX
  }v2:${eventId}:${Date.now()}`;
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

  // A missing webhook is intentional silent mode, not a future replay queue.
  // Claim and finalize a non-recoverable suppression marker so wiring Discord
  // later cannot publish old awards. A later result repair still rewrites any
  // marker to `stale:` and can therefore announce the corrected slate.
  const webhookConfigured = !!(await getWebhookUrl());
  const marker = honorsAnnouncedKey(seasonId, week);
  const claim = await claimHonorAnnouncement(marker);
  if (!claim) return;
  // Test seam: result repair owns this marker even if it lands after the
  // honors worker claimed the old slate but before a terminal suppression.
  await raceHook("honors.maybeAnnounceWeekHonors.afterClaim");
  if (!webhookConfigured) {
    await prisma.setting.updateMany({
      where: { key: marker, value: claim.value },
      data: {
        value: `suppressed:honors:${claim.mode}:no-webhook:${new Date().toISOString()}`,
      },
    });
    return;
  }

  // An all-forfeit week has no award to announce initially. A correction is
  // different: Discord must be told that the previous award was withdrawn.
  // Retain a final marker for the empty initial slate so missing-marker crash
  // discovery does not reconsider the same no-performance week forever.
  if (!honors.player && !honors.team && claim.mode === "initial") {
    await prisma.setting.updateMany({
      where: { key: marker, value: claim.value },
      data: {
        value: `suppressed:honors:initial:no-performance:${new Date().toISOString()}`,
      },
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
    undefined,
    {
      dedupeKey: announcementDedupeKey("honors", {
        key: marker,
        value: claim.value,
        eventId: claim.eventId,
      }),
      marker: { key: marker, eventId: claim.eventId },
    },
  );
  if (!sent) {
    await prisma.setting.updateMany({
      where: { key: marker, value: claim.value },
      data: { value: failedValue(claim.mode, claim.eventId) },
    });
    return;
  }
  await prisma.setting.updateMany({
    where: { key: marker, value: claim.value },
    data: {
      value: `sent:honors:v2:${claim.eventId}:${honorDigest(honors)}:${new Date().toISOString()}`,
    },
  });
}

/** Drain a bounded set of failed/stale honors from the ordinary site heartbeat. */
export async function retryPendingHonorAnnouncements(
  options: { limit?: number; shouldContinue?: () => boolean } = {},
): Promise<void> {
  const limit = Math.max(1, Math.min(options.limit ?? 4, 4));
  const activeSeason = singleActiveSeason(
    await prisma.season.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true },
    }),
  );
  if (!activeSeason) return;
  const pending = await prisma.setting.findMany({
    where: {
      // Archived seasons are historical truth, not an unbounded retry queue.
      // The complete marker set of the one active season is small and avoids
      // any fixed take-window where broken early weeks starve later work.
      key: { startsWith: `${HONORS_ANNOUNCED_PREFIX}${activeSeason.id}:` },
      OR: [
        { value: { startsWith: HONORS_STALE_PREFIX } },
        { value: { startsWith: HONORS_FAILED_INITIAL_PREFIX } },
        { value: { startsWith: HONORS_FAILED_CORRECTED_PREFIX } },
        { value: { startsWith: HONORS_CLAIM_PREFIX } },
      ],
    },
    orderBy: { key: "asc" },
  });
  if (pending.length === 0) return;
  const readyWeeks = new Set(
    (await getSeasonHonorReadiness(activeSeason.id))
      .filter((row) => row.state === HONOR_WEEK_STATE.READY)
      .map((row) => row.week),
  );
  let attempted = 0;
  for (const row of pending) {
    if (attempted >= limit) break;
    if (options.shouldContinue && !options.shouldContinue()) break;
    const activeClaim = HONORS_CLAIM_PATTERN.exec(row.value);
    if (activeClaim && Number(activeClaim[1]) > Date.now()) continue;
    const suffix = row.key.slice(HONORS_ANNOUNCED_PREFIX.length);
    const split = suffix.lastIndexOf(":");
    const seasonId = suffix.slice(0, split);
    const week = Number(suffix.slice(split + 1));
    if (seasonId && Number.isSafeInteger(week) && week > 0) {
      // A reopened/broken early week must not consume the worker's limit and
      // starve a later ready failed marker forever. Retain its state for the
      // result-repair path, but only count work that can publish now.
      if (seasonId !== activeSeason.id || !readyWeeks.has(week)) continue;
      attempted += 1;
      await maybeAnnounceWeekHonors(seasonId, week);
    }
  }
}
