import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import { INHOUSE, INHOUSE_DUEL_STATUS, INHOUSE_STATUS } from "@/lib/constants";
import { inhouseLobbyCode } from "@/lib/inhouse";
import type { SessionUser } from "@/lib/auth";
import {
  boardInputFrom,
  cancelLobby,
  declineMatch,
  joinQueue,
  loadInhouseRoomRows,
} from "@/lib/inhouse-service";
import { declineDuel, joinDuelQueue } from "@/lib/inhouse-duel-service";
import {
  banInhousePlayer,
  giveInhouseBanRole,
  liftInhouseBan,
  syncInhouseBanRoles,
} from "@/lib/inhouse-ban-service";
import { loadBoardSnapshot } from "@/lib/inhouse-board-service";
import { SETTING_KEYS, setSetting } from "@/lib/settings";
import type { InhouseBanLengthKey } from "@/lib/inhouse-ban";
import { ON_POSTGRES, makeUser, raceAll, sessionFor } from "./factories";

// Inhouse bans (docs/features/inhouse.md#bans): the queues refuse a banned
// player, the requeues skip one, the board lists the running bans, and the
// bot's Discord role follows the ban's life.

vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return { ...actual, sendInhouseDiscordMessage: vi.fn(async () => true) };
});
// 1v1 joins need a lobby bot that can host them.
vi.mock("@/lib/dota-lobby-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota-lobby-service")>();
  return { ...actual, inhouseLobbyBotConfigured: vi.fn(() => true) };
});
// The one bot-token call a ban makes; everything around it stays real.
vi.mock("@/lib/discord-roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord-roles")>();
  return { ...actual, setInhouseBanRole: vi.fn(async () => "ok" as const) };
});
import { setInhouseBanRole } from "@/lib/discord-roles";
const mockRole = vi.mocked(setInhouseBanRole);

const DAY = 86_400_000;
const ROLE_ID = "900000000000000777";

beforeEach(() => {
  mockRole.mockReset();
  mockRole.mockResolvedValue("ok");
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_GUILD_ID;
});
afterEach(() => {
  setRaceHook(null);
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_GUILD_ID;
});

async function adminSession(): Promise<SessionUser> {
  return sessionFor(await makeUser("Ban Admin", "ADMIN"));
}

async function player(name: string, discordId: string | null = null) {
  const user = await makeUser(name);
  if (discordId) {
    await prisma.user.update({ where: { id: user.id }, data: { discordId } });
  }
  return { user, session: sessionFor(user) };
}

