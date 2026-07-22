import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  INHOUSE,
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_STATUS,
} from "./constants";
import {
  detectIntervalSeconds,
  nextPickTeam,
  orderCaptains,
  playersNeeded,
  queueDropCutoff,
  queuePresence,
  queuePresentCutoff,
  requeueLastSeenAt,
  tallyMethod,
  type CaptainCandidate,
  type CaptainMethod,
} from "./inhouse";
import { summarizeInhouse } from "./inhouse-stats";
import { gameMvp } from "./achievements";
import { heroById } from "./heroes";
import {
  fetchOpenDotaMatch,
  fetchRecentMatchIds,
  parseMatchId,
  steamIdToAccountId,
  type OpenDotaMatch,
} from "./dota";
import { classifyGame } from "./match-import";
import {
  inhouseLobbyMessage,
  inhouseQueueMessage,
  inhouseResultMessage,
  sendDiscordMessage,
} from "./discord";
import { stampResultChange, SETTING_KEYS } from "./settings";
import { clampMmrToRank } from "./rank";
import type { SessionUser } from "./auth";

export type ActionResult = { ok: true } | { ok: false; error: string };

// The transaction-scoped Prisma client type (also satisfied by `prisma` itself).
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const pickDeadline = () => new Date(Date.now() + INHOUSE.PICK_SECONDS * 1000);
const voteDeadline = () => new Date(Date.now() + INHOUSE.VOTE_SECONDS * 1000);
const acceptDeadline = () =>
  new Date(Date.now() + INHOUSE.ACCEPT_SECONDS * 1000);

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
    include: { players: { include: { user: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const recs = summarizeInhouse(
    lobbies.map((l) => ({
      id: l.id,
      winnerTeam: l.winnerTeam,
      createdAt: l.createdAt,
      players: l.players.map((p) => ({
        userId: p.userId,
        name: p.user.name,
        avatar: p.user.avatar,
        team: p.team,
      })),
    })),
  );
  return new Map(
    recs.map((r) => [
      r.userId,
      { wins: r.wins, losses: r.losses, winRate: r.winRate, games: r.games },
    ]),
  );
}

/**
 * Form a lobby when enough players are waiting. Idempotent + safe to call on
 * every poll: no-ops unless the single active-lobby slot is free AND the queue
 * has reached LOBBY_SIZE. The lobby opens in the READY_CHECK phase — the
 * Dota-style accept gate: all ten must press ACCEPT before the captain vote
 * starts (acceptMatch / resolveReadyCheck), so an AFK player is dropped
 * instead of drafted.
 */
export async function maybeFormLobby(): Promise<boolean> {
  // Captured in-tx, sent post-commit (draft-sale pattern) — the active-lobby
  // guard means at most one formation, so at most one announcement.
  let announce: string | null = null;
  let formed = false;
  try {
    formed = await prisma.$transaction(async (tx) => {
    const now = Date.now();
    // Ghosts never get drafted: drop entries whose heartbeat went silent (the
    // player closed /inhouse long ago), so the queue count everyone watches
    // stays honest. Runs on every poll — the table only ever holds a handful
    // of rows.
    await tx.inhouseQueueEntry.deleteMany({
      where: { lastSeenAt: { lt: queueDropCutoff(now) } },
    });

    const active = await tx.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      select: { id: true },
    });
    if (active) return false;

    // Only players seen recently count toward the ten — an "away" entry keeps
    // its queue position but can't be pulled into a lobby it won't show up to.
    const queue = await tx.inhouseQueueEntry.findMany({
      where: { lastSeenAt: { gte: queuePresentCutoff(now) } },
      orderBy: { joinedAt: "asc" },
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
          wins: r?.wins ?? 0,
          losses: r?.losses ?? 0,
          games: r?.games ?? 0,
        };
      }),
    });

    await tx.inhouseQueueEntry.deleteMany({
      where: { userId: { in: queue.map((q) => q.userId) } },
    });

    // Player names for the Discord announcement, in queue order.
    const users = await tx.user.findMany({
      where: { id: { in: queue.map((q) => q.userId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    announce = inhouseLobbyMessage(
      queue.map((q) => nameById.get(q.userId) ?? "?"),
    );
    return true;
    },
    // SQLite serializes writers anyway; on Postgres this is what makes the
    // findFirst-then-create "one active lobby" invariant hold — the loser of
    // two concurrent formations aborts (P2034) instead of double-forming.
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    // Serialization conflict: someone else's poll formed the lobby first.
    if ((e as { code?: string }).code === "P2034") return false;
    throw e;
  }
  if (formed && announce) await sendDiscordMessage(announce);
  return formed;
}

/**
 * Claim the READY_CHECK → CAPTAIN_VOTE flip (all ten accepted) and start the
 * vote clock. updateMany-guarded: two concurrent resolvers flip it once.
 */
async function startCaptainVote(tx: Tx, lobbyId: string): Promise<boolean> {
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
 * with a live heartbeat AND keep priority (their queue slot is anchored to the
 * lobby's formation time, so it outranks anyone who joined during the check).
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
 */
async function failReadyCheck(
  tx: Tx,
  lobbyId: string,
  opts: { pendingBackdated: boolean; dropUserId?: string },
): Promise<boolean> {
  const claim = await tx.inhouseLobby.updateMany({
    where: { id: lobbyId, status: INHOUSE_STATUS.READY_CHECK },
    data: { status: INHOUSE_STATUS.CANCELLED, acceptEndsAt: null },
  });
  if (claim.count === 0) return false;
  const lobby = await tx.inhouseLobby.findUniqueOrThrow({
    where: { id: lobbyId },
    select: {
      createdAt: true,
      players: { select: { userId: true, mmr: true, acceptedAt: true } },
    },
  });
  const requeue = lobby.players.filter((p) => {
    if (p.userId === opts.dropUserId) return false;
    return p.acceptedAt != null || opts.pendingBackdated;
  });
  const now = Date.now();
  for (const [i, p] of requeue.entries()) {
    const lastSeenAt =
      p.acceptedAt != null ? new Date() : requeueLastSeenAt(now);
    // Anchor queue order to the lobby's formation instant (+ index) so
    // re-queued players outrank anyone who joined the queue DURING the check —
    // they were here first. Staggered by index for deterministic order.
    const joinedAt = new Date(lobby.createdAt.getTime() + i);
    await tx.inhouseQueueEntry.upsert({
      where: { userId: p.userId },
      create: { userId: p.userId, mmr: p.mmr, joinedAt, lastSeenAt },
      update: { joinedAt, lastSeenAt },
    });
  }
  return true;
}

/** Press ACCEPT on the ready check. Idempotent — a double-click is one accept. */
export async function acceptMatch(viewer: SessionUser): Promise<ActionResult> {
  return prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.READY_CHECK },
      include: { players: true },
    });
    if (!lobby) return { ok: false as const, error: "No match to accept" };
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
export async function declineMatch(viewer: SessionUser): Promise<ActionResult> {
  return prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.READY_CHECK },
      include: { players: true },
    });
    if (!lobby) return { ok: false as const, error: "No match to decline" };
    if (!lobby.players.some((p) => p.userId === viewer.id)) {
      return { ok: false as const, error: "You're not in this lobby" };
    }
    const failed = await failReadyCheck(tx, lobby.id, {
      pendingBackdated: true,
      dropUserId: viewer.id,
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
 * the no-shows, re-queuing only the players who accepted. Idempotent; safe on
 * every poll.
 */
export async function resolveReadyCheck(): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.READY_CHECK },
      include: { players: true },
    });
    if (!lobby) return false;
    const allAccepted =
      lobby.players.length > 0 && lobby.players.every((p) => p.acceptedAt);
    if (allAccepted) return startCaptainVote(tx, lobby.id);
    const expired =
      !!lobby.acceptEndsAt && lobby.acceptEndsAt.getTime() <= Date.now();
    if (!expired) return false;
    // Timed out with pending players: they ignored a 45s chime + tab flash —
    // proven AFK, dropped. Accepters go back to the front of the queue.
    return failReadyCheck(tx, lobby.id, { pendingBackdated: false });
  });
}

