import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  isValidDiscordContent,
  materializeAllowedMentions,
  normalizeMentionAllowlist,
  type MentionAllowlist,
} from "./discord-payload";
import {
  announcementMarkerOwnsEvent,
  MARKER_UUID_SOURCE,
} from "./announcement-marker";
import { databaseNow } from "./database-time";
import {
  DELIVERY_RECENT_MS,
  DISCARDED_ERROR_CODE,
  discordErrorCode,
  discordRefusalKind,
  EXPIRED_ERROR_CODE,
  type LeagueDeliveryHealth,
} from "./league-delivery";
import { prisma } from "./prisma";

export const LEAGUE_ANNOUNCEMENT_STATUS = {
  PENDING: "PENDING",
  SENDING: "SENDING",
  SENT: "SENT",
  CANCELLED: "CANCELLED",
} as const;

/**
 * How long a SENDING row stays claimed before another worker may retry it.
 * The automation gate imports this to know when such a row becomes due.
 */
export const LEAGUE_ANNOUNCEMENT_CLAIM_LEASE_MS = 30_000;
const BASE_RETRY_MS = 30_000;
const MAX_RETRY_MS = 15 * 60_000;
const DEFAULT_LIMIT = 4;
const CANDIDATE_BATCH = 25;
const MAX_DEDUPE_KEY = 190;
const MAX_MARKER_KEY = 500;
const UUID_PATTERN = new RegExp(`^${MARKER_UUID_SOURCE}$`, "i");

type AnnouncementDb = Pick<Prisma.TransactionClient, "leagueAnnouncement">;

/**
 * What one webhook POST came back with. `true` = Discord accepted it; `false`
 * = no answer (network, timeout, a disabled transport), retried with backoff;
 * `{ status }` = Discord answered with that non-2xx status, which decides
 * whether the post is dropped, the queue pauses, or it is retried
 * (discordRefusalKind).
 */
export type LeagueSendResult = boolean | { status: number };
type Send = (
  content: string,
  mentions?: MentionAllowlist,
) => Promise<LeagueSendResult>;

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
  blocked?: "WEBHOOK_UNAVAILABLE" | "DISCORD_MUTATIONS_DISABLED";
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

/**
 * The row update after a POST that Discord did not accept. A refused MESSAGE
 * is dropped so it cannot block every later post; a refused WEBHOOK keeps the
 * post and retries only at the slowest interval, which pauses the whole queue
 * (ordering holds everything behind it) until a working webhook is saved.
 */
function failedSendData(result: LeagueSendResult, now: Date, attempts: number) {
  const released = { claimedAt: null, claimToken: null };
  if (typeof result !== "object") {
    return {
      ...released,
      status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
      availableAt: retryAt(now, attempts),
      lastErrorCode: "TRANSPORT_REJECTED",
    };
  }
  const lastErrorCode = discordErrorCode(result.status);
  switch (discordRefusalKind(result.status)) {
    case "post":
      return {
        ...released,
        status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
        lastErrorCode,
      };
    case "webhook":
      return {
        ...released,
        status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
        availableAt: new Date(now.getTime() + MAX_RETRY_MS),
        lastErrorCode,
      };
    default:
      return {
        ...released,
        status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
        availableAt: retryAt(now, attempts),
        lastErrorCode,
      };
  }
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
        claimedAt: { lt: new Date(now.getTime() - LEAGUE_ANNOUNCEMENT_CLAIM_LEASE_MS) },
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
  expiresAt?: Date | null;
}) {
  const mentions = normalizeMentionAllowlist(input.mentions);
  const rendered = materializeAllowedMentions(input.content, mentions);
  const dedupeKey = input.dedupeKey ?? null;
  const markerKey = input.marker?.key ?? null;
  const markerEventId = input.marker?.eventId ?? null;
  const expiresAt = input.expiresAt ?? null;
  if (
    !input.content.trim() ||
    (expiresAt !== null && !Number.isFinite(expiresAt.getTime())) ||
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
    expiresAt,
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
    /** Dropped instead of sent once this passes (see cancelExpired...). */
    expiresAt?: Date | null;
  },
  db: AnnouncementDb = prisma,
) {
  const { content, dedupeKey, markerKey, markerEventId, expiresAt, mentions } =
    preparedAnnouncement(input);

  if (!dedupeKey) {
    return db.leagueAnnouncement.create({
      data: { content, mentions, markerKey, markerEventId, expiresAt },
    });
  }

  // One statement, including when `db` is an existing domain transaction. A
  // caught unique violation still poisons a PostgreSQL transaction, so the
  // tempting read/create/P2002/re-read shape is not safe at this boundary.
  return db.leagueAnnouncement.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey,
      content,
      mentions,
      markerKey,
      markerEventId,
      expiresAt,
    },
    // A row created during a rolling release may predate source metadata. The
    // stable dedupe key still identifies this exact event generation, so it is
    // safe to attach (but never rewrite the historical payload).
    update: { markerKey, markerEventId },
  });
}

/**
 * Drop time-bound posts whose moment has passed (a match-night reminder after
 * kickoff, a live-draft post once the draft is over) instead of sending them
 * late — after a webhook outage the backlog would otherwise arrive hours or
 * days later reading as news. Runs before the ordering check, so a stale row
 * never blocks a current one; dropping is not sending, so "accepted" still
 * never lands before "proposed". A row mid-send under a LIVE lease is left to
 * its sender, which records the outcome it actually got.
 */
