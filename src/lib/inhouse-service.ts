import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  INHOUSE,
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_BET_STATUS,
  INHOUSE_BETS,
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
import { summarizeInhouse, toFinishedLobby } from "./inhouse-stats";
import type { InhouseBoxPlayer } from "./inhouse-box";
import {
  potTier,
  potView,
  type PotTier,
  type Settlement,
} from "./inhouse-bets";
import { resolveUnsettledBets, settleInhouseBets } from "./inhouse-bet-service";
import { gameMvp } from "./achievements";
import { heroById } from "./heroes";
import {
  fetchOpenDotaMatch,
  fetchRecentMatchIds,
  parseMatchId,
  type OpenDotaMatch,
} from "./dota";
import { effectiveDotaAccountId } from "./dota-account";
import { classifyGame } from "./match-import";
import {
  inhouseLobbyMessage,
  inhouseQueueMessage,
  inhouseResultMessage,
  inhouseResultVoidedMessage,
  sendInhouseDiscordMessage,
  getInhousePingRoleId,
} from "./discord";
import {
  deliverInhouseAnnouncements,
  INHOUSE_ANNOUNCEMENT_KIND,
  INHOUSE_ANNOUNCEMENT_STATUS,
} from "./inhouse-announcement-outbox";
import { claimThrottle, stampResultChange, SETTING_KEYS } from "./settings";
import { lobbyView, syncInhouseBoard } from "./inhouse-board-service";
import { resolveSiteUrl } from "./site-url";
import { clampMmrToRank } from "./rank";
import { logAdminAction } from "./admin-log";
import { raceHook } from "./race-hook";
import type { SessionUser } from "./auth";

export type InhouseActionResult = { ok: true } | { ok: false; error: string };

// The transaction-scoped Prisma client type (also satisfied by `prisma` itself).
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const pickDeadline = () => new Date(Date.now() + INHOUSE.PICK_SECONDS * 1000);
const voteDeadline = () => new Date(Date.now() + INHOUSE.VOTE_SECONDS * 1000);
const acceptDeadline = () =>
  new Date(Date.now() + INHOUSE.ACCEPT_SECONDS * 1000);

/**
 * The DRAFTING → READY transition, written in ONE place because there are TWO
 * write sites for it and only one of them is the path anyone thinks about:
 * `applyPick`'s advance claim (the last pick lands) and `restoreLostPickTurn`'s
 * recovery (a DRAFTING lobby found off the clock).
 *
 * `betsCloseAt` is stamped here, inside the same claim `data` as the status, and
 * by nothing else in the codebase. That is what makes the betting window
 * un-pushable by an interested party — unlike `startedAt`, which `startGame`
 * writes whenever someone presses Start, deliberately including long after the
 * game (see the late-bet void). It also means a lost claim leaves NO window
 * behind: nothing happened, so nothing is half-opened.
 *
 * Miss the second site and the failure is silent in the worst way — a lobby
 * recovered through the lost-turn path arrives with betting off, no error
 * anywhere, and ten players who simply never see the panel. That is the standin
 * announcement's four-call-sites shape with money attached, which is why this is
 * a function and not a copied literal.
 */
