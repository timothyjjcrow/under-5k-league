import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  INHOUSE,
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_PLAYING_STATUSES,
  INHOUSE_STATUS,
} from "./constants";
import {
  detectIntervalSeconds,
  inhouseDetectWindow,
  nextPickTeam,
  orderCaptains,
  playersNeeded,
  queuePresence,
  queuePresentCutoff,
  requeueLastSeenAt,
  tallyMethod,
  type CaptainCandidate,
  type CaptainMethod,
} from "./inhouse";
import { summarizeInhouse, toFinishedLobby } from "./inhouse-stats";
import {
  abandonedReason,
  adminCancelReason,
  declinedReason,
  noShowReason,
  resultVoidedReason,
} from "./inhouse-end-reason";
import type { InhouseBoxPlayer } from "./inhouse-box";
import {
  canStartOpenDotaFetch,
  fetchOpenDotaMatch,
  fetchRecentMatchIds,
  openDotaBudgetExpired,
  parseMatchId,
  type OpenDotaFetchOptions,
  type OpenDotaMatch,
} from "./dota";
import { effectiveDotaAccountId } from "./dota-account";
import { botReportedMatchId, inhouseBotGameStatus } from "./dota-lobby-service";
import { classifyGame } from "./match-import";
import {
  inhouseLobbyMessage,
  inhouseQueueMessage,
  inhouseResultVoidedMessage,
  sendInhouseDiscordMessage,
  getInhousePingRoleId,
} from "./discord";
import {
  deliverInhouseAnnouncements,
  inhouseResultAnnouncementContent,
  INHOUSE_ANNOUNCEMENT_KIND,
  INHOUSE_ANNOUNCEMENT_STATUS,
} from "./inhouse-announcement-outbox";
import {
  claimProviderCooldown,
  claimThrottle,
  stampResultChange,
  SETTING_KEYS,
} from "./settings";
import { lobbyView, syncInhouseBoard } from "./inhouse-board-service";
import { resolveSiteUrl } from "./site-url";
import { clampMmrToRank } from "./rank";
import { logAdminAction } from "./admin-log";
import { raceHook } from "./race-hook";
import { waitBeforeSerializableRetry } from "./serializable-retry";
import type { SessionUser } from "./auth";
import { invalidateAutomationGateBestEffort } from "./automation-gate-invalidation";

export type InhouseActionResult = { ok: true } | { ok: false; error: string };

// The transaction-scoped Prisma client type (also satisfied by `prisma` itself).
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const pickDeadline = () => new Date(Date.now() + INHOUSE.PICK_SECONDS * 1000);
const voteDeadline = () => new Date(Date.now() + INHOUSE.VOTE_SECONDS * 1000);
const acceptDeadline = () =>
  new Date(Date.now() + INHOUSE.ACCEPT_SECONDS * 1000);
const QUEUE_WRITE_RETRY_ATTEMPTS = 8;

const queueIdleDeadline = (nowMs = Date.now()) =>
  new Date(nowMs + INHOUSE.QUEUE_IDLE_HOURS * 3_600_000);

const expiredQueuePredicates = (
  nowMs: number,
): Prisma.InhouseQueueEntryWhereInput[] => [
  { idleExpiresAt: { lt: new Date(nowMs) } },
  {
    // Rollback bridge for rows written by an older binary. The release
    // migration backfills this field, but old code can still insert null
    // during the deployment window.
    idleExpiresAt: null,
    joinedAt: {
      lt: new Date(nowMs - INHOUSE.QUEUE_IDLE_HOURS * 3_600_000),
    },
  },
];

/** Clear a roster whose four-hour window elapsed before a new change lands. */
async function expireStaticQueue(tx: Tx, nowMs = Date.now()) {
  const expired = await tx.inhouseQueueEntry.findFirst({
    where: { OR: expiredQueuePredicates(nowMs) },
    select: { id: true },
  });
  if (!expired) return { count: 0 };
  // Fail closed if rolling-deploy or contention ever leaves mixed deadlines:
  // one expired shared clock resets the WHOLE waiting roster, never a subset
  // that then receives another four-hour extension.
  return tx.inhouseQueueEntry.deleteMany();
}

/** Refresh every current waiter after a semantic queue-composition change. */
async function refreshQueueIdleDeadline(tx: Tx, nowMs = Date.now()) {
  await tx.inhouseQueueEntry.updateMany({
    data: { idleExpiresAt: queueIdleDeadline(nowMs) },
  });
}

type WinLoss = { wins: number; losses: number; winRate: number; games: number };

/** Inhouse win/loss records for a set of users, from their completed lobbies. */
async function loadRecords(
  db: Tx,
  userIds: string[],
): Promise<Map<string, WinLoss>> {
  if (userIds.length === 0) return new Map();
  const lobbies = await db.inhouseLobby.findMany({
    where: {
      status: INHOUSE_STATUS.COMPLETED,
      players: { some: { userId: { in: userIds } } },
    },
    // Formation is the one moment these snapshots are computed, so silently
    // truncating the history gives long-running players a different record
    // from the ladder. Fetch the full career, but only the fields the shared
    // stats mapper consumes (the former include loaded every User column).
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
  const recs = summarizeInhouse(lobbies.map(toFinishedLobby));
  return new Map(
    recs.map((r) => [
      r.userId,
      { wins: r.wins, losses: r.losses, winRate: r.winRate, games: r.games },
    ]),
  );
}

/**
 * Form a lobby when enough players are waiting. Idempotent and safe under
 * concurrent leased maintenance calls: no-ops unless the single active-lobby slot is free AND the queue
 * has reached LOBBY_SIZE. The lobby opens in the READY_CHECK phase — the
 * Dota-style accept gate: all ten must press ACCEPT before the captain vote
 * starts (acceptMatch / resolveReadyCheck), so an AFK player is dropped
 * instead of drafted.
 */
export async function maybeFormLobby(): Promise<boolean> {
  // Captured in-tx, sent post-commit (draft-sale pattern) — the active-lobby
  // guard means at most one formation, so at most one announcement.
  let lobbyPlayers: { name: string; discordId: string | null }[] = [];
  // The ready check's deadline, so the ping can say how long players have.
  let acceptEndsAt: Date | null = null;
  let formed = false;
  try {
    formed = await prisma.$transaction(
      async (tx) => {
        const now = Date.now();
        // Only the shared four-hour activity clock clears the waiting queue.
        // Missing heartbeats can mean a suspended browser tab, not a leave.
        // SERIALIZABLE preserves the existing join-versus-reset ordering;
        // active lobby membership lives in a separate table and is untouched.
        await expireStaticQueue(tx, now);

        const active = await tx.inhouseLobby.findFirst({
          where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
          select: { id: true },
        });
        if (active) return false;

        // Only players seen recently count toward the ten — an "away" entry keeps
        // its queue position but can't be pulled into a lobby it won't show up to.
        const queue = await tx.inhouseQueueEntry.findMany({
          where: { lastSeenAt: { gte: queuePresentCutoff(now) } },
          orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
          take: INHOUSE.LOBBY_SIZE,
        });
        if (queue.length < INHOUSE.LOBBY_SIZE) return false;

        const lobby = await tx.inhouseLobby.create({
          data: {
            status: INHOUSE_STATUS.READY_CHECK,
            acceptEndsAt: acceptDeadline(),
            radiantTeam: 1,
          },
        });
        acceptEndsAt = lobby.acceptEndsAt;

        // Snapshot each player's inhouse record onto their lobby row — one history
        // scan per FORMATION instead of one per poll. Frozen is correct: no result
        // can land while this lobby occupies the single active slot.
        const records = await loadRecords(
          tx,
          queue.map((q) => q.userId),
        );

        // Everyone starts in the pool with no captain; the vote decides the two.
        await tx.inhouseLobbyPlayer.createMany({
          data: queue.map((q) => {
            const r = records.get(q.userId);
            return {
              lobbyId: lobby.id,
              userId: q.userId,
              mmr: q.mmr,
              queuedAt: q.joinedAt,
              wins: r?.wins ?? 0,
              losses: r?.losses ?? 0,
              games: r?.games ?? 0,
            };
          }),
        });

        await tx.inhouseQueueEntry.deleteMany({
          where: { userId: { in: queue.map((q) => q.userId) } },
        });
        await refreshQueueIdleDeadline(tx, now);

        // Player names for the Discord announcement, in queue order. discordId
        // comes along so the ten can be mentioned by id — the only escalation the
        // league has that reaches a phone. The site's chime and tab title can't.
        const users = await tx.user.findMany({
          where: { id: { in: queue.map((q) => q.userId) } },
          select: { id: true, name: true, discordId: true },
        });
        const byId = new Map(users.map((u) => [u.id, u]));
        lobbyPlayers = queue.map((q) => ({
          name: byId.get(q.userId)?.name ?? "?",
          discordId: byId.get(q.userId)?.discordId ?? null,
        }));
        return true;
      },
      // SQLite serializes writers anyway; on Postgres this makes competing
      // formations conflict before the partial unique index provides the final
      // "one active lobby" barrier. Depending on the interleaving, the loser is
      // reported as a serialization conflict (P2034) or unique conflict (P2002).
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    // Someone else's poll formed the lobby first. The serializable transaction
    // and the database's partial unique index can report the same safe loser in
    // two different ways.
    const code = (e as { code?: string }).code;
    if (code === "P2034" || code === "P2002") return false;
    throw e;
  }
  if (formed && lobbyPlayers.length > 0) {
    const roleId = await getInhousePingRoleId();
    await sendInhouseDiscordMessage(
      inhouseLobbyMessage(lobbyPlayers, roleId, acceptEndsAt),
      {
        // Only these exact ids may ring anyone — a Steam persona in the same
        // message still can't ping (see MentionAllowlist).
        roles: roleId ? [roleId] : [],
        users: lobbyPlayers
          .map((p) => p.discordId)
          .filter((id): id is string => !!id),
      },
    );
  }
  return formed;
}

/**
 * Claim the READY_CHECK → CAPTAIN_VOTE flip (all ten accepted) and start the
 * vote clock. updateMany-guarded: two concurrent resolvers flip it once, and —
 * the case that actually bites — a check CANCELLED under the last accept is
 * never flipped back to life. The caller counted pending players on a snapshot
 * and this write lands after it, so "everyone accepted" can be several seconds
 * stale by the time we get here.
 */
async function startCaptainVote(tx: Tx, lobbyId: string): Promise<boolean> {
  // Seam: the decline/cancel that lands in exactly that gap. Racing can't
  // steer it — the rival has to commit between the pending count and this
  // write, a window measured in milliseconds.
  await raceHook("inhouse.startCaptainVote.beforeFlip");
  const flip = await tx.inhouseLobby.updateMany({
    where: { id: lobbyId, status: INHOUSE_STATUS.READY_CHECK },
    data: {
      status: INHOUSE_STATUS.CAPTAIN_VOTE,
      acceptEndsAt: null,
      voteEndsAt: voteDeadline(),
    },
  });
  return flip.count > 0;
}

/**
 * Fail the ready check: cancel the lobby and re-queue ONLY the players who
 * deserve their spot back. Accepters proved they're present — they re-queue
 * with a live heartbeat AND keep priority (their exact original queue slot was
 * snapshotted at formation, so it outranks anyone who joined during the check).
 * `pendingBackdated` players (a decline aborted the check before their clock
 * ran out) re-queue with a BACKDATED heartbeat — their own next poll
 * re-confirms them within seconds if they're really there (the cancelLobby
 * pattern). Everyone else (the decliner, or no-shows whose clock expired) is
 * dropped and must rejoin.
 *
 * The requeue set is decided from a re-read of `acceptedAt` taken AFTER the
 * CANCELLED claim wins — never from the caller's pre-claim snapshot. On
 * Postgres read-committed an accept can commit between the caller's read and
 * this claim (the claim locks only the lobby row, not the player rows); that
 * player holds a committed accept + an ok response, so they MUST be treated as
 * an accepter, not a dropped no-show.
 *
 * `endReason` rides the CANCELLED claim itself, so the lobby can never be
 * cancelled without saying why. It is built from the caller's pre-claim
 * snapshot, which is the one thing that can be a few milliseconds stale: an
 * accept committing in that gap is requeued as an accepter above, yet may
 * still be named as a no-show in the admin-only reason. That is a display
 * nuance on a record, never a membership decision.
 */
async function failReadyCheck(
  tx: Tx,
  lobbyId: string,
  opts: { pendingBackdated: boolean; dropUserId?: string; endReason: string },
): Promise<boolean> {
  const claim = await tx.inhouseLobby.updateMany({
    where: { id: lobbyId, status: INHOUSE_STATUS.READY_CHECK },
    data: {
      status: INHOUSE_STATUS.CANCELLED,
      acceptEndsAt: null,
      endReason: opts.endReason,
    },
  });
  if (claim.count === 0) return false;
  const lobby = await tx.inhouseLobby.findUniqueOrThrow({
    where: { id: lobbyId },
    select: {
      players: {
        select: {
          userId: true,
          mmr: true,
          acceptedAt: true,
          queuedAt: true,
        },
      },
    },
  });
  const requeue = lobby.players
    .filter((p) => {
      if (p.userId === opts.dropUserId) return false;
      return p.acceptedAt != null || opts.pendingBackdated;
    })
    .sort(
      (a, b) =>
        a.queuedAt.getTime() - b.queuedAt.getTime() ||
        a.userId.localeCompare(b.userId),
    );
  const now = Date.now();
  const expired = await expireStaticQueue(tx, now);
  const idleExpiresAt = queueIdleDeadline(now);
  if (expired.count > 0 || requeue.length > 0) {
    // Lock/update the existing queue before inserting individual requeue rows.
    // Every queue mutation uses this order so concurrent joins cannot deadlock
    // by each holding its own row while waiting on the other's.
    await refreshQueueIdleDeadline(tx, now);
  }
  for (const p of requeue) {
    const lastSeenAt =
      p.acceptedAt != null ? new Date() : requeueLastSeenAt(now);
    // Restore the exact immutable queue position captured at formation. Using
    // `lobby.createdAt + index` only approximates it: an overflow player who was
    // already waiting (or joined in those first few milliseconds) could slip in
    // front of accepters who were promised their spots back.
    const joinedAt = p.queuedAt;
    await tx.inhouseQueueEntry.upsert({
      where: { userId: p.userId },
      create: {
        userId: p.userId,
        mmr: p.mmr,
        joinedAt,
        lastSeenAt,
        idleExpiresAt,
      },
      update: { joinedAt, lastSeenAt, idleExpiresAt },
    });
  }
  return true;
}

/** Press ACCEPT on the ready check. Idempotent — a double-click is one accept. */
export async function acceptMatch(
  viewer: SessionUser,
): Promise<InhouseActionResult> {
  return prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.READY_CHECK },
      include: { players: true },
    });
    if (!lobby) return { ok: false as const, error: "No match to accept" };
    // Seam: a decline/expiry CANCELLING the lobby between this read and the
    // accept claim below — the one interleaving the relation filter exists
    // for, and the one no amount of racing reliably produces.
    await raceHook("inhouse.acceptMatch.beforeClaim");
    const mine = lobby.players.find((p) => p.userId === viewer.id);
    if (!mine) {
      return { ok: false as const, error: "You're not in this lobby" };
    }
    // Claim the accept (null → now) AND re-assert the lobby is still in the
    // ready check, atomically — on Postgres a concurrent decline/expiry could
    // have CANCELLED it between the read above and here; without the relation
    // filter this would stamp acceptedAt on a dead lobby and falsely report
    // success. Zero rows = either already accepted (quiet success) or the
    // lobby is gone (tell them).
    const claimed = await tx.inhouseLobbyPlayer.updateMany({
      where: {
        id: mine.id,
        acceptedAt: null,
        lobby: { status: INHOUSE_STATUS.READY_CHECK },
      },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count === 0) {
      const stillOpen = await tx.inhouseLobby.count({
        where: { id: lobby.id, status: INHOUSE_STATUS.READY_CHECK },
      });
      if (stillOpen === 0) {
        return { ok: false as const, error: "The match was cancelled" };
      }
      // else: they'd already accepted — fall through as a quiet success.
    }
    const pending = await tx.inhouseLobbyPlayer.count({
      where: { lobbyId: lobby.id, acceptedAt: null },
    });
    if (pending === 0) await startCaptainVote(tx, lobby.id);
    return { ok: true as const };
  });
}

