// The 1v1 mid inhouse engine ("duel"; docs/features/inhouse-duels.md): the
// 1v1 queue, pairing, every duel transition, the OpenDota result and the 1v1
// ladder. Pure rules live in inhouse-duel.ts; the lobby bot's side in
// inhouse-duel-bot.ts.
//
// Every state change is a guarded claim (updateMany on the exact state judged,
// with a count check), and every commit the room shows is followed by
// publishInhouseRoomChange() outside the transaction and before any provider
// call (Rule P, docs/features/concurrency-and-testing.md).

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_DUEL,
  INHOUSE_DUEL_BOT_STATUSES,
  INHOUSE_DUEL_LIVE_STATUSES,
  INHOUSE_DUEL_OPEN_STATUSES,
  INHOUSE_DUEL_RESULT_STATUSES,
  INHOUSE_DUEL_STATUS,
} from "./constants";
import {
  assignDuelSides,
  duelAcceptExpired,
  duelAcceptOpenAfter,
  duelBothAccepted,
  duelRequeueAfterAccept,
  DUEL_NO_BOT_NOTE,
  duelIsLive,
  duelTakesResult,
  duelBotEndedWithoutGame,
  duelEndReason,
  duelGiveUpAtMs,
  duelJoinRefusal,
  duelLadder,
  duelMatchFloorSeconds,
  duelNeverPlayedDue,
  duelPresentCutoff,
  duelQueueExpiresAt,
  duelResultCeilingSeconds,
  duelResultGiveUpDue,
  duelBotMatchWaitOver,
  duelScanCutoffFor,
  duelScanDue,
  duelScanOrder,
  duelWaiterExpired,
  pickDuelOpponent,
  pickDuelPair,
  sharedDuelMatchIds,
  validateDuelMatch,
  type DuelMatchRefusal,
  type DuelResult,
  type DuelWaiter,
} from "./inhouse-duel";
import {
  createDuelBotLobby,
  DUEL_BOT_SPEC_SELECT,
  duelBotGameStatus,
  releaseDuelBotAfterClose,
  retryDuelBotCreate,
} from "./inhouse-duel-bot";
import { runAfterResponse } from "./after-response";
import type { DotaLobbyStatus } from "./dota-lobby";
import { botReportedMatchId, inhouseLobbyBotConfigured } from "./dota-lobby-service";
import {
  canStartOpenDotaFetch,
  fetchOpenDotaMatch,
  fetchRecentMatches,
  openDotaBudgetExpired,
  parseMatchId,
  type OpenDotaFetchOptions,
} from "./dota";
import { effectiveDotaAccountId } from "./dota-account";
import { loadInhouseJoinFacts } from "./inhouse-service";
import { inhouseJoinRefusalBeforeTyping } from "./inhouse-mmr-cap";
import { claimProviderCooldown } from "./settings";
import { logAdminAction } from "./admin-log";
import { publishInhouseRoomChange } from "./inhouse-room-version";
import { invalidateAutomationGateBestEffort } from "./automation-gate-invalidation";
import { raceHook } from "./race-hook";
import { waitBeforeSerializableRetry } from "./serializable-retry";
import { isSerializationConflict, isUniqueViolation } from "./prisma-errors";
import type { RankedInhouse } from "./inhouse-stats";
import type { SessionUser } from "./auth";

export type DuelActionResult = { ok: true } | { ok: false; error: string };

type Tx = Prisma.TransactionClient;

/** Tries in all for a Serializable join or sweep (the 5v5 queue's budget). */
const DUEL_WRITE_ATTEMPTS = 8;

/**
 * The pair claim lost: one of the queue rows it judged was gone (a rival
 * paired them, they left, an admin removed them). Thrown past the claim's
 * delete, so the transaction rolls back; caught outside, where the join
 * retries against a fresh read.
 */
class DuelPairRaceError extends Error {}

const userDotaIdentity = {
  select: {
    id: true,
    name: true,
    steamId: true,
    dotaAccountIdV2: true,
    legacyDotaAccountId: true,
  },
} as const;

const liveDuelOf = (userId: string): Prisma.InhouseDuelWhereInput => ({
  status: { in: INHOUSE_DUEL_LIVE_STATUSES },
  OR: [{ radiantUserId: userId }, { direUserId: userId }],
});

/**
 * Which of these users can't be paired now: in a live 5v5 lobby, or in a
 * live duel. Read inside the pairing's Serializable transaction, so a 5v5
 * formation or a rival pairing that commits after it aborts one side.
 */
async function busyDuelUserIds(tx: Tx, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const in5v5 = await tx.inhouseLobbyPlayer.findMany({
    where: {
      userId: { in: userIds },
      lobby: { status: { in: INHOUSE_ACTIVE_STATUSES } },
    },
    select: { userId: true },
  });
  const inDuel = await tx.inhouseDuel.findMany({
    where: {
      status: { in: INHOUSE_DUEL_LIVE_STATUSES },
      OR: [{ radiantUserId: { in: userIds } }, { direUserId: { in: userIds } }],
    },
    select: { radiantUserId: true, direUserId: true },
  });
  const busy = new Set(in5v5.map((p) => p.userId));
  for (const d of inDuel) {
    busy.add(d.radiantUserId);
    busy.add(d.direUserId);
  }
  return busy;
}

/** Every pairable-looking waiter: present and unexpired (judged again in JS). */
async function readPresentWaiters(tx: Tx, nowMs: number): Promise<DuelWaiter[]> {
  return tx.inhouseDuelQueueEntry.findMany({
    where: {
      expiresAt: { gt: new Date(nowMs) },
      lastSeenAt: { gte: duelPresentCutoff(nowMs) },
    },
    select: {
      id: true,
      userId: true,
      joinedAt: true,
      lastSeenAt: true,
      expiresAt: true,
    },
  });
}

/**
 * The pair claim, inside the pairing transaction: delete exactly the queue
 * rows judged (the waiter's, and the joiner's own when they had one), then
 * create the duel, ACCEPTING: both players get ACCEPT_SECONDS to accept
 * before the bot is asked for a lobby. Any other count throws
 * DuelPairRaceError: the delete may already have removed one row, and a
 * return would commit that.
 */
async function claimPair(
  tx: Tx,
  rowIds: string[],
  firstUserId: string,
  secondUserId: string,
): Promise<string> {
  const claimed = await tx.inhouseDuelQueueEntry.deleteMany({
    where: { id: { in: rowIds } },
  });
  if (claimed.count !== rowIds.length) throw new DuelPairRaceError();
  const sides = assignDuelSides(firstUserId, secondUserId);
  const duel = await tx.inhouseDuel.create({
    data: {
      status: INHOUSE_DUEL_STATUS.ACCEPTING,
      radiantUserId: sides.radiantUserId,
      direUserId: sides.direUserId,
    },
    select: { id: true },
  });
  return duel.id;
}

/** A P2034 or P2002 that a fresh try may not hit, or a lost pair claim. */
function retryableJoinError(error: unknown): boolean {
  return (
    error instanceof DuelPairRaceError ||
    isSerializationConflict(error) ||
    isUniqueViolation(error)
  );
}

/**
 * The MMR cap's refusal for a 1v1 join, or null: the 5v5 queue's own rule
 * before anything is typed (a duel takes no typed MMR), from the same facts.
 */
export async function duelMmrRefusal(userId: string): Promise<string | null> {
  return inhouseJoinRefusalBeforeTyping(await loadInhouseJoinFacts(userId));
}

type JoinOutcome =
  | { kind: "queued" }
  | { kind: "paired"; duelId: string }
  | { kind: "refused"; error: string };