/**
 * Resolve the captain-selection vote once everyone has voted or the timer runs
 * out: tally the winning method, rank candidates, install the top two as
 * captains, and drop into the draft. Idempotent; safe on every poll.
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
    const expired = !!lobby.voteEndsAt && lobby.voteEndsAt.getTime() <= Date.now();
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
      joinedAt: p.createdAt,
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
): Promise<ActionResult> {
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
    const mine = lobby.players.find((p) => p.userId === viewer.id);
    if (!mine) {
      return { ok: false as const, error: "Only players in the lobby can vote" };
    }
    let nominee: string | null = null;
    if (m === "VOTE") {
      if (!nomineeId) return { ok: false as const, error: "Pick a player to captain" };
      if (!lobby.players.some((p) => p.userId === nomineeId)) {
        return { ok: false as const, error: "That player isn't in this lobby" };
      }
      nominee = nomineeId;
    }
    await tx.inhouseLobbyPlayer.update({
      where: { id: mine.id },
      data: { votedMethod: m, votedNomineeId: nominee },
    });
    return { ok: true as const };
  });
  if (res.ok) await resolveCaptainVote(); // resolve early if that was the last vote
  return res;
}

/** Assign a pool player to the team currently on the clock and advance the draft. */
async function applyPick(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  lobbyId: string,
  targetUserId: string,
): Promise<ActionResult> {
  const lobby = await tx.inhouseLobby.findUnique({
    where: { id: lobbyId },
    include: { players: true },
  });
  if (!lobby || lobby.status !== INHOUSE_STATUS.DRAFTING || !lobby.pickTeam) {
    return { ok: false, error: "The draft isn't running" };
  }
  const target = lobby.players.find((p) => p.userId === targetUserId);
  if (!target) return { ok: false, error: "That player isn't in this lobby" };
  if (target.team !== null) return { ok: false, error: "Player already drafted" };

  const team = lobby.pickTeam;
  const picksMade = lobby.players.filter(
    (p) => p.team !== null && !p.isCaptain,
  ).length;

  // Claim the pick atomically — a captain's double-click or an admin racing
  // them must consume ONE turn, not two (a plain read-then-write pair loses
  // that race silently under Postgres read-committed).
  const claim = await tx.inhouseLobbyPlayer.updateMany({
    where: { id: target.id, team: null },
    data: { team, pickIndex: picksMade },
  });
  if (claim.count === 0) return { ok: false, error: "Player already drafted" };

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

  if (next === null) {
    await tx.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        status: INHOUSE_STATUS.READY,
        pickTeam: null,
        pickEndsAt: null,
      },
    });
  } else {
    await tx.inhouseLobby.update({
      where: { id: lobby.id },
      data: { pickTeam: next, pickEndsAt: pickDeadline() },
    });
  }
  return { ok: true };
}