async function queuedIds(): Promise<string[]> {
  const rows = await prisma.inhouseQueueEntry.findMany({
    orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

async function ban(admin: SessionUser, userId: string, length: InhouseBanLengthKey = "1w") {
  const saved = await banInhousePlayer(admin, { userId, length, reason: "Griefing" });
  if (!saved.ok) throw new Error(saved.error);
  return saved;
}

/** Ten queued players: the tenth join forms a READY_CHECK lobby. */
async function fullLobby() {
  const players = [];
  for (let i = 0; i < INHOUSE.LOBBY_SIZE; i++) {
    const p = await player(`B${i}`);
    expect(await joinQueue(p.session, 3000)).toEqual({ ok: true });
    players.push(p);
  }
  const lobby = await prisma.inhouseLobby.findFirstOrThrow({
    where: { status: INHOUSE_STATUS.READY_CHECK },
  });
  return { players, lobby };
}

describe("inhouse bans — the queues", () => {
  it("takes a banned player out of both queues and refuses both joins until lifted", async () => {
    const admin = await adminSession();
    const target = await player("Griefer");
    const other = await player("Fine");
    expect(await joinQueue(target.session, 3000)).toEqual({ ok: true });
    expect(await joinQueue(other.session, 3000)).toEqual({ ok: true });
    await prisma.inhouseDuelQueueEntry.create({
      data: { userId: target.user.id, expiresAt: new Date(Date.now() + 600_000) },
    });

    const saved = await ban(admin, target.user.id);
    expect(saved).toMatchObject({ leftQueues: true, replaced: false, liveGame: null });
    expect(await queuedIds()).toEqual([other.user.id]);
    expect(await prisma.inhouseDuelQueueEntry.count()).toBe(0);

    const refused = await joinQueue(target.session, 3000);
    expect(refused).toMatchObject({ ok: false });
    expect(!refused.ok && refused.error).toMatch(
      /^You're banned from inhouse games until .+\. Reason: Griefing$/,
    );
    expect(await joinDuelQueue(target.session)).toMatchObject({
      ok: false,
      error: expect.stringContaining("banned from inhouse games"),
    });
    expect(await queuedIds()).toEqual([other.user.id]);

    expect(await liftInhouseBan(admin, saved.banId)).toMatchObject({ ok: true });
    expect(await joinQueue(target.session, 3000)).toEqual({ ok: true });
    expect(await queuedIds()).toContain(target.user.id);
  });

  it("refuses a join at the write when the ban lands after the join's first read", async () => {
    const admin = await adminSession();
    const target = await player("Late");
    let fired = false;
    setRaceHook(
      onceAt("inhouse.joinQueue.beforeWrite", async () => {
        fired = true;
        await ban(admin, target.user.id);
      }),
    );
    const res = await joinQueue(target.session, 3000);
    expect(fired).toBe(true);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("banned") });
    expect(await queuedIds()).toEqual([]);
  });

  it("lets a player back in once the ban runs out", async () => {
    const admin = await adminSession();
    const target = await player("Served");
    await prisma.inhouseBan.create({
      data: {
        userId: target.user.id,
        reason: "Old",
        endsAt: new Date(Date.now() - 1_000),
        bannedById: admin.id,
        bannedByName: admin.name,
      },
    });
    expect(await joinQueue(target.session, 3000)).toEqual({ ok: true });
  });

  it("replaces a running ban, so changing a length is one step", async () => {
    const admin = await adminSession();
    const target = await player("Twice");
    const first = await ban(admin, target.user.id, "1d");
    const second = await banInhousePlayer(admin, {
      userId: target.user.id,
      length: "permanent",
      reason: "Again",
    });
    expect(second).toMatchObject({ ok: true, replaced: true, endsAt: null });
    const rows = await prisma.inhouseBan.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: first.banId, liftedByName: admin.name });
    expect(rows[0].liftedAt).not.toBeNull();
    // The new ban owns the role from here: the old one has nothing to undo.
    expect(rows[0].settledAt).not.toBeNull();
    expect(rows[1]).toMatchObject({ liftedAt: null, endsAt: null, reason: "Again" });
  });

  it("lifts a ban once: a second lift and a lift of an ended ban are refused", async () => {
    const admin = await adminSession();
    const target = await player("Lifted");
    const saved = await ban(admin, target.user.id);
    expect(await liftInhouseBan(admin, saved.banId)).toMatchObject({ ok: true, name: "Lifted" });
    expect(await liftInhouseBan(admin, saved.banId)).toEqual({
      ok: false,
      error: "That ban was already lifted.",
    });
    const old = await prisma.inhouseBan.create({
      data: {
        userId: target.user.id,
        reason: "Old",
        endsAt: new Date(Date.now() - 1_000),
        bannedById: admin.id,
        bannedByName: admin.name,
      },
    });
    expect(await liftInhouseBan(admin, old.id)).toEqual({
      ok: false,
      error: "That ban already ended.",
    });
  });

  it("refuses a player who isn't an admin", async () => {
    const target = await player("Victim");
    const rando = await player("Rando");
    expect(
      await banInhousePlayer(rando.session, {
        userId: target.user.id,
        length: "1d",
        reason: "x",
      }),
    ).toEqual({ ok: false, error: "Admins only" });
    expect(await prisma.inhouseBan.count()).toBe(0);
  });
});