function readyTransitionData(nowMs: number) {
  return {
    status: INHOUSE_STATUS.READY,
    pickTeam: null,
    pickEndsAt: null,
    betsCloseAt: new Date(nowMs + INHOUSE_BETS.WINDOW_SECONDS * 1000),
  };
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
  let lobbyPlayers: { name: string; discordId: string | null }[] = [];
  let formed = false;
  try {
    formed = await prisma.$transaction(
      async (tx) => {
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
    await sendInhouseDiscordMessage(inhouseLobbyMessage(lobbyPlayers, roleId), {
      // Only these exact ids may ring anyone — a Steam persona in the same
      // message still can't ping (see MentionAllowlist).
      roles: roleId ? [roleId] : [],
      users: lobbyPlayers
        .map((p) => p.discordId)
        .filter((id): id is string => !!id),
    });
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
      create: { userId: p.userId, mmr: p.mmr, joinedAt, lastSeenAt },
      update: { joinedAt, lastSeenAt },
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
 * Scrap a lobby that was abandoned in READY or IN_PROGRESS. These are the only
 * two phases with NO clock — READY_CHECK, CAPTAIN_VOTE and DRAFTING all expire
 * into a resolver — so before this they could hold the single active-lobby
 * slot forever: `maybeFormLobby` early-returns on any active lobby, so no new
 * game could ever form, and the abandoned lobby's own ten players were refused
 * the queue by joinQueue's inActiveLobby guard. The whole feature was down for
 * everyone until an admin happened to visit /inhouse and press Cancel.
 *
 * Both floors (ABANDON_*_HOURS) are deliberately far past any legitimate use:
 * Start can be pressed late — even after the game — and the manual result
 * paths have no time gate, so a group that simply forgot still recovers their
 * game normally. Idempotent; safe on every poll.
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
          updatedAt: {
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
    },
  });
  return claim.count > 0;
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
        ? readyTransitionData(Date.now())
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
        ? // The shared block writes `pickTeam: null` back over the null the
          // WHERE above just asserted. That no-op is the whole price of having
          // ONE definition of what reaching READY means — and a hand-written
          // variant here is exactly how this branch, the one nobody thinks
          // about, ends up as the one that forgets to open the betting window.
          readyTransitionData(Date.now())
        : { pickTeam: next, pickEndsAt: pickDeadline() },
  });
  return claim.count > 0;
}

/**
 * If a captain lets their pick clock run out, auto-draft the top remaining
 * player for them so the lobby never stalls. Idempotent; safe on every poll.
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
  let joined: boolean;
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
        await tx.inhouseQueueEntry.upsert({
          where: { userId: viewer.id },
          create: { userId: viewer.id, mmr: safeMmr },
          // Keep original joinedAt so we don't lose queue position; an explicit
          // re-join is also a fresh sign of life.
          update: { mmr: safeMmr, lastSeenAt: new Date() },
        });
        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    // Lost the race to a lobby forming around this player.
    if ((e as { code?: string }).code === "P2034") {
      return { ok: false, error: "You're already in a live inhouse" };
    }
    throw e;
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
export async function leaveQueue(
  viewer: SessionUser,
): Promise<InhouseActionResult> {
  await prisma.inhouseQueueEntry.deleteMany({ where: { userId: viewer.id } });
  return { ok: true };
}

/** Launch the game once teams are set — whoever hosts the in-client lobby. */
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
      return { ok: false as const, error: "That lobby was just cancelled" };
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
  // rather than reject the match (rejecting would strand the lobby
  // IN_PROGRESS and block the single active slot until an admin cancelled).
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
 * Write a built result onto the lobby and close it out. Guarded: only an
 * IN_PROGRESS lobby can complete, and only one caller wins the claim — an
 * admin cancel (or a rival record with a different match id) racing the slow
 * OpenDota fetch must never be overwritten, and a CANCELLED lobby must never
 * resurrect as COMPLETED. The claim winner stamps per-player Elo deltas and
 * transactionally queues the Discord announcement. A claimed outbox worker
 * sends it after commit and retries through the site heartbeat.
 */