/**
 * Decline the ready check: the match fails NOW (no point running out the
 * clock), the decliner is dropped from the queue, accepters re-queue with
 * priority, and still-pending players re-queue with a backdated heartbeat —
 * they did nothing wrong, but must re-confirm presence via their own poll.
 */
export async function declineMatch(
  viewer: SessionUser,
): Promise<InhouseActionResult> {
  return prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.READY_CHECK },
      include: { players: { include: { user: { select: { name: true } } } } },
    });
    if (!lobby) return { ok: false as const, error: "No match to decline" };
    const mine = lobby.players.find((p) => p.userId === viewer.id);
    if (!mine) {
      return { ok: false as const, error: "You're not in this lobby" };
    }
    const failed = await failReadyCheck(tx, lobby.id, {
      pendingBackdated: true,
      dropUserId: viewer.id,
      endReason: declinedReason(mine.user.name),
    });
    if (!failed) {
      // Lost the claim: the check already resolved (everyone accepted, a
      // faster decline, an expiry, or an admin cancel) — not necessarily
      // "started".
      return { ok: false as const, error: "The match is no longer waiting" };
    }
    return { ok: true as const };
  });
}

/**
 * Resolve an expired ready check: everyone accepted → captain vote (the last
 * accept may race the clock — completeness wins); otherwise cancel and drop
 * the no-shows, re-queuing only the players who accepted. Idempotent and safe
 * under concurrent maintenance calls.
 */
export async function resolveReadyCheck(): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.READY_CHECK },
      include: { players: { include: { user: { select: { name: true } } } } },
    });
    if (!lobby) return false;
    const allAccepted =
      lobby.players.length > 0 && lobby.players.every((p) => p.acceptedAt);
    if (allAccepted) return startCaptainVote(tx, lobby.id);
    const expired =
      !!lobby.acceptEndsAt && lobby.acceptEndsAt.getTime() <= Date.now();
    if (!expired) return false;
    // Timed out with pending players: they ignored the Discord ping, the chime
    // and the tab flash for the whole accept window — proven AFK, dropped.
    // Accepters go back to the front of the queue.
    const noShows = lobby.players
      .filter((p) => !p.acceptedAt)
      .sort(
        (a, b) =>
          a.queuedAt.getTime() - b.queuedAt.getTime() ||
          a.userId.localeCompare(b.userId),
      )
      .map((p) => p.user.name);
    return failReadyCheck(tx, lobby.id, {
      pendingBackdated: false,
      endReason: noShowReason(noShows),
    });
  });
}

/**
 * Scrap a lobby that was abandoned in READY or IN_PROGRESS. These are the only
 * two phases with NO clock — READY_CHECK, CAPTAIN_VOTE and DRAFTING all expire
 * into a resolver — so before this they could hold the single active-lobby
 * slot forever: `maybeFormLobby` early-returns on any active lobby, so no new
 * game could ever form, and the abandoned lobby's own ten players were refused
 * the queue by joinQueue's inActiveLobby guard. The whole feature was down for
 * everyone until an admin happened to visit /inhouse and press Cancel.
 *
 * Both floors (ABANDON_*_HOURS) are deliberately far past any legitimate use.
 * A READY lobby counts as being played (Start is optional), so it is scanned
 * for its result and gets the same window as a started game, measured from
 * FORMATION — not `updatedAt`, which each scan's detectedAt claim bumps, so an
 * updatedAt floor would never fire while the scan keeps looking. The manual
 * result paths have no time gate inside the window. Idempotent and safe under
 * concurrent maintenance calls.
 *
 * Unlike cancelLobby this does NOT re-queue anyone: an admin cancels a LIVE
 * lobby whose players are present and want the next game, whereas by
 * definition nobody has touched this one for hours. Re-queueing ten ghosts
 * would just park them on the pinned Discord board until the next prune.
 */
export async function resolveAbandonedLobby(): Promise<boolean> {
  const now = Date.now();
  const stale = await prisma.inhouseLobby.findFirst({
    where: {
      OR: [
        {
          status: INHOUSE_STATUS.READY,
          createdAt: {
            lt: new Date(now - INHOUSE.ABANDON_READY_HOURS * 3_600_000),
          },
        },
        {
          status: INHOUSE_STATUS.IN_PROGRESS,
          startedAt: {
            lt: new Date(now - INHOUSE.ABANDON_IN_PROGRESS_HOURS * 3_600_000),
          },
        },
      ],
    },
    select: { id: true, status: true },
  });
  if (!stale) return false;
  // Guarded claim on the status we read: a Start / result landing between the
  // read and here must win, and two concurrent pollers must tear down once.
  const claim = await prisma.inhouseLobby.updateMany({
    where: { id: stale.id, status: stale.status },
    data: {
      status: INHOUSE_STATUS.CANCELLED,
      pickTeam: null,
      pickEndsAt: null,
      endReason: abandonedReason(stale.status),
    },
  });
  return claim.count > 0;
}

/**
 * Resolve the captain-selection vote once everyone has voted or the timer runs
 * out: tally the winning method, rank candidates, install the top two as
 * captains, and drop into the draft. Idempotent and safe under concurrent
 * maintenance calls.
 */
export async function resolveCaptainVote(): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.CAPTAIN_VOTE },
      include: { players: true },
    });
    if (!lobby) return false;

    const allVoted =
      lobby.players.length > 0 && lobby.players.every((p) => p.votedMethod);
    const expired =
      !!lobby.voteEndsAt && lobby.voteEndsAt.getTime() <= Date.now();
    if (!allVoted && !expired) return false;

    const method = tallyMethod(
      lobby.players
        .map((p) => p.votedMethod)
        .filter((m): m is CaptainMethod => !!m),
    );

    const nominations = new Map<string, number>();
    for (const p of lobby.players) {
      if (p.votedNomineeId) {
        nominations.set(
          p.votedNomineeId,
          (nominations.get(p.votedNomineeId) ?? 0) + 1,
        );
      }
    }

    // Record snapshots were frozen onto the player rows at formation.
    const candidates: CaptainCandidate[] = lobby.players.map((p) => ({
      userId: p.userId,
      mmr: p.mmr,
      joinedAt: p.queuedAt,
      nominations: nominations.get(p.userId) ?? 0,
      wins: p.wins,
      winRate: p.games > 0 ? p.wins / p.games : 0,
      games: p.games,
    }));

    const ordered = orderCaptains(method, candidates);
    const team1 = ordered[0]?.userId;
    const team2 = ordered[1]?.userId;

    // Claim the transition FIRST: two concurrent resolvers both passing the
    // checks above must install captains (and start the pick clock) once.
    const transition = await tx.inhouseLobby.updateMany({
      where: { id: lobby.id, status: INHOUSE_STATUS.CAPTAIN_VOTE },
      data: {
        status: INHOUSE_STATUS.DRAFTING,
        voteEndsAt: null,
        pickTeam: INHOUSE.FIRST_PICK_TEAM,
        pickEndsAt: pickDeadline(),
      },
    });
    if (transition.count === 0) return false;

    for (const p of lobby.players) {
      const team = p.userId === team1 ? 1 : p.userId === team2 ? 2 : null;
      if (team) {
        await tx.inhouseLobbyPlayer.update({
          where: { id: p.id },
          data: { team, isCaptain: true },
        });
      }
    }
    return true;
  });
}

/** Cast (or change) your captain-selection ballot during the CAPTAIN_VOTE phase. */
export async function castVote(
  viewer: SessionUser,
  method: string,
  nomineeId?: string,
): Promise<InhouseActionResult> {
  const m = method as CaptainMethod;
  if (m !== "MMR" && m !== "RECORD" && m !== "VOTE") {
    return { ok: false, error: "Invalid vote" };
  }
  const res = await prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.CAPTAIN_VOTE },
      include: { players: true },
    });
    if (!lobby) return { ok: false as const, error: "Voting isn't open" };
    if (!lobby.voteEndsAt || lobby.voteEndsAt.getTime() <= Date.now()) {
      return { ok: false as const, error: "Voting has closed" };
    }
    const mine = lobby.players.find((p) => p.userId === viewer.id);
    if (!mine) {
      return {
        ok: false as const,
        error: "Only players in the lobby can vote",
      };
    }
    let nominee: string | null = null;
    if (m === "VOTE") {
      if (!nomineeId)
        return { ok: false as const, error: "Pick a player to captain" };
      if (!lobby.players.some((p) => p.userId === nomineeId)) {
        return { ok: false as const, error: "That player isn't in this lobby" };
      }
      nominee = nomineeId;
    }

    // Seam: the vote clock expires (or a resolver advances the lobby) after
    // this caller validated its ballot but before the player-row write. The
    // write below must re-assert both facts on the related lobby, atomically.
    await raceHook("inhouse.castVote.beforeClaim");
    const claimed = await tx.inhouseLobbyPlayer.updateMany({
      where: {
        id: mine.id,
        lobby: {
          status: INHOUSE_STATUS.CAPTAIN_VOTE,
          voteEndsAt: { gt: new Date() },
        },
      },
      data: { votedMethod: m, votedNomineeId: nominee },
    });
    if (claimed.count === 0) {
      return { ok: false as const, error: "Voting just closed" };
    }
    return { ok: true as const };
  });
  if (res.ok) await resolveCaptainVote(); // resolve early if that was the last vote
  return res;
}

