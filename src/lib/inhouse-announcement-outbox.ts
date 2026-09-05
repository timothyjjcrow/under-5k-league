import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  INHOUSE_BET_STATUS,
  INHOUSE_STATUS,
} from "./constants";
import {
  inhouseResultMessage,
  sendInhouseDiscordMessage,
  type InhouseBetSlip,
} from "./discord";
import { parseInhouseBox, type InhouseBoxPlayer } from "./inhouse-box";
import { summarizeInhouse, toFinishedLobby } from "./inhouse-stats";
import { gameMvp } from "./achievements";
import { databaseNow } from "./database-time";
import { heroById } from "./heroes";
import { prisma } from "./prisma";
import { stampResultChange } from "./settings";
import { discordMutationsAllowed } from "./discord-mutation-policy";

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
const RECOVERY_WINDOW_MS = 60 * 60_000;
const DEFAULT_RECOVERY_LIMIT = 4;
const MAX_RECOVERY_LIMIT = 20;

type Send = (content: string) => Promise<boolean>;

type InhouseResultAnnouncementSource = {
  winnerTeam: number;
  radiantTeam: number;
  radiantScore: number;
  direScore: number;
  durationSecs: number;
  dotaMatchId: string;
  boxScore: InhouseBoxPlayer[];
};

/** The single result renderer used by both the live path and crash recovery. */
export function inhouseResultAnnouncementContent(
  result: InhouseResultAnnouncementSource,
  slips?: InhouseBetSlip[] | null,
): string {
  const radiantWin = result.winnerTeam === result.radiantTeam;
  const mvpId = gameMvp(result.boxScore, radiantWin);
  const mvp = mvpId
    ? result.boxScore.find((player) => player.userId === mvpId)
    : null;
  return inhouseResultMessage({
    winnerSide: radiantWin ? "Radiant" : "Dire",
    radiantScore: result.radiantScore,
    direScore: result.direScore,
    durationSecs: result.durationSecs,
    mvpName: mvp?.name ?? null,
    mvpHero: mvp ? (heroById(mvp.heroId)?.name ?? null) : null,
    dotaMatchId: result.dotaMatchId,
    slips,
  });
}

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

export type InhouseResultReconciliationOptions = {
  /** Deterministic clock seam and upper edge of the recovery window. */
  now?: Date;
  /** Maximum recent completed lobbies examined in this heartbeat. */
  limit?: number;
};

export type InhouseResultReconciliation = {
  scanned: number;
  created: number;
};

const RECOVERABLE_BET_OUTCOMES = new Set([
  "WON",
  "LOST",
  "VOID_LINEUP",
  "VOID_LATE",
]);

function persistedBetSlips(source: {
  betSettlement: string | null;
  bets: {
    userId: string;
    stake: number;
    matched: number | null;
    outcome: string | null;
    payout: number | null;
    user: { name: string };
  }[];
}): InhouseBetSlip[] | null {
  if (source.betSettlement !== INHOUSE_BET_STATUS.SETTLED) return null;
  const slips: InhouseBetSlip[] = [];
  for (const bet of source.bets) {
    if (
      !bet.outcome ||
      !RECOVERABLE_BET_OUTCOMES.has(bet.outcome) ||
      bet.matched === null ||
      bet.payout === null
    ) {
      // A partial settlement must never be rendered as if it were the whole
      // pot. The money sweeper can finish it and a later heartbeat can retry.
      return null;
    }
    slips.push({
      name: bet.user.name,
      stake: bet.stake,
      matched: bet.matched,
      outcome: bet.outcome as InhouseBetSlip["outcome"],
      delta: bet.payout,
    });
  }
  return slips;
}

