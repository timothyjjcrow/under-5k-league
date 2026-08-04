import { randomUUID } from "node:crypto";
import { INHOUSE_STATUS } from "./constants";
import { sendInhouseDiscordMessage } from "./discord";
import { prisma } from "./prisma";

/** Stable values persisted in Prisma's String fields (SQLite has no enums). */
export const INHOUSE_ANNOUNCEMENT_KIND = {
  RESULT: "RESULT",
  RESULT_VOIDED: "RESULT_VOIDED",
} as const;

export const INHOUSE_ANNOUNCEMENT_STATUS = {
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

type Send = (content: string) => Promise<boolean>;

export type InhouseAnnouncementDeliveryOptions = {
  /** Restrict an immediate post-commit attempt to the lobby just changed. */
  lobbyId?: string;
  /** Deterministic clock seam for retry/lease integration tests. */
  now?: Date;
  /** Maximum external webhook attempts in this pass. */
  limit?: number;
  /** Transport seam; production uses the canonical inhouse Discord sender. */
  send?: Send;
};

export type InhouseAnnouncementDelivery = {
  attempted: number;
  delivered: number;
  /** At least one event still needs delivery or lease recovery. */
  pending: boolean;
};

type Candidate = Awaited<ReturnType<typeof loadCandidates>>[number];

const nonTerminal = [
  INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
  INHOUSE_ANNOUNCEMENT_STATUS.SENDING,
];

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
        status: INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
        availableAt: { lte: now },
      },
      {
        status: INHOUSE_ANNOUNCEMENT_STATUS.SENDING,
        claimedAt: { lt: new Date(now.getTime() - CLAIM_LEASE_MS) },
      },
    ],
  };
}

function loadCandidates(now: Date, lobbyId?: string) {
  return prisma.inhouseAnnouncement.findMany({
    where: {
      ...(lobbyId ? { lobbyId } : {}),
      ...eligibleWhere(now),
    },
    orderBy: [{ createdAt: "asc" }, { sequence: "asc" }, { id: "asc" }],
    take: CANDIDATE_BATCH,
    include: {
      lobby: { select: { status: true, dotaMatchId: true } },
    },
  });
}

function stillDescribesCurrentState(event: Candidate): boolean {
  if (event.kind === INHOUSE_ANNOUNCEMENT_KIND.RESULT) {
    return (
      event.resultMatchId !== null &&
      event.lobby.status === INHOUSE_STATUS.COMPLETED &&
      event.lobby.dotaMatchId === event.resultMatchId
    );
  }
  if (event.kind === INHOUSE_ANNOUNCEMENT_KIND.RESULT_VOIDED) {
    return event.lobby.status === INHOUSE_STATUS.CANCELLED;
  }
  return false;
}

async function cancelIfEligible(event: Candidate, now: Date): Promise<boolean> {
  const cancelled = await prisma.inhouseAnnouncement.updateMany({
    where: { id: event.id, ...eligibleWhere(now) },
    data: {
      status: INHOUSE_ANNOUNCEMENT_STATUS.CANCELLED,
      claimedAt: null,
      claimToken: null,
    },
  });
  return cancelled.count === 1;
}

/**
 * Deliver durable inhouse Discord events with a short database lease.
 *
 * The webhook call is deliberately outside every transaction. A unique
 * `(lobbyId, kind)` row deduplicates ordinary retries, the claim token stops
 * concurrent heartbeat workers from both completing one lease, and the
 * per-lobby sequence keeps a void correction behind any result already in
 * flight. Discord webhooks do not accept an idempotency key, so the final
 * network/commit gap is inherently at-least-once: if this process dies after
 * Discord accepts a POST but before SENT commits, lease recovery may repost it.
 */