/**
 * Thrown by applyPick once it has NULLED `pickTeam` (its turn claim) but can't
 * finish the pick. It must be a throw, never a `return`: a returned value
 * RESOLVES the Prisma interactive transaction, which COMMITS it — leaving the
 * lobby DRAFTING with `pickTeam = null`, a state no resolver can move
 * (resolveStalledPick filters `pickTeam: { not: null }`, makePick bails on
 * `!lobby.pickTeam`), so the draft freezes for all ten with an expired clock
 * and only an admin cancel recovers. Throwing rolls the claim back, which is
 * what the turn-claim comment below has always promised.
 */
class PickRaceError extends Error {}

/** Assign a pool player to the team currently on the clock and advance the draft. */
async function applyPick(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  lobbyId: string,
  targetUserId: string,
  /** The team the CALLER authorized against, when it authorized against one. */
  expectTeam?: number | null,
): Promise<InhouseActionResult> {
  const lobby = await tx.inhouseLobby.findUnique({
    where: { id: lobbyId },
    include: { players: true },
  });
  if (!lobby || lobby.status !== INHOUSE_STATUS.DRAFTING || !lobby.pickTeam) {
    return { ok: false, error: "The draft isn't running" };
  }
  const target = lobby.players.find((p) => p.userId === targetUserId);
  if (!target) return { ok: false, error: "That player isn't in this lobby" };
  if (target.team !== null)
    return { ok: false, error: "Player already drafted" };

  const team = lobby.pickTeam;
  // makePick authorized the caller against the pickTeam ITS OWN read saw.
  // Postgres takes a fresh snapshot per statement even inside one interactive
  // transaction, so the re-read above can legitimately show a DIFFERENT team
  // (a poller's resolveStalledPick advanced the turn in between) — and the
  // guarded claim below would then happily succeed, drafting the caller's
  // choice onto the OPPOSING captain's roster. Refuse instead; the room
  // toasts it and the next ~250ms poll shows whose turn it really is.
  if (expectTeam != null && team !== expectTeam) {
    return { ok: false, error: "That pick was already made" };
  }
  const picksMade = lobby.players.filter(
    (p) => p.team !== null && !p.isCaptain,
  ).length;

  // Seam: everything above is a READ, so a rival on another connection can
  // commit here without blocking. The interleaving that matters — the turn
  // moved on with a fresh deadline while this caller was deciding — cannot be
  // produced by racing real calls (see src/lib/race-hook.ts).
  await raceHook("inhouse.applyPick.beforeTurnClaim");

  // Claim the TURN first. The per-player claim below only stops the same
  // player being taken twice; two DIFFERENT players (a captain clicking X
  // while resolveStalledPick auto-picks Y) both succeeded, so one turn
  // assigned two players and the lobby finished 6v4. Nulling pickTeam is the
  // claim: a concurrent caller's `pickTeam: team` predicate then fails, and a
  // rollback restores it. The real next turn is written at the end.
  //
  // `pickEndsAt` is in the predicate because `pickTeam` ALONE is not unique to
  // a turn: the snake pattern (2,1,1,2,2,1,1,2) repeats a team across
  // consecutive picks, so at a pair boundary a loser that blocked on the
  // winner's row lock re-evaluates after the commit, sees the SAME pickTeam
  // the winner just re-wrote, and claims a turn that was never its own. The
  // winner always stamps a fresh pickDeadline() when it advances, so the
  // deadline is what actually identifies the turn.
  const turn = await tx.inhouseLobby.updateMany({
    where: {
      id: lobbyId,
      status: INHOUSE_STATUS.DRAFTING,
      pickTeam: team,
      pickEndsAt: lobby.pickEndsAt,
    },
    data: { pickTeam: null },
  });
  if (turn.count === 0) {
    return { ok: false, error: "That pick was already made" };
  }

  // Claim the pick atomically — a captain's double-click or an admin racing
  // them must consume ONE turn, not two (a plain read-then-write pair loses
  // that race silently under Postgres read-committed).
  // Seam: a rival drafting THIS target between the read and the claim. Safe —
  // the only row this transaction has written is the lobby, and the rival
  // touches a player row.
  await raceHook("inhouse.applyPick.beforePlayerClaim");
  const claim = await tx.inhouseLobbyPlayer.updateMany({
    where: { id: target.id, team: null },
    data: { team, pickIndex: picksMade },
  });
  // Past the turn claim: THROW so the nulled pickTeam rolls back (see
  // PickRaceError) — a return here would commit the frozen draft.
  if (claim.count === 0) throw new PickRaceError("Player already drafted");

  let team1Picks =
    lobby.players.filter((p) => p.team === 1 && !p.isCaptain).length +
    (team === 1 ? 1 : 0);
  let team2Picks =
    lobby.players.filter((p) => p.team === 2 && !p.isCaptain).length +
    (team === 2 ? 1 : 0);
  let next = nextPickTeam(team1Picks, team2Picks);

  // Last-pick auto-assign: with one pool player left there's nothing to
  // decide — assign them instantly instead of running a 60s clock for a
  // foregone conclusion.
  const remaining = lobby.players.filter(
    (p) => p.team === null && p.id !== target.id,
  );
  if (next !== null && remaining.length === 1) {
    // Seam: the last pool player taken by a rival between the read and here.
    await raceHook("inhouse.applyPick.beforeLastAssign");
    const lastClaim = await tx.inhouseLobbyPlayer.updateMany({
      where: { id: remaining[0].id, team: null },
      data: { team: next, pickIndex: picksMade + 1 },
    });
    if (lastClaim.count > 0) {
      if (next === 1) team1Picks += 1;
      else team2Picks += 1;
      next = nextPickTeam(team1Picks, team2Picks);
    }
  }

  // Re-assert DRAFTING on the way out. Unlike every other claim in this file
  // this one CANNOT currently be falsified, and the reason is worth writing
  // down rather than rediscovering: the turn claim above UPDATEd this same row,
  // so the transaction holds its row lock until commit and an admin cancel
  // landing "mid-pick" does not land at all — it blocks, then re-evaluates its
  // own guard against the committed result. That makes deleting this predicate
  // an EQUIVALENT MUTANT (mutation-guard.mjs lists it as one, with no test able
  // to kill it) rather than an untested gap. It stays because it is the
  // property we want enforced at the write if the turn claim is ever moved,
  // narrowed or removed — and the lock itself is pinned by
  // "the DRAFTING re-assert cannot be falsified" in inhouse.itest.ts, which
  // fails the moment that stops being true.
  await raceHook("inhouse.applyPick.beforeAdvance");
  const advanced = await tx.inhouseLobby.updateMany({
    where: { id: lobby.id, status: INHOUSE_STATUS.DRAFTING },
    data:
      next === null
        ? // Draft complete: teams lock and the lobby waits for Start. The
          // other writer of this transition is restoreLostPickTurn.
          { status: INHOUSE_STATUS.READY, pickTeam: null, pickEndsAt: null }
        : { pickTeam: next, pickEndsAt: pickDeadline() },
  });
  if (advanced.count === 0) {
    // Also past the turn claim — throw, don't return (see PickRaceError).
    throw new PickRaceError("That lobby is no longer drafting");
  }
  return { ok: true };
}

/**
 * Belt-and-braces: put a DRAFTING lobby that somehow lost its `pickTeam` back
 * on the clock. `pickTeam` is nulled for a few statements as applyPick's turn
 * claim, so any path that commits between the claim and the advance strands
 * the draft in a state NOTHING can move — resolveStalledPick filters
 * `pickTeam: { not: null }` and makePick bails on `!lobby.pickTeam`, so all
 * ten watch a dead clock until an admin cancels. applyPick now throws (see
 * PickRaceError) so the claim rolls back instead, but the recovery is cheap
 * and the failure mode is severe enough to be worth making unreachable rather
 * than merely fixed: `nextPickTeam` is pure and the rosters are the source of
 * truth, so the correct turn can always be recomputed. Idempotent.
 */
async function restoreLostPickTurn(): Promise<boolean> {
  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: INHOUSE_STATUS.DRAFTING, pickTeam: null },
    include: { players: true },
  });
  if (!lobby) return false;
  // Seam: another poller restoring the same lost turn first. Not inside a
  // transaction, so nothing is locked.
  await raceHook("inhouse.restoreLostPickTurn.beforeClaim");
  const next = nextPickTeam(
    lobby.players.filter((p) => p.team === 1 && !p.isCaptain).length,
    lobby.players.filter((p) => p.team === 2 && !p.isCaptain).length,
  );
  const claim = await prisma.inhouseLobby.updateMany({
    // Guarded on the null we read, so a real in-flight turn claim (which holds
    // the null for only a few statements) can never be overwritten by this.
    where: { id: lobby.id, status: INHOUSE_STATUS.DRAFTING, pickTeam: null },
    data:
      next === null
        ? // Every seat is filled, so the draft is over: the same DRAFTING →
          // READY transition applyPick's advance writes. `pickTeam` is already
          // null (the WHERE asserts it).
          { status: INHOUSE_STATUS.READY, pickEndsAt: null }
        : { pickTeam: next, pickEndsAt: pickDeadline() },
  });
  return claim.count > 0;
}

/**
 * If a captain lets their pick clock run out, auto-draft the top remaining
 * player for them so the lobby never stalls. Idempotent and safe under
 * concurrent maintenance calls.
 */
export async function resolveStalledPick(): Promise<boolean> {
  await restoreLostPickTurn();
  try {
    return await prisma.$transaction(async (tx) => {
      const lobby = await tx.inhouseLobby.findFirst({
        where: { status: INHOUSE_STATUS.DRAFTING, pickTeam: { not: null } },
        include: { players: true },
      });
      if (
        !lobby ||
        !lobby.pickEndsAt ||
        lobby.pickEndsAt.getTime() > Date.now()
      ) {
        return false;
      }
      const pool = lobby.players
        .filter((p) => p.team === null)
        .sort(
          (a, b) =>
            b.mmr - a.mmr ||
            a.queuedAt.getTime() - b.queuedAt.getTime() ||
            a.userId.localeCompare(b.userId),
        );
      if (pool.length === 0) return false;
      const r = await applyPick(tx, lobby.id, pool[0].userId);
      return r.ok;
    });
  } catch (e) {
    // The catch MUST be outside the transaction callback so the throw actually
    // rolls the turn claim back. Losing the race is the normal outcome when
    // ten pollers hit an expired clock at once — the winner's pick stands.
    if (e instanceof PickRaceError) return false;
    throw e;
  }
}

/** A captain (or admin, on their behalf) drafts a player from the pool. */
export async function makePick(
  viewer: SessionUser,
  targetUserId: string,
): Promise<InhouseActionResult> {
  await resolveStalledPick();
  try {
    return await prisma.$transaction(async (tx) => {
      const lobby = await tx.inhouseLobby.findFirst({
        where: { status: INHOUSE_STATUS.DRAFTING },
        include: { players: true },
      });
      if (!lobby || !lobby.pickTeam) {
        return { ok: false as const, error: "The draft isn't running" };
      }
      const isAdmin = viewer.role === "ADMIN";
      const captainOnClock = lobby.players.find(
        (p) => p.team === lobby.pickTeam && p.isCaptain,
      );
      if (!isAdmin && captainOnClock?.userId !== viewer.id) {
        return { ok: false as const, error: "It's not your turn to pick" };
      }
      // Pass the team we just authorized against: applyPick re-reads the lobby
      // and must refuse if the turn moved on underneath us.
      return applyPick(tx, lobby.id, targetUserId, lobby.pickTeam);
    });
  } catch (e) {
    // Outside the callback on purpose (see resolveStalledPick).
    if (e instanceof PickRaceError) {
      return { ok: false as const, error: e.message };
    }
    throw e;
  }
}