/**
 * If a captain lets their pick clock run out, auto-draft the top remaining
 * player for them so the lobby never stalls. Idempotent; safe on every poll.
 */
export async function resolveStalledPick(): Promise<boolean> {
  const res = await prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.DRAFTING, pickTeam: { not: null } },
      include: { players: true },
    });
    if (!lobby || !lobby.pickEndsAt || lobby.pickEndsAt.getTime() > Date.now()) {
      return false;
    }
    const pool = lobby.players
      .filter((p) => p.team === null)
      .sort(
        (a, b) => b.mmr - a.mmr || a.createdAt.getTime() - b.createdAt.getTime(),
      );
    if (pool.length === 0) return false;
    const r = await applyPick(tx, lobby.id, pool[0].userId);
    return r.ok;
  });
  return res;
}

/** A captain (or admin, on their behalf) drafts a player from the pool. */
export async function makePick(
  viewer: SessionUser,
  targetUserId: string,
): Promise<ActionResult> {
  await resolveStalledPick();
  return prisma.$transaction(async (tx) => {
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
    return applyPick(tx, lobby.id, targetUserId);
  });
}

/** Add the current user to the inhouse queue (or refresh their seed MMR). */
export async function joinQueue(
  viewer: SessionUser,
  mmr: number,
): Promise<ActionResult> {
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

  // Guard + upsert in ONE transaction: a concurrent poll's maybeFormLobby
  // (its own transaction) can't consume this player into a forming lobby
  // between the check and the write, which would leave them both rostered in
  // the live lobby AND queued for the next one.
  const joined = await prisma.$transaction(async (tx) => {
    const inActiveLobby = await tx.inhouseLobbyPlayer.findFirst({
      where: {
        userId: viewer.id,
        lobby: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      },
      select: { id: true },
    });
    if (inActiveLobby) return false;
    await tx.inhouseQueueEntry.upsert({
      where: { userId: viewer.id },
      create: { userId: viewer.id, mmr: safeMmr },
      // Keep original joinedAt so we don't lose queue position; an explicit
      // re-join is also a fresh sign of life.
      update: { mmr: safeMmr, lastSeenAt: new Date() },
    });
    return true;
  });
  if (!joined) {
    return { ok: false, error: "You're already in a live inhouse" };
  }
  const formed = await maybeFormLobby();

  // "Almost there" Discord ping: only when THIS join crosses the milestone
  // upward (so hovering at the threshold stays quiet), never on the join that
  // formed a lobby (that gets its own announcement), and at most once per
  // throttle window so leave/rejoin churn can't spam the channel.
  if (!formed) {
    const milestone = INHOUSE.LOBBY_SIZE - 2;
    const presentAfter = await prisma.inhouseQueueEntry.count({
      where: { lastSeenAt: { gte: queuePresentCutoff(Date.now()) } },
    });
    if (
      presentBefore < milestone &&
      presentAfter >= milestone &&
      (await claimQueuePingThrottle(Date.now()))
    ) {
      await sendDiscordMessage(
        inhouseQueueMessage(presentAfter, INHOUSE.LOBBY_SIZE),
      );
    }
  }
  return { ok: true };
}

