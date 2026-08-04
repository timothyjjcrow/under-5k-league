import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  isValidDiscordContent,
  materializeAllowedMentions,
  normalizeMentionAllowlist,
  type MentionAllowlist,
} from "./discord-payload";
import { announcementMarkerOwnsEvent } from "./announcement-marker";
import { databaseNow } from "./database-time";
import { prisma } from "./prisma";

export const LEAGUE_ANNOUNCEMENT_STATUS = {
  PENDING: "PENDING",
  SENDING: "SENDING",
  SENT: "SENT",
  CANCELLED: "CANCELLED",
} as const;

const CLAIM_LEASE_MS = 30_000;
const BASE_RETRY_MS = 30_000;
const MAX_RETRY_MS = 15 * 60_000;
const DEFAULT_LIMIT = 4;
const CANDIDATE_BATCH = 25;
const MAX_DEDUPE_KEY = 190;
const MAX_MARKER_KEY = 500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AnnouncementDb = Pick<Prisma.TransactionClient, "leagueAnnouncement">;
type Send = (content: string, mentions?: MentionAllowlist) => Promise<boolean>;

export type LeagueAnnouncementDeliveryOptions = {
  now?: Date;
  limit?: number;
  send: Send;
};

export type LeagueAnnouncementDelivery = {
  attempted: number;
  delivered: number;
  pending: boolean;
  /** A stable operator-facing reason that pending work could not be tried. */
  blocked?: "WEBHOOK_UNAVAILABLE";
};

export type LeagueAnnouncementMarker = {
  key: string;
  eventId: string;
};

function retryAt(now: Date, attempts: number): Date {
  const exponent = Math.min(Math.max(0, attempts - 1), 5);
  return new Date(
    now.getTime() + Math.min(BASE_RETRY_MS * 2 ** exponent, MAX_RETRY_MS),
  );
}

function eligibleWhere(now: Date) {
  return {
    OR: [
      {
        status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
        availableAt: { lte: now },
      },
      {
        status: LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
        claimedAt: { lt: new Date(now.getTime() - CLAIM_LEASE_MS) },
      },
    ],
  };
}

function parseMentions(value: string): MentionAllowlist | undefined {
  try {
    return normalizeMentionAllowlist(JSON.parse(value) as MentionAllowlist);
  } catch {
    return undefined;
  }
}

export class InvalidLeagueAnnouncementError extends Error {
  readonly code = "INVALID_LEAGUE_ANNOUNCEMENT";

  constructor() {
    super("League announcement content or dedupe key is invalid");
    this.name = "InvalidLeagueAnnouncementError";
  }
}

function preparedAnnouncement(input: {
  content: string;
  mentions?: MentionAllowlist;
  dedupeKey?: string;
  marker?: LeagueAnnouncementMarker;
}) {
  const mentions = normalizeMentionAllowlist(input.mentions);
  const rendered = materializeAllowedMentions(input.content, mentions);
  const dedupeKey = input.dedupeKey ?? null;
  const markerKey = input.marker?.key ?? null;
  const markerEventId = input.marker?.eventId ?? null;
  if (
    !input.content.trim() ||
    !isValidDiscordContent(rendered) ||
    (dedupeKey !== null &&
      (!dedupeKey.trim() || dedupeKey.length > MAX_DEDUPE_KEY)) ||
    (input.marker !== undefined &&
      (!dedupeKey ||
        !markerKey?.trim() ||
        markerKey.length > MAX_MARKER_KEY ||
        !markerEventId ||
        !UUID_PATTERN.test(markerEventId)))
  ) {
    throw new InvalidLeagueAnnouncementError();
  }
  return {
    content: input.content,
    dedupeKey,
    markerKey,
    markerEventId,
    mentions: JSON.stringify(mentions ?? {}),
  };
}

/**
 * Persist league-channel work before attempting Discord. A stable dedupe key
 * lets a domain marker retry without creating a second event. With no key,
 * each call is intentionally a distinct human action.
 */
export async function enqueueLeagueAnnouncement(
  input: {
    content: string;
    mentions?: MentionAllowlist;
    dedupeKey?: string;
    marker?: LeagueAnnouncementMarker;
  },
  db: AnnouncementDb = prisma,
) {
  const { content, dedupeKey, markerKey, markerEventId, mentions } =
    preparedAnnouncement(input);

  if (!dedupeKey) {
    return db.leagueAnnouncement.create({
      data: { content, mentions, markerKey, markerEventId },
    });
  }

  // One statement, including when `db` is an existing domain transaction. A
  // caught unique violation still poisons a PostgreSQL transaction, so the
  // tempting read/create/P2002/re-read shape is not safe at this boundary.
  return db.leagueAnnouncement.upsert({
    where: { dedupeKey },
    create: { dedupeKey, content, mentions, markerKey, markerEventId },
    // A row created during a rolling release may predate source metadata. The
    // stable dedupe key still identifies this exact event generation, so it is
    // safe to attach (but never rewrite the historical payload).
    update: { markerKey, markerEventId },
  });
}

/**
 * Drain the durable league-channel queue in creation order. An earlier
 * non-terminal row blocks every later row, so concurrent request/cron drains
 * cannot intentionally deliver “accepted” before an older “proposed”. Discord
 * exposes no idempotency key, therefore a crash after it accepts a POST but
 * before SENT commits can still duplicate the message on lease recovery.
 */