/** Add the current user to the inhouse queue (or refresh their seed MMR). */
export async function joinQueue(
  viewer: SessionUser,
  mmr: number,
): Promise<InhouseActionResult> {
  // MMR drives captain selection, auto-pick order, and the balance meter — so
  // prefer the league-trusted number (their registration, which admins see and
  // the season cap gates) over the free-typed client value. The typed value
  // only seeds players who never registered for a season; a blank re-join
  // ("Run it back") falls back to their last lobby's snapshot instead of
  // silently resetting them to unknown.
  const [reg, dbUser] = await Promise.all([
    prisma.registration.findFirst({
      where: { userId: viewer.id, mmr: { gt: 0 } },
      orderBy: { createdAt: "desc" },
      select: { mmr: true },
    }),
    prisma.user.findUnique({
      where: { id: viewer.id },
      select: { rankTier: true },
    }),
  ]);
  // A registration MMR is league-approved as-is — clamped against the medal
  // at its own save, or deliberately set by an admin override (the escape
  // hatch for stale medals, which this path must not silently undo). Only
  // SELF-reported numbers get the medal check: the free-typed value and the
  // old lobby snapshot (which may predate medal validation). A blank-but-
  // medaled player seeds at the medal floor instead of unknown.
  let safeMmr: number;
  if (reg) {
    safeMmr = reg.mmr;
  } else {
    safeMmr = Number.isFinite(mmr)
      ? Math.max(0, Math.min(12000, Math.floor(mmr)))
      : 0;
    if (safeMmr === 0) {
      const last = await prisma.inhouseLobbyPlayer.findFirst({
        where: { userId: viewer.id, mmr: { gt: 0 } },
        orderBy: { createdAt: "desc" },
        select: { mmr: true },
      });
      if (last) safeMmr = last.mmr;
    }
    safeMmr = clampMmrToRank(safeMmr, dbUser?.rankTier).mmr;
  }

  // Counted BEFORE the join so the Discord milestone check below sees the
  // crossing (this join is the one that may push the count over the line).
  const presentBefore = await prisma.inhouseQueueEntry.count({
    where: { lastSeenAt: { gte: queuePresentCutoff(Date.now()) } },
  });

  // Guard + upsert at SERIALIZABLE, matching maybeFormLobby. A plain
  // transaction reads at read-committed on Postgres, so the findFirst below
  // locks nothing: a concurrent poll forming a lobby could insert this
  // player's InhouseLobbyPlayer row between the check and the upsert, leaving
  // them rostered in the live lobby AND queued for the next one. Serializable
  // makes the two conflict, and the loser aborts with P2034.
  let joined: boolean | null = null;
  for (let attempt = 0; attempt < QUEUE_WRITE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      joined = await prisma.$transaction(
        async (tx) => {
          const inActiveLobby = await tx.inhouseLobbyPlayer.findFirst({
            where: {
              userId: viewer.id,
              lobby: { status: { in: INHOUSE_ACTIVE_STATUSES } },
            },
            select: { id: true },
          });
          if (inActiveLobby) return false;
          const now = Date.now();
          const expired = await expireStaticQueue(tx, now);
          const queued = await tx.inhouseQueueEntry.findUnique({
            where: { userId: viewer.id },
            select: { id: true },
          });
          const idleExpiresAt = queueIdleDeadline(now);
          if (expired.count > 0 || !queued) {
            // Shared rows first, then this user's row: concurrent distinct
            // joins take locks in the same order instead of cross-locking.
            await refreshQueueIdleDeadline(tx, now);
          }
          await tx.inhouseQueueEntry.upsert({
            where: { userId: viewer.id },
            create: { userId: viewer.id, mmr: safeMmr, idleExpiresAt },
            // A duplicate request is presence, not a composition change. Keep
            // both the original queue position and shared idle deadline.
            update: { mmr: safeMmr, lastSeenAt: new Date(now) },
          });
          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      break;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        (code === "P2034" || code === "P2002") &&
        attempt + 1 < QUEUE_WRITE_RETRY_ATTEMPTS
      ) {
        // Queue-wide deadline writes intentionally serialize semantic changes.
        // A jittered backoff lets the winner commit before this request
        // re-reads the active-lobby guard and current queue composition, and
        // spreads the losers out: a fixed delay retried them in step, one
        // winner per round, so a ninth simultaneous join ran out of tries.
        await waitBeforeSerializableRetry(attempt + 1);
        continue;
      }
      if (code !== "P2034" && code !== "P2002") throw error;
    }
  }
  if (joined === null) {
    // A final fresh read distinguishes the original formation race from
    // ordinary queue contention instead of falsely calling both a live game.
    const [inActiveLobby, inQueue] = await Promise.all([
      prisma.inhouseLobbyPlayer.findFirst({
        where: {
          userId: viewer.id,
          lobby: { status: { in: INHOUSE_ACTIVE_STATUSES } },
        },
        select: { id: true },
      }),
      prisma.inhouseQueueEntry.findUnique({
        where: { userId: viewer.id },
        select: { id: true },
      }),
    ]);
    if (inActiveLobby) {
      return { ok: false, error: "You're already in a live inhouse" };
    }
    if (!inQueue) {
      return { ok: false, error: "The queue changed — please try joining again" };
    }
    joined = true;
  }
  if (!joined) {
    return { ok: false, error: "You're already in a live inhouse" };
  }
  const formed = await maybeFormLobby();

  // "Almost there" Discord ping: only when THIS join crosses the milestone
  // upward (so hovering at the threshold stays quiet), never on the join that
  // formed a lobby (that gets its own announcement), and at most once per
  // throttle window so leave/rejoin churn can't spam the channel.
  if (!formed) {
    const milestone = INHOUSE.QUEUE_PING_AT;
    const presentAfter = await prisma.inhouseQueueEntry.count({
      where: { lastSeenAt: { gte: queuePresentCutoff(Date.now()) } },
    });
    if (
      presentBefore < milestone &&
      presentAfter >= milestone &&
      (await claimQueuePingThrottle(Date.now()))
    ) {
      const roleId = await getInhousePingRoleId();
      await sendInhouseDiscordMessage(
        inhouseQueueMessage(presentAfter, INHOUSE.LOBBY_SIZE, roleId),
        { roles: roleId ? [roleId] : [] },
      );
    }
  }
  return { ok: true };
}

/**
 * Atomic spam throttle for the queue ping. Delegates to settings.claimThrottle
 * — this function was a byte-for-byte semantic copy of it (same
 * update-where-stale → findUnique → create-catch-P2002 sequence, same
 * staleness math; the canonical ordering rationale lives on claimThrottle).
 * Exactly one of two concurrent milestone-crossing joins wins.
 */
async function claimQueuePingThrottle(nowMs: number): Promise<boolean> {
  return claimThrottle(
    SETTING_KEYS.INHOUSE_QUEUE_PING_AT,
    INHOUSE.QUEUE_PING_MIN_MINUTES * 60,
    nowMs,
  );
}

/**
 * Refresh availability without renewing the shared idle deadline or requiring
 * a browser tab to stay foregrounded. The conditional update only writes
 * once per QUEUE_HEARTBEAT_SECONDS, so pollers don't hammer the DB.
 */
async function touchQueueHeartbeat(viewerId: string): Promise<void> {
  const staleBefore = new Date(
    Date.now() - INHOUSE.QUEUE_HEARTBEAT_SECONDS * 1000,
  );
  await prisma.inhouseQueueEntry.updateMany({
    where: { userId: viewerId, lastSeenAt: { lt: staleBefore } },
    data: { lastSeenAt: new Date() },
  });
}

/** Remove the current user from the queue. No-op if they're not queued. */
export async function leaveQueue(
  viewer: SessionUser,
): Promise<InhouseActionResult> {
  await prisma.$transaction(async (tx) => {
    const now = Date.now();
    const expired = await expireStaticQueue(tx, now);
    const queued = await tx.inhouseQueueEntry.findUnique({
      where: { userId: viewer.id },
      select: { id: true },
    });
    if (expired.count > 0 || queued) {
      // Take the shared queue locks before deleting the caller's row. Two
      // simultaneous leaves then serialize instead of cross-locking A and B.
      await refreshQueueIdleDeadline(tx, now);
    }
    await tx.inhouseQueueEntry.deleteMany({
      where: { userId: viewer.id },
    });
  });
  return { ok: true };
}

/**
 * OPTIONAL: mark the game as started once teams are set. It starts the room's
 * game clock and shows the game as live on the Discord board; nothing depends
 * on it any more — the result scan and "Record by match ID" run from READY
 * too, so a group that goes straight into Dota is recorded all the same.
 */
export async function startGame(
  viewer: SessionUser,
): Promise<InhouseActionResult> {
  return prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.READY },
      include: { players: true },
    });
    if (!lobby)
      return { ok: false as const, error: "No lobby is ready to start" };
    const isMember = lobby.players.some((p) => p.userId === viewer.id);
    if (!isMember && viewer.role !== "ADMIN") {
      return {
        ok: false as const,
        error: "Only players in the lobby can start it",
      };
    }
    // Guarded claim, not a write-by-id: an admin cancel committing between the
    // read above and this write would be silently reverted, putting ten
    // players in a live lobby AND back in the queue (cancelLobby re-queues
    // them).
    const started = await tx.inhouseLobby.updateMany({
      where: { id: lobby.id, status: INHOUSE_STATUS.READY },
      data: {
        status: INHOUSE_STATUS.IN_PROGRESS,
        startedById: viewer.id,
        startedAt: new Date(),
      },
    });
    if (started.count === 0) {
      // A READY lobby can now also close on its result, so the rival that won
      // is not necessarily a cancel.
      return {
        ok: false as const,
        error: "That game just finished or was cancelled",
      };
    }
    return { ok: true as const };
  });
}

// ---- Result recording (OpenDota only — no manual winner) ------------------

type LobbyPlayerFull = {
  userId: string;
  team: number | null;
  user: {
    name: string;
    dotaAccountIdV2: number | null;
    legacyDotaAccountId: number | null;
    steamId: string;
  };
};

// One per-player line of the stored box score (mirrors the league Game blob).
// Aliased to the readers' type so the writer/reader contract for
// InhouseLobby.boxScore is compiler-enforced, not comment-enforced.
type BoxScorePlayer = InhouseBoxPlayer;

type BuiltResult = {
  winnerTeam: number;
  radiantTeam: number;
  dotaMatchId: string;
  durationSecs: number;
  radiantScore: number;
  direScore: number;
  boxScore: BoxScorePlayer[];
  startTime: number;
  /**
   * Players whose PLAYED side didn't match the team they were drafted onto —
   * see the reconciliation note in buildResult. `team` is the side they
   * actually played; applyResult writes it back before rating the game.
   */
  teamFixes: { userId: string; team: number }[];
};

/**
 * Validate a fetched OpenDota match against the lobby's two rosters and, if it's
 * genuinely this game, build the full result + per-player box score. Returns
 * null when the match isn't between these teams. Reuses the unit-tested
 * classifyGame (rosters on opposite sides → winner + which side was Radiant).
 */