/**
 * Atomic spam throttle for the queue ping (the result-sync Setting-claim
 * pattern): create the row or conditionally advance a stale one — exactly one
 * of two concurrent milestone-crossing joins wins. ISO timestamps compare
 * lexicographically, so `lt` is a valid staleness test.
 */
async function claimQueuePingThrottle(nowMs: number): Promise<boolean> {
  const key = SETTING_KEYS.INHOUSE_QUEUE_PING_AT;
  const value = new Date(nowMs).toISOString();
  try {
    await prisma.setting.create({ data: { key, value } });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
  }
  const staleBefore = new Date(
    nowMs - INHOUSE.QUEUE_PING_MIN_MINUTES * 60_000,
  ).toISOString();
  const updated = await prisma.setting.updateMany({
    where: { key, value: { lt: staleBefore } },
    data: { value },
  });
  return updated.count > 0;
}

/**
 * Holding a queue spot means keeping /inhouse open: every state poll refreshes
 * the viewer's own heartbeat. Throttled — the conditional update only writes
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
export async function leaveQueue(viewer: SessionUser): Promise<ActionResult> {
  await prisma.inhouseQueueEntry.deleteMany({ where: { userId: viewer.id } });
  return { ok: true };
}

/** Launch the game once teams are set — whoever hosts the in-client lobby. */
export async function startGame(viewer: SessionUser): Promise<ActionResult> {
  return prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.READY },
      include: { players: true },
    });
    if (!lobby) return { ok: false as const, error: "No lobby is ready to start" };
    const isMember = lobby.players.some((p) => p.userId === viewer.id);
    if (!isMember && viewer.role !== "ADMIN") {
      return { ok: false as const, error: "Only players in the lobby can start it" };
    }
    await tx.inhouseLobby.update({
      where: { id: lobby.id },
      data: {
        status: INHOUSE_STATUS.IN_PROGRESS,
        startedById: viewer.id,
        startedAt: new Date(),
      },
    });
    return { ok: true as const };
  });
}