export async function deliverLeagueAnnouncements(
  options: LeagueAnnouncementDeliveryOptions,
): Promise<LeagueAnnouncementDelivery> {
  // availableAt/createdAt are database defaults. Compare them with the same
  // clock so a small app/DB clock skew cannot hide a just-enqueued event from
  // its immediate delivery attempt (or make concurrency election flaky).
  const now = options.now ?? (await databaseNow());
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 20));
  let attempted = 0;
  let delivered = 0;
  let transitions = 0;

  while (attempted < limit && transitions < CANDIDATE_BATCH * 2) {
    const candidates = await prisma.leagueAnnouncement.findMany({
      where: eligibleWhere(now),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CANDIDATE_BATCH,
    });
    if (candidates.length === 0) break;

    let progressed = false;
    for (const event of candidates) {
      const earlier = await prisma.leagueAnnouncement.count({
        where: {
          OR: [
            { createdAt: { lt: event.createdAt } },
            { createdAt: event.createdAt, id: { lt: event.id } },
          ],
          status: {
            in: [
              LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
              LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
            ],
          },
        },
      });
      if (earlier > 0) continue;

      const mentions = parseMentions(event.mentions);
      if (
        !event.content.trim() ||
        !isValidDiscordContent(
          materializeAllowedMentions(event.content, mentions),
        )
      ) {
        const cancelled = await prisma.leagueAnnouncement.updateMany({
          where: { id: event.id, ...eligibleWhere(now) },
          data: {
            status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
            claimedAt: null,
            claimToken: null,
            lastErrorCode: "INVALID_PAYLOAD",
          },
        });
        if (cancelled.count === 1) {
          progressed = true;
          transitions += 1;
        }
        continue;
      }

      const claimToken = randomUUID();
      const claim = await prisma.leagueAnnouncement.updateMany({
        where: { id: event.id, ...eligibleWhere(now) },
        data: {
          status: LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
          attempts: { increment: 1 },
          claimedAt: now,
          claimToken,
          lastErrorCode: null,
        },
      });
      if (claim.count === 0) continue;

      progressed = true;
      attempted += 1;
      transitions += 1;

      const hasMarkerKey = event.markerKey !== null;
      const hasMarkerEventId = event.markerEventId !== null;
      if (hasMarkerKey !== hasMarkerEventId) {
        await prisma.leagueAnnouncement.updateMany({
          where: {
            id: event.id,
            status: LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
            claimToken,
          },
          data: {
            status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
            claimedAt: null,
            claimToken: null,
            lastErrorCode: "INVALID_SOURCE",
          },
        });
        break;
      }
      if (event.markerKey && event.markerEventId) {
        let source: { value: string } | null;
        try {
          source = await prisma.setting.findUnique({
            where: { key: event.markerKey },
            select: { value: true },
          });
        } catch {
          await prisma.leagueAnnouncement.updateMany({
            where: {
              id: event.id,
              status: LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
              claimToken,
            },
            data: {
              status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
              availableAt: retryAt(now, event.attempts + 1),
              claimedAt: null,
              claimToken: null,
              lastErrorCode: "SOURCE_CHECK_FAILED",
            },
          });
          break;
        }
        if (
          !source ||
          !announcementMarkerOwnsEvent(source.value, event.markerEventId)
        ) {
          await prisma.leagueAnnouncement.updateMany({
            where: {
              id: event.id,
              status: LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
              claimToken,
            },
            data: {
              status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
              claimedAt: null,
              claimToken: null,
              lastErrorCode: "STALE_SOURCE",
            },
          });
          break;
        }
      }

      let accepted = false;
      try {
        accepted = await options.send(event.content, mentions);
      } catch {
        // The production transport resolves false. Keep injected transports and
        // future refactors from losing a leased row when they reject instead.
      }

      if (accepted) {
        const completed = await prisma.leagueAnnouncement.updateMany({
          where: {
            id: event.id,
            status: LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
            claimToken,
          },
          data: {
            status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
            sentAt: now,
            claimedAt: null,
            claimToken: null,
            lastErrorCode: null,
          },
        });
        if (completed.count === 1) delivered += 1;
      } else {
        await prisma.leagueAnnouncement.updateMany({
          where: {
            id: event.id,
            status: LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
            claimToken,
          },
          data: {
            status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
            availableAt: retryAt(now, event.attempts + 1),
            claimedAt: null,
            claimToken: null,
            lastErrorCode: "TRANSPORT_REJECTED",
          },
        });
      }
      break;
    }
    if (!progressed) break;
  }

  const pending =
    (await prisma.leagueAnnouncement.count({
      where: {
        status: {
          in: [
            LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
            LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
          ],
        },
      },
    })) > 0;
  return { attempted, delivered, pending };
}

export async function hasPendingLeagueAnnouncements(): Promise<boolean> {
  return (
    (await prisma.leagueAnnouncement.count({
      where: {
        status: {
          in: [
            LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
            LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
          ],
        },
      },
    })) > 0
  );
}

/** Queue one message and make a bounded immediate attempt in global order. */
export async function enqueueAndDeliverLeagueAnnouncement(
  input: {
    content: string;
    mentions?: MentionAllowlist;
    dedupeKey?: string;
    marker?: LeagueAnnouncementMarker;
  },
  send: Send,
): Promise<boolean> {
  const event = await enqueueLeagueAnnouncement(input);
  if (event.status === LEAGUE_ANNOUNCEMENT_STATUS.SENT) return true;
  try {
    await deliverLeagueAnnouncements({ send, limit: 1 });
  } catch {
    // Persistence is the success boundary; a future drain owns this row.
  }
  return true;
}