function buildResult(
  od: OpenDotaMatch,
  players: LobbyPlayerFull[],
  minPerSide = 3,
): BuiltResult | null {
  const accountMap = new Map<
    number,
    { userId: string; name: string; team: number }
  >();
  const team1 = new Set<number>();
  const team2 = new Set<number>();
  for (const p of players) {
    const acc = effectiveDotaAccountId(p.user);
    if (acc == null || p.team == null) continue;
    accountMap.set(acc, { userId: p.userId, name: p.user.name, team: p.team });
    (p.team === 1 ? team1 : team2).add(acc);
  }
  if (team1.size === 0 || team2.size === 0) return null;

  // A zero-length "game" can't be a played inhouse (same convention as the
  // league records page: unreported ≠ data) — refuse to close the lobby on one.
  if (!od.duration || od.duration <= 0) return null;

  const cls = classifyGame(
    od,
    { teamId: "1", accountIds: team1 },
    { teamId: "2", accountIds: team2 },
    minPerSide,
  );
  if (!cls.ok || !cls.winnerTeamId) return null;

  const radiantTeam = cls.radiantTeamId === "1" ? 1 : 2;
  const direTeam = radiantTeam === 1 ? 2 : 1;

  // Reconcile the DRAFT against what was actually played. Nothing enforces
  // sides in the manually hosted Dota lobby — players click their own slots —
  // and classifyGame's side assignment is a tolerant MAJORITY vote (it exists
  // for league games, where a standin may be unknown to us). So a 1-for-1 slot
  // mix-up still classifies fine, and the two players who swapped end up
  // credited with the opposite of what they did: a win and a positive Elo
  // swing for the player who actually lost, and vice versa — while the result
  // card lists them in the other side's column, because it groups by the
  // game's real `isRadiant`. The PLAYED game is the truth, so we move them
  // rather than reject the match (rejecting would strand the lobby in play
  // and block the single active slot until an admin cancelled).
  // isCaptain is deliberately left alone — who captained the draft is a fact
  // about the draft, not about which side they ended up on.
  const teamFixes: { userId: string; team: number }[] = [];

  const boxScore: BoxScorePlayer[] = od.players.map((pl) => {
    const isRadiant = pl.isRadiant ?? pl.player_slot < 128;
    const m = pl.account_id != null ? accountMap.get(pl.account_id) : undefined;
    const playedTeam = isRadiant ? radiantTeam : direTeam;
    if (m && m.team !== playedTeam) {
      teamFixes.push({ userId: m.userId, team: playedTeam });
    }
    return {
      userId: m?.userId ?? null,
      name: m?.name ?? pl.personaname ?? null,
      // The side they played, not the side they were drafted onto — so the
      // stored box score can't disagree with the roster it's rendered beside.
      team: m ? playedTeam : null,
      isRadiant,
      heroId: pl.hero_id,
      kills: pl.kills,
      deaths: pl.deaths,
      assists: pl.assists,
      netWorth: pl.net_worth ?? null,
      gpm: pl.gold_per_min ?? null,
      lastHits: pl.last_hits ?? null,
    };
  });

  return {
    winnerTeam: cls.winnerTeamId === "1" ? 1 : 2,
    radiantTeam,
    dotaMatchId: String(od.match_id),
    durationSecs: od.duration,
    radiantScore: od.radiant_score ?? 0,
    direScore: od.dire_score ?? 0,
    boxScore,
    startTime: od.start_time,
    teamFixes,
  };
}

/**
 * Write a built result onto the lobby and close it out. Guarded: only a lobby
 * being played (READY or IN_PROGRESS — Start is optional) can complete, and
 * only one caller wins the claim — an admin cancel (or a rival record with a
 * different match id) racing the slow OpenDota fetch must never be
 * overwritten, and a CANCELLED lobby must never resurrect as COMPLETED. The
 * claim winner stamps per-player Elo deltas and transactionally queues the
 * Discord announcement. A claimed outbox worker sends it after commit and
 * retries through the site heartbeat.
 */
async function applyResult(lobbyId: string, r: BuiltResult): Promise<boolean> {
  // The claim AND the teamFixes loop commit together, as one transaction.
  //
  // The claim on its own would commit a COMPLETED lobby still carrying the
  // DRAFT roster, and a reader in that gap rates it wrong: the result
  // reconciler (reconcileMissingInhouseResultAnnouncements, run by the
  // automation worker) stamps Elo off `InhouseLobbyPlayer.team`, so a slot swap
  // would credit the win to a player who actually lost. If the request dies
  // before the loop lands, everything rolls back and a retry is byte-identical
  // to the happy path.
  //
  // The Elo scan deliberately stays OUTSIDE — it is a full-history read that
  // has no business holding a write transaction open.
  // Computed OUT HERE, not inline in the claim's `data` below — and that is not
  // a style choice. scripts/mutation-guard.mjs parses these writes to find the
  // claims it ratchets, and an inline ternary in `data` made it stop seeing this
  // one entirely: the claim went [GONE] against a baseline that still listed it,
  // which is the ratchet's "a guard was removed or weakened" alarm. It fired on
  // CI while a local --discover had been green, because the discover ran BEFORE
  // the inline version was written. Keep `data` a flat object literal; hoist any
  // expression that needs a conditional.
  //
  // `matchStartTime` is Valve's own start_time for the played game, persisted
  // so the archive, the player profile and the board can date a game by when
  // it was actually played (`matchStartTime ?? startedAt ?? createdAt`). Both
  // result paths already floor start_time at the lobby createdAt (recordMatch
  // refuses below it; findInhouseGame skips below it), so a 0 or missing value
  // cannot arrive today; the guard stays so a future third result path can
  // never date a game to 1970. Null falls back to the next date in that chain.
  const matchStart =
    Number.isFinite(r.startTime) && r.startTime > 0
      ? new Date(r.startTime * 1000)
      : null;
  // Stable result recency, never `updatedAt`. Hoisted to keep the guarded
  // claim's data block flat for the mutation ratchet (same rule as matchStart
  // immediately above).
  const completedAt = new Date();
  // The durable announcement commits with COMPLETED, so a process death after
  // this transaction can no longer erase the result itself.
  const resultContent = inhouseResultAnnouncementContent(r);

  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.inhouseLobby.updateMany({
      where: { id: lobbyId, status: { in: INHOUSE_PLAYING_STATUSES } },
      data: {
        status: INHOUSE_STATUS.COMPLETED,
        completedAt,
        winnerTeam: r.winnerTeam,
        radiantTeam: r.radiantTeam,
        dotaMatchId: r.dotaMatchId,
        durationSecs: r.durationSecs,
        radiantScore: r.radiantScore,
        direScore: r.direScore,
        boxScore: JSON.stringify(r.boxScore),
        matchStartTime: matchStart, // see the note above the claim
      },
    });
    // THE LAST LEGAL RETURN in this callback — nothing has been written.
    if (claim.count === 0) return false;

    // Seam: the claim is written but NOT committed. This is the window the
    // transaction exists to close — no reader may see a COMPLETED lobby
    // carrying the DRAFT roster. A test yields here and kills this request;
    // racing cannot steer an interleaving this narrow.
    await raceHook("inhouse.applyResult.beforeTeamFixes");

    // Move anyone who played the opposite side onto the side they actually
    // played (see buildResult). Inside the claim's transaction so no reader
    // can ever see a COMPLETED lobby carrying the draft's roster —
    // summarizeInhouse rates off InhouseLobbyPlayer.team, so a visible
    // half-state would mis-rate the game.
    for (const fix of r.teamFixes) {
      await tx.inhouseLobbyPlayer.updateMany({
        where: { lobbyId, userId: fix.userId },
        data: { team: fix.team },
      });
    }
    await tx.inhouseAnnouncement.create({
      data: {
        lobbyId,
        kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        sequence: 1,
        content: resultContent,
        resultMatchId: r.dotaMatchId,
      },
    });
    await stampResultChange(tx);
    return true;
  });
  if (!claimed) return false;

  // Exact process-death seam: everything above is committed, while the Elo
  // stamp has not started. The heartbeat reconciler must be able to finish
  // from columns alone after this point.
  await raceHook("inhouse.applyResult.afterPrimaryCommit");

  // Stamp each participant's Elo swing from THIS game: the lobby is now the
  // newest completed one, so summarizeInhouse's lastChange IS this game's
  // delta. One history scan per completion — the room's post-game banner
  // reads the stored map instead of re-deriving the ladder every poll.
  const history = await prisma.inhouseLobby.findMany({
    where: { status: INHOUSE_STATUS.COMPLETED },
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
  const recs = summarizeInhouse(history.map(toFinishedLobby));
  const thisLobby = history.find((l) => l.id === lobbyId);
  const participants = new Set(thisLobby?.players.map((p) => p.userId) ?? []);
  const deltas: Record<string, number> = {};
  for (const rec of recs) {
    if (participants.has(rec.userId)) deltas[rec.userId] = rec.lastChange;
  }

  // A completed result is still voidable while the history is being scanned.
  // The old update-by-id below could therefore restore eloDeltas on a
  // CANCELLED lobby, then publish a stale result after the void correction.
  // Yield while everything is still read-only so the exact interleaving can be
  // tested without deadlocking a rival on this row.
  await raceHook("inhouse.applyResult.beforeFinalizationClaim");

  // Finalize only if this exact result is still current. COMPLETED already
  // committed with its outbox row; this transaction stamps Elo. No network
  // call runs while this transaction is open. voidLastResult serializes
  // publication through the same outbox:
  //
  //   * either way, the void cancels a still-unsent result or queues its
  //     correction behind an already-leased/sent one;
  //   * if the void wins first, this claim also loses, so no Elo is stamped.
  const finalized = await prisma.$transaction(async (tx) => {
    const claim = await tx.inhouseLobby.updateMany({
      where: {
        id: lobbyId,
        status: INHOUSE_STATUS.COMPLETED,
        dotaMatchId: r.dotaMatchId,
      },
      data: { eloDeltas: JSON.stringify(deltas) },
    });
    if (claim.count === 0) return false;
    await stampResultChange(tx);
    return true;
  });
  if (!finalized) return false;

  // Preserve the immediate announcement when Discord is healthy, but only
  // AFTER the result + outbox transaction commits. A false/throw leaves the
  // row PENDING for the sitewide sync heartbeat instead of burning the event.
  try {
    await deliverInhouseAnnouncements({ lobbyId });
  } catch {
    console.error(
      "[inhouse-announcement] immediate delivery failed (DELIVERY_FAILED)",
    );
  }
  return true;
}

/**
 * Find this inhouse game on OpenDota: scan the 10 players' recent matches (in
 * parallel), take the one they share, validate it, and return the most recent
 * match that started after the lobby formed — so a prior game with the same
 * players can't be mistaken for this one. `unreachable` = every recent-list
 * fetch failed (OpenDota down / rate-limited), which the caller must not
 * present as "your match data is private".
 */
async function findInhouseGame(
  players: LobbyPlayerFull[],
  floorSeconds: number,
  options: OpenDotaFetchOptions = {},
): Promise<{
  result: BuiltResult | null;
  unreachable: boolean;
  deadlineReached?: boolean;
}> {
  const accounts = players
    .map((p) => effectiveDotaAccountId(p.user))
    .filter((a): a is number => a != null);
  if (accounts.length === 0) return { result: null, unreachable: false };
  if (!canStartOpenDotaFetch(options)) {
    return { result: null, unreachable: false, deadlineReached: true };
  }

  const lists = await Promise.all(
    accounts.map((acc) => fetchRecentMatchIds(acc, 10, options)),
  );
  if (!canStartOpenDotaFetch(options) || openDotaBudgetExpired(options)) {
    return { result: null, unreachable: false, deadlineReached: true };
  }
  // A game shared by fewer than this many of our players isn't a candidate.
  const MIN_SHARED = 4;
  const reachable = lists.filter((l) => l !== null).length;
  // "OpenDota was the problem" is not just the all-failed case. Every list is
  // a vote, and a candidate needs MIN_SHARED of them — so once enough fetches
  // 429 that the survivors CAN'T reach the threshold, detection is
  // structurally impossible no matter how public everyone's data is. Reporting
  // that as "turn on Expose Public Match Data" sends ten players hunting
  // through Dota settings for a problem they don't have. Both clauses matter:
  // the second requires a fetch to have actually failed, so a lobby that
  // simply has too few resolvable accounts isn't blamed on OpenDota either.
  const unreachable =
    reachable === 0 || (reachable < accounts.length && reachable < MIN_SHARED);
  const counts = new Map<number, number>();
  for (const ids of lists) {
    for (const id of ids ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  // A game shared by several of our players is a candidate; buildResult does the
  // real validation. Cap the full-match fetches to keep API usage sane.
  const candidateIds = [...counts.entries()]
    .filter(([, c]) => c >= MIN_SHARED)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id]) => id);
  if (candidateIds.length === 0) return { result: null, unreachable };

  if (!canStartOpenDotaFetch(options)) {
    return { result: null, unreachable, deadlineReached: true };
  }

  const matches = await Promise.all(
    candidateIds.map((id) => fetchOpenDotaMatch(String(id), options)),
  );
  if (!canStartOpenDotaFetch(options) || openDotaBudgetExpired(options)) {
    return { result: null, unreachable, deadlineReached: true };
  }
  let best: BuiltResult | null = null;
  for (const od of matches) {
    if (!od || od.start_time < floorSeconds) continue;
    const r = buildResult(od, players);
    if (r && (!best || r.startTime > best.startTime)) best = r;
  }
  return { result: best, unreachable };
}