// ---- Result recording (OpenDota only — no manual winner) ------------------

type LobbyPlayerFull = {
  userId: string;
  team: number | null;
  user: { name: string; dotaAccountId: number | null; steamId: string };
};

// One per-player line of the stored box score (mirrors the league Game blob).
type BoxScorePlayer = {
  userId: string | null;
  name: string | null;
  team: number | null;
  isRadiant: boolean;
  heroId: number;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number | null;
  gpm: number | null;
  lastHits: number | null;
};

type BuiltResult = {
  winnerTeam: number;
  radiantTeam: number;
  dotaMatchId: string;
  durationSecs: number;
  radiantScore: number;
  direScore: number;
  boxScore: BoxScorePlayer[];
  startTime: number;
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
    const acc = p.user.dotaAccountId ?? steamIdToAccountId(p.user.steamId);
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

  const boxScore: BoxScorePlayer[] = od.players.map((pl) => {
    const isRadiant = pl.isRadiant ?? pl.player_slot < 128;
    const m = pl.account_id != null ? accountMap.get(pl.account_id) : undefined;
    return {
      userId: m?.userId ?? null,
      name: m?.name ?? pl.personaname ?? null,
      team: m?.team ?? null,
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
    radiantTeam: cls.radiantTeamId === "1" ? 1 : 2,
    dotaMatchId: String(od.match_id),
    durationSecs: od.duration,
    radiantScore: od.radiant_score ?? 0,
    direScore: od.dire_score ?? 0,
    boxScore,
    startTime: od.start_time,
  };
}

/**
 * Write a built result onto the lobby and close it out. Guarded: only an
 * IN_PROGRESS lobby can complete, and only one caller wins the claim — an
 * admin cancel (or a rival record with a different match id) racing the slow
 * OpenDota fetch must never be overwritten, and a CANCELLED lobby must never
 * resurrect as COMPLETED. The claim winner stamps per-player Elo deltas and
 * sends the Discord announcement, so both happen exactly once.
 */
async function applyResult(lobbyId: string, r: BuiltResult): Promise<boolean> {
  const claimed = await prisma.inhouseLobby.updateMany({
    where: { id: lobbyId, status: INHOUSE_STATUS.IN_PROGRESS },
    data: {
      status: INHOUSE_STATUS.COMPLETED,
      winnerTeam: r.winnerTeam,
      radiantTeam: r.radiantTeam,
      dotaMatchId: r.dotaMatchId,
      durationSecs: r.durationSecs,
      radiantScore: r.radiantScore,
      direScore: r.direScore,
      boxScore: JSON.stringify(r.boxScore),
    },
  });
  if (claimed.count === 0) return false;

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
  const recs = summarizeInhouse(
    history.map((l) => ({
      id: l.id,
      winnerTeam: l.winnerTeam,
      createdAt: l.createdAt,
      players: l.players.map((p) => ({
        userId: p.userId,
        name: p.user.name,
        avatar: p.user.avatar,
        team: p.team,
      })),
    })),
  );
  const participants = new Set(
    history
      .find((l) => l.id === lobbyId)
      ?.players.map((p) => p.userId) ?? [],
  );
  const deltas: Record<string, number> = {};
  for (const rec of recs) {
    if (participants.has(rec.userId)) deltas[rec.userId] = rec.lastChange;
  }
  await prisma.inhouseLobby.update({
    where: { id: lobbyId },
    data: { eloDeltas: JSON.stringify(deltas) },
  });

  // Every parked client learns via the /api/sync cursor, not just this one.
  await stampResultChange();

  // Post-claim, so exactly one path — button, paste, or background scan —
  // ever announces. Best-effort like every other inhouse send.
  const radiantWin = r.winnerTeam === r.radiantTeam;
  const mvpId = gameMvp(r.boxScore, radiantWin);
  const mvp = mvpId ? r.boxScore.find((b) => b.userId === mvpId) : null;
  await sendDiscordMessage(
    inhouseResultMessage({
      winnerSide: radiantWin ? "Radiant" : "Dire",
      radiantScore: r.radiantScore,
      direScore: r.direScore,
      durationSecs: r.durationSecs,
      mvpName: mvp?.name ?? null,
      mvpHero: mvp ? (heroById(mvp.heroId)?.name ?? null) : null,
      dotaMatchId: r.dotaMatchId,
    }),
  );
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
): Promise<{ result: BuiltResult | null; unreachable: boolean }> {
  const accounts = players
    .map((p) => p.user.dotaAccountId ?? steamIdToAccountId(p.user.steamId))
    .filter((a): a is number => a != null);
  if (accounts.length === 0) return { result: null, unreachable: false };

  const lists = await Promise.all(
    accounts.map((acc) => fetchRecentMatchIds(acc, 10)),
  );
  const unreachable = lists.every((l) => l === null);
  const counts = new Map<number, number>();
  for (const ids of lists) {
    for (const id of ids ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  // A game shared by several of our players is a candidate; buildResult does the
  // real validation. Cap the full-match fetches to keep API usage sane.
  const candidateIds = [...counts.entries()]
    .filter(([, c]) => c >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id]) => id);
  if (candidateIds.length === 0) return { result: null, unreachable };

  const matches = await Promise.all(
    candidateIds.map((id) => fetchOpenDotaMatch(String(id))),
  );
  let best: BuiltResult | null = null;
  for (const od of matches) {
    if (!od || od.start_time < floorSeconds) continue;
    const r = buildResult(od, players);
    if (r && (!best || r.startTime > best.startTime)) best = r;
  }
  return { result: best, unreachable };
}

/**
 * On-demand: look up the result on OpenDota by scanning the players' recent
 * games. Needs the game finished + public match data enabled.
 */
export async function autoDetectResult(
  viewer: SessionUser,
): Promise<ActionResult> {
  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: INHOUSE_STATUS.IN_PROGRESS },
    include: { players: { include: { user: true } } },
  });
  if (!lobby) return { ok: false, error: "No game is in progress" };
  if (
    !lobby.players.some((p) => p.userId === viewer.id) &&
    viewer.role !== "ADMIN"
  ) {
    return { ok: false, error: "Only players in the game can do that" };
  }
  await prisma.inhouseLobby.update({
    where: { id: lobby.id },
    data: { detectedAt: new Date() },
  });
  const { result: found, unreachable } = await findInhouseGame(
    lobby.players,
    Math.floor(lobby.createdAt.getTime() / 1000),
  );
  if (!found) {
    // Don't blame players' privacy settings when OpenDota itself was the
    // problem — the fixes are completely different.
    return {
      ok: false,
      error: unreachable
        ? "OpenDota didn't respond (down or rate-limited) — try again in a minute, or paste the match ID."
        : "Couldn't find the game on OpenDota yet — make sure it's finished and players have 'Expose Public Match Data' on. You can also paste the match ID.",
    };
  }
  if (!(await applyResult(lobby.id, found))) {
    return {
      ok: false,
      error: "The lobby closed while we fetched — the result is already in (or an admin cancelled it).",
    };
  }
  return { ok: true };
}