async function reconcileOneResult(
  lobbyId: string,
  cutoff: Date,
): Promise<"created" | "finalized" | "skipped"> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const source = await tx.inhouseLobby.findUnique({
            where: { id: lobbyId },
            include: {
              players: {
                select: {
                  userId: true,
                  team: true,
                  user: { select: { name: true, avatar: true } },
                },
              },
              bets: {
                where: { confirmedAt: { not: null } },
                select: {
                  userId: true,
                  stake: true,
                  matched: true,
                  outcome: true,
                  payout: true,
                  user: { select: { name: true } },
                },
              },
              announcements: {
                select: {
                  id: true,
                  kind: true,
                  status: true,
                  resultMatchId: true,
                },
              },
            },
          });
          if (
            !source ||
            source.status !== INHOUSE_STATUS.COMPLETED ||
            !source.completedAt ||
            source.completedAt < cutoff ||
            (source.winnerTeam !== 1 && source.winnerTeam !== 2) ||
            (source.radiantTeam !== 1 && source.radiantTeam !== 2) ||
            !source.dotaMatchId ||
            !/^\d+$/.test(source.dotaMatchId) ||
            source.durationSecs === null ||
            source.durationSecs <= 0 ||
            source.radiantScore === null ||
            source.radiantScore < 0 ||
            source.direScore === null ||
            source.direScore < 0
          ) {
            return "skipped";
          }

          const resultEvent = source.announcements.find(
            (event) => event.kind === INHOUSE_ANNOUNCEMENT_KIND.RESULT,
          );
          const voidEvent = source.announcements.find(
            (event) => event.kind === INHOUSE_ANNOUNCEMENT_KIND.RESULT_VOIDED,
          );
          if (
            voidEvent ||
            (resultEvent &&
              (resultEvent.resultMatchId !== source.dotaMatchId ||
                resultEvent.status === INHOUSE_ANNOUNCEMENT_STATUS.CANCELLED)) ||
            (resultEvent && source.eloDeltas !== "{}")
          ) {
            return "skipped";
          }

          // Re-rate only through this lobby. A newer game may have completed
          // while an old binary was down; using the global ladder's lastChange
          // would then stamp that newer game's swing onto this result.
          const history = await tx.inhouseLobby.findMany({
            where: {
              status: INHOUSE_STATUS.COMPLETED,
              createdAt: { lte: source.createdAt },
            },
            select: {
              id: true,
              winnerTeam: true,
              createdAt: true,
              players: {
                select: {
                  userId: true,
                  team: true,
                  user: { select: { name: true, avatar: true } },
                },
              },
            },
          });
          const records = summarizeInhouse(history.map(toFinishedLobby));
          const participantIds = new Set(
            source.players
              .filter((player) => player.team === 1 || player.team === 2)
              .map((player) => player.userId),
          );
          const deltas: Record<string, number> = {};
          for (const record of records) {
            if (participantIds.has(record.userId)) {
              deltas[record.userId] = record.lastChange;
            }
          }
          if (
            participantIds.size === 0 ||
            Object.keys(deltas).length !== participantIds.size
          ) {
            return "skipped";
          }

          const boxScore = parseInhouseBox(source.boxScore);
          const content = inhouseResultAnnouncementContent(
            {
              winnerTeam: source.winnerTeam,
              radiantTeam: source.radiantTeam,
              radiantScore: source.radiantScore,
              direScore: source.direScore,
              durationSecs: source.durationSecs,
              dotaMatchId: source.dotaMatchId,
              boxScore,
            },
            persistedBetSlips(source),
          );

          // Re-assert both the exact source result and the missing/current
          // event at the write. Serializable makes a concurrent void, bet
          // settlement or rival reconciler either win first or retry cleanly.
          const claim = await tx.inhouseLobby.updateMany({
            where: {
              id: source.id,
              status: INHOUSE_STATUS.COMPLETED,
              completedAt: source.completedAt,
              winnerTeam: source.winnerTeam,
              radiantTeam: source.radiantTeam,
              dotaMatchId: source.dotaMatchId,
              durationSecs: source.durationSecs,
              radiantScore: source.radiantScore,
              direScore: source.direScore,
              boxScore: source.boxScore,
              betSettlement: source.betSettlement,
              ...(resultEvent
                ? { announcements: { some: { id: resultEvent.id } } }
                : {
                    announcements: {
                      none: {
                        kind: {
                          in: [
                            INHOUSE_ANNOUNCEMENT_KIND.RESULT,
                            INHOUSE_ANNOUNCEMENT_KIND.RESULT_VOIDED,
                          ],
                        },
                      },
                    },
                  }),
            },
            data: { eloDeltas: JSON.stringify(deltas) },
          });
          if (claim.count === 0) return "skipped";

          if (resultEvent) {
            // Never rewrite a payload a worker may already have in flight. A
            // sent/base result is still truthful; Elo recovery remains useful.
            await tx.inhouseAnnouncement.updateMany({
              where: {
                id: resultEvent.id,
                status: INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
                resultMatchId: source.dotaMatchId,
              },
              data: { content },
            });
          } else {
            await tx.inhouseAnnouncement.create({
              data: {
                lobbyId: source.id,
                kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
                sequence: 1,
                content,
                resultMatchId: source.dotaMatchId,
              },
            });
          }
          await stampResultChange(tx);
          return resultEvent ? "finalized" : "created";
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "P2002") return "skipped";
      if (code === "P2034" && attempt < 2) continue;
      throw error;
    }
  }
  return "skipped";
}

/**
 * Repair the bounded crash window left by an older result writer: a recent
 * COMPLETED lobby without durable RESULT work. It also finalizes a base event
 * whose writer died immediately after the new atomic completion transaction.
 * Old history is deliberately excluded so enabling recovery cannot replay a
 * season's archive into Discord; outages longer than one hour need an explicit
 * operator repair.
 */
export async function reconcileMissingInhouseResultAnnouncements(
  options: InhouseResultReconciliationOptions = {},
): Promise<InhouseResultReconciliation> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - RECOVERY_WINDOW_MS);
  const limit = Math.max(
    1,
    Math.min(options.limit ?? DEFAULT_RECOVERY_LIMIT, MAX_RECOVERY_LIMIT),
  );
  const candidates = await prisma.inhouseLobby.findMany({
    where: {
      status: INHOUSE_STATUS.COMPLETED,
      completedAt: { gte: cutoff },
      dotaMatchId: { not: null },
      OR: [
        { eloDeltas: "{}" },
        {
          announcements: {
            none: { kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT },
          },
        },
      ],
    },
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true },
  });

  let created = 0;
  for (const candidate of candidates) {
    if ((await reconcileOneResult(candidate.id, cutoff)) === "created") {
      created += 1;
    }
  }
  return { scanned: candidates.length, created };
}

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
  // Match the board and league outbox: an intentional preview send block is
  // not a transport failure. Leave copied event leases, attempts and retry
  // timestamps untouched while still reporting that pending work exists.
  if (!discordMutationsAllowed()) {
    const pending = await prisma.inhouseAnnouncement.findFirst({
      where: {
        ...(options.lobbyId ? { lobbyId: options.lobbyId } : {}),
        status: { in: nonTerminal },
      },
      select: { id: true },
    });
    return { attempted: 0, delivered: 0, pending: pending !== null };
  }
  // Outbox availability is database-stamped; using the same clock prevents a
  // fresh event being skipped when the application host is slightly behind.
  const now = options.now ?? (await databaseNow());
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
      } catch {
        // The canonical sender resolves false, but keep the outbox safe for an
        // injected/custom sender that rejects. Never serialize an error here:
        // transport errors can retain a credential-bearing webhook URL.
        console.error(
          "[inhouse-announcement] Discord send failed (TRANSPORT_FAILED)",
        );
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
            sentAt: now,
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