/**
 * One result lookup for a lobby being played, shared by the scheduled scan
 * and the manual "Check now" so the two can never look in different places.
 *
 * When the lobby bot launched the game, the bot's match id comes first: one
 * OpenDota match lookup instead of ten recent-match lists, validated exactly
 * like a pasted id (checkMatchForLobby). The history scan stays the fallback —
 * for games hosted without the bot, a bot id that isn't this lobby's game, and
 * a bot game OpenDota still lacks DETECT_BOT_MATCH_WAIT_MINUTES after the
 * detect clock (`clockMs`) started. Before that, a bot game OpenDota hasn't
 * published is `botGamePending`: the history scan can't find an unpublished
 * game either, so it isn't spent.
 */
async function lookUpLobbyGame(
  lobby: { id: string; radiantTeam: number; createdAt: Date },
  players: (LobbyPlayerFull & { isCaptain: boolean })[],
  clockMs: number,
  nowMs: number,
  options: OpenDotaFetchOptions = {},
): Promise<{
  found: BuiltResult | null;
  deadlineReached: boolean;
  /** The history scan couldn't reach enough of OpenDota to decide. */
  unreachable: boolean;
  botGamePending: boolean;
}> {
  let found: BuiltResult | null = null;
  let scanHistories = true;
  let botGamePending = false;
  // The bot read never throws: no bot, an unreachable one, or a game it didn't
  // host all come back without a match id, and the history scan runs as ever.
  const botMatchId = botReportedMatchId(
    await inhouseBotGameStatus(
      { id: lobby.id, radiantTeam: lobby.radiantTeam, players },
      options,
    ),
  );
  if (botMatchId) {
    const od = await fetchOpenDotaMatch(botMatchId, options);
    if (!canStartOpenDotaFetch(options) || openDotaBudgetExpired(options)) {
      return {
        found: null,
        deadlineReached: true,
        unreachable: false,
        botGamePending: false,
      };
    }
    if (od) {
      // Never recorded on the bot's word alone: the same floor and roster
      // check as a pasted id. A game that fails them isn't this lobby's, so
      // look through the players' histories instead.
      const checked = checkMatchForLobby(od, lobby.createdAt, players);
      if (checked.ok) found = checked.result;
    } else {
      // Not on OpenDota yet — the game is still running or still publishing.
      // One lookup per interval until then, not the ten-player scan.
      scanHistories =
        nowMs - clockMs >= INHOUSE.DETECT_BOT_MATCH_WAIT_MINUTES * 60_000;
      botGamePending = !scanHistories;
    }
  }
  if (found || !scanHistories) {
    return { found, deadlineReached: false, unreachable: false, botGamePending };
  }
  const scanned = await findInhouseGame(
    players,
    Math.floor(lobby.createdAt.getTime() / 1000),
    options,
  );
  return {
    found: scanned.result,
    deadlineReached: scanned.deadlineReached === true,
    unreachable: scanned.unreachable,
    botGamePending: false,
  };
}

// Both manual result paths run from READY as well as IN_PROGRESS: a lobby is
// being played from the moment teams lock, whether or not anyone pressed Start.
const NO_GAME_TO_RECORD = "There's no game to record right now";

/**
 * On-demand "Check now": the same lookup as the scheduled scan
 * (lookUpLobbyGame) — the lobby bot's match id when the bot launched the
 * game, otherwise the players' recent games, which needs public match data.
 */
export async function autoDetectResult(
  viewer: SessionUser,
): Promise<InhouseActionResult> {
  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: { in: INHOUSE_PLAYING_STATUSES } },
    include: { players: { include: { user: true } } },
  });
  if (!lobby) return { ok: false, error: NO_GAME_TO_RECORD };
  if (
    !lobby.players.some((p) => p.userId === viewer.id) &&
    viewer.role !== "ADMIN"
  ) {
    return { ok: false, error: "Only players in the game can do that" };
  }
  // Throttled claim, not a blind stamp. Each press is ~16 OpenDota calls, and
  // ten impatient players hammering the button after a game burned hundreds —
  // enough to exhaust the free daily budget and take LEAGUE result sync down
  // with it. The background scanner already claims this way; the manual button
  // bypassed it entirely.
  const claim = await prisma.inhouseLobby.updateMany({
    where: {
      id: lobby.id,
      status: { in: INHOUSE_PLAYING_STATUSES },
      OR: [
        { detectedAt: null },
        {
          detectedAt: {
            lt: new Date(Date.now() - INHOUSE.DETECT_MANUAL_GAP_SECONDS * 1000),
          },
        },
      ],
    },
    data: { detectedAt: new Date() },
  });
  if (claim.count === 0) {
    return {
      ok: false,
      error: "Just checked — give it a few seconds and try again",
    };
  }
  // The press's claim stamps detectedAt, which holds the scheduled scan off
  // for an interval, so the press does the scan's whole job — bot id first.
  const now = Date.now();
  const clockMs =
    inhouseDetectWindow({
      status: lobby.status,
      createdAtMs: lobby.createdAt.getTime(),
      startedAtMs: lobby.startedAt?.getTime() ?? null,
    })?.clockMs ?? lobby.createdAt.getTime();
  const { found, unreachable, botGamePending } = await lookUpLobbyGame(
    lobby,
    lobby.players,
    clockMs,
    now,
  );
  if (!found) {
    // Don't blame players' privacy settings when OpenDota itself was the
    // problem, or when the bot hosted the game and knows its id — the fixes
    // are completely different.
    return {
      ok: false,
      error: botGamePending
        ? "The bot's game isn't on OpenDota yet. It usually shows up a few minutes after the game ends, and the result records itself then."
        : unreachable
          ? "OpenDota didn't respond (down or rate-limited) — try again in a minute, or paste the match ID."
          : `Couldn't find the game on OpenDota yet — make sure it's finished, the ${INHOUSE.LOBBY_TICKET} ticket was used, and players have 'Expose Public Match Data' on. You can also paste the match ID.`,
    };
  }
  if (!(await applyResult(lobby.id, found))) {
    return {
      ok: false,
      error:
        "The lobby closed while we fetched — the result is already in (or an admin cancelled it).",
    };
  }
  return { ok: true };
}

/**
 * The record-by-match-ID check, shared by a pasted id and the lobby bot's id.
 * A given id is trusted this far and no further:
 *   - the game must have started after this lobby formed — the floor
 *     findInhouseGame enforces too, so a PRIOR game between the same ten
 *     (yesterday's inhouse, a rematch id typo) can never close this one;
 *   - the classifyGame roster check must find at least two linked players per
 *     side. That is thinner than the background scan's three: someone vouched
 *     for this specific id (a player pasting it, or the bot that hosted it),
 *     and it is the escape hatch for lobbies where most players have
 *     "Expose Public Match Data" off.
 */
function checkMatchForLobby(
  od: OpenDotaMatch,
  lobbyCreatedAt: Date,
  players: LobbyPlayerFull[],
):
  | { ok: true; result: BuiltResult }
  | { ok: false; reason: "before-lobby" | "not-these-teams" } {
  if (od.start_time < Math.floor(lobbyCreatedAt.getTime() / 1000))
    return { ok: false, reason: "before-lobby" };
  const result = buildResult(od, players, 2);
  return result
    ? { ok: true, result }
    : { ok: false, reason: "not-these-teams" };
}

/** Record the result from a specific Dota match id/URL (fetched via OpenDota). */
export async function recordMatch(
  viewer: SessionUser,
  input: string,
): Promise<InhouseActionResult> {
  const matchId = parseMatchId(input);
  if (!matchId)
    return { ok: false, error: "Enter a valid Dota match ID or link" };

  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: { in: INHOUSE_PLAYING_STATUSES } },
    include: { players: { include: { user: true } } },
  });
  if (!lobby) return { ok: false, error: NO_GAME_TO_RECORD };
  if (
    !lobby.players.some((p) => p.userId === viewer.id) &&
    viewer.role !== "ADMIN"
  ) {
    return { ok: false, error: "Only players in the game can do that" };
  }

  const providerClaim = await claimProviderCooldown(
    "open-dota-match-import",
    viewer.id,
    `inhouse:${lobby.id}`,
  );
  if (providerClaim === "cooldown") {
    return {
      ok: false,
      error:
        "A Dota match ID was checked for this lobby recently — wait about a minute before trying another ID",
    };
  }
  if (providerClaim === "unavailable") {
    return {
      ok: false,
      error:
        "Couldn't safely start the OpenDota lookup — wait a minute and try again",
    };
  }

  const od = await fetchOpenDotaMatch(matchId);
  if (!od) {
    return {
      ok: false,
      error:
        "Couldn't fetch that match from OpenDota (is the ID right and public?)",
    };
  }
  const checked = checkMatchForLobby(od, lobby.createdAt, lobby.players);
  if (!checked.ok) {
    return {
      ok: false,
      error:
        checked.reason === "before-lobby"
          ? "That match started before this lobby formed — wrong game?"
          : "Couldn't match that game to these teams — at least two linked players per side need public match data (check the ID too).",
    };
  }
  if (!(await applyResult(lobby.id, checked.result))) {
    return {
      ok: false,
      error:
        "The lobby closed while we fetched — the result is already in (or an admin cancelled it).",
    };
  }
  return { ok: true };
}

/**
 * Automatic, throttled result detection run during maintenance: once a game
 * has been going long enough, quietly try OpenDota at most once per interval
 * and close the lobby out if we find it. It claims the attempt atomically so
 * concurrent worker/room recovery calls do not all scan. Idempotent.
 *
 * Runs for a lobby being played — READY or IN_PROGRESS — on the clock
 * inhouseDetectWindow picks, so ten players who go straight into Dota without
 * pressing the optional Start are still recorded.
 *
 * The lookup itself (the lobby bot's match id first, then the players'
 * histories) is lookUpLobbyGame, shared with the manual "Check now".
 */
export function maybeAutoDetectResult(): Promise<boolean>;
export function maybeAutoDetectResult(
  options: OpenDotaFetchOptions,
): Promise<{ recorded: boolean; deadlineReached: boolean }>;
export async function maybeAutoDetectResult(
  options?: OpenDotaFetchOptions,
): Promise<boolean | { recorded: boolean; deadlineReached: boolean }> {
  const detailed = options !== undefined;
  const finish = (recorded: boolean, deadlineReached = false) =>
    detailed ? { recorded, deadlineReached } : recorded;
  const fetchOptions = options ?? {};
  if (!canStartOpenDotaFetch(fetchOptions)) return finish(false, true);

  const now = Date.now();
  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: { in: INHOUSE_PLAYING_STATUSES } },
    // Most maintenance passes find a fresh game or an existing cooldown. Read
    // only its clocks first; neither case needs the ten player/user records or
    // any of the lobby's stored result JSON.
    select: {
      id: true,
      status: true,
      createdAt: true,
      startedAt: true,
      detectedAt: true,
      radiantTeam: true,
    },
  });
  if (!lobby) return finish(false);
  const detectWindow = inhouseDetectWindow({
    status: lobby.status,
    createdAtMs: lobby.createdAt.getTime(),
    startedAtMs: lobby.startedAt?.getTime() ?? null,
  });
  if (!detectWindow || now < detectWindow.opensAtMs) {
    return finish(false); // too early — the game can't be over yet
  }

  // Claim this attempt so only one concurrent poll actually hits OpenDota.
  // The interval stretches with the game's age (pure detectIntervalSeconds):
  // a normal game scans every DETECT_INTERVAL_SECONDS, an abandoned lobby
  // nobody cancels decays to one scan per DETECT_INTERVAL_MAX_SECONDS.
  const interval = detectIntervalSeconds(now - detectWindow.clockMs);
  const cutoff = new Date(now - interval * 1000);
  if (lobby.detectedAt && lobby.detectedAt >= cutoff) return finish(false);
  // Either playing status may hold the claim: a Start (or the bot's launch)
  // landing mid-scan moves READY to IN_PROGRESS without ending the game.
  const claim = await prisma.inhouseLobby.updateMany({
    where: {
      id: lobby.id,
      status: { in: INHOUSE_PLAYING_STATUSES },
      OR: [{ detectedAt: null }, { detectedAt: { lt: cutoff } }],
    },
    data: { detectedAt: new Date(now) },
  });
  if (claim.count === 0) return finish(false);

  // Only the claim winner needs a roster. Re-check the exact live claim while
  // loading it so a cancellation or successor scan that already committed
  // cannot spend provider requests. Keep both Dota identity columns for the
  // rollback-safe override chain, plus the Steam fallback and display name.
  const players = await prisma.inhouseLobbyPlayer.findMany({
    where: {
      lobbyId: lobby.id,
      lobby: {
        status: { in: INHOUSE_PLAYING_STATUSES },
        detectedAt: new Date(now),
      },
    },
    select: {
      userId: true,
      team: true,
      isCaptain: true,
      user: {
        select: {
          name: true,
          dotaAccountIdV2: true,
          legacyDotaAccountId: true,
          steamId: true,
        },
      },
    },
  });
  // An empty roster means a rival moved the lobby or the claim on first.
  if (players.length === 0) return finish(false);

  const { found, deadlineReached } = await lookUpLobbyGame(
    lobby,
    players,
    detectWindow.clockMs,
    now,
    fetchOptions,
  );
  if (deadlineReached) {
    // The attempt did not finish, so it must not buy a full backoff interval.
    // Restore only the exact claim this invocation stamped; a newer poll or an
    // admin result can never be overwritten by a timed-out worker.
    await raceHook("inhouse.autoDetect.beforeDeadlineRollback");
    await prisma.inhouseLobby.updateMany({
      where: {
        id: lobby.id,
        status: { in: INHOUSE_PLAYING_STATUSES },
        detectedAt: new Date(now),
      },
      data: { detectedAt: lobby.detectedAt },
    });
    return finish(false, true);
  }
  if (!found) return finish(false);
  return finish(await applyResult(lobby.id, found));
}