/** Record the result from a specific Dota match id/URL (fetched via OpenDota). */
export async function recordMatch(
  viewer: SessionUser,
  input: string,
): Promise<ActionResult> {
  const matchId = parseMatchId(input);
  if (!matchId) return { ok: false, error: "Enter a valid Dota match ID or link" };

  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: INHOUSE_STATUS.IN_PROGRESS },
    include: { players: { include: { user: true } } },
  });
  if (!lobby) return { ok: false, error: "No game is in progress" };
  if (
    !lobby.players.some((p) => p.userId === viewer.id) &&
    viewer.role !== "ADMIN"
  ) {
    return { ok: false, error: "Only players in the game can do that" };
  }

  const od = await fetchOpenDotaMatch(matchId);
  if (!od) {
    return {
      ok: false,
      error: "Couldn't fetch that match from OpenDota (is the ID right and public?)",
    };
  }
  // Same floor findInhouseGame enforces: a PRIOR game between the same ten
  // players (yesterday's inhouse, a rematch id typo) must not close this one.
  if (od.start_time < Math.floor(lobby.createdAt.getTime() / 1000)) {
    return {
      ok: false,
      error: "That match started before this lobby formed — wrong game?",
    };
  }
  // Humans vouched for this specific match id, so accept a thinner roster
  // match than the background scan demands (2 recognizable players per side
  // instead of 3) — the escape hatch for lobbies where most players have
  // "Expose Public Match Data" off and auto-detect is structurally blind.
  const built = buildResult(od, lobby.players, 2);
  if (!built) {
    return {
      ok: false,
      error:
        "Couldn't match that game to these teams — at least two linked players per side need public match data (check the ID too).",
    };
  }
  if (!(await applyResult(lobby.id, built))) {
    return {
      ok: false,
      error: "The lobby closed while we fetched — the result is already in (or an admin cancelled it).",
    };
  }
  return { ok: true };
}

