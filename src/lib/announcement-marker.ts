import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { ANNOUNCE_FAILED_PREFIX } from "./settings";
import { raceHook } from "./race-hook";

const CLAIM_PREFIX = "claim:v2:";
const FAILED_PREFIX = `${ANNOUNCE_FAILED_PREFIX}v2:`;
const SENT_PREFIX = "sent:v2:";
const CLAIM_LEASE_MS = 90_000;
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CLAIM_PATTERN = new RegExp(
  `^claim:v2:(\\d{1,16}):(${UUID}):(${UUID})$`,
  "i",
);
const FAILED_PATTERN = new RegExp(`^failed:v2:(${UUID}):\\d{1,16}$`, "i");
const SENT_PATTERN = new RegExp(`^sent:v2:(${UUID}):\\d{1,16}$`, "i");
const HONORS_CLAIM_PATTERN = new RegExp(
  `^claim:honors:v2:\\d{1,16}:(${UUID}):${UUID}:(?:initial|corrected)$`,
  "i",
);
const HONORS_FAILED_PATTERN = new RegExp(
  `^failed:honors:(?:initial|corrected):v2:(${UUID}):\\d{1,16}$`,
  "i",
);
const HONORS_SENT_PATTERN = new RegExp(`^sent:honors:v2:(${UUID}):`, "i");
const NON_TERMINAL_ANNOUNCEMENT_STATUSES = ["PENDING", "SENDING"];

export type AnnouncementMarkerClaim = {
  key: string;
  value: string;
  eventId: string;
};

function claimValue(nowMs: number, eventId: string): string {
  return `${CLAIM_PREFIX}${nowMs + CLAIM_LEASE_MS}:${eventId}:${randomUUID()}`;
}

function eventIdFromRecoverableValue(value: string): string | null {
  return (
    CLAIM_PATTERN.exec(value)?.[2] ?? FAILED_PATTERN.exec(value)?.[1] ?? null
  );
}

/**
 * Whether an existing marker is safe to reclaim. Historical plain timestamp
 * values are intentionally treated as SENT; only an explicit failure or an
 * expired v2 lease may run again.
 */
export function recoverableAnnouncementMarker(
  value: string,
  nowMs = Date.now(),
): boolean {
  if (value.startsWith(ANNOUNCE_FAILED_PREFIX)) return true;
  const claim = CLAIM_PATTERN.exec(value);
  return !!claim && Number(claim[1]) <= nowMs;
}

/**
 * Prove that a persisted marker still represents one durable outbox event.
 * Delivery accepts the claim, retry, and finalized forms because a worker can
 * legitimately drain the row on either side of marker finalization. Legacy
 * marker values have no generation identity and therefore never authorize a
 * marker-backed queued message.
 */
export function announcementMarkerOwnsEvent(
  value: string,
  eventId: string,
): boolean {
  const ownedEventId =
    CLAIM_PATTERN.exec(value)?.[2] ??
    FAILED_PATTERN.exec(value)?.[1] ??
    SENT_PATTERN.exec(value)?.[1] ??
    HONORS_CLAIM_PATTERN.exec(value)?.[1] ??
    HONORS_FAILED_PATTERN.exec(value)?.[1] ??
    HONORS_SENT_PATTERN.exec(value)?.[1] ??
    null;
  return ownedEventId?.toLowerCase() === eventId.toLowerCase();
}

/**
 * Invalidate reminder-like markers only while their event is still in flight.
 * A finalized marker with no queued transport stays put so a later lifecycle
 * change cannot cause a duplicate reminder. Claim/failed generations and
 * marker-backed pending rows are deleted by exact key+value inside the caller's
 * source transaction, making any queued stale payload fail its source check.
 */