/** Admin: scrap the current lobby (stuck draft, no-shows). Players can requeue. */
/**
 * Void the most recently completed inhouse result (admin).
 *
 * Results are recorded from OpenDota, so the wrong game can be picked up — ten
 * players running back-to-back games in one custom lobby will have several
 * candidates, and the scan takes the shared one that started after formation.
 * Before this there was no way back: no re-record, no delete, and the Elo
 * swing was already stamped. Flipping the lobby to CANCELLED drops it from the
 * ladder and history queries (both filter on COMPLETED), and because
 * summarizeInhouse accumulates Elo over the surviving lobbies, every player's
 * rating recomputes correctly on the next read.
 */
export async function voidLastResult(
  viewer: SessionUser,
  lobbyId?: string | null,
): Promise<InhouseActionResult> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  // With an explicit lobbyId, void THAT game — the /inhouse/history admin
  // control names its target, so a result completing between the admin's look
  // and their click can never redirect the void (the old newest-by-updatedAt
  // lookup voided whatever finished most recently at click time). The bare
  // form stays for the room's post-game banner, whose gate already pins the
  // viewer to the game it shows.
  const last = lobbyId
    ? await prisma.inhouseLobby.findFirst({
        where: { id: lobbyId, status: INHOUSE_STATUS.COMPLETED },
      })
    : ((await prisma.inhouseLobby.findFirst({
        // PostgreSQL sorts NULLS FIRST for DESC while SQLite sorts them last.
        // Excluding null here makes the stamped-result order provider-stable;
        // the second query keeps pre-completedAt history voidable after deploy.
        where: {
          status: INHOUSE_STATUS.COMPLETED,
          completedAt: { not: null },
        },
        orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      })) ??
      (await prisma.inhouseLobby.findFirst({
        where: {
          status: INHOUSE_STATUS.COMPLETED,
          completedAt: null,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })));
  if (!last) {
    return {
      ok: false,
      error: lobbyId
        ? "That game isn't a completed result — it may already be voided"
        : "No completed game to void",
    };
  }

  const voidContent = inhouseResultVoidedMessage({
    dotaMatchId: last.dotaMatchId,
  });

  // Guarded claim + durable correction. If the result has not started sending,
  // cancel it in the same transaction so Discord never receives a result that
  // was already void by commit time. A SENDING result is left alone because the
  // webhook may already have accepted it; sequence 2 then waits behind it and
  // publishes the correction afterwards.
  const voided = await prisma.$transaction(async (tx) => {
    const claim = await tx.inhouseLobby.updateMany({
      where: { id: last.id, status: INHOUSE_STATUS.COMPLETED },
      data: {
        status: INHOUSE_STATUS.CANCELLED,
        // The claim nulls the match id below; the reason keeps it on record.
        endReason: resultVoidedReason(viewer.name, last.dotaMatchId),
        winnerTeam: null,
        dotaMatchId: null,
        durationSecs: null,
        radiantScore: null,
        direScore: null,
        boxScore: "[]",
        eloDeltas: "{}",
      },
    });
    if (claim.count === 0) return false;
    await tx.inhouseAnnouncement.updateMany({
      where: {
        lobbyId: last.id,
        kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        status: INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
      },
      data: { status: INHOUSE_ANNOUNCEMENT_STATUS.CANCELLED },
    });
    await tx.inhouseAnnouncement.create({
      data: {
        lobbyId: last.id,
        kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT_VOIDED,
        sequence: 2,
        content: voidContent,
        resultMatchId: last.dotaMatchId,
      },
    });
    return true;
  });
  if (!voided) {
    return { ok: false, error: "That result was already voided" };
  }
  // The lobby cancellation and correction outbox are durable at this point.
  // Signal before the cursor and audit follow-ups so neither best-effort step
  // can hide the correction from a sleeping worker.
  invalidateAutomationGateBestEffort();
  await stampResultChange();

  // Post-claim, so only the winner of a concurrent void writes the record —
  // the cancelLobby ordering. The lobby reads CANCELLED like any abandoned
  // game, the Elo swing simply recomputes away, and the claim has nulled the
  // match id that would identify the game. The AdminAction row IS the whole
  // record, which is why the id goes in the summary rather than being left to
  // a join that has nothing to join against.
  await logAdminAction({
    action: "voidLastResult",
    summary: `Voided the inhouse result${
      last.dotaMatchId ? ` (match ${last.dotaMatchId})` : ""
    }`,
  });

  // Every successful void corrects Discord: the published winner is now false.
  // The outbox event was committed with the state flip above, and this
  // post-commit attempt preserves the old immediate UX without making a
  // transport failure permanent. It rides the ALERT webhook, never the board's.
  try {
    await deliverInhouseAnnouncements({ lobbyId: last.id });
  } catch {
    console.error(
      "[inhouse-announcement] void delivery failed (DELIVERY_FAILED)",
    );
  }
  return { ok: true };
}

export async function cancelLobby(
  viewer: SessionUser,
): Promise<InhouseActionResult> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
  });
  if (!lobby) return { ok: false, error: "No active lobby" };
  const players = await prisma.inhouseLobbyPlayer.findMany({
    where: { lobbyId: lobby.id },
    select: { userId: true, mmr: true, queuedAt: true },
  });
  const requeuePlayers = [...players].sort(
    (a, b) =>
      a.queuedAt.getTime() - b.queuedAt.getTime() ||
      a.userId.localeCompare(b.userId),
  );
  const cancelled = await prisma.$transaction(async (tx) => {
    // Guarded transition: if the result landed between the admin's read and
    // this write (auto-detect closing the lobby mid-confirm-dialog), the
    // cancel must lose — a played game keeps its result and nobody re-queues.
    const claim = await tx.inhouseLobby.updateMany({
      where: {
        id: lobby.id,
        status: { in: INHOUSE_ACTIVE_STATUSES },
      },
      data: {
        status: INHOUSE_STATUS.CANCELLED,
        pickTeam: null,
        pickEndsAt: null,
        endReason: adminCancelReason(viewer.name, lobby.status),
      },
    });
    if (claim.count === 0) return false;
    // Put everyone back in the queue so a cancelled lobby (wrong captains,
    // someone AFK, …) re-forms with a fresh vote instead of stranding 10
    // players. The heartbeat is backdated: players still on the page
    // re-confirm on their next poll, while the ghosts that likely caused the
    // cancel never do — so the same lobby can't instantly re-form around them.
    const now = Date.now();
    const expired = await expireStaticQueue(tx, now);
    const idleExpiresAt = queueIdleDeadline(now);
    if (expired.count > 0 || requeuePlayers.length > 0) {
      await refreshQueueIdleDeadline(tx, now);
    }
    for (const [i, p] of requeuePlayers.entries()) {
      await tx.inhouseQueueEntry.upsert({
        where: { userId: p.userId },
        create: {
          userId: p.userId,
          mmr: p.mmr,
          // Stagger joins so queue order stays deterministic.
          joinedAt: new Date(now + i),
          lastSeenAt: requeueLastSeenAt(now),
          idleExpiresAt,
        },
        update: {
          lastSeenAt: requeueLastSeenAt(now),
          idleExpiresAt,
        },
      });
    }
    return true;
  });
  if (!cancelled) {
    return {
      ok: false,
      error: "The lobby just finished — its result is in, nothing to cancel.",
    };
  }
  // Every successful admin cancellation is destructive and therefore gets an
  // audit row. Written after the claim so a losing cancel logs nothing.
  await logAdminAction({
    action: "cancelLobby",
    summary: `Cancelled the inhouse (${lobby.status}) with ${players.length} player(s)`,
  });
  return { ok: true };
}

type PlayerView = {
  userId: string;
  name: string;
  avatar: string | null;
  rankTier: number | null;
  mmr: number;
  pickIndex: number | null;
  /** Inhouse W-L, so captains can draft on record (null = no games yet). */
  record: { wins: number; losses: number; games: number } | null;
};

// The shape of a lobby-player row (with its joined user) that we read from.
type LobbyPlayerRow = {
  userId: string;
  mmr: number;
  pickIndex: number | null;
  queuedAt: Date;
  // Record snapshot frozen at lobby formation.
  wins: number;
  losses: number;
  games: number;
  user: { name: string; avatar: string | null; rankTier: number | null };
};

type VoteCandidate = PlayerView & {
  wins: number;
  losses: number;
  winRate: number;
  games: number;
  nominations: number;
  /**
   * When this player joined the LOBBY (epoch ms). Carried so the room can rank
   * the vote previews with `orderCaptains`, the same function resolveCaptainVote
   * installs captains with — its final tiebreak is earliest-queued, and without
   * this field the client could only approximate it.
   */
  joinedAt: number;
};

type VoteBlock = {
  candidates: VoteCandidate[];
  methodTallies: { VOTE: number; MMR: number; RECORD: number };
  votedCount: number;
  voterCount: number;
};

type ReadyCheckBlock = {
  acceptedCount: number;
  total: number;
  players: {
    userId: string;
    name: string;
    avatar: string | null;
    accepted: boolean;
  }[];
};