describe("inhouse bans — a live game and the requeues", () => {
  it("leaves the banned player's live game alone, and a failed ready check doesn't requeue them", async () => {
    const admin = await adminSession();
    const { players, lobby } = await fullLobby();
    const saved = await ban(admin, players[0].user.id);
    expect(saved).toMatchObject({
      leftQueues: false,
      liveGame: `inhouse #${inhouseLobbyCode(lobby.id)}`,
    });
    // Still in the game: the ban doesn't cancel it.
    expect(
      await prisma.inhouseLobby.findUniqueOrThrow({ where: { id: lobby.id } }),
    ).toMatchObject({ status: INHOUSE_STATUS.READY_CHECK });

    // A decline sends the eight others still pending back to the queue,
    // never the banned one.
    expect(await declineMatch(players[1].session, lobby.id)).toEqual({ ok: true });
    const queued = await queuedIds();
    expect(queued).toHaveLength(INHOUSE.LOBBY_SIZE - 2);
    expect(queued).not.toContain(players[0].user.id);
    expect(queued).not.toContain(players[1].user.id);
  });

  it("an admin cancel requeues everyone but the banned player", async () => {
    const admin = await adminSession();
    const { players, lobby } = await fullLobby();
    await ban(admin, players[3].user.id);
    expect(await cancelLobby(admin, lobby.id)).toEqual({ ok: true });
    const queued = await queuedIds();
    expect(queued).toHaveLength(INHOUSE.LOBBY_SIZE - 1);
    expect(queued).not.toContain(players[3].user.id);
  });

  it("a 1v1's decline doesn't requeue the banned player who had accepted", async () => {
    const admin = await adminSession();
    const a = await player("DuelA");
    const b = await player("DuelB");
    const duel = await prisma.inhouseDuel.create({
      data: {
        radiantUserId: a.user.id,
        direUserId: b.user.id,
        status: INHOUSE_DUEL_STATUS.ACCEPTING,
        radiantAcceptedAt: new Date(),
      },
    });
    const saved = await ban(admin, a.user.id);
    expect(saved.liveGame).toBe("a 1v1");
    expect(await declineDuel(b.session, duel.id)).toEqual({ ok: true });
    // Without the ban, the accepter goes back to the front of the 1v1 queue.
    expect(await prisma.inhouseDuelQueueEntry.count()).toBe(0);
  });
});

describe("inhouse bans — what players see", () => {
  it("the room's rows and the board both list the running bans, and only them", async () => {
    const admin = await adminSession();
    const week = await player("WeekBan");
    const forever = await player("Forever");
    const served = await player("Served");
    await ban(admin, week.user.id, "1w");
    await banInhousePlayer(admin, {
      userId: forever.user.id,
      length: "permanent",
      reason: "Cheating",
    });
    await prisma.inhouseBan.create({
      data: {
        userId: served.user.id,
        reason: "Old",
        endsAt: new Date(Date.now() - 1_000),
        bannedById: admin.id,
        bannedByName: admin.name,
      },
    });
    const nowMs = Date.now();
    const fromRoom = boardInputFrom(await loadInhouseRoomRows(nowMs), nowMs).bans;
    const fromWorker = (await loadBoardSnapshot(nowMs)).bans;
    expect(fromRoom).toEqual(fromWorker);
    expect(fromRoom.map((b) => [b.name, b.reason, b.endsAtMs === null])).toEqual([
      ["Forever", "Cheating", true],
      ["WeekBan", "Griefing", false],
    ]);
  });
});