export async function invalidatePendingAnnouncementMarkers(
  tx: Pick<Prisma.TransactionClient, "setting" | "leagueAnnouncement">,
  keyScope: string,
  options: { prefix?: boolean } = {},
): Promise<number> {
  const markers = await tx.setting.findMany({
    where: {
      key: options.prefix ? { startsWith: keyScope } : keyScope,
    },
    select: { key: true, value: true },
  });
  if (markers.length === 0) return 0;
  const queued = await tx.leagueAnnouncement.findMany({
    where: {
      markerKey: { in: markers.map((marker) => marker.key) },
      status: { in: NON_TERMINAL_ANNOUNCEMENT_STATUSES },
    },
    select: { markerKey: true },
  });
  const queuedKeys = new Set(queued.flatMap((row) => row.markerKey ?? []));
  const removable = markers.filter(
    (marker) =>
      marker.value.startsWith(CLAIM_PREFIX) ||
      marker.value.startsWith(ANNOUNCE_FAILED_PREFIX) ||
      queuedKeys.has(marker.key),
  );
  if (removable.length === 0) return 0;
  const removed = await tx.setting.deleteMany({
    where: {
      OR: removable.map((marker) => ({
        key: marker.key,
        value: marker.value,
      })),
    },
  });
  return removed.count;
}

/**
 * Atomically claim a once-only marker with an expiring lease. The event id is
 * preserved across failed/stale retries so the durable outbox can deduplicate
 * the crash gap between enqueueing a message and finalizing this marker.
 */
export async function claimAnnouncementMarker(
  key: string,
  nowMs = Date.now(),
): Promise<AnnouncementMarkerClaim | null> {
  const initialEventId = randomUUID();
  const initialValue = claimValue(nowMs, initialEventId);
  const created = await prisma.$executeRaw`
    INSERT INTO "Setting" ("key", "value")
    VALUES (${key}, ${initialValue})
    ON CONFLICT ("key") DO NOTHING
  `;
  if (created > 0) {
    return { key, value: initialValue, eventId: initialEventId };
  }

  const current = await prisma.setting.findUnique({
    where: { key },
    select: { value: true },
  });
  if (!current || !recoverableAnnouncementMarker(current.value, nowMs)) {
    return null;
  }
  const eventId = eventIdFromRecoverableValue(current.value) ?? randomUUID();
  const value = claimValue(nowMs, eventId);
  // Test seam: another worker can reclaim and even finalize this exact
  // generation after our read. The value-scoped write below must then lose.
  await raceHook("announcement-marker.claimAnnouncementMarker.beforeReclaim");
  const claimed = await prisma.setting.updateMany({
    where: { key, value: current.value },
    data: { value },
  });
  return claimed.count === 1 ? { key, value, eventId } : null;
}

export async function markAnnouncementSent(
  claim: AnnouncementMarkerClaim,
  nowMs = Date.now(),
): Promise<boolean> {
  const finalized = await prisma.setting.updateMany({
    where: { key: claim.key, value: claim.value },
    data: { value: `${SENT_PREFIX}${claim.eventId}:${nowMs}` },
  });
  return finalized.count === 1;
}

export async function markAnnouncementFailed(
  claim: AnnouncementMarkerClaim,
  nowMs = Date.now(),
): Promise<boolean> {
  const finalized = await prisma.setting.updateMany({
    where: { key: claim.key, value: claim.value },
    data: { value: `${FAILED_PREFIX}${claim.eventId}:${nowMs}` },
  });
  return finalized.count === 1;
}

export async function releaseAnnouncementClaim(
  claim: AnnouncementMarkerClaim,
): Promise<boolean> {
  const released = await prisma.setting.deleteMany({
    where: { key: claim.key, value: claim.value },
  });
  return released.count === 1;
}

/** A bounded, non-identifying queue key for one marker generation. */
export function announcementDedupeKey(
  kind: "series" | "champion" | "reminder" | "honors",
  claim: AnnouncementMarkerClaim,
): string {
  const markerDigest = createHash("sha256")
    .update(claim.key)
    .digest("hex")
    .slice(0, 32);
  return `${kind}:${markerDigest}:${claim.eventId}`;
}