/** Everything the inhouse room client needs, tailored to the viewing user. */
export async function getInhouseState(
  viewer: SessionUser | null,
  /**
   * `runMaintenance: false` turns this into a side-effect-free spectator
   * snapshot. Anonymous traffic must never be able to advance a lobby, call
   * OpenDota, or edit Discord; the leased one-minute worker and
   * authenticated room participants retain those recovery paths.
   *
   * Set `syncBoard: false` on the mutation path so a button press never waits
   * on Discord — see the board sync at the bottom of this function.
   */
  {
    runMaintenance = true,
    syncBoard = true,
    detectResults = true,
  }: {
    runMaintenance?: boolean;
    syncBoard?: boolean;
    /** Room HTTP polls use the leased worker for automatic OpenDota scans. */
    detectResults?: boolean;
  } = {},
) {
  // Heartbeat before forming: the polling viewer must count as present.
  if (viewer) await touchQueueHeartbeat(viewer.id);
  if (runMaintenance) {
    // Abandoned lobby first: it frees the single active-lobby slot, so
    // maybeFormLobby can form the next game on this poll instead of the one
    // after.
    await resolveAbandonedLobby();
    await maybeFormLobby();
    await resolveReadyCheck();
    await resolveCaptainVote();
    await resolveStalledPick();
    if (detectResults) await maybeAutoDetectResult();
  }

  const [queue, lobbyRow] = await Promise.all([
    prisma.inhouseQueueEntry.findMany({
      orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
      select: {
        userId: true,
        mmr: true,
        lastSeenAt: true,
        user: {
          select: { name: true, avatar: true, rankTier: true },
        },
      },
    }),
    prisma.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      select: {
        id: true,
        status: true,
        acceptEndsAt: true,
        voteEndsAt: true,
        pickTeam: true,
        pickEndsAt: true,
        radiantTeam: true,
        winnerTeam: true,
        createdAt: true,
        startedAt: true,
        startedBy: { select: { name: true } },
        players: {
          select: {
            userId: true,
            team: true,
            isCaptain: true,
            pickIndex: true,
            mmr: true,
            acceptedAt: true,
            votedMethod: true,
            votedNomineeId: true,
            wins: true,
            losses: true,
            games: true,
            queuedAt: true,
            user: {
              select: { name: true, avatar: true, rankTier: true },
            },
          },
        },
      },
    }),
  ]);

  // Records were snapshotted onto the player rows at lobby formation — the
  // vote and draft views read them without a history scan on every poll.
  const now = Date.now();
  const toView = (p: LobbyPlayerRow): PlayerView => ({
    userId: p.userId,
    name: p.user.name,
    avatar: p.user.avatar,
    rankTier: p.user.rankTier,
    mmr: p.mmr,
    pickIndex: p.pickIndex,
    record:
      p.games > 0 ? { wins: p.wins, losses: p.losses, games: p.games } : null,
  });

  let lobby: null | {
    id: string;
    status: string;
    acceptEndsAt: number | null;
    voteEndsAt: number | null;
    pickTeam: number | null;
    pickEndsAt: number | null;
    radiantTeam: number;
    winnerTeam: number | null;
    startedAt: number | null;
    startedByName: string | null;
    /**
     * When the automatic OpenDota scan starts looking for this game's result
     * (epoch ms; null outside READY/IN_PROGRESS) — inhouseDetectWindow, the
     * same clock maybeAutoDetectResult waits on.
     */
    scanOpensAt: number | null;
    onClockCaptain: { userId: string; name: string } | null;
    teams: {
      team: number;
      isRadiant: boolean;
      captain: PlayerView | null;
      players: PlayerView[];
    }[];
    pool: PlayerView[];
    vote: VoteBlock | null;
    readyCheck: ReadyCheckBlock | null;
  } = null;

  if (lobbyRow) {
    const buildTeam = (team: number) => {
      const members = lobbyRow.players.filter((p) => p.team === team);
      const captain = members.find((p) => p.isCaptain) ?? null;
      const picks = members
        .filter((p) => !p.isCaptain)
        .sort((a, b) => (a.pickIndex ?? 0) - (b.pickIndex ?? 0));
      return {
        team,
        isRadiant: lobbyRow.radiantTeam === team,
        captain: captain ? toView(captain) : null,
        players: picks.map(toView),
      };
    };
    const onClock = lobbyRow.pickTeam
      ? lobbyRow.players.find(
          (p) => p.team === lobbyRow.pickTeam && p.isCaptain,
        )
      : null;

    let vote: VoteBlock | null = null;
    if (lobbyRow.status === INHOUSE_STATUS.CAPTAIN_VOTE) {
      const nominations = new Map<string, number>();
      const methodTallies = { VOTE: 0, MMR: 0, RECORD: 0 };
      for (const p of lobbyRow.players) {
        if (p.votedNomineeId) {
          nominations.set(
            p.votedNomineeId,
            (nominations.get(p.votedNomineeId) ?? 0) + 1,
          );
        }
        if (p.votedMethod && p.votedMethod in methodTallies) {
          methodTallies[p.votedMethod as keyof typeof methodTallies] += 1;
        }
      }
      const candidates: VoteCandidate[] = lobbyRow.players
        .map((p) => ({
          ...toView(p),
          wins: p.wins,
          losses: p.losses,
          winRate: p.games > 0 ? p.wins / p.games : 0,
          games: p.games,
          nominations: nominations.get(p.userId) ?? 0,
          joinedAt: p.queuedAt.getTime(),
        }))
        .sort((a, b) => b.mmr - a.mmr || a.name.localeCompare(b.name));
      vote = {
        candidates,
        methodTallies,
        votedCount: lobbyRow.players.filter((p) => p.votedMethod).length,
        voterCount: lobbyRow.players.length,
      };
    }

    // The accept grid: who's in, who has pressed ACCEPT (sorted so pending
    // players surface first — the ones everyone is waiting on).
    let readyCheck: ReadyCheckBlock | null = null;
    if (lobbyRow.status === INHOUSE_STATUS.READY_CHECK) {
      const players = lobbyRow.players
        .map((p) => ({
          userId: p.userId,
          name: p.user.name,
          avatar: p.user.avatar,
          accepted: p.acceptedAt != null,
        }))
        .sort(
          (a, b) =>
            Number(a.accepted) - Number(b.accepted) ||
            a.name.localeCompare(b.name),
        );
      readyCheck = {
        acceptedCount: players.filter((p) => p.accepted).length,
        total: players.length,
        players,
      };
    }

    lobby = {
      id: lobbyRow.id,
      status: lobbyRow.status,
      acceptEndsAt: lobbyRow.acceptEndsAt
        ? lobbyRow.acceptEndsAt.getTime()
        : null,
      voteEndsAt: lobbyRow.voteEndsAt ? lobbyRow.voteEndsAt.getTime() : null,
      pickTeam: lobbyRow.pickTeam,
      pickEndsAt: lobbyRow.pickEndsAt ? lobbyRow.pickEndsAt.getTime() : null,
      radiantTeam: lobbyRow.radiantTeam,
      winnerTeam: lobbyRow.winnerTeam,
      startedAt: lobbyRow.startedAt ? lobbyRow.startedAt.getTime() : null,
      startedByName: lobbyRow.startedBy?.name ?? null,
      scanOpensAt:
        inhouseDetectWindow({
          status: lobbyRow.status,
          createdAtMs: lobbyRow.createdAt.getTime(),
          startedAtMs: lobbyRow.startedAt?.getTime() ?? null,
        })?.opensAtMs ?? null,
      onClockCaptain: onClock
        ? { userId: onClock.userId, name: onClock.user.name }
        : null,
      teams: [buildTeam(1), buildTeam(2)],
      pool: lobbyRow.players
        .filter((p) => p.team === null)
        .sort(
          (a, b) =>
            b.mmr - a.mmr ||
            a.queuedAt.getTime() - b.queuedAt.getTime() ||
            a.userId.localeCompare(b.userId),
        )
        .map(toView),
      vote,
      readyCheck,
    };
  }

  const myLobbyPlayer = viewer
    ? (lobbyRow?.players.find((p) => p.userId === viewer.id) ?? null)
    : null;
  const inQueue = viewer ? queue.some((q) => q.userId === viewer.id) : false;
  const inLobby = !!myLobbyPlayer;
  const isCaptain = !!myLobbyPlayer?.isCaptain;
  const myTeam = myLobbyPlayer?.team ?? null;

  const myVote = myLobbyPlayer?.votedMethod
    ? {
        method: myLobbyPlayer.votedMethod as CaptainMethod,
        nomineeId: myLobbyPlayer.votedNomineeId,
      }
    : null;

  // Personal end-of-game payoff: the active-statuses query above drops a
  // COMPLETED lobby instantly, so the room would silently snap to the queue.
  // Probe cheaply (the 1.5s poll must not scan history every tick) for a
  // completed lobby the viewer just played. `completedAt` is immutable result
  // time; `updatedAt` is deliberately not used because any later write to the
  // row would resurface an old game as the newest banner.
  let lastResult: null | {
    lobbyId: string;
    winnerSide: "Radiant" | "Dire";
    radiantScore: number;
    direScore: number;
    myTeamWon: boolean;
    eloDelta: number;
  } = null;
  if (viewer) {
    const recent = await prisma.inhouseLobby.findFirst({
      where: {
        status: INHOUSE_STATUS.COMPLETED,
        completedAt: { gte: new Date(now - 10 * 60_000) },
        players: { some: { userId: viewer.id } },
      },
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        winnerTeam: true,
        radiantTeam: true,
        radiantScore: true,
        direScore: true,
        eloDeltas: true,
        players: {
          where: { userId: viewer.id },
          select: { userId: true, team: true },
        },
      },
    });
    if (recent && recent.winnerTeam != null) {
      let eloDelta = 0;
      try {
        const map = JSON.parse(recent.eloDeltas) as Record<string, unknown>;
        const v = map[viewer.id];
        if (typeof v === "number" && Number.isFinite(v)) eloDelta = v;
      } catch {
        // Malformed JSON — show the result without a delta.
      }
      const myPlayer = recent.players.find((pl) => pl.userId === viewer.id);
      lastResult = {
        lobbyId: recent.id,
        winnerSide:
          recent.winnerTeam === recent.radiantTeam ? "Radiant" : "Dire",
        radiantScore: recent.radiantScore ?? 0,
        direScore: recent.direScore ?? 0,
        myTeamWon: myPlayer?.team === recent.winnerTeam,
        eloDelta,
      };
    }
  }

  // Long-unseen or freshly requeued players retain their position while
  // waiting to reconfirm. Ordinary background tabs keep counting for hours.
  const presentEntries = queue.filter(
    (q) => queuePresence(q.lastSeenAt.getTime(), now) === "present",
  );
  const presentCount = presentEntries.length;

  // Keep the pinned Discord board in step. Everything it needs is already
  // loaded, so an enabled board costs one Setting read per poll and an edit
  // only when the rendered state actually moved; a board that was never set up
  // costs the read alone. Awaited on purpose — Vercel kills orphaned work
  // after the response, so a fire-and-forget edit would land at random.
  //
  // ONLY ON THE POLL PATH (`syncBoard`, default on). /api/inhouse answers
  // every MUTATION with this same state payload, so without the opt-out the
  // player who pressed ACCEPT is precisely the request that renders the
  // changed digest, wins the throttle claim and then blocks on Discord for up
  // to 2.5s — on the accept/vote/pick clocks, where seconds are the whole
  // point. The route passes syncBoard:false there; that client's own poll
  // lands ~250ms later (act() nudges the loop via bumpPollRef) and carries the
  // board instead, on a request nobody is waiting on.
  if (syncBoard) {
    await syncInhouseBoard({
      presentNames: presentEntries.map((q) => q.user.name),
      awayCount: queue.length - presentCount,
      lobbySize: INHOUSE.LOBBY_SIZE,
      // lobbyView is shared with loadBoardSnapshot so the two builders can
      // never describe the same lobby differently (a disagreement would make
      // the two paths repaint each other's digest in a loop).
      lobby: lobbyRow ? lobbyView(lobbyRow) : null,
      siteUrl: resolveSiteUrl(),
      nowMs: now,
    });
  }

  return {
    now,
    lobbySize: INHOUSE.LOBBY_SIZE,
    teamSize: INHOUSE.TEAM_SIZE,
    pickSeconds: INHOUSE.PICK_SECONDS,
    voteSeconds: INHOUSE.VOTE_SECONDS,
    acceptSeconds: INHOUSE.ACCEPT_SECONDS,
    lastResult,
    needed: playersNeeded(presentCount),
    queue: queue.map((q) => ({
      userId: q.userId,
      name: q.user.name,
      avatar: q.user.avatar,
      rankTier: q.user.rankTier,
      mmr: q.mmr,
      away: queuePresence(q.lastSeenAt.getTime(), now) === "away",
    })),
    lobby,
    me: {
      userId: viewer?.id ?? null,
      isLoggedIn: !!viewer,
      isAdmin: viewer?.role === "ADMIN",
      inQueue,
      inLobby,
      myTeam,
      isCaptain,
      isOnClock:
        lobby?.status === INHOUSE_STATUS.DRAFTING &&
        isCaptain &&
        myTeam === lobby.pickTeam,
      canVote: lobby?.status === INHOUSE_STATUS.CAPTAIN_VOTE && inLobby,
      myVote,
      // Ready check: can this viewer accept, and have they already?
      canAccept: lobby?.status === INHOUSE_STATUS.READY_CHECK && inLobby,
      hasAccepted: myLobbyPlayer?.acceptedAt != null,
      canJoin: !!viewer && !inQueue && !inLobby,
      canStart:
        lobby?.status === INHOUSE_STATUS.READY &&
        (inLobby || viewer?.role === "ADMIN"),
      // A lobby is being played from the moment teams lock, Start or not.
      canRecord:
        !!lobby &&
        INHOUSE_PLAYING_STATUSES.includes(lobby.status as never) &&
        (inLobby || viewer?.role === "ADMIN"),
      canCancel: !!lobby && viewer?.role === "ADMIN",
    },
  };
}

export type InhouseState = Awaited<ReturnType<typeof getInhouseState>>;