describe("inhouse bans — the Discord role", () => {
  beforeEach(async () => {
    process.env.DISCORD_BOT_TOKEN = "test-token";
    process.env.DISCORD_GUILD_ID = "900000000000000001";
    await setSetting(SETTING_KEYS.INHOUSE_BAN_ROLE_ID, ROLE_ID);
  });

  it("gives the role after a ban and takes it off at the lift", async () => {
    const admin = await adminSession();
    const target = await player("Roled", "123456789012345678");
    const saved = await ban(admin, target.user.id);
    expect(await giveInhouseBanRole(saved.banId, saved.discordId)).toBe("given");
    expect(mockRole).toHaveBeenLastCalledWith(
      "123456789012345678",
      true,
      expect.objectContaining({ roleId: ROLE_ID }),
    );
    expect(
      (await prisma.inhouseBan.findUniqueOrThrow({ where: { id: saved.banId } })).roleAddedAt,
    ).not.toBeNull();

    expect(await liftInhouseBan(admin, saved.banId)).toMatchObject({ ok: true, role: "removed" });
    expect(mockRole).toHaveBeenLastCalledWith("123456789012345678", false, expect.anything());
    expect(
      (await prisma.inhouseBan.findUniqueOrThrow({ where: { id: saved.banId } })).settledAt,
    ).not.toBeNull();
  });

  it("a lift that lands while the role goes on: the worker takes it off again", async () => {
    const admin = await adminSession();
    const target = await player("Crossed", "123456789012345683");
    const saved = await ban(admin, target.user.id);
    // A second admin lifts the ban while the first admin's grant is in flight.
    mockRole.mockImplementationOnce(async () => {
      expect(await liftInhouseBan(admin, saved.banId)).toMatchObject({ ok: true, role: "removed" });
      return "ok";
    });
    expect(await giveInhouseBanRole(saved.banId, saved.discordId)).toBe("given");
    expect(
      (await prisma.inhouseBan.findUniqueOrThrow({ where: { id: saved.banId } })).settledAt,
    ).toBeNull();
    await syncInhouseBanRoles();
    expect(mockRole).toHaveBeenLastCalledWith("123456789012345683", false, expect.anything());
    expect(
      (await prisma.inhouseBan.findUniqueOrThrow({ where: { id: saved.banId } })).settledAt,
    ).not.toBeNull();
  });

  it("says why no role was given: no linked Discord, or not in the server", async () => {
    const admin = await adminSession();
    const unlinked = await player("NoDiscord");
    const a = await ban(admin, unlinked.user.id);
    expect(await giveInhouseBanRole(a.banId, a.discordId)).toBe("not-linked");
    const outside = await player("Outside", "123456789012345679");
    const b = await ban(admin, outside.user.id);
    mockRole.mockResolvedValueOnce("not-a-member");
    expect(await giveInhouseBanRole(b.banId, b.discordId)).toBe("not-in-server");
    const row = await prisma.inhouseBan.findUniqueOrThrow({ where: { id: b.banId } });
    expect(row.roleAddedAt).toBeNull();
    expect(row.roleTriedAt).not.toBeNull();
  });

  it("the worker takes the role off a ban that ran out, and waits out a refusal", async () => {
    const admin = await adminSession();
    const target = await player("Expired", "123456789012345680");
    const longAgo = new Date(Date.now() - 2 * DAY);
    const ended = await prisma.inhouseBan.create({
      data: {
        userId: target.user.id,
        reason: "Old",
        endsAt: new Date(Date.now() - 1_000),
        bannedById: admin.id,
        bannedByName: admin.name,
        roleAddedAt: longAgo,
        roleTriedAt: longAgo,
      },
    });
    mockRole.mockResolvedValueOnce("failed");
    await syncInhouseBanRoles();
    expect(mockRole).toHaveBeenCalledTimes(1);
    expect(mockRole).toHaveBeenLastCalledWith("123456789012345680", false, expect.anything());
    let row = await prisma.inhouseBan.findUniqueOrThrow({ where: { id: ended.id } });
    expect(row.settledAt).toBeNull();

    // Refused moments ago: the next pass waits its retry.
    await syncInhouseBanRoles();
    expect(mockRole).toHaveBeenCalledTimes(1);

    await syncInhouseBanRoles(Date.now() + 10 * 60_000);
    expect(mockRole).toHaveBeenCalledTimes(2);
    row = await prisma.inhouseBan.findUniqueOrThrow({ where: { id: ended.id } });
    expect(row.settledAt).not.toBeNull();
  });

  it("the worker gives a missing role, and never takes off one a newer ban owns", async () => {
    const admin = await adminSession();
    const target = await player("Again", "123456789012345681");
    const old = await prisma.inhouseBan.create({
      data: {
        userId: target.user.id,
        reason: "Old",
        endsAt: new Date(Date.now() - 1_000),
        bannedById: admin.id,
        bannedByName: admin.name,
        roleAddedAt: new Date(Date.now() - DAY),
        roleTriedAt: new Date(Date.now() - DAY),
      },
    });
    const running = await ban(admin, target.user.id);
    await syncInhouseBanRoles();
    // One call, the grant; the old ban settles without a removal.
    expect(mockRole.mock.calls.map((c) => c[1])).toEqual([true]);
    const rows = await prisma.inhouseBan.findMany({ where: { id: { in: [old.id, running.banId] } } });
    expect(rows.find((r) => r.id === old.id)?.settledAt).not.toBeNull();
    expect(rows.find((r) => r.id === running.banId)?.roleAddedAt).not.toBeNull();
  });

  it("leaves Discord alone with no ban role set", async () => {
    await setSetting(SETTING_KEYS.INHOUSE_BAN_ROLE_ID, "");
    const admin = await adminSession();
    const target = await player("Quiet", "123456789012345682");
    const saved = await ban(admin, target.user.id);
    expect(await giveInhouseBanRole(saved.banId, saved.discordId)).toBe("off");
    expect(await liftInhouseBan(admin, saved.banId)).toMatchObject({ ok: true, role: "off" });
    await syncInhouseBanRoles();
    expect(mockRole).not.toHaveBeenCalled();
    expect(
      (await prisma.inhouseBan.findUniqueOrThrow({ where: { id: saved.banId } })).settledAt,
    ).not.toBeNull();
  });
});