async function applyResult(lobbyId: string, r: BuiltResult): Promise<boolean> {
  // The claim AND the teamFixes loop commit together, as one transaction.
  //
  // They used to be separate statements, which was harmless until betting
  // existed and is a money bug now. The claim commits on its own, so between
  // it and the end of the loop the row reads COMPLETED with a PENDING pot but
  // the DRAFT roster — and `resolveUnsettledBets` runs on EVERY page view of
  // the entire site via /api/sync. A rival landing in that gap wins the
  // settlement claim and pays out against the side each player was DRAFTED
  // onto rather than the side they PLAYED, so a slot swap pays the wrong five
  // and VOID_LINEUP never fires at all. It is permanent, too: settlement is
  // single-winner, so the real call below then finds nothing to do.
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
  // `matchStartTime` is persisted into the EXISTING claim below rather than read
  // from `r` at settlement time: any check performed AFTER a claim has to be
  // computable from COLUMNS, because the request holding this BuiltResult is
  // allowed to die (serverless, a dropped connection, a deploy). The late-bet
  // void keys on Valve's own start_time, the one timestamp ten interested
  // parties cannot forge, so the lazy sweeper hours later must reach the
  // identical verdict to the fast path — and it can only do that if the number
  // is on the row. Costs one field in a write that was already happening, and
  // if the claim loses, nothing was stamped.
  //
  // The guard below it is BELT-AND-BRACES and UNREACHABLE TODAY, said plainly
  // because "defensive" and "untested gap" look identical from here. Both
  // result paths already floor start_time at the lobby createdAt (recordMatch
  // refuses below it; findInhouseGame skips below it), so a 0 or missing value
  // cannot arrive — which is also why no test can kill this predicate. It stays
  // because the failure it prevents is silent and TOTAL: new Date(0) is 1970,
  // every bet is then placedAt > matchStart, and the WHOLE pot voids to
  // VOID_LATE. Nobody wins, nobody loses, and the feature simply looks broken
  // with no error anywhere. Null instead means we cannot establish when the game
  // began, so the late-bet rule is not enforced and the pot settles normally —
  // failing OPEN, the right side when the uncertainty is ours not the bettor
  // side's. If a THIRD result path is ever added, this is what stops it.
  const matchStart =
    Number.isFinite(r.startTime) && r.startTime > 0
      ? new Date(r.startTime * 1000)
      : null;
  // Stable result recency. `updatedAt` also moves when a stranded pot retries,
  // which can otherwise resurrect an older game's banner above the real latest
  // result. Hoisted to keep the guarded claim's data block flat for the mutation
  // ratchet (same rule as matchStart immediately above).
  const completedAt = new Date();

  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.inhouseLobby.updateMany({
      where: { id: lobbyId, status: INHOUSE_STATUS.IN_PROGRESS },
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
    // transaction exists to close — a rival `resolveUnsettledBets` (which
    // /api/sync runs on every page view of the entire site) must not be able
    // to see a COMPLETED lobby carrying the DRAFT roster. A test yields here
    // and either kills this request or runs that sweeper from a second
    // connection; racing cannot steer an interleaving this narrow.
    await raceHook("inhouse.applyResult.beforeTeamFixes");

    // Move anyone who played the opposite side onto the side they actually
    // played (see buildResult). Inside the claim's transaction so no reader
    // can ever see a COMPLETED lobby carrying the draft's roster —
    // summarizeInhouse rates off InhouseLobbyPlayer.team and settlement voids
    // off it, so a visible half-state mis-rates the game AND mis-pays the pot.
    for (const fix of r.teamFixes) {
      await tx.inhouseLobbyPlayer.updateMany({
        where: { lobbyId, userId: fix.userId },
        data: { team: fix.team },
      });
    }
    return true;
  });
  if (!claimed) return false;

  // Pay the pot. Both boundaries around this call are load-bearing:
  //
  //   * AFTER the teamFixes loop, because that loop rewrites the very column
  //     settlement reads — `InhouseLobbyPlayer.team`, the side each player
  //     actually played. Settling first would compare every frozen bet against
  //     the DRAFT instead of the game, which prices a two-man slot swap in the
  //     hand-hosted Dota lobby as a live arbitrage instead of voiding both
  //     halves of it.
  //   * BEFORE the history scan below, because that scan is the slow unwindowed
  //     one and the `eloDeltas` write under it is the ONE write in this
  //     function that is not a claim. Money must not sit downstream of the
  //     least-guarded statement here.
  //
  // The try/catch is mandatory, not defensive habit. This runs from resolver
  // chains that /api/sync executes on every page view of the entire site, so a
  // bug in the betting code must never be able to stop the Elo stamp, the
  // result cursor or the Discord announcement — ten people playing Dota do not
  // care that the pot failed. A settlement left PENDING is retried by
  // `resolveUnsettledBets` on the next poll from anywhere.
  let settlement: Settlement | null = null;
  try {
    settlement = await settleInhouseBets(lobbyId);
  } catch (e) {
    console.error("[inhouse-bets] settlement failed", e);
  }

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

  // Built before the finalization claim so the row lock below is held only for
  // the Elo write and its durable outbox insert.
  //
  // The third boundary: the announcement is downstream of the settlement, which
  // is the only order that lets it carry the slips block (who was in for what).
  // Names come off the history scan already in hand rather than a fresh query.
  // `settlement` is null whenever this caller didn't win the settlement claim,
  // whenever nobody bet, and whenever the try/catch above swallowed a bug —
  // in all three the post reads exactly as it did before betting existed.
  const nameOf = new Map(
    thisLobby?.players.map((p) => [p.userId, p.user.name]) ?? [],
  );
  const slips = settlement
    ? settlement.bets.map((b) => ({ ...b, name: nameOf.get(b.userId) ?? "?" }))
    : null;

  const radiantWin = r.winnerTeam === r.radiantTeam;
  const mvpId = gameMvp(r.boxScore, radiantWin);
  const mvp = mvpId ? r.boxScore.find((b) => b.userId === mvpId) : null;
  // Assembled as a variable, not passed as a fresh literal: `slips` rides along
  // on the argument the formatter already takes, and TypeScript only applies its
  // excess-property check to literals at the call site. So this compiles while
  // inhouseResultMessage still ignores the field (rendering the block is
  // discord.ts's half of the feature) and starts feeding it the day it declares
  // one — and if it declares a DIFFERENT shape, this stops compiling rather than
  // quietly sending the old message.
  const resultMessage = {
    winnerSide: (radiantWin ? "Radiant" : "Dire") as "Radiant" | "Dire",
    radiantScore: r.radiantScore,
    direScore: r.direScore,
    durationSecs: r.durationSecs,
    mvpName: mvp?.name ?? null,
    mvpHero: mvp ? (heroById(mvp.heroId)?.name ?? null) : null,
    dotaMatchId: r.dotaMatchId,
    slips,
  };
  const resultContent = inhouseResultMessage(resultMessage);

  // A completed result is still voidable while settlement/history are being
  // computed. The old update-by-id below could therefore restore eloDeltas on
  // a CANCELLED lobby, then publish a stale result after the void correction.
  // Yield while everything is still read-only so the exact interleaving can be
  // tested without deadlocking a rival on this row.
  await raceHook("inhouse.applyResult.beforeFinalizationClaim");

  // Finalize only if this exact result is still current. The UPDATE and outbox
  // insert commit together, so a committed result can never silently lack its
  // retryable Discord work. No network call runs while this transaction is
  // open. voidLastResult serializes publication through the same outbox:
  //
  //   * void wins first -> this claim loses, so no result event exists;
  //   * finalization wins first -> void cancels an unsent result, or queues its
  //     correction behind an already-leased/sent result.
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
    await tx.inhouseAnnouncement.create({
      data: {
        lobbyId,
        kind: INHOUSE_ANNOUNCEMENT_KIND.RESULT,
        sequence: 1,
        content: resultContent,
        resultMatchId: r.dotaMatchId,
      },
    });
    return true;
  });
  if (!finalized) return false;

  // Every parked client learns via the /api/sync cursor, not just this one.
  await stampResultChange();
  // Preserve the immediate announcement when Discord is healthy, but only
  // AFTER the result + outbox transaction commits. A false/throw leaves the
  // row PENDING for the sitewide sync heartbeat instead of burning the event.
  try {
    await deliverInhouseAnnouncements({ lobbyId });
  } catch (error) {
    console.error("[inhouse-announcement] immediate delivery failed", error);
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
): Promise<{ result: BuiltResult | null; unreachable: boolean }> {
  const accounts = players
    .map((p) => effectiveDotaAccountId(p.user))
    .filter((a): a is number => a != null);
  if (accounts.length === 0) return { result: null, unreachable: false };

  const lists = await Promise.all(
    accounts.map((acc) => fetchRecentMatchIds(acc, 10)),
  );
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
): Promise<InhouseActionResult> {
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
  // Throttled claim, not a blind stamp. Each press is ~16 OpenDota calls, and
  // ten impatient players hammering the button after a game burned hundreds —
  // enough to exhaust the free daily budget and take LEAGUE result sync down
  // with it. The background scanner already claims this way; the manual button
  // bypassed it entirely.
  const claim = await prisma.inhouseLobby.updateMany({
    where: {
      id: lobby.id,
      status: INHOUSE_STATUS.IN_PROGRESS,
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
      error:
        "The lobby closed while we fetched — the result is already in (or an admin cancelled it).",
    };
  }
  return { ok: true };
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
      error:
        "Couldn't fetch that match from OpenDota (is the ID right and public?)",
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
      error:
        "The lobby closed while we fetched — the result is already in (or an admin cancelled it).",
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

  // Refuse while a LIVE lobby is holding stakes.
  //
  // Voiding this game makes the sweeper reverse its payouts, and a reversal is
  // an unfloored `{ increment: -payout }`. If a winner has already staked
  // those winnings on the lobby that is running right now, the claw-back takes
  // them below zero — a state nothing else in the system can produce, whose
  // only symptom is a player mysteriously unable to bet. (`adjustCred` is the
  // repair and now works on a negative balance, but "the admin can clean it
  // up afterwards" is not a design.) Waiting costs the admin one game; the
  // alternative costs a player their balance silently.
  //
  // Read-time only, deliberately. Re-asserting this at the write means a
  // Serializable pair with `placeInhouseBet` — it reads the lobby and writes a
  // bet, this counts bets and writes the lobby — and SSI only spots the cycle
  // if BOTH sides are Serializable, so it would mean putting the hot betting
  // path on Serializable with P2034 retries to close a gap of milliseconds
  // that requires an admin to press Void in the exact instant someone stakes.
  // The residual case lands on the honest side: a negative balance an admin
  // can now actually fix.
  const liveStakes = await prisma.inhouseBet.count({
    where: {
      confirmedAt: { not: null },
      lobby: { status: { in: INHOUSE_ACTIVE_STATUSES } },
    },
  });
  if (liveStakes > 0) {
    return {
      ok: false,
      error:
        "There's a live game with Cred staked on it — void this result once that game has finished.",
    };
  }

  // The pot, read BEFORE the claim — unlike cancelLobby, which reads its
  // figures afterwards, this one has no choice: the claim NULLS dotaMatchId and
  // blanks the box score, so a moment later there is nothing left that names
  // which game was removed. Stakes themselves don't move (a reversal rewrites
  // outcomes and balances, never `stake`), so reading early costs no accuracy;
  // the figures are only USED below, past the claim, so a losing void still
  // logs and announces nothing.
  const pot = await prisma.inhouseBet.aggregate({
    where: { lobbyId: last.id, confirmedAt: { not: null } },
    _sum: { stake: true },
    _count: { _all: true },
  });
  const betCount = pot._count._all;
  const staked = pot._sum.stake ?? 0;
  const voidContent = inhouseResultVoidedMessage({
    betCount,
    staked,
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
  await stampResultChange();

  // Await the canonical settlement resolver before returning. The state flip
  // remains the single source of truth for *why* money moves; invoking the
  // existing sweeper here merely closes the window where a successful admin
  // action still showed the old payout/refund until somebody next polled.
  // Best-effort for the same reason as the site-wide resolver chain: a betting
  // failure cannot roll back the already-committed void, and the next poll can
  // retry the unchanged settlement state.
  try {
    await resolveUnsettledBets(last.id);
  } catch (e) {
    console.error("[inhouse-bets] post-void sweep failed", e);
  }

  // Post-claim, so only the winner of a concurrent void writes the record —
  // the cancelLobby ordering. This action erases a result and every payout that
  // came off it, and until now it left NO trace anywhere: the lobby reads
  // CANCELLED like any abandoned game, the Elo swing simply recomputes away,
  // and the match id that would identify the game is gone. The AdminAction row
  // IS the whole record, which is why the id and the pot go in the summary
  // rather than being left to a join that has nothing to join against.
  await logAdminAction({
    action: "voidLastResult",
    summary: `Voided the inhouse result${
      last.dotaMatchId ? ` (match ${last.dotaMatchId})` : ""
    } — ${
      betCount > 0
        ? `${betCount} confirmed bet(s), ${staked} Cred staked, reversed to pre-game balances`
        : "no Cred was staked on it"
    }`,
  });

  // Every successful void corrects Discord, including a betless game. The
  // outbox event was committed with the state flip above, and this post-commit
  // attempt preserves the old immediate UX without making a transport failure
  // permanent. It rides the ALERT webhook, never the board's.
  try {
    await deliverInhouseAnnouncements({ lobbyId: last.id });
  } catch (error) {
    console.error("[inhouse-announcement] void delivery failed", error);
  }
  return { ok: true };
}

export async function cancelLobby(
  viewer: SessionUser,
  opts?: { force?: boolean },
): Promise<InhouseActionResult> {
  if (viewer.role !== "ADMIN") return { ok: false, error: "Admins only" };
  const force = opts?.force === true;
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
    //
    // Second predicate, unless the admin explicitly forced it: an IN_PROGRESS
    // lobby with confirmed bets on it must not be cancelled casually, because
    // under any betting design cancelling a live game IS an undo for a losing
    // bet — the game is half-played, everyone can see how it is going, and the
    // sweeper refunds the pot in full. The gate is the reopenMatch pattern
    // (relation filter in the WHERE, not an `if` above it) so it survives the
    // result landing between the admin's read and this write.
    //
    // Only the IN_PROGRESS branch: the window opens at READY, but a lobby
    // cancelled there has no result to unwind and nothing to read off, so the
    // refund is uncontroversial.
    //
    // And admins are deliberately NOT locked out. An unkillable lobby holds the
    // single active slot — no new game can form and its own ten are refused the
    // queue — for the six hours until the abandon sweep, which is a strictly
    // worse failure than a forced cancel that leaves an AdminAction behind.
    const claim = await tx.inhouseLobby.updateMany({
      where: {
        id: lobby.id,
        status: { in: INHOUSE_ACTIVE_STATUSES },
        OR: force
          ? undefined
          : [
              { status: { not: INHOUSE_STATUS.IN_PROGRESS } },
              {
                status: INHOUSE_STATUS.IN_PROGRESS,
                bets: { none: { confirmedAt: { not: null } } },
              },
            ],
      },
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
    for (const [i, p] of requeuePlayers.entries()) {
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
    // The claim now has two ways to lose, and "nothing happened" is the one
    // answer an admin cannot act on (the reopenMatch lesson). Re-read to say
    // WHICH — a live pot is the recoverable one, and the sentence has to name
    // the override, because the admin's next move is the only thing that
    // unblocks the single active lobby slot.
    const staked = force
      ? 0
      : await prisma.inhouseBet.count({
          where: {
            lobbyId: lobby.id,
            confirmedAt: { not: null },
            lobby: { status: INHOUSE_STATUS.IN_PROGRESS },
          },
        });
    if (staked > 0) {
      return {
        ok: false,
        error: `${staked} ${
          staked === 1 ? "player has" : "players have"
        } Cred staked on this live game — cancelling refunds the pot in full. Use the forced cancel if that's really what you want.`,
      };
    }
    return {
      ok: false,
      error: "The lobby just finished — its result is in, nothing to cancel.",
    };
  }
  // Every successful admin cancellation is destructive and therefore gets an
  // audit row, not only the forced/money-bearing variant. Read after the claim
  // so a losing cancel logs nothing; stake figures remain stable through a
  // refund, which changes outcomes and balances but never the original stake.
  const pot = await prisma.inhouseBet.aggregate({
    where: { lobbyId: lobby.id, confirmedAt: { not: null } },
    _sum: { stake: true },
    _count: { _all: true },
  });
  await logAdminAction({
    action: "cancelLobby",
    summary: `${force ? "Force-cancelled" : "Cancelled"} the inhouse (${lobby.status}) with ${
      players.length
    } player(s) — ${pot._count._all} confirmed bet(s), ${
      pot._sum.stake ?? 0
    } Cred staked`,
  });

  // Synchronous best-effort sweep: the action returns after the canonical
  // refund path has had a chance to synchronize balances with CANCELLED.
  try {
    await resolveUnsettledBets(lobby.id);
  } catch (e) {
    console.error("[inhouse-bets] post-cancel sweep failed", e);
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

/**
 * The live pot, as the room's panel renders it. PUBLIC — every slip is visible
 * to everyone the instant it lands, because the panel is a live argument
 * ("they're 160 ahead — somebody take it") and a pot nobody can see is an
 * argument nobody can join.
 *
 * `covered` per slip comes from the SAME `potView` settlement reads, so the
 * button's promise ("100 staked · 40 covered · 60 comes home") and the payout
 * agree to the Cred. Two copies of that arithmetic is the `avgKnownMmr`
 * mistake — one average, three inline definitions, disagreeing on screen.
 */
type PotBlock = {
  /** Epoch ms, or null once the window has closed — the room shows no clock. */
  closesAt: number | null;
  pool1: number;
  pool2: number;
  matched: number;
  tier: PotTier;
  slips: {
    userId: string;
    name: string;
    team: number;
    stake: number;
    covered: number;
  }[];
};

/** Everything the inhouse room client needs, tailored to the viewing user. */
export async function getInhouseState(
  viewer: SessionUser | null,
  /** Set `syncBoard: false` on the MUTATION path so a button press never waits
   *  on Discord — see the board sync at the bottom of this function. */
  { syncBoard = true }: { syncBoard?: boolean } = {},
) {
  // Heartbeat before forming: the polling viewer must count as present.
  if (viewer) await touchQueueHeartbeat(viewer.id);
  // Abandoned first: it frees the single active-lobby slot, so maybeFormLobby
  // can form the next game on this very poll instead of the one after.
  await resolveAbandonedLobby();
  // …then the pot, immediately, and for the same reason the abandon sweep runs
  // first: that sweep is what flips a dead lobby to CANCELLED, so a stake
  // stranded on it becomes refundable on THIS poll rather than the next one.
  // It also covers the case nothing else does — the request that won
  // applyResult's COMPLETED claim died before it could pay out, and every
  // result path requires IN_PROGRESS, so nothing would ever re-trigger.
  //
  // Wrapped, and only this one is: the chain below runs from /api/sync on every
  // page view of the entire site. A bug in the betting code must never be able
  // to stop ten people playing Dota, so it logs and the poll carries on; the
  // next poll from anywhere retries the same pot.
  try {
    await resolveUnsettledBets();
  } catch (e) {
    console.error("[inhouse-bets]", e);
  }
  await maybeFormLobby();
  await resolveReadyCheck();
  await resolveCaptainVote();
  await resolveStalledPick();
  await maybeAutoDetectResult();

  const [queue, lobbyRow] = await Promise.all([
    prisma.inhouseQueueEntry.findMany({
      orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
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
    pot: PotBlock | null;
  } = null;

  // Filled alongside the lobby below; the `me` block needs it too (the viewer's
  // own slip and whether they can still place one).
  let pot: PotBlock | null = null;

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

    // BUDGETED: one query, and only for a lobby that actually has a betting
    // window. `betsCloseAt` is stamped once, on the DRAFTING → READY
    // transition, and the confirm claim requires `betsCloseAt > now` — so a
    // lobby without it provably has no bets, and the four phases before READY
    // (where the room polls hardest) pay nothing at all for this feature.
    if (lobbyRow.betsCloseAt) {
      const bets = await prisma.inhouseBet.findMany({
        where: { lobbyId: lobbyRow.id, confirmedAt: { not: null } },
        select: { userId: true, team: true, stake: true, placedAt: true },
        // Placement order — the slips are a log of the argument as it happened.
        // userId breaks the tie the way the rest of the repo does, so two
        // pollers can never render the same pot in two orders.
        orderBy: [{ placedAt: "asc" }, { userId: "asc" }],
      });
      const rows = bets.map((b) => ({
        userId: b.userId,
        team: b.team,
        stake: b.stake,
        placedAtMs: b.placedAt.getTime(),
      }));
      const view = potView(rows);
      const nameOf = new Map(
        lobbyRow.players.map((p) => [p.userId, p.user.name]),
      );
      pot = {
        // Null once it has passed, not a stale timestamp the room has to judge
        // for itself: "is the window open" is one question with one answer, and
        // the server is the only clock that matters (the room already folds its
        // skew against `now`).
        closesAt:
          lobbyRow.betsCloseAt.getTime() > now
            ? lobbyRow.betsCloseAt.getTime()
            : null,
        pool1: view.pool1,
        pool2: view.pool2,
        matched: view.matched,
        tier: potTier(view.pool1 + view.pool2),
        slips: rows.map((b) => ({
          userId: b.userId,
          name: nameOf.get(b.userId) ?? "?",
          team: b.team,
          stake: b.stake,
          covered: view.coveredByUser[b.userId] ?? 0,
        })),
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
        .sort(
          (a, b) =>
            b.mmr - a.mmr ||
            a.queuedAt.getTime() - b.queuedAt.getTime() ||
            a.userId.localeCompare(b.userId),
        )
        .map(toView),
      vote,
      readyCheck,
      pot,
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
  // time; `updatedAt` is deliberately not used because a delayed Cred retry
  // changes it and would resurface an old game as the newest banner.
  let lastResult: null | {
    lobbyId: string;
    winnerSide: "Radiant" | "Dire";
    radiantScore: number;
    direScore: number;
    myTeamWon: boolean;
    eloDelta: number;
    /**
     * The viewer's net Cred from that game, or null when they didn't bet — so
     * the banner omits the line entirely rather than announcing "+0 Cred" to
     * the eight people who sat the pot out.
     */
    credDelta: number | null;
    /** True when this bettor's payout/refund is still on the retryable sweep. */
    credPending: boolean;
  } = null;
  if (viewer) {
    const recent = await prisma.inhouseLobby.findFirst({
      where: {
        status: INHOUSE_STATUS.COMPLETED,
        completedAt: { gte: new Date(now - 10 * 60_000) },
        players: { some: { userId: viewer.id } },
      },
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      include: {
        players: true,
        bets: {
          where: { userId: viewer.id, confirmedAt: { not: null } },
          select: { id: true },
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
      // The eloDeltas precedent exactly: stamped once at settlement, read off
      // the row this query already fetched. ZERO extra queries on the poll
      // path, and never re-derived — a banner that recomputed the pot would
      // disagree with the ledger the moment anything was voided.
      let credDelta: number | null = null;
      try {
        const map = JSON.parse(recent.betDeltas) as Record<string, unknown>;
        const v = map[viewer.id];
        if (typeof v === "number" && Number.isFinite(v)) credDelta = v;
      } catch {
        // Malformed JSON — show the result without a Cred line.
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
        credDelta,
        credPending:
          recent.bets.length > 0 &&
          recent.betSettlement === INHOUSE_BET_STATUS.PENDING,
      };
    }
  }

  // The viewer's own slip, read straight off the pot so the panel's "40 of your
  // 100 is covered" is literally the same arithmetic everyone else's row shows.
  const myBet =
    myLobbyPlayer && pot
      ? (pot.slips.find((s) => s.userId === myLobbyPlayer.userId) ?? null)
      : null;

  // BUDGETED: the balance is fetched only when there is something to spend it
  // on (a seat in the lobby) or something to reconcile (a game that just
  // finished). A spectator idling on /inhouse pays nothing for it.
  //
  // A plain read, deliberately NOT `ensureCredAccount`: the poll path must not
  // write, and it doesn't need to — START_BALANCE is the column default the row
  // will be created with, so a player who has never bet sees the number they
  // are about to be funded with, and their first bet writes the account.
  let cred: number | null = null;
  if (viewer && (inLobby || lastResult)) {
    const acct = await prisma.inhouseCredit.findUnique({
      where: { userId: viewer.id },
      select: { balance: true },
    });
    cred = acct?.balance ?? INHOUSE_BETS.START_BALANCE;
  }

  // "Away" entries (heartbeat gone quiet — tab closed or backgrounded hard)
  // keep their spot for a grace window but don't count toward the ten.
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
      // never describe the same lobby differently. The pot is taken off the
      // block already built above rather than re-counted: `pool1 + pool2` is
      // the total staked, and it is null on exactly the lobbies that have no
      // betting window — the same test `potFrom` applies on the board's own
      // path, which is what keeps the two out of a digest fight.
      lobby: lobbyRow
        ? lobbyView(lobbyRow, pot ? pot.pool1 + pot.pool2 : null)
        : null,
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
      /** Play-money balance; null when signed out (nothing to show). */
      cred,
      myBet: myBet
        ? { stake: myBet.stake, team: myBet.team, covered: myBet.covered }
        : null,
      // ELIGIBILITY only — one of the ten, on a side, window still open, hasn't
      // bet. Never "is signed in": /api/inhouse answers `state` before its 401
      // gate, so a session proves nothing about a seat in this lobby, and the
      // write re-derives membership from InhouseLobbyPlayer regardless.
      //
      // Affordability is deliberately NOT folded in here. It depends on the
      // stake, and `betGateError` is the one place that decides it — the room
      // already calls it for the chip it is about to enable, and a second
      // definition of "can you bet" is exactly how a disabled button and the
      // sentence explaining it end up telling different stories.
      canBet: inLobby && myTeam != null && !myBet && pot?.closesAt != null,
    },
  };
}

export type InhouseState = Awaited<ReturnType<typeof getInhouseState>>;