/**
 * Automatic, throttled result detection run on poll: once a game has been going
 * long enough, quietly try OpenDota at most once per interval and close the
 * lobby out if we find it. Safe to call on every poll (claims the attempt
 * atomically so concurrent pollers don't all scan). Idempotent.
 */
export async function maybeAutoDetectResult(): Promise<boolean> {
  const now = Date.now();
  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: INHOUSE_STATUS.IN_PROGRESS },
    include: { players: { include: { user: true } } },
  });
  if (!lobby || !lobby.startedAt) return false;
  if (now - lobby.startedAt.getTime() < INHOUSE.DETECT_MIN_MINUTES * 60_000) {
    return false; // too early — the game can't be over yet
  }

  // Claim this attempt so only one concurrent poll actually hits OpenDota.
  // The interval stretches with the game's age (pure detectIntervalSeconds):
  // a normal game scans every DETECT_INTERVAL_SECONDS, an abandoned lobby
  // nobody cancels decays to one scan per DETECT_INTERVAL_MAX_SECONDS.
  const interval = detectIntervalSeconds(now - lobby.startedAt.getTime());
  const cutoff = new Date(now - interval * 1000);
  const claim = await prisma.inhouseLobby.updateMany({
    where: {
      id: lobby.id,
      status: INHOUSE_STATUS.IN_PROGRESS,
      OR: [{ detectedAt: null }, { detectedAt: { lt: cutoff } }],
    },
    data: { detectedAt: new Date(now) },
  });
  if (claim.count === 0) return false;

  const { result: found } = await findInhouseGame(
    lobby.players,
    Math.floor(lobby.createdAt.getTime() / 1000),
  );
  if (!found) return false;
  return applyResult(lobby.id, found);
}