async function cancelExpiredLeagueAnnouncements(now: Date): Promise<number> {
  const dropped = await prisma.leagueAnnouncement.updateMany({
    where: {
      expiresAt: { lte: now },
      OR: [
        { status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING },
        {
          status: LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
          claimedAt: {
            lt: new Date(now.getTime() - LEAGUE_ANNOUNCEMENT_CLAIM_LEASE_MS),
          },
        },
      ],
    },
    data: {
      status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
      claimedAt: null,
      claimToken: null,
      lastErrorCode: EXPIRED_ERROR_CODE,
    },
  });
  return dropped.count;
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

  await cancelExpiredLeagueAnnouncements(now);

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

      let result: LeagueSendResult = false;
      try {
        result = await options.send(event.content, mentions);
      } catch {
        // The production transport resolves false. Keep injected transports and
        // future refactors from losing a leased row when they reject instead.
      }

      if (result === true) {
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
          data: failedSendData(result, now, event.attempts + 1),
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

/**
 * Mark every waiting post in `group` as out of date now, then drop it. For
 * posts that go stale on an EVENT rather than at a known time — the live
 * draft's posts once the draft ends (see sendDiscordMessage's expiryGroup).
 * A group is a dedupe-key prefix ending in ":", so one season's group can
 * never match another's.
 */
export async function expireLeagueAnnouncementGroup(
  group: string,
): Promise<number> {
  if (!group.endsWith(":") || group.length < 2) return 0;
  const now = await databaseNow();
  await prisma.leagueAnnouncement.updateMany({
    where: {
      dedupeKey: { startsWith: group },
      status: {
        in: [
          LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
          LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
        ],
      },
    },
    data: { expiresAt: now },
  });
  return cancelExpiredLeagueAnnouncements(now);
}

/**
 * Make every waiting post due now. Called when an admin saves a webhook (or
 * a test post goes through): a queue paused by a refused webhook otherwise
 * waits out its slowest retry interval before trying the new one.
 */
export async function resumeLeagueAnnouncements(): Promise<number> {
  const now = await databaseNow();
  const resumed = await prisma.leagueAnnouncement.updateMany({
    where: { status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING },
    data: { availableAt: now },
  });
  return resumed.count;
}

/**
 * The admin's "Discard waiting posts": cancel every post queued up to `upTo`
 * (the newest one the admin was shown, so a post queued after the page loaded
 * is never discarded unseen). A post mid-send under a live lease is left
 * alone; it may already be in Discord.
 */
export async function discardWaitingLeagueAnnouncements(
  upTo: Date,
): Promise<number> {
  const now = await databaseNow();
  const discarded = await prisma.leagueAnnouncement.updateMany({
    where: {
      createdAt: { lte: upTo },
      OR: [
        { status: LEAGUE_ANNOUNCEMENT_STATUS.PENDING },
        {
          status: LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
          claimedAt: {
            lt: new Date(now.getTime() - LEAGUE_ANNOUNCEMENT_CLAIM_LEASE_MS),
          },
        },
      ],
    },
    data: {
      status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
      claimedAt: null,
      claimToken: null,
      lastErrorCode: DISCARDED_ERROR_CODE,
    },
  });
  return discarded.count;
}

/**
 * Delivery health for the admin panel: database reads only, so it is safe on
 * the page's blocking path. Error codes only — never the webhook URL. Timed
 * on the database clock, like the createdAt/availableAt it is compared with.
 */
export async function loadLeagueDeliveryHealth(
  at?: Date,
): Promise<LeagueDeliveryHealth> {
  const now = at ?? (await databaseNow());
  const waitingWhere = {
    status: {
      in: [
        LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
        LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
      ],
    },
  };
  const since = new Date(now.getTime() - DELIVERY_RECENT_MS);
  const refusedWhere = {
    status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
    lastErrorCode: { in: [discordErrorCode(400), discordErrorCode(413)] },
    updatedAt: { gte: since },
  };
  const [waiting, head, newest, lastSent, refused, lastRefused, expired] =
    await Promise.all([
      prisma.leagueAnnouncement.count({ where: waitingWhere }),
      prisma.leagueAnnouncement.findFirst({
        where: waitingWhere,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { createdAt: true, lastErrorCode: true, availableAt: true },
      }),
      prisma.leagueAnnouncement.findFirst({
        where: waitingWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { createdAt: true },
      }),
      prisma.leagueAnnouncement.findFirst({
        where: {
          status: LEAGUE_ANNOUNCEMENT_STATUS.SENT,
          sentAt: { not: null },
        },
        orderBy: { sentAt: "desc" },
        select: { sentAt: true },
      }),
      prisma.leagueAnnouncement.count({ where: refusedWhere }),
      prisma.leagueAnnouncement.findFirst({
        where: refusedWhere,
        orderBy: { updatedAt: "desc" },
        select: { lastErrorCode: true },
      }),
      prisma.leagueAnnouncement.count({
        where: {
          status: LEAGUE_ANNOUNCEMENT_STATUS.CANCELLED,
          lastErrorCode: EXPIRED_ERROR_CODE,
          updatedAt: { gte: since },
        },
      }),
    ]);
  return {
    checkedAt: now,
    waiting,
    oldestWaitingAt: head?.createdAt ?? null,
    newestWaitingAt: newest?.createdAt ?? null,
    headErrorCode: head?.lastErrorCode ?? null,
    headRetryAt: head?.availableAt ?? null,
    lastDeliveredAt: lastSent?.sentAt ?? null,
    refusedRecently: refused,
    lastRefusedCode: lastRefused?.lastErrorCode ?? null,
    expiredRecently: expired,
  };
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
