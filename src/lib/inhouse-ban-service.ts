// Inhouse bans (Tim, 2026-11-02): the writes and reads. The rules and words
// are inhouse-ban.ts. A ban keeps a player out of both inhouse queues: the
// joins (joinQueue, joinDuelQueue) refuse them inside their own Serializable
// transactions, and the requeues (failReadyCheck, cancelLobby, the 1v1's
// requeueAtFront) skip them. The bot gives the "Inhouse Banned" Discord role
// for the ban's length; the worker takes it off at the end
// (syncInhouseBanRoles).

import { Prisma } from "@prisma/client";
import {
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_DUEL_LIVE_STATUSES,
} from "./constants";
import { getInhouseBanRoleConfig, setInhouseBanRole } from "./discord-roles";
import { inhouseLobbyCode } from "./inhouse";
import {
  activeInhouseBans,
  inhouseBanActive,
  inhouseBanEndsAt,
  inhouseBanRefusal,
  inhouseBanRoleStep,
  type InhouseBanInput,
  type InhouseBanRoleOutcome,
  type InhouseBanRoleRow,
  type InhouseBanRow,
  type InhouseBanView,
} from "./inhouse-ban";
import { publishInhouseRoomChange } from "./inhouse-room-version";
import { prisma } from "./prisma";
import { isSerializationConflict } from "./prisma-errors";
import { raceHook } from "./race-hook";
import { retrySerializable } from "./serializable-retry";
import type { SessionUser } from "./auth";

type Db = Prisma.TransactionClient | typeof prisma;

/** A ban running at `now`: not lifted, and permanent or ending later. */
export function activeInhouseBanWhere(now: Date): Prisma.InhouseBanWhereInput {
  return { liftedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: now } }] };
}

const banRowSelect = {
  id: true,
  userId: true,
  reason: true,
  createdAt: true,
  endsAt: true,
  liftedAt: true,
  user: { select: { name: true, avatar: true } },
} as const;

/**
 * Every ban running at `nowMs`, for the room's rows, the board and /inhouse.
 * Bans are rare, so this is a small read; activeInhouseBans judges them again
 * at each caller's own clock.
 */
export async function loadActiveInhouseBanRows(
  db: Db,
  nowMs: number = Date.now(),
): Promise<InhouseBanRow[]> {
  return db.inhouseBan.findMany({
    where: activeInhouseBanWhere(new Date(nowMs)),
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 200,
    select: banRowSelect,
  });
}

/** The player's running ban (the longest-lasting), or null. */
export async function activeInhouseBanFor(
  db: Db,
  userId: string,
  nowMs: number = Date.now(),
): Promise<InhouseBanView | null> {
  const rows = await db.inhouseBan.findMany({
    where: { userId, ...activeInhouseBanWhere(new Date(nowMs)) },
    select: banRowSelect,
  });
  return activeInhouseBans(rows, nowMs)[0] ?? null;
}

/**
 * Why this player can't join an inhouse queue, or null when they aren't
 * banned. Pass the join's transaction to judge it at the write.
 */
export async function inhouseBanRefusalFor(
  db: Db,
  userId: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const ban = await activeInhouseBanFor(db, userId, nowMs);
  return ban
    ? inhouseBanRefusal({
        endsAt: ban.endsAtMs === null ? null : new Date(ban.endsAtMs),
        reason: ban.reason,
      })
    : null;
}