// SQLite serializes writers, so these races only bite on Postgres. The seams
// fire inside the ban's open transaction, before it writes anything, so the
// rival never waits on a row the ban holds.
describe.skipIf(!ON_POSTGRES)("inhouse bans — raced (Postgres)", () => {
  it("a cancel that requeues the ten inside the ban's gap: the ban's retry takes them out", async () => {
    const admin = await adminSession();
    const { players, lobby } = await fullLobby();
    let fired = false;
    setRaceHook(
      onceAt("inhouseBan.banInhousePlayer.beforeWrite", async () => {
        fired = true;
        expect(await cancelLobby(admin, lobby.id)).toEqual({ ok: true });
      }),
    );
    const saved = await banInhousePlayer(admin, {
      userId: players[0].user.id,
      length: "1d",
      reason: "Race",
    });
    expect(fired).toBe(true);
    // The cancel read no ban and requeued all ten; the ban's write to the
    // game's row aborts it, and the retry removes the requeued row.
    expect(saved).toMatchObject({ ok: true, leftQueues: true, liveGame: null });
    const queued = await queuedIds();
    expect(queued).toHaveLength(INHOUSE.LOBBY_SIZE - 1);
    expect(queued).not.toContain(players[0].user.id);
  });

  it("a 1v1 decline inside the ban's gap: the requeued accepter comes out again", async () => {
    const admin = await adminSession();
    const a = await player("GapA");
    const b = await player("GapB");
    const duel = await prisma.inhouseDuel.create({
      data: {
        radiantUserId: a.user.id,
        direUserId: b.user.id,
        status: INHOUSE_DUEL_STATUS.ACCEPTING,
        radiantAcceptedAt: new Date(),
      },
    });
    let fired = false;
    setRaceHook(
      onceAt("inhouseBan.banInhousePlayer.beforeWrite", async () => {
        fired = true;
        expect(await declineDuel(b.session, duel.id)).toEqual({ ok: true });
      }),
    );
    expect(
      await banInhousePlayer(admin, { userId: a.user.id, length: "1d", reason: "Race" }),
    ).toMatchObject({ ok: true });
    expect(fired).toBe(true);
    expect(await prisma.inhouseDuelQueueEntry.count()).toBe(0);
  });

  it("a ban and a join that cross never leave the banned player queued", async () => {
    const admin = await adminSession();
    for (let round = 0; round < 8; round++) {
      const target = await player(`Racer${round}`);
      const [banned] = await raceAll<{ ok: boolean }>([
        () => banInhousePlayer(admin, { userId: target.user.id, length: "1d", reason: "Race" }),
        () => joinQueue(target.session, 3000),
      ]);
      if (banned.ok) {
        expect(await queuedIds(), `round ${round}`).not.toContain(target.user.id);
      }
    }
  });

  it("a ban racing an admin cancel never requeues the banned player", async () => {
    const admin = await adminSession();
    for (let round = 0; round < 4; round++) {
      const { players, lobby } = await fullLobby();
      const [banned, cancelled] = await raceAll<{ ok: boolean }>([
        () =>
          banInhousePlayer(admin, {
            userId: players[0].user.id,
            length: "1d",
            reason: "Race",
          }),
        () => cancelLobby(admin, lobby.id),
      ]);
      expect(cancelled).toEqual({ ok: true });
      if (banned.ok) {
        expect(await queuedIds(), `round ${round}`).not.toContain(players[0].user.id);
      }
      await prisma.inhouseQueueEntry.deleteMany();
    }
  });
});