export async function deliverInhouseAnnouncements(
  options: InhouseAnnouncementDeliveryOptions = {},
): Promise<InhouseAnnouncementDelivery> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 20));
  const send = options.send ?? sendInhouseDiscordMessage;
  let attempted = 0;
  let delivered = 0;
  // Cancellations do not consume the network-attempt limit. Cap all state
  // transitions too so corrupt/unknown rows cannot turn one heartbeat into an
  // unbounded cleanup loop.
  let transitions = 0;

  while (attempted < limit && transitions < CANDIDATE_BATCH * 2) {
    const candidates = await loadCandidates(now, options.lobbyId);
    if (candidates.length === 0) break;

    let progressed = false;
    for (const event of candidates) {
      // A void event cannot overtake a result that is pending, leased, or in
      // flight. Terminal SENT/CANCELLED rows never reopen, so this fresh check
      // is sufficient before the void's claim.
      const earlier = await prisma.inhouseAnnouncement.count({
        where: {
          lobbyId: event.lobbyId,
          sequence: { lt: event.sequence },
          status: { in: nonTerminal },
        },
      });
      if (earlier > 0) continue;

      // A pending result voided before publication is stale, not work. This
      // check is repeated in the atomic claim below so a void racing between
      // this read and the write still wins safely.
      if (!stillDescribesCurrentState(event)) {
        if (await cancelIfEligible(event, now)) {
          transitions += 1;
          progressed = true;
        }
        continue;
      }

      const claimToken = randomUUID();
      const lobbyState =
        event.kind === INHOUSE_ANNOUNCEMENT_KIND.RESULT
          ? {
              status: INHOUSE_STATUS.COMPLETED,
              dotaMatchId: event.resultMatchId,
            }
          : { status: INHOUSE_STATUS.CANCELLED };
      const claim = await prisma.inhouseAnnouncement.updateMany({
        where: {
          id: event.id,
          ...eligibleWhere(now),
          lobby: { is: lobbyState },
        },
        data: {
          status: INHOUSE_ANNOUNCEMENT_STATUS.SENDING,
          attempts: { increment: 1 },
          claimedAt: now,
          claimToken,
        },
      });
      if (claim.count === 0) continue;

      attempted += 1;
      transitions += 1;
      progressed = true;

      let accepted = false;
      try {
        accepted = await send(event.content);
      } catch (error) {
        // The canonical sender resolves false, but keep the outbox safe for an
        // injected/custom sender that rejects.
        console.error("[inhouse-announcement] Discord send failed", error);
      }

      if (accepted) {
        const completed = await prisma.inhouseAnnouncement.updateMany({
          where: {
            id: event.id,
            status: INHOUSE_ANNOUNCEMENT_STATUS.SENDING,
            claimToken,
          },
          data: {
            status: INHOUSE_ANNOUNCEMENT_STATUS.SENT,
            sentAt: new Date(),
            claimedAt: null,
            claimToken: null,
          },
        });
        if (completed.count === 1) delivered += 1;
      } else {
        // A result can be voided while its webhook request is in flight. If the
        // send failed, do not put that stale result back on the queue; cancelling
        // it unblocks the durable void correction behind it. If it is still the
        // current result, preserve it with exponential retry.
        const lobby = await prisma.inhouseLobby.findUnique({
          where: { id: event.lobbyId },
          select: { status: true, dotaMatchId: true },
        });
        const remainsCurrent =
          event.kind === INHOUSE_ANNOUNCEMENT_KIND.RESULT
            ? lobby?.status === INHOUSE_STATUS.COMPLETED &&
              lobby.dotaMatchId === event.resultMatchId
            : lobby?.status === INHOUSE_STATUS.CANCELLED;
        await prisma.inhouseAnnouncement.updateMany({
          where: {
            id: event.id,
            status: INHOUSE_ANNOUNCEMENT_STATUS.SENDING,
            claimToken,
          },
          data: {
            status: remainsCurrent
              ? INHOUSE_ANNOUNCEMENT_STATUS.PENDING
              : INHOUSE_ANNOUNCEMENT_STATUS.CANCELLED,
            availableAt: retryAt(now, event.attempts + 1),
            claimedAt: null,
            claimToken: null,
          },
        });
      }

      if (attempted >= limit) break;
    }
    if (!progressed) break;
  }

  const pending =
    (await prisma.inhouseAnnouncement.count({
      where: {
        ...(options.lobbyId ? { lobbyId: options.lobbyId } : {}),
        status: { in: nonTerminal },
      },
    })) > 0;
  return { attempted, delivered, pending };
}