/** Which of these players are banned now. */
export async function bannedUserIds(
  db: Db,
  userIds: string[],
  nowMs: number = Date.now(),
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db.inhouseBan.findMany({
    where: { userId: { in: userIds }, ...activeInhouseBanWhere(new Date(nowMs)) },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

export type InhouseBanSaveResult =
  | {
      ok: true;
      banId: string;
      name: string;
      discordId: string | null;
      endsAt: Date | null;
      /** A ban that was running is lifted in its favour. */
      replaced: boolean;
      /** They were in the 5v5 or the 1v1 queue, and aren't now. */
      leftQueues: boolean;
      /** The live game they're still in ("inhouse #1234", "a 1v1"), if any. */
      liveGame: string | null;
    }
  | { ok: false; error: string };

/**
 * Ban one player from inhouse games. In one Serializable transaction: lift
 * any ban of theirs still running (this one replaces it, so changing a
 * length is one step), write the ban, and take them out of the 5v5 queue
 * (dropFromQueue, the leave's own locks) and the 1v1 queue.
 *
 * The joins re-read the ban inside their own Serializable transactions,
 * and this one reads both queues, so a join and a ban that cross abort one
 * and the retry sees the other: never a banned player left queued.
 *
 * A game they're already in is left alone (the toast names it; an admin can
 * cancel it). Its row is written here, though, as a lock: a cancel or a
 * failed ready check claims that same row before it requeues the ten and
 * then reads the bans, so it either waits for this commit and skips them, or
 * commits first and this transaction aborts and retries against the queue
 * it requeued.
 */
export async function banInhousePlayer(
  admin: SessionUser,
  input: InhouseBanInput,
): Promise<InhouseBanSaveResult> {
  if (admin.role !== "ADMIN") return { ok: false, error: "Admins only" };
  // Imported here: inhouse-service imports this file for the join's check.
  const { dropFromQueue } = await import("./inhouse-service");
  try {
    const saved = await retrySerializable(() =>
      prisma.$transaction(
        async (tx) => {
          const now = new Date();
          const user = await tx.user.findUnique({
            where: { id: input.userId },
            select: { id: true, name: true, discordId: true },
          });
          // Nothing is written yet, so the refusal may return.
          if (!user) return null;
          const running = await tx.inhouseBan.findMany({
            where: { userId: user.id, ...activeInhouseBanWhere(now) },
            select: { id: true },
          });
          // Seam: between the read of the running bans and the writes.
          await raceHook("inhouseBan.banInhousePlayer.beforeWrite");
          if (running.length > 0) {
            // Settled too: the new ban owns the Discord role from here.
            await tx.inhouseBan.updateMany({
              where: { id: { in: running.map((r) => r.id) } },
              data: { liftedAt: now, liftedByName: admin.name, settledAt: now },
            });
          }
          const ban = await tx.inhouseBan.create({
            data: {
              userId: user.id,
              reason: input.reason,
              // One clock for both, so the ban lasts exactly its length.
              createdAt: now,
              endsAt: inhouseBanEndsAt(input.length, now.getTime()),
              bannedById: admin.id,
              bannedByName: admin.name,
            },
            select: { id: true, endsAt: true },
          });
          const left5v5 = await dropFromQueue(tx, user.id);
          const left1v1 = await tx.inhouseDuelQueueEntry.deleteMany({
            where: { userId: user.id },
          });
          const lobbies = await tx.inhouseLobbyPlayer.findMany({
            where: {
              userId: user.id,
              lobby: { status: { in: INHOUSE_ACTIVE_STATUSES } },
            },
            select: { lobbyId: true },
          });
          if (lobbies.length > 0) {
            // The lock above: a write to the game's own row, nothing changed.
            await tx.inhouseLobby.updateMany({
              where: { id: { in: lobbies.map((l) => l.lobbyId) } },
              data: { updatedAt: now },
            });
          }
          const duels = await tx.inhouseDuel.findMany({
            where: {
              status: { in: INHOUSE_DUEL_LIVE_STATUSES },
              OR: [{ radiantUserId: user.id }, { direUserId: user.id }],
            },
            select: { id: true },
          });
          if (duels.length > 0) {
            // The same lock for the 1v1's requeue (declineDuel and the accept
            // clock claim the duel's row before requeueAtFront).
            await tx.inhouseDuel.updateMany({
              where: { id: { in: duels.map((d) => d.id) } },
              data: { updatedAt: now },
            });
          }
          const liveGame =
            lobbies.length > 0
              ? `inhouse #${inhouseLobbyCode(lobbies[0].lobbyId)}`
              : duels.length > 0
                ? "a 1v1"
                : null;
          return {
            banId: ban.id,
            name: user.name,
            discordId: user.discordId,
            endsAt: ban.endsAt,
            replaced: running.length > 0,
            leftQueues: left5v5 || left1v1.count > 0,
            liveGame,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    if (!saved) return { ok: false, error: "That player no longer exists." };
    // Rule P: the ban and the queue rows it removed are committed.
    await publishInhouseRoomChange();
    return { ok: true, ...saved };
  } catch (error) {
    if (isSerializationConflict(error)) {
      return {
        ok: false,
        error: "The queue was busy and the ban didn't save. Try again.",
      };
    }
    throw error;
  }
}

/** The bot's answer, as the admin's toast words it. */
function roleOutcome(
  change: "ok" | "not-a-member" | "forbidden" | "failed",
  on: boolean,
): InhouseBanRoleOutcome {
  if (change === "ok") return on ? "given" : "removed";
  if (change === "not-a-member") return on ? "not-in-server" : "removed";
  return change;
}

/**
 * Give a new ban's Discord role, after its commit (never inside a
 * transaction). Best-effort: whatever happens, the ban stands, and the
 * worker tries again (inhouseBanRoleStep) until the role is on.
 */
export async function giveInhouseBanRole(
  banId: string,
  discordId: string | null,
): Promise<InhouseBanRoleOutcome> {
  const cfg = await getInhouseBanRoleConfig();
  if (!cfg) return "off";
  if (!discordId) return "not-linked";
  const change = await setInhouseBanRole(discordId, true, cfg);
  const now = new Date();
  // By id alone: this is the site's own bookkeeping.
  await prisma.inhouseBan.updateMany({
    where: { id: banId },
    data: change === "ok" ? { roleAddedAt: now, roleTriedAt: now } : { roleTriedAt: now },
  });
  if (change === "ok") {
    // A lift that landed while the role went on settled the ban with
    // nothing to take off. Unsettle it: the worker's next pass (the
    // caller's gate expiry wakes it) takes the role off again.
    const row = await prisma.inhouseBan.findUnique({
      where: { id: banId },
      select: { settledAt: true },
    });
    if (row?.settledAt) {
      // No retry clock either: the removal is due at once.
      await prisma.inhouseBan.updateMany({
        where: { id: banId },
        data: { settledAt: null, roleTriedAt: null },
      });
    }
  }
  return roleOutcome(change, true);
}

export type InhouseBanLiftResult =
  | { ok: true; name: string; role: InhouseBanRoleOutcome }
  | { ok: false; error: string };

/**
 * Lift a running ban. The claim is the ban still unlifted, so a second
 * admin's click gets "already lifted" and nothing twice. The Discord role
 * comes off after the commit, unless another ban of theirs is running.
 */
export async function liftInhouseBan(
  admin: SessionUser,
  banId: string,
): Promise<InhouseBanLiftResult> {
  if (admin.role !== "ADMIN") return { ok: false, error: "Admins only" };
  if (!banId) return { ok: false, error: "Choose a ban to lift." };
  const ban = await prisma.inhouseBan.findUnique({
    where: { id: banId },
    select: { endsAt: true, user: { select: { name: true } } },
  });
  if (!ban) return { ok: false, error: "That ban no longer exists." };
  const now = new Date();
  if (ban.endsAt && ban.endsAt.getTime() <= now.getTime()) {
    return { ok: false, error: "That ban already ended." };
  }
  const lifted = await prisma.inhouseBan.updateMany({
    where: { id: banId, liftedAt: null },
    data: { liftedAt: now, liftedByName: admin.name },
  });
  if (lifted.count === 0) {
    return { ok: false, error: "That ban was already lifted." };
  }
  // Rule P: /inhouse and the board stop showing it.
  await publishInhouseRoomChange();
  const role = await settleInhouseBanRole(banId, now.getTime());
  return { ok: true, name: ban.user.name, role };
}

const roleRowSelect = {
  id: true,
  userId: true,
  endsAt: true,
  liftedAt: true,
  roleAddedAt: true,
  roleTriedAt: true,
  user: { select: { discordId: true } },
} as const;

type RoleRowRead = {
  id: string;
  userId: string;
  endsAt: Date | null;
  liftedAt: Date | null;
  roleAddedAt: Date | null;
  roleTriedAt: Date | null;
  user: { discordId: string | null };
};

function asRoleRow(row: RoleRowRead): InhouseBanRoleRow {
  return {
    endsAt: row.endsAt,
    liftedAt: row.liftedAt,
    roleAddedAt: row.roleAddedAt,
    roleTriedAt: row.roleTriedAt,
    discordId: row.user.discordId,
  };
}

/**
 * Do one unsettled ban's Discord step now (inhouseBanRoleStep): give the
 * role, take it off, or mark the ban settled. Outside any transaction; each
 * stamp is by id, the site's own record of what it last did.
 */
async function runInhouseBanRoleStep(
  row: RoleRowRead,
  nowMs: number,
  otherActive: boolean,
): Promise<InhouseBanRoleOutcome> {
  const cfg = await getInhouseBanRoleConfig();
  const step = inhouseBanRoleStep(asRoleRow(row), nowMs, {
    roleOn: cfg !== null,
    otherActive,
  });
  const discordId = row.user.discordId;
  // Waiting out a retry (the worker only; a fresh lift never waits).
  if (step.kind === "wait") return "failed";
  if (step.kind === "settle") {
    await prisma.inhouseBan.updateMany({
      where: { id: row.id },
      data: { settledAt: new Date(nowMs) },
    });
    if (otherActive) return "given";
    return cfg ? (discordId ? "removed" : "not-linked") : "off";
  }
  if (step.kind === "grant") return giveInhouseBanRole(row.id, discordId);
  // remove
  if (!cfg || !discordId) return "off";
  const change = await setInhouseBanRole(discordId, false, cfg);
  const at = new Date();
  const gone = change === "ok" || change === "not-a-member";
  await prisma.inhouseBan.updateMany({
    where: { id: row.id },
    data: gone ? { settledAt: at, roleTriedAt: at } : { roleTriedAt: at },
  });
  if (gone) {
    // A new ban made while the role came off: mark its role ungiven, so
    // the worker's next pass gives it again.
    const newer = await prisma.inhouseBan.findMany({
      where: { userId: row.userId, ...activeInhouseBanWhere(at) },
      select: { id: true },
    });
    if (newer.length > 0) {
      await prisma.inhouseBan.updateMany({
        where: { id: { in: newer.map((b) => b.id) } },
        data: { roleAddedAt: null, roleTriedAt: null },
      });
    }
  }
  return roleOutcome(change, false);
}

/** Settle one ban that just ended (a lift): the role off, or nothing to do. */
async function settleInhouseBanRole(
  banId: string,
  nowMs: number,
): Promise<InhouseBanRoleOutcome> {
  const row = await prisma.inhouseBan.findUnique({
    where: { id: banId },
    select: roleRowSelect,
  });
  if (!row) return "off";
  const others = await bannedUserIds(prisma, [row.userId], nowMs);
  return runInhouseBanRoleStep(row, nowMs, others.has(row.userId));
}

/**
 * The worker's ban step (result-sync-service.ts): for every unsettled ban,
 * give a missing role, take the role off a ban that ended or was lifted, or
 * mark it settled. Worker-only, never a room poll: Discord has no timed
 * roles, so a ban's end needs a clock, and the automation gate wakes the
 * worker for it (inhouseBanWakeAtMs). Never throws past one ban.
 */
export async function syncInhouseBanRoles(nowMs: number = Date.now()): Promise<void> {
  const rows = await prisma.inhouseBan.findMany({
    where: { settledAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 50,
    select: roleRowSelect,
  });
  if (rows.length === 0) return;
  const ended = rows.filter((r) => !inhouseBanActive(r, nowMs));
  const stillBanned = await bannedUserIds(
    prisma,
    [...new Set(ended.map((r) => r.userId))],
    nowMs,
  );
  for (const row of rows) {
    try {
      await runInhouseBanRoleStep(
        row,
        nowMs,
        !inhouseBanActive(row, nowMs) && stillBanned.has(row.userId),
      );
    } catch {
      // One ban's Discord trouble never stops the rest, or the pass.
    }
  }
}

/** The unsettled bans the automation gate reads (inhouseBanWakeAtMs). */
export async function loadUnsettledInhouseBans(): Promise<InhouseBanRoleRow[]> {
  const rows = await prisma.inhouseBan.findMany({
    where: { settledAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 100,
    select: roleRowSelect,
  });
  return rows.map(asRoleRow);
}

/** Running and recent bans for /admin/inhouse-players. */
export async function loadInhouseBanAdminRows(nowMs: number = Date.now()) {
  const rows = await prisma.inhouseBan.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 40,
    select: {
      ...banRowSelect,
      bannedByName: true,
      liftedByName: true,
      roleAddedAt: true,
      settledAt: true,
      user: { select: { name: true, avatar: true, discordId: true } },
    },
  });
  return rows.map((r) => ({ ...r, active: inhouseBanActive(r, nowMs) }));
}

export type InhouseBanAdminRow = Awaited<ReturnType<typeof loadInhouseBanAdminRows>>[number];