/** Admin: scrap the current lobby (stuck draft, no-shows). Players can requeue. */
export async function cancelLobby(viewer: SessionUser): Promise<ActionResult> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  const lobby = await prisma.inhouseLobby.findFirst({
    where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
  });
  if (!lobby) return { ok: false, error: "No active lobby" };
  const players = await prisma.inhouseLobbyPlayer.findMany({
    where: { lobbyId: lobby.id },
    select: { userId: true, mmr: true },
  });
  const cancelled = await prisma.$transaction(async (tx) => {
    // Guarded transition: if the result landed between the admin's read and
    // this write (auto-detect closing the lobby mid-confirm-dialog), the
    // cancel must lose — a played game keeps its result and nobody re-queues.
    const claim = await tx.inhouseLobby.updateMany({
      where: { id: lobby.id, status: { in: INHOUSE_ACTIVE_STATUSES } },
      data: {
        status: INHOUSE_STATUS.CANCELLED,
        pickTeam: null,
        pickEndsAt: null,
      },
    });
    if (claim.count === 0) return false;
    // Put everyone back in the queue so a cancelled lobby (wrong captains,
    // someone AFK, …) re-forms with a fresh vote instead of stranding 10
    // players. The heartbeat is backdated: players still on the page
    // re-confirm on their next poll, while the ghosts that likely caused the
    // cancel never do — so the same lobby can't instantly re-form around them.
    for (const [i, p] of players.entries()) {
      await tx.inhouseQueueEntry.upsert({
        where: { userId: p.userId },
        create: {
          userId: p.userId,
          mmr: p.mmr,
          // Stagger joins so queue order stays deterministic.
          joinedAt: new Date(Date.now() + i),
          lastSeenAt: requeueLastSeenAt(Date.now()),
        },
        update: { lastSeenAt: requeueLastSeenAt(Date.now()) },
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
export async function getInhouseState(viewer: SessionUser | null) {
  // Heartbeat before forming: the polling viewer must count as present.
  if (viewer) await touchQueueHeartbeat(viewer.id);
  await maybeFormLobby();
  await resolveReadyCheck();
  await resolveCaptainVote();
  await resolveStalledPick();
  await maybeAutoDetectResult();

  const [queue, lobbyRow] = await Promise.all([
    prisma.inhouseQueueEntry.findMany({
      orderBy: { joinedAt: "asc" },
      include: { user: true },
    }),
    prisma.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      include: {
        startedBy: true,
        players: { include: { user: true } },
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
      p.games > 0
        ? { wins: p.wins, losses: p.losses, games: p.games }
        : null,
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
      onClockCaptain: onClock
        ? { userId: onClock.userId, name: onClock.user.name }
        : null,
      teams: [buildTeam(1), buildTeam(2)],
      pool: lobbyRow.players
        .filter((p) => p.team === null)
        .sort((a, b) => b.mmr - a.mmr || a.createdAt.getTime() - b.createdAt.getTime())
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
  // completed lobby the viewer just played; their Elo swing was stamped into
  // eloDeltas when the result landed, so this is a single-row read.
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
        updatedAt: { gte: new Date(now - 10 * 60_000) },
        players: { some: { userId: viewer.id } },
      },
      orderBy: { updatedAt: "desc" },
      include: { players: true },
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

  // "Away" entries (heartbeat gone quiet — tab closed or backgrounded hard)
  // keep their spot for a grace window but don't count toward the ten.
  const presentCount = queue.filter(
    (q) => queuePresence(q.lastSeenAt.getTime(), now) === "present",
  ).length;

  return {
    now,
    lobbySize: INHOUSE.LOBBY_SIZE,
    teamSize: INHOUSE.TEAM_SIZE,
    pickSeconds: INHOUSE.PICK_SECONDS,
    voteSeconds: INHOUSE.VOTE_SECONDS,
    acceptSeconds: INHOUSE.ACCEPT_SECONDS,
    detectMinMinutes: INHOUSE.DETECT_MIN_MINUTES,
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
      canRecord:
        lobby?.status === INHOUSE_STATUS.IN_PROGRESS &&
        (inLobby || viewer?.role === "ADMIN"),
      canCancel: !!lobby && viewer?.role === "ADMIN",
    },
  };
}

export type InhouseState = Awaited<ReturnType<typeof getInhouseState>>;