/**
 * "Join 1v1" (refused while no lobby bot can host 1v1s here): pair with the
 * oldest PRESENT waiter who isn't in a live 5v5 lobby or a live duel (the
 * pair then has ACCEPT_SECONDS to accept: acceptDuel), or wait. A repeat join refreshes the row's expiry
 * (and its place, once it had expired) and tries the pairing again.
 *
 * Serializable, retried with a jittered wait: the transaction reads the 1v1
 * queue, the live duels AND the live 5v5 players, so a rival pairing, a
 * leave or a 5v5 formation that crosses it aborts one side. The pair claim
 * is the delete of the judged queue rows with its count checked
 * (claimPair); a lost claim throws and retries.
 */
export async function joinDuelQueue(viewer: SessionUser): Promise<DuelActionResult> {
  // 1v1s are bot only: with no bot that can host here (no connection, or no
  // in-house ticket), a pair could never play. The card shows the same line.
  if (!inhouseLobbyBotConfigured()) return { ok: false, error: DUEL_NO_BOT_NOTE };
  const mmrRefusal = await duelMmrRefusal(viewer.id);
  if (mmrRefusal) return { ok: false, error: mmrRefusal };

  let outcome: JoinOutcome | null = null;
  for (let attempt = 0; attempt < DUEL_WRITE_ATTEMPTS; attempt += 1) {
    try {
      outcome = await prisma.$transaction(
        async (tx): Promise<JoinOutcome> => {
          const nowMs = Date.now();
          const in5v5 = await tx.inhouseLobbyPlayer.findFirst({
            where: {
              userId: viewer.id,
              lobby: { status: { in: INHOUSE_ACTIVE_STATUSES } },
            },
            select: { id: true },
          });
          const inDuel = await tx.inhouseDuel.findFirst({
            where: liveDuelOf(viewer.id),
            select: { id: true },
          });
          const refusal = duelJoinRefusal({
            mmrRefusal: null,
            in5v5: !!in5v5,
            inDuel: !!inDuel,
          });
          // Nothing is written yet, so a refusal may return.
          if (refusal) return { kind: "refused", error: refusal };

          const own = await tx.inhouseDuelQueueEntry.findUnique({
            where: { userId: viewer.id },
            select: {
              id: true,
              userId: true,
              joinedAt: true,
              lastSeenAt: true,
              expiresAt: true,
            },
          });
          const waiters = await readPresentWaiters(tx, nowMs);
          const busy = await busyDuelUserIds(
            tx,
            waiters.map((w) => w.userId).filter((id) => id !== viewer.id),
          );
          const opponent = pickDuelOpponent(waiters, viewer.id, busy, nowMs);
          if (opponent) {
            // Seam: between the read that judged the waiter and the claim.
            await raceHook("inhouseDuel.joinDuelQueue.beforePairClaim");
            const rowIds = own ? [opponent.id, own.id] : [opponent.id];
            const duelId = await claimPair(tx, rowIds, viewer.id, opponent.userId);
            return { kind: "paired", duelId };
          }
          // Wait. A repeat join keeps its place unless its row had expired
          // (the worker just hadn't deleted it yet): then it queues anew.
          const now = new Date(nowMs);
          const joinedAt =
            own && !duelWaiterExpired(own, nowMs) ? own.joinedAt : now;
          const expiresAt = duelQueueExpiresAt(nowMs);
          await tx.inhouseDuelQueueEntry.upsert({
            where: { userId: viewer.id },
            create: { userId: viewer.id, joinedAt: now, lastSeenAt: now, expiresAt },
            update: { joinedAt, lastSeenAt: now, expiresAt },
          });
          return { kind: "queued" };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      break;
    } catch (error) {
      if (!retryableJoinError(error)) throw error;
      if (attempt + 1 < DUEL_WRITE_ATTEMPTS) {
        await waitBeforeSerializableRetry(attempt + 1);
      }
    }
  }
  if (outcome === null) {
    // Out of tries: a fresh read tells "a rival paired you" (fine) from
    // ordinary contention.
    const [inDuel, queued] = await Promise.all([
      prisma.inhouseDuel.findFirst({ where: liveDuelOf(viewer.id), select: { id: true } }),
      prisma.inhouseDuelQueueEntry.findUnique({
        where: { userId: viewer.id },
        select: { id: true },
      }),
    ]);
    if (!inDuel && !queued) {
      return { ok: false, error: "The 1v1 queue changed — please try joining again" };
    }
    outcome = { kind: "queued" };
  }
  if (outcome.kind === "refused") return { ok: false, error: outcome.error };
  // Rule P: the queue row or the new duel is committed. A new pair waits for
  // both accepts (acceptDuel asks the bot for its lobby); the worker's
  // accept clock needs a wake, which the route's gate expiry gives it.
  await publishInhouseRoomChange();
  return { ok: true };
}

/** "Leave 1v1". A player already paired is told so, not silently "left". */
export async function leaveDuelQueue(viewer: SessionUser): Promise<DuelActionResult> {
  const left = await prisma.inhouseDuelQueueEntry.deleteMany({
    where: { userId: viewer.id },
  });
  if (left.count > 0) {
    // Rule P: the row is gone.
    await publishInhouseRoomChange();
    return { ok: true };
  }
  const paired = await prisma.inhouseDuel.findFirst({
    where: liveDuelOf(viewer.id),
    select: { id: true },
  });
  if (paired) {
    return {
      ok: false,
      error: "You've been paired for a 1v1 already. Decline or call it off from the 1v1 card.",
    };
  }
  return { ok: true };
}

/**
 * Admin: take one player out of the 1v1 queue. The leave they could make,
 * made for them: a `deleteMany` and its count, so their own leave or the
 * pairing that took them first gets a refusal, not a crash. Not a ban.
 * Logged only when it removed someone.
 */
export async function removeFromDuelQueue(
  viewer: SessionUser,
  userId: string,
): Promise<DuelActionResult> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  if (!userId) return { ok: false, error: "Choose a player to remove" };
  const queued = await prisma.inhouseDuelQueueEntry.findUnique({
    where: { userId },
    select: { user: { select: { name: true } } },
  });
  const removed = await prisma.inhouseDuelQueueEntry.deleteMany({ where: { userId } });
  if (removed.count === 0) {
    return {
      ok: false,
      error: "They're not in the 1v1 queue any more: they left, or a 1v1 took them.",
    };
  }
  // Rule P: the row is gone.
  await publishInhouseRoomChange();
  await logAdminAction({
    action: "removeFromDuelQueue",
    summary: `Removed ${queued?.user.name ?? "a player"} from the 1v1 queue`,
  });
  return { ok: true };
}

/**
 * Presence for the viewer's 1v1 queue row, written at most once per
 * HEARTBEAT_SECONDS (the 5v5 queue's touchQueueHeartbeat). Never renews the
 * row's expiry. Returns how many rows it wrote (0 or 1): the WHERE is the one
 * enforcement point. The caller (the room poll) publishes when it wrote.
 */
export async function touchDuelQueueHeartbeat(viewerId: string): Promise<number> {
  const staleBefore = new Date(Date.now() - INHOUSE_DUEL.HEARTBEAT_SECONDS * 1000);
  const touched = await prisma.inhouseDuelQueueEntry.updateMany({
    where: { userId: viewerId, lastSeenAt: { lt: staleBefore } },
    data: { lastSeenAt: new Date() },
  });
  return touched.count;
}

type AcceptingDuel = {
  id: string;
  createdAt: Date;
  radiantUserId: string;
  direUserId: string;
  radiantAcceptedAt: Date | null;
  direAcceptedAt: Date | null;
};

const acceptingDuelSelect = {
  id: true,
  createdAt: true,
  radiantUserId: true,
  direUserId: true,
  radiantAcceptedAt: true,
  direAcceptedAt: true,
} as const;

/**
 * Put players back at the front of the 1v1 queue after their pair ended
 * unaccepted: `joinedAt` is the ended duel's pairing, ahead of anyone who
 * joined since, and `lastSeenAt` when they were last known to be there
 * (duelRequeueAfterAccept). Inside the claim's transaction and past its
 * write, so a failure throws and rolls the claim back with it.
 */
async function requeueAtFront(
  tx: Tx,
  duel: AcceptingDuel,
  declinedBy: string | null,
  nowMs: number,
): Promise<void> {
  const expiresAt = duelQueueExpiresAt(nowMs);
  for (const p of duelRequeueAfterAccept(duel, declinedBy)) {
    await tx.inhouseDuelQueueEntry.upsert({
      where: { userId: p.userId },
      create: {
        userId: p.userId,
        joinedAt: duel.createdAt,
        lastSeenAt: p.seenAt,
        expiresAt,
      },
      update: { joinedAt: duel.createdAt, lastSeenAt: p.seenAt, expiresAt },
    });
  }
}

/**
 * Both players accepted: ACCEPTING becomes READY, and only then is the bot
 * asked for the lobby (after the response, never inside a transaction). The
 * claim is ACCEPTING with both stamps, so whichever accept lands second
 * makes it (an accept and its rival's can't both miss: each writes its own
 * stamp before trying), and the worker's settle step catches a promote that
 * never ran. Returns whether this call made it READY.
 */
async function promoteAcceptedDuel(duelId: string): Promise<boolean> {
  await raceHook("inhouseDuel.promoteAcceptedDuel.beforeClaim");
  const promoted = await prisma.inhouseDuel.updateMany({
    where: {
      id: duelId,
      status: INHOUSE_DUEL_STATUS.ACCEPTING,
      radiantAcceptedAt: { not: null },
      direAcceptedAt: { not: null },
    },
    data: { status: INHOUSE_DUEL_STATUS.READY },
  });
  if (promoted.count === 0) return false;
  // Rule P, then the gate: a READY duel has the worker's bot reads and the
  // lobby create retry.
  await publishInhouseRoomChange();
  invalidateAutomationGateBestEffort();
  await runAfterResponse(() => createDuelBotLobby(duelId));
  return true;
}

const NO_DUEL_TO_ACCEPT = "There's no 1v1 waiting for your answer";

/**
 * "Accept 1v1": stamp the viewer's side of their ACCEPTING duel, in time
 * (paired after duelAcceptOpenAfter), then try to make it READY. Only the
 * two players; an admin can't accept for anyone. A second press, or a duel
 * already through, is fine.
 */
export async function acceptDuel(
  viewer: SessionUser,
  duelId: string,
): Promise<DuelActionResult> {
  if (!duelId) return { ok: false, error: NO_DUEL_TO_ACCEPT };
  const duel = await prisma.inhouseDuel.findFirst({
    where: { id: duelId, status: INHOUSE_DUEL_STATUS.ACCEPTING },
    select: acceptingDuelSelect,
  });
  if (!duel || (duel.radiantUserId !== viewer.id && duel.direUserId !== viewer.id)) {
    return acceptRefusal(viewer, duelId);
  }
  const nowMs = Date.now();
  const acceptedAt = new Date(nowMs);
  const openAfter = duelAcceptOpenAfter(nowMs);
  // Seam: a decline, the expiry or an admin cancel landing after the read.
  // The sides never change while ACCEPTING (only a result rewrites them),
  // so the read's side is the claim's.
  await raceHook("inhouseDuel.acceptDuel.beforeClaim");
  const claim =
    duel.radiantUserId === viewer.id
      ? await prisma.inhouseDuel.updateMany({
          where: {
            id: duel.id,
            status: INHOUSE_DUEL_STATUS.ACCEPTING,
            radiantAcceptedAt: null,
            createdAt: { gt: openAfter },
          },
          data: { radiantAcceptedAt: acceptedAt },
        })
      : await prisma.inhouseDuel.updateMany({
          where: {
            id: duel.id,
            status: INHOUSE_DUEL_STATUS.ACCEPTING,
            direAcceptedAt: null,
            createdAt: { gt: openAfter },
          },
          data: { direAcceptedAt: acceptedAt },
        });
  if (claim.count === 0) return acceptRefusal(viewer, duelId);
  // Rule P: the stamp is committed (the opponent's card shows it).
  await publishInhouseRoomChange();
  await promoteAcceptedDuel(duel.id);
  return { ok: true };
}

/** Why an accept changed nothing: already accepted or through (fine), or the words. */
async function acceptRefusal(viewer: SessionUser, duelId: string): Promise<DuelActionResult> {
  const current = await prisma.inhouseDuel.findUnique({
    where: { id: duelId },
    select: { ...acceptingDuelSelect, status: true },
  });
  if (!current || (current.radiantUserId !== viewer.id && current.direUserId !== viewer.id)) {
    return { ok: false, error: NO_DUEL_TO_ACCEPT };
  }
  if (current.status === INHOUSE_DUEL_STATUS.ACCEPTING) {
    const mine =
      current.radiantUserId === viewer.id
        ? current.radiantAcceptedAt
        : current.direAcceptedAt;
    if (mine !== null) return { ok: true };
    if (duelAcceptExpired(current, Date.now())) {
      return { ok: false, error: "Too late: the time to accept this 1v1 ran out." };
    }
    return { ok: false, error: "The 1v1 changed — please try again." };
  }
  if (current.status === INHOUSE_DUEL_STATUS.CANCELLED) {
    return { ok: false, error: "That 1v1 was called off before it started." };
  }
  // READY or past it: both accepted.
  return { ok: true };
}

/**
 * "Decline": either player ends their ACCEPTING duel; the other goes back to
 * the front of the 1v1 queue (requeueAtFront), the decliner leaves it. The
 * claim is ACCEPTING, so it loses to the promote (both accepted first), the
 * expiry and an admin cancel.
 */
export async function declineDuel(
  viewer: SessionUser,
  duelId: string,
): Promise<DuelActionResult> {
  if (!duelId) return { ok: false, error: NO_DUEL_TO_ACCEPT };
  const duel = await prisma.inhouseDuel.findFirst({
    where: { id: duelId, status: INHOUSE_DUEL_STATUS.ACCEPTING },
    select: acceptingDuelSelect,
  });
  if (!duel || (duel.radiantUserId !== viewer.id && duel.direUserId !== viewer.id)) {
    return { ok: false, error: NO_DUEL_TO_ACCEPT };
  }
  // Seam: both accepting, the expiry or an admin cancel landing after the read.
  await raceHook("inhouseDuel.declineDuel.beforeClaim");
  const endReason = duelEndReason.declined(viewer.name);
  const nowMs = Date.now();
  const completedAt = new Date(nowMs);
  const declined = await prisma.$transaction(async (tx) => {
    const claim = await tx.inhouseDuel.updateMany({
      where: { id: duel.id, status: INHOUSE_DUEL_STATUS.ACCEPTING },
      data: { status: INHOUSE_DUEL_STATUS.CANCELLED, endReason, completedAt },
    });
    // The last legal return: nothing is written yet.
    if (claim.count === 0) return false;
    // The stamps are frozen now (an accept claims ACCEPTING): read them fresh.
    const closed = await tx.inhouseDuel.findUniqueOrThrow({
      where: { id: duel.id },
      select: acceptingDuelSelect,
    });
    await requeueAtFront(tx, closed, viewer.id, nowMs);
    return true;
  });
  if (!declined) {
    return { ok: false, error: "That 1v1 already started or ended, so it can't be declined" };
  }
  await publishInhouseRoomChange();
  return { ok: true };
}

/**
 * The worker's accept clock, every pass: an ACCEPTING duel both players
 * accepted becomes READY (a promote that never ran after the second
 * accept), and one whose time ran out unaccepted is CANCELLED, whoever
 * accepted going back to the front of the 1v1 queue and whoever didn't
 * leaving it. Each is a claim on the state judged. Returns how many it
 * readied and how many it closed.
 */
export async function settleDuelAccepts(
  nowMs = Date.now(),
): Promise<{ readied: number; expired: number }> {
  const accepting = await prisma.inhouseDuel.findMany({
    where: { status: INHOUSE_DUEL_STATUS.ACCEPTING },
    select: {
      ...acceptingDuelSelect,
      status: true,
      radiantUser: { select: { name: true } },
      direUser: { select: { name: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  let readied = 0;
  let expired = 0;
  for (const d of accepting) {
    if (duelBothAccepted(d)) {
      if (await promoteAcceptedDuel(d.id)) readied += 1;
      continue;
    }
    if (!duelAcceptExpired(d, nowMs)) continue;
    const missing = [
      d.radiantAcceptedAt === null ? d.radiantUser.name : null,
      d.direAcceptedAt === null ? d.direUser.name : null,
    ].filter((n): n is string => n !== null);
    const endReason = duelEndReason.notAccepted(missing);
    const completedAt = new Date(nowMs);
    // Seam: a last accept or a decline landing after the read.
    await raceHook("inhouseDuel.settleDuelAccepts.beforeExpireClaim");
    const closed = await prisma.$transaction(async (tx) => {
      const claim = await tx.inhouseDuel.updateMany({
        where: {
          id: d.id,
          status: INHOUSE_DUEL_STATUS.ACCEPTING,
          OR: [{ radiantAcceptedAt: null }, { direAcceptedAt: null }],
        },
        data: { status: INHOUSE_DUEL_STATUS.CANCELLED, endReason, completedAt },
      });
      // The last legal return: nothing is written yet.
      if (claim.count === 0) return false;
      const frozen = await tx.inhouseDuel.findUniqueOrThrow({
        where: { id: d.id },
        select: acceptingDuelSelect,
      });
      await requeueAtFront(tx, frozen, null, nowMs);
      return true;
    });
    if (closed) {
      expired += 1;
      await publishInhouseRoomChange();
    }
  }
  return { readied, expired };
}

type DuelForAction = {
  id: string;
  status: string;
  radiantUserId: string;
  direUserId: string;
};

async function findDuel(
  duelId: string | null | undefined,
  statuses: readonly string[],
): Promise<DuelForAction | null> {
  if (!duelId) return null;
  return prisma.inhouseDuel.findFirst({
    where: { id: duelId, status: { in: [...statuses] } },
    select: { id: true, status: true, radiantUserId: true, direUserId: true },
  });
}

const playsIn = (duel: DuelForAction, userId: string) =>
  duel.radiantUserId === userId || duel.direUserId === userId;

const NO_DUEL_TO_FINISH = "There's no 1v1 being played to mark over";

/**
 * "1v1 over": the fallback for a bot game whose end the bot missed. Only a
 * PLAYING duel (the bot saw it launch) moves to AWAITING_RESULT; the result
 * still records itself from OpenDota. Either player or an admin.
 */
export async function finishDuel(
  viewer: SessionUser,
  duelId: string,
): Promise<DuelActionResult> {
  const duel = await findDuel(duelId, INHOUSE_DUEL_RESULT_STATUSES);
  if (!duel) return { ok: false, error: NO_DUEL_TO_FINISH };
  if (!playsIn(duel, viewer.id) && viewer.role !== "ADMIN") {
    return { ok: false, error: "Only the two players can mark their 1v1 over" };
  }
  if (duel.status === INHOUSE_DUEL_STATUS.AWAITING_RESULT) return { ok: true };
  if (duel.status !== INHOUSE_DUEL_STATUS.PLAYING) {
    return {
      ok: false,
      error: "This 1v1 hasn't started yet: the lobby bot starts it.",
    };
  }
  // Seam: a result, a cancel or the bot's over read landing first.
  await raceHook("inhouseDuel.finishDuel.beforeClaim");
  const finishedAt = new Date();
  const finished = await prisma.inhouseDuel.updateMany({
    where: { id: duel.id, status: INHOUSE_DUEL_STATUS.PLAYING },
    data: { status: INHOUSE_DUEL_STATUS.AWAITING_RESULT, finishedAt },
  });
  if (finished.count === 0) {
    const current = await prisma.inhouseDuel.findUnique({
      where: { id: duel.id },
      select: { status: true },
    });
    return current?.status === INHOUSE_DUEL_STATUS.CANCELLED
      ? { ok: false, error: "That 1v1 was cancelled" }
      : { ok: true };
  }
  // Rule P, then let the bot go.
  await publishInhouseRoomChange();
  releaseDuelBotAfterClose(duel.id);
  return { ok: true };
}

/**
 * "Call it off": either player cancels a READY duel whose game never
 * started. The claim is READY with no startedAt, so it loses to the bot's
 * launch read, a result and an admin cancel.
 */
export async function callOffDuel(
  viewer: SessionUser,
  duelId: string,
): Promise<DuelActionResult> {
  const duel = await findDuel(duelId, INHOUSE_DUEL_LIVE_STATUSES);
  if (!duel || !playsIn(duel, viewer.id)) {
    return { ok: false, error: "There's no 1v1 of yours to call off" };
  }
  await raceHook("inhouseDuel.callOffDuel.beforeClaim");
  const endReason = duelEndReason.calledOff(viewer.name);
  const completedAt = new Date();
  const called = await prisma.inhouseDuel.updateMany({
    where: { id: duel.id, status: INHOUSE_DUEL_STATUS.READY, startedAt: null },
    data: { status: INHOUSE_DUEL_STATUS.CANCELLED, endReason, completedAt },
  });
  if (called.count === 0) {
    return {
      ok: false,
      error: "That 1v1 already started or ended, so it can't be called off",
    };
  }
  await publishInhouseRoomChange();
  releaseDuelBotAfterClose(duel.id);
  return { ok: true };
}

/**
 * Admin: cancel any open duel (ACCEPTING, READY, PLAYING or
 * AWAITING_RESULT). Loses to a result that lands first. Logged after the
 * claim, so a losing rival logs nothing. Nobody is requeued.
 */
export async function cancelDuel(
  viewer: SessionUser,
  duelId: string,
): Promise<DuelActionResult> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  const duel = await prisma.inhouseDuel.findFirst({
    where: { id: duelId, status: { in: INHOUSE_DUEL_OPEN_STATUSES } },
    select: {
      id: true,
      radiantUser: { select: { name: true } },
      direUser: { select: { name: true } },
    },
  });
  if (!duel) {
    return { ok: false, error: "That 1v1 is already over (a result or a cancel)" };
  }
  await raceHook("inhouseDuel.cancelDuel.beforeClaim");
  const endReason = duelEndReason.adminCancel(viewer.name);
  const completedAt = new Date();
  const cancelled = await prisma.inhouseDuel.updateMany({
    where: { id: duel.id, status: { in: INHOUSE_DUEL_OPEN_STATUSES } },
    data: { status: INHOUSE_DUEL_STATUS.CANCELLED, endReason, completedAt },
  });
  if (cancelled.count === 0) {
    return { ok: false, error: "That 1v1 just ended: its result landed or it was cancelled" };
  }
  await publishInhouseRoomChange();
  releaseDuelBotAfterClose(duel.id);
  await logAdminAction({
    action: "cancelDuel",
    summary: `Cancelled the 1v1 ${duel.radiantUser.name} vs ${duel.direUser.name}`,
  });
  return { ok: true };
}

/**
 * Admin: void a recorded 1v1 result (the wrong game was picked up). The
 * duel goes CANCELLED with its result cleared, so the ladder (derived from
 * COMPLETED duels) recomputes without it. The AdminAction commits with the
 * claim: the claim nulls the match id, so its row is the one record of it.
 */
export async function voidDuelResult(
  viewer: SessionUser,
  duelId: string,
): Promise<DuelActionResult> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  const duel = await prisma.inhouseDuel.findFirst({
    where: { id: duelId, status: INHOUSE_DUEL_STATUS.COMPLETED },
    select: {
      id: true,
      dotaMatchId: true,
      radiantUser: { select: { name: true } },
      direUser: { select: { name: true } },
    },
  });
  if (!duel) {
    return { ok: false, error: "That 1v1 isn't a recorded result — it may already be voided" };
  }
  await raceHook("inhouseDuel.voidDuelResult.beforeClaim");
  const endReason = duelEndReason.voided(viewer.name, duel.dotaMatchId);
  const summary = `Voided the 1v1 result ${duel.radiantUser.name} vs ${duel.direUser.name}${
    duel.dotaMatchId ? ` (match ${duel.dotaMatchId})` : ""
  }`;
  // The void is when it closed now: its players are told (lastCancelled).
  const completedAt = new Date();
  const voided = await prisma.$transaction(async (tx) => {
    const claim = await tx.inhouseDuel.updateMany({
      // COMPLETED is the state judged: nothing re-completes a duel, so a
      // rival void that lands first leaves this claim nothing to match.
      where: { id: duel.id, status: INHOUSE_DUEL_STATUS.COMPLETED },
      data: {
        status: INHOUSE_DUEL_STATUS.CANCELLED,
        endReason,
        completedAt,
        winnerTeam: null,
        dotaMatchId: null,
        durationSecs: null,
        radiantHeroId: null,
        direHeroId: null,
      },
    });
    // The last legal return: nothing is written yet.
    if (claim.count === 0) return false;
    await tx.adminAction.create({
      data: {
        actorId: viewer.id,
        actorName: viewer.name || "(unknown)",
        action: "voidDuelResult",
        summary: summary.slice(0, 500),
      },
    });
    return true;
  });
  if (!voided) return { ok: false, error: "That 1v1 result was already voided" };
  await publishInhouseRoomChange();
  return { ok: true };
}

/**
 * The lobby bot saw this duel's game launch: READY becomes PLAYING, stamping
 * `startedAt` and the bot's match id. Guarded on READY, so a late read never
 * resurrects a closed duel. A duel already PLAYING with no stored match id
 * gets the id alone (also guarded). Returns whether it moved the duel.
 */
export async function markDuelStartedFromBot(
  duelId: string,
  botMatchId: string | null,
): Promise<boolean> {
  const startedAt = new Date();
  const started = await prisma.inhouseDuel.updateMany({
    where: { id: duelId, status: INHOUSE_DUEL_STATUS.READY },
    data: { status: INHOUSE_DUEL_STATUS.PLAYING, startedAt, botMatchId },
  });
  if (started.count > 0) {
    await publishInhouseRoomChange();
    invalidateAutomationGateBestEffort();
    return true;
  }
  if (botMatchId) {
    const stamped = await prisma.inhouseDuel.updateMany({
      where: {
        id: duelId,
        status: { in: INHOUSE_DUEL_RESULT_STATUSES },
        botMatchId: null,
      },
      data: { botMatchId },
    });
    if (stamped.count > 0) await publishInhouseRoomChange();
  }
  return false;
}

/**
 * The lobby bot saw Dota's postgame for this duel: a live duel moves to
 * AWAITING_RESULT (finishDuel's claim, from READY too, should the bot see
 * the launch and the end in one read), and the bot is let go. The result
 * still records itself from OpenDota. Returns whether it moved the duel.
 */
export async function endDuelFromBot(duelId: string): Promise<boolean> {
  await raceHook("inhouseDuel.endDuelFromBot.beforeClaim");
  const finishedAt = new Date();
  const ended = await prisma.inhouseDuel.updateMany({
    where: { id: duelId, status: { in: INHOUSE_DUEL_BOT_STATUSES } },
    data: { status: INHOUSE_DUEL_STATUS.AWAITING_RESULT, finishedAt },
  });
  if (ended.count === 0) return false;
  await publishInhouseRoomChange();
  invalidateAutomationGateBestEffort();
  releaseDuelBotAfterClose(duelId);
  return true;
}

/**
 * The lobby bot's game for this duel ended with no result to wait for (a
 * failed launch, a game Dota didn't score, a lobby released with no match):
 * the duel is CANCELLED with `why` in its reason, and the bot is let go.
 * Which bot reads mean this: duelBotEndedWithoutGame. Returns whether it closed it.
 */
export async function cancelDuelFromBot(duelId: string, why: string): Promise<boolean> {
  const endReason = duelEndReason.botCancelled(why);
  const completedAt = new Date();
  const cancelled = await prisma.inhouseDuel.updateMany({
    where: { id: duelId, status: { in: INHOUSE_DUEL_RESULT_STATUSES } },
    data: { status: INHOUSE_DUEL_STATUS.CANCELLED, endReason, completedAt },
  });
  if (cancelled.count === 0) return false;
  await publishInhouseRoomChange();
  invalidateAutomationGateBestEffort();
  releaseDuelBotAfterClose(duelId);
  return true;
}

export type DuelApplyOutcome = "recorded" | "closed" | "duplicate";

/** The match is already another duel's result (InhouseDuel.dotaMatchId). */
function isDuplicateDuelMatch(e: unknown): boolean {
  const err = e as { code?: string; meta?: { target?: unknown } };
  return (
    err.code === "P2002" &&
    JSON.stringify(err.meta?.target ?? "").includes("dotaMatchId")
  );
}

/**
 * Write a checked result onto the duel. Guarded on the result statuses, so
 * a cancel racing the OpenDota fetch wins and a closed duel never turns
 * COMPLETED; the unique dotaMatchId refuses one match for two duels. The
 * sides are rewritten to the match's own, so winnerTeam and the heroes line
 * up with them.
 */
export async function applyDuelResult(
  duelId: string,
  r: DuelResult,
): Promise<DuelApplyOutcome> {
  // Hoisted so the claim's data stays a flat literal (scripts/mutation-guard).
  const completedAt = new Date();
  const matchStartTime =
    Number.isFinite(r.startTime) && r.startTime > 0
      ? new Date(r.startTime * 1000)
      : null;
  await raceHook("inhouseDuel.applyDuelResult.beforeClaim");
  let claimed: number;
  try {
    const claim = await prisma.inhouseDuel.updateMany({
      where: { id: duelId, status: { in: INHOUSE_DUEL_RESULT_STATUSES } },
      data: {
        status: INHOUSE_DUEL_STATUS.COMPLETED,
        completedAt,
        radiantUserId: r.radiantUserId,
        direUserId: r.direUserId,
        winnerTeam: r.winnerTeam,
        dotaMatchId: r.dotaMatchId,
        durationSecs: r.durationSecs,
        radiantHeroId: r.radiantHeroId,
        direHeroId: r.direHeroId,
        matchStartTime,
      },
    });
    claimed = claim.count;
  } catch (e) {
    if (isDuplicateDuelMatch(e)) return "duplicate";
    throw e;
  }
  if (claimed === 0) return "closed";
  await publishInhouseRoomChange();
  releaseDuelBotAfterClose(duelId);
  return "recorded";
}

type DuelWithPlayers = {
  id: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  botMatchId: string | null;
  radiantUser: {
    id: string;
    name: string;
    steamId: string;
    dotaAccountIdV2: number | null;
    legacyDotaAccountId: number | null;
  };
  direUser: DuelWithPlayers["radiantUser"];
};

const duelWithPlayersSelect = {
  id: true,
  status: true,
  createdAt: true,
  startedAt: true,
  botMatchId: true,
  radiantUser: userDotaIdentity,
  direUser: userDotaIdentity,
} as const;

/**
 * The result ceiling for this duel (duelResultCeilingSeconds): when the
 * earliest later 1v1 with either of its players was paired, or null.
 */
async function duelCeilingSeconds(duel: DuelWithPlayers): Promise<number | null> {
  const ids = [duel.radiantUser.id, duel.direUser.id];
  const next = await prisma.inhouseDuel.findFirst({
    where: {
      id: { not: duel.id },
      createdAt: { gt: duel.createdAt },
      OR: [{ radiantUserId: { in: ids } }, { direUserId: { in: ids } }],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { createdAt: true },
  });
  return duelResultCeilingSeconds(next ? next.createdAt.getTime() : null);
}

function duelMatchPlayers(duel: DuelWithPlayers) {
  return [duel.radiantUser, duel.direUser].map((u) => ({
    userId: u.id,
    accountId: effectiveDotaAccountId(u),
  }));
}

const MATCH_REFUSAL_COPY: Record<DuelMatchRefusal, string> = {
  "wrong-mode": "That match isn't a 1v1 Solo Mid game — check the ID.",
  "not-two-players": "That match doesn't have exactly two players — check the ID.",
  "before-duel": "That match started before this 1v1 was paired — wrong game?",
  "after-next-duel":
    "That match started after a later 1v1 of these players was paired — it belongs to that one.",
  "not-these-players":
    "Couldn't find both of this 1v1's players in that match (check the ID, and that both Dota accounts are linked).",
  "same-side": "Both players were on the same side in that match — wrong game?",
  unfinished: "That match isn't finished on OpenDota yet — try again in a few minutes.",
};

const DUEL_MATCH_ALREADY_RECORDED = "That Dota match is already recorded for another 1v1.";
const DUEL_CLOSED_WHILE_FETCHING =
  "The 1v1 closed while we fetched — its result is already in, or it was cancelled.";

/** "Record by match ID": a player (or admin) pastes the 1v1's Dota match. */
export async function recordDuelMatch(
  viewer: SessionUser,
  input: string,
  duelId: string,
): Promise<DuelActionResult> {
  const matchId = parseMatchId(input);
  if (!matchId) return { ok: false, error: "Enter a valid Dota match ID or link" };
  const duel = await prisma.inhouseDuel.findFirst({
    where: { id: duelId, status: { in: INHOUSE_DUEL_RESULT_STATUSES } },
    select: duelWithPlayersSelect,
  });
  if (!duel) return { ok: false, error: "There's no 1v1 to record right now" };
  const isPlayer =
    duel.radiantUser.id === viewer.id || duel.direUser.id === viewer.id;
  if (!isPlayer && viewer.role !== "ADMIN") {
    return { ok: false, error: "Only the two players can record their 1v1" };
  }
  const providerClaim = await claimProviderCooldown(
    "open-dota-match-import",
    viewer.id,
    `duel:${duel.id}`,
  );
  if (providerClaim === "cooldown") {
    return {
      ok: false,
      error:
        "A Dota match ID was checked for this 1v1 recently — wait about a minute before trying another ID",
    };
  }
  if (providerClaim === "unavailable") {
    return {
      ok: false,
      error: "Couldn't safely start the OpenDota lookup — wait a minute and try again",
    };
  }
  const od = await fetchOpenDotaMatch(matchId);
  if (!od) {
    return {
      ok: false,
      error: "Couldn't fetch that match from OpenDota (is the ID right and public?)",
    };
  }
  const checked = validateDuelMatch(od, {
    createdAtMs: duel.createdAt.getTime(),
    players: duelMatchPlayers(duel),
    ceilingSeconds: await duelCeilingSeconds(duel),
  });
  if (!checked.ok) return { ok: false, error: MATCH_REFUSAL_COPY[checked.reason] };
  const outcome = await applyDuelResult(duel.id, checked.result);
  if (outcome === "recorded") return { ok: true };
  return {
    ok: false,
    error:
      outcome === "duplicate" ? DUEL_MATCH_ALREADY_RECORDED : DUEL_CLOSED_WHILE_FETCHING,
  };
}

/**
 * Find this duel's game on OpenDota: the bot's reported match id first
 * (checked like a pasted id), then a match in BOTH players' recent matches
 * in 1v1 Solo Mid between the pairing and a later 1v1's pairing
 * (sharedDuelMatchIds, oldest first), each candidate fetched and checked
 * with validateDuelMatch. While OpenDota lacks the bot's match, the
 * histories are skipped until BOT_MATCH_WAIT_MINUTES after the game started
 * (duelBotMatchWaitOver): they can't hold an unpublished game either.
 * `unreachable`: a history read failed, which is not the same as "nothing
 * there", and the caller stops its pass.
 */
async function lookUpDuelGame(
  duel: DuelWithPlayers,
  nowMs: number,
  options: OpenDotaFetchOptions,
): Promise<{ found: DuelResult | null; deadlineReached: boolean; unreachable: boolean }> {
  const expired = () => !canStartOpenDotaFetch(options) || openDotaBudgetExpired(options);
  const ceilingSeconds = await duelCeilingSeconds(duel);
  const check = (od: Awaited<ReturnType<typeof fetchOpenDotaMatch>>) => {
    if (!od) return null;
    const checked = validateDuelMatch(od, {
      createdAtMs: duel.createdAt.getTime(),
      players: duelMatchPlayers(duel),
      ceilingSeconds,
    });
    return checked.ok ? checked.result : null;
  };
  if (duel.botMatchId) {
    const od = await fetchOpenDotaMatch(duel.botMatchId, options);
    const found = check(od);
    if (found) return { found, deadlineReached: false, unreachable: false };
    if (expired()) return { found: null, deadlineReached: true, unreachable: false };
    // Not on OpenDota yet: one lookup per scan, not two histories, until the
    // wait is over. A match that is there but isn't this duel's falls through.
    if (!od && !duelBotMatchWaitOver(duel, nowMs)) {
      return { found: null, deadlineReached: false, unreachable: false };
    }
  }
  const accounts = duelMatchPlayers(duel).map((p) => p.accountId);
  if (accounts.some((a) => a == null)) {
    return { found: null, deadlineReached: false, unreachable: false };
  }
  const lists = await Promise.all(
    (accounts as number[]).map((a) =>
      fetchRecentMatches(a, INHOUSE_DUEL.SCAN_RECENT_MATCHES, options),
    ),
  );
  if (expired()) return { found: null, deadlineReached: true, unreachable: false };
  if (lists.some((l) => l === null)) {
    return { found: null, deadlineReached: false, unreachable: true };
  }
  const [a, b] = lists as NonNullable<(typeof lists)[number]>[];
  const candidates = sharedDuelMatchIds(
    a,
    b,
    duelMatchFloorSeconds(duel.createdAt.getTime()),
    ceilingSeconds,
  ).slice(0, 2);
  for (const id of candidates) {
    const found = check(await fetchOpenDotaMatch(String(id), options));
    if (found) return { found, deadlineReached: false, unreachable: false };
    if (expired()) return { found: null, deadlineReached: true, unreachable: false };
  }
  return { found: null, deadlineReached: false, unreachable: false };
}

/**
 * The worker's result scan: duels whose game started and a result can land
 * on (PLAYING, AWAITING_RESULT; never a READY one, which has no game, nor a
 * closed one), from SCAN_AFTER_MINUTES after pairing, each at most once per
 * its scan interval (duelScanIntervalSeconds: SCAN_EVERY_SECONDS, growing
 * with the game's age to SCAN_MAX_SECONDS), at most SCAN_PER_PASS per pass,
 * stalest checkedAt first. Each attempt claims `checkedAt` so two workers
 * never scan one duel; an attempt cut off by the deadline restores exactly
 * the claim it stamped. OpenDota unreachable stops the pass: the next duel's
 * reads would fail the same way.
 */
export async function maybeAutoDetectDuelResults(
  options: OpenDotaFetchOptions = {},
): Promise<{ recorded: boolean; deadlineReached: boolean }> {
  let recorded = false;
  if (!canStartOpenDotaFetch(options)) return { recorded, deadlineReached: true };
  const nowMs = Date.now();
  const open = await prisma.inhouseDuel.findMany({
    where: { status: { in: INHOUSE_DUEL_RESULT_STATUSES } },
    select: { id: true, status: true, createdAt: true, startedAt: true, checkedAt: true },
  });
  const due = duelScanOrder(open.filter((d) => duelScanDue(d, nowMs))).slice(
    0,
    INHOUSE_DUEL.SCAN_PER_PASS,
  );
  for (const d of due) {
    if (!canStartOpenDotaFetch(options)) return { recorded, deadlineReached: true };
    const checkedAt = new Date(nowMs);
    const cutoff = duelScanCutoffFor(d, nowMs);
    // Seam: a cancel, a result or another worker's claim landing after the
    // read that judged this duel due.
    await raceHook("inhouseDuel.autoDetect.beforeClaim");
    const claim = await prisma.inhouseDuel.updateMany({
      where: {
        id: d.id,
        status: { in: INHOUSE_DUEL_RESULT_STATUSES },
        OR: [{ checkedAt: null }, { checkedAt: { lte: cutoff } }],
      },
      data: { checkedAt },
    });
    if (claim.count === 0) continue;
    // Rule P: the claim is committed; the lookup below is OpenDota.
    await publishInhouseRoomChange();
    // Only the claim winner loads players, on the exact claim it stamped.
    const duel = await prisma.inhouseDuel.findFirst({
      where: {
        id: d.id,
        status: { in: INHOUSE_DUEL_RESULT_STATUSES },
        checkedAt: checkedAt,
      },
      select: duelWithPlayersSelect,
    });
    if (!duel) continue;
    const { found, deadlineReached, unreachable } = await lookUpDuelGame(
      duel,
      nowMs,
      options,
    );
    if (deadlineReached) {
      await raceHook("inhouseDuel.autoDetect.beforeDeadlineRollback");
      const restored = await prisma.inhouseDuel.updateMany({
        where: {
          id: d.id,
          status: { in: INHOUSE_DUEL_RESULT_STATUSES },
          checkedAt: checkedAt,
        },
        data: { checkedAt: d.checkedAt },
      });
      if (restored.count > 0) await publishInhouseRoomChange();
      return { recorded, deadlineReached: true };
    }
    if (found && (await applyDuelResult(duel.id, found)) === "recorded") {
      recorded = true;
    }
    if (unreachable) break;
  }
  return { recorded, deadlineReached: false };
}

/**
 * Whether the never-played call-off may close this READY duel now, given what
 * this pass read from the lobby bot (`botReads`, by duel id). A game the bot
 * launched near the end of the setup window may not have reached the site
 * yet, so with a bot that can host 1v1s the call-off waits for a read taken
 * this pass that shows no game starting (anything but `started` or
 * `starting`); a duel the pass didn't read (its deadline, an unreachable bot)
 * waits for the next pass. With no such bot there is nothing to wait for.
 * GIVE_UP_HOURS after pairing it closes regardless, so an unreachable bot
 * never holds two players forever.
 */
function neverPlayedMayClose(
  d: { id: string; createdAt: Date },
  nowMs: number,
  botReads: ReadonlyMap<string, DotaLobbyStatus | null> | undefined,
): boolean {
  if (!inhouseLobbyBotConfigured()) return true;
  if (duelGiveUpAtMs(d) <= nowMs) return true;
  const read = botReads?.get(d.id) ?? null;
  return read !== null && read.state !== "started" && read.state !== "starting";
}

/**
 * The give-up clocks: a READY duel with no started game SETUP_MINUTES after
 * pairing ("never-played", which includes waiting too long for a busy bot;
 * only on this pass's bot read, neverPlayedMayClose), and a PLAYING or
 * AWAITING_RESULT duel with no result GIVE_UP_HOURS after pairing
 * ("result-never-showed"). Each is a claim on the state judged; the bot is
 * let go after each. Returns how many it closed.
 */
export async function giveUpOnDuels(
  nowMs = Date.now(),
  botReads?: ReadonlyMap<string, DotaLobbyStatus | null>,
): Promise<number> {
  const open = await prisma.inhouseDuel.findMany({
    where: { status: { in: INHOUSE_DUEL_RESULT_STATUSES } },
    select: { id: true, status: true, createdAt: true, startedAt: true, checkedAt: true },
  });
  let closed = 0;
  for (const d of open) {
    const neverPlayed =
      duelNeverPlayedDue(d, nowMs) && neverPlayedMayClose(d, nowMs, botReads);
    if (!neverPlayed && !duelResultGiveUpDue(d, nowMs)) continue;
    // Seam: the bot's launch read or a result landing after the read.
    await raceHook("inhouseDuel.giveUpOnDuels.beforeClaim");
    if (neverPlayed) {
      const endReason = duelEndReason.neverPlayed();
      const completedAt = new Date();
      const gaveUp = await prisma.inhouseDuel.updateMany({
        where: { id: d.id, status: INHOUSE_DUEL_STATUS.READY, startedAt: null },
        data: { status: INHOUSE_DUEL_STATUS.CANCELLED, endReason, completedAt },
      });
      if (gaveUp.count > 0) {
        closed += 1;
        await publishInhouseRoomChange();
        releaseDuelBotAfterClose(d.id);
      }
    } else {
      const endReason = duelEndReason.resultNeverShowed();
      const completedAt = new Date();
      const gaveUp = await prisma.inhouseDuel.updateMany({
        where: {
          id: d.id,
          status: {
            in: [INHOUSE_DUEL_STATUS.PLAYING, INHOUSE_DUEL_STATUS.AWAITING_RESULT],
          },
        },
        data: { status: INHOUSE_DUEL_STATUS.CANCELLED, endReason, completedAt },
      });
      if (gaveUp.count > 0) {
        closed += 1;
        await publishInhouseRoomChange();
        releaseDuelBotAfterClose(d.id);
      }
    }
  }
  return closed;
}

/** Delete 1v1 queue rows past their expiry. Returns how many went. */
export async function expireDuelQueue(nowMs = Date.now()): Promise<number> {
  const expired = await prisma.inhouseDuelQueueEntry.deleteMany({
    where: { expiresAt: { lte: new Date(nowMs) } },
  });
  if (expired.count > 0) await publishInhouseRoomChange();
  return expired.count;
}

/**
 * The worker's sweep: pair two waiters left waiting side by side (one was
 * away or in a 5v5 when the other joined, so no join paired them). The same
 * Serializable read and pair claim as a join; a lost claim or an abort just
 * stops the sweep until the next pass. Returns how many duels it formed.
 */
export async function pairDuelQueue(maxPairs = 10): Promise<number> {
  let formed = 0;
  for (let i = 0; i < maxPairs; i += 1) {
    let duelId: string | null;
    try {
      duelId = await prisma.$transaction(
        async (tx) => {
          const nowMs = Date.now();
          const waiters = await readPresentWaiters(tx, nowMs);
          if (waiters.length < 2) return null;
          const busy = await busyDuelUserIds(
            tx,
            waiters.map((w) => w.userId),
          );
          const pair = pickDuelPair(waiters, busy, nowMs);
          if (!pair) return null;
          return claimPair(
            tx,
            [pair[0].id, pair[1].id],
            pair[0].userId,
            pair[1].userId,
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (retryableJoinError(error)) break;
      throw error;
    }
    if (!duelId) break;
    formed += 1;
    await publishInhouseRoomChange();
  }
  if (formed > 0) invalidateAutomationGateBestEffort();
  return formed;
}

/**
 * Act on what the lobby bot reports for one duel (the worker's read and the
 * bot panel's, /api/dota-lobby): Dota's end of a played game (`over`) moves
 * a live duel to AWAITING_RESULT; a launch (`started`, also a running game
 * the bot has `left`) moves READY to PLAYING with the bot's match id; a job
 * `released` after its game started (a failed launch, a game Dota didn't
 * score) cancels it (duelBotEndedWithoutGame). A `released` READY duel whose
 * game never started stays READY: the worker asks for a fresh lobby.
 * Each is a guarded claim that publishes the room and wakes the automation
 * gate before it returns. `botMatchId`, when the caller read it, skips a
 * write that would change nothing (a PLAYING duel whose id is stored).
 */
export async function applyDuelBotStatus(
  duel: {
    id: string;
    status: string;
    startedAt: Date | null;
    botMatchId?: string | null;
  },
  status: DotaLobbyStatus | null,
): Promise<void> {
  if (!status) return;
  if (status.over) {
    if (duelIsLive(duel.status)) await endDuelFromBot(duel.id);
    return;
  }
  if (status.state === "started") {
    const matchId = botReportedMatchId(status);
    if (
      duel.status === INHOUSE_DUEL_STATUS.READY ||
      (matchId && duel.botMatchId == null)
    ) {
      await markDuelStartedFromBot(duel.id, matchId);
    }
    return;
  }
  // A READY duel whose game never started reads `released` like `idle`:
  // never cancelled here (duelBotEndedWithoutGame), its lobby made again.
  const why = duelBotEndedWithoutGame(status, duel);
  if (why && duelTakesResult(duel.status)) await cancelDuelFromBot(duel.id, why);
}

/** Cheap probe for the worker's idle early return: any 1v1 work at all? */
export async function duelWorkPending(): Promise<boolean> {
  const [queued, open] = await Promise.all([
    prisma.inhouseDuelQueueEntry.findFirst({ select: { id: true } }),
    prisma.inhouseDuel.findFirst({
      where: { status: { in: INHOUSE_DUEL_OPEN_STATUSES } },
      select: { id: true },
    }),
  ]);
  return !!queued || !!open;
}

const logDuelStepFailure = (step: string) =>
  console.error(`[inhouse-duel] worker step failed (${step})`);

/**
 * Every 1v1 step the one-minute worker runs (syncInhouse calls it in its own
 * try/catch, stage C): expire queue rows, settle the accept clocks (before
 * the pairing, so a player put back at the front can pair again in the same
 * pass), pair waiters left side by side,
 * read the bot for live duels (and act on it), ask the bot once for the
 * oldest READY duel's lobby it doesn't have yet, scan OpenDota, then the
 * give-up clocks (after
 * the scan, so a result that is there lands first). Each step catches its
 * own failure, so one never stops the next, nor the 5v5 work.
 */
export async function runDuelWorkerSteps(
  options: OpenDotaFetchOptions = {},
): Promise<{ recorded: boolean; deadlineReached: boolean }> {
  let recorded = false;
  let deadlineReached = false;
  try {
    await expireDuelQueue();
  } catch {
    logDuelStepFailure("expire-queue");
  }
  try {
    await settleDuelAccepts();
  } catch {
    logDuelStepFailure("settle-accepts");
  }
  try {
    await pairDuelQueue();
  } catch {
    logDuelStepFailure("pair-queue");
  }
  // The bot's read of each live duel, oldest first; then one create retry
  // for the oldest READY duel the bot has no lobby for (the join's own
  // create found it busy, saved for a 5v5, or unreachable).
  const read: { id: string; status: string; bot: DotaLobbyStatus | null }[] = [];
  try {
    const live = await prisma.inhouseDuel.findMany({
      where: { status: { in: INHOUSE_DUEL_BOT_STATUSES } },
      select: { ...DUEL_BOT_SPEC_SELECT, botMatchId: true, startedAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const duel of live) {
      if (!canStartOpenDotaFetch(options)) {
        deadlineReached = true;
        break;
      }
      const bot = await duelBotGameStatus(duel, options);
      read.push({ id: duel.id, status: duel.status, bot });
      await applyDuelBotStatus(duel, bot);
    }
  } catch {
    logDuelStepFailure("bot-status");
  }
  if (!deadlineReached && canStartOpenDotaFetch(options)) {
    try {
      await retryDuelBotCreate(read, { signal: options.signal });
    } catch {
      logDuelStepFailure("bot-create");
    }
  }
  if (!deadlineReached) {
    try {
      const scan = await maybeAutoDetectDuelResults(options);
      recorded = scan.recorded;
      deadlineReached = scan.deadlineReached;
    } catch {
      logDuelStepFailure("result-scan");
    }
  }
  try {
    // The never-played call-off acts only on duels this pass read.
    await giveUpOnDuels(
      Date.now(),
      new Map(read.map((r) => [r.id, r.bot])),
    );
  } catch {
    logDuelStepFailure("give-up");
  }
  return { recorded, deadlineReached };
}

// The 1v1 ladder memo, per server instance (Rule P allows a cache each
// instance keeps for itself). Keyed on the completed duels' count and latest
// completedAt: a result moves the latest, a void moves the count.
let ladderMemo: { key: string; ladder: RankedInhouse } | null = null;

/** The 1v1 ladder, derived from every completed duel ([createdAt, id] order). */
export async function loadDuelLadder(): Promise<RankedInhouse> {
  const agg = await prisma.inhouseDuel.aggregate({
    where: { status: INHOUSE_DUEL_STATUS.COMPLETED },
    _count: { _all: true },
    _max: { completedAt: true },
  });
  const key = `${agg._count._all}:${agg._max.completedAt?.getTime() ?? 0}`;
  if (ladderMemo?.key === key) return ladderMemo.ladder;
  const duels = await prisma.inhouseDuel.findMany({
    where: { status: INHOUSE_DUEL_STATUS.COMPLETED },
    select: {
      id: true,
      winnerTeam: true,
      createdAt: true,
      radiantUserId: true,
      direUserId: true,
      radiantUser: { select: { name: true, avatar: true } },
      direUser: { select: { name: true, avatar: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const ladder = duelLadder(duels);
  ladderMemo = { key, ladder };
  return ladder;
}

/** Tests: forget the ladder memo. */
export function resetDuelLadderMemoForTests(): void {
  ladderMemo = null;
}
