import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The smurf check (docs/features/players-and-registration.md#smurf-check;
// Tim, 2026-11-27): a new league signup and a first inhouse read the
// player's stored OpenDota snapshot, and an account with obvious signs of a
// smurf waits for an admin, through the same approval row a medal over the
// line uses (reason SMURF). Any approval sets the MMR and clears the check;
// only a medal one lets a medal over the line in.

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  getSessionUser: vi.fn(async () => ({ id: "smurf-admin", name: "Smurf Admin" })),
}));
// The check makes no call of its own; the signup's medal fetch answers
// nothing, so nothing here reaches OpenDota.
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchPlayerRankTier: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendDiscordMessage: vi.fn(async () => true),
  sendInhouseDiscordMessage: vi.fn(async () => true),
}));
vi.mock("@/lib/discord-roles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord-roles")>()),
  sendDirectMessage: vi.fn(async () => "ok" as const),
}));

import { askForMedalApproval } from "@/app/actions/medal-approval";
import { approveMedalApproval } from "@/app/actions/admin-medal-approvals";
import { saveRegistration } from "@/app/actions/registration";
import { requireAdmin, requireUser, type SessionUser } from "@/lib/auth";
import {
  APPROVAL_REASON,
  INHOUSE_DUEL_STATUS,
  INHOUSE_STATUS,
  MEDAL_APPROVAL_STATUS,
} from "@/lib/constants";
import { sendDirectMessage } from "@/lib/discord-roles";
import { duelMmrRefusal } from "@/lib/inhouse-duel-service";
import { joinQueue } from "@/lib/inhouse-service";
import {
  approveMedalRequest,
  askMedalApproval,
  loadMedalApprovalAdminRows,
} from "@/lib/medal-approval-service";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { makeSeason, makeUser, sessionFor } from "./factories";

const ADMIN: SessionUser = {
  id: "smurf-admin",
  steamId: "76561190000009500",
  name: "Smurf Admin",
  avatar: null,
  role: "ADMIN",
};

const mockDm = vi.mocked(sendDirectMessage);

function form(fields: Record<string, string | number>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
}

/** A stored snapshot in pub-stats.ts's shape. */
function snapshot({
  totalGames,
  lobbyMmr = null,
}: {
  totalGames: number;
  lobbyMmr?: number | null;
}): string {
  return JSON.stringify({
    recentWins: 50,
    recentLosses: 50,
    totalGames,
    lastPlayedAt: 1_793_000_000,
    topHeroes: [],
    scout: {
      v: 2,
      games: 100,
      firstAt: 1_790_000_000,
      lastAt: 1_793_000_000,
      ranked: 90,
      unranked: 5,
      turbo: 5,
      recentWins: 10,
      recentLosses: 10,
      form: "WLWLWLWLWL",
      core: 40,
      support: 40,
      coreAverages: null,
      supportAverages: null,
      positions: [8, 8, 8, 8, 8],
      partyKnown: 90,
      party: 10,
      abandons: 0,
      lobbyMmr,
      lobbyGames: lobbyMmr == null ? 0 : 40,
      lobbyRanked: lobbyMmr != null,
      regions: [],
      regionGames: 0,
      heroes: [],
      heroCount: 30,
    },
  });
}

/** A Legend 5 account with 190 games: young for its medal, so flagged. */
async function flagged(name = "Young Legend", rankTier = 55) {
  const user = await makeUser(name);
  return prisma.user.update({
    where: { id: user.id },
    data: {
      rankTier,
      pubStats: snapshot({ totalGames: 190, lobbyMmr: 3980 }),
      pubStatsAt: new Date(),
    },
  });
}

async function askAsSmurf(user: { id: string; steamId: string; name: string; role: string }) {
  const asked = await askMedalApproval(sessionFor(user), "This is my main now.");
  expect(asked).toMatchObject({ ok: true, reason: APPROVAL_REASON.SMURF });
  return prisma.medalApproval.findUniqueOrThrow({ where: { userId: user.id } });
}

async function approveAs(approvalId: string, mmr: number) {
  expect(
    await approveMedalRequest(ADMIN, {
      approvalId,
      judgedStatus: MEDAL_APPROVAL_STATUS.PENDING,
      mmr,
    }),
  ).toMatchObject({ ok: true });
}

async function finishedInhouse(userId: string) {
  const lobby = await prisma.inhouseLobby.create({
    data: { status: INHOUSE_STATUS.COMPLETED, completedAt: new Date(), winnerTeam: 1 },
  });
  await prisma.inhouseLobbyPlayer.create({
    data: { lobbyId: lobby.id, userId, team: 1, mmr: 3700 },
  });
}

beforeEach(() => {
  vi.mocked(requireUser).mockReset();
  vi.mocked(requireAdmin).mockReset();
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN);
  mockDm.mockReset();
  mockDm.mockResolvedValue("ok");
  vi.stubEnv("ADMIN_STEAM_IDS", "");
});
afterEach(() => {
  setRaceHook(null);
  vi.unstubAllEnvs();
});

describe("the league signup", () => {
  it("refuses a new signup the check flags, says what it found, and stores nothing", async () => {
    const season = await makeSeason();
    const player = await flagged();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    expect(await saveRegistration({}, form({ type: "PLAYER", mmr: 3700 }))).toEqual({
      error:
        "New signups get a smurf check, and yours needs an admin to look first: only 190 games on the account, few for a Legend 5 medal. Ask on this page, and an admin will set the MMR you play at.",
    });
    expect(await prisma.registration.count({ where: { seasonId: season.id } })).toBe(0);
  });

  it("refuses a standin signup the same way: every signup is checked", async () => {
    await makeSeason({ status: "REGULAR_SEASON" });
    const player = await flagged();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    expect(await saveRegistration({}, form({ type: "STANDIN", mmr: 3700 }))).toEqual({
      error: expect.stringMatching(/^New signups get a smurf check/),
    });
  });

  it("lets in an ordinary account, and one with no snapshot (unknown never blocks)", async () => {
    const season = await makeSeason();
    const veteran = await makeUser("Veteran");
    await prisma.user.update({
      where: { id: veteran.id },
      data: { rankTier: 55, pubStats: snapshot({ totalGames: 4000 }), pubStatsAt: new Date() },
    });
    const unknown = await makeUser("Private Data");
    await prisma.user.update({ where: { id: unknown.id }, data: { rankTier: 55 } });
    for (const user of [veteran, unknown]) {
      vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
      expect(await saveRegistration({}, form({ type: "PLAYER", mmr: 3700 }))).toEqual({
        message: expect.any(String),
      });
    }
    expect(await prisma.registration.count({ where: { seasonId: season.id } })).toBe(2);
  });

  it("never locks out a signup already in, but judges a return from withdrawn", async () => {
    const season = await makeSeason();
    const player = await flagged();
    await prisma.registration.create({
      data: { seasonId: season.id, userId: player.id, type: "PLAYER", mmr: 3700 },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    expect(
      await saveRegistration({}, form({ type: "PLAYER", mmr: 3700, favoriteHeroes: "Axe" })),
    ).toEqual({ message: expect.any(String) });
    await prisma.registration.update({
      where: { seasonId_userId: { seasonId: season.id, userId: player.id } },
      data: { status: "WITHDRAWN" },
    });
    expect(await saveRegistration({}, form({ type: "PLAYER", mmr: 3700 }))).toEqual({
      error: expect.stringMatching(/^New signups get a smurf check/),
    });
  });

  // The write re-asserts the admission the gate judged: a flagged player
  // got past it only as an ACTIVE signup, so a withdrawal landing between
  // the gate and the write must not be revived.
  it("doesn't revive a flagged signup that was withdrawn mid-submit", async () => {
    const season = await makeSeason();
    const player = await flagged();
    const reg = await prisma.registration.create({
      data: { seasonId: season.id, userId: player.id, type: "PLAYER", mmr: 3700 },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    let fired = false;
    setRaceHook(
      onceAt("registration.saveRegistration.beforeWrite", async () => {
        fired = true;
        await prisma.registration.update({
          where: { id: reg.id },
          data: { status: "WITHDRAWN" },
        });
      }),
    );
    expect(await saveRegistration({}, form({ type: "PLAYER", mmr: 3700 }))).toEqual({
      error: expect.stringMatching(/smurf check needs an admin to look at your account/),
    });
    expect(fired).toBe(true);
    expect((await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } })).status).toBe(
      "WITHDRAWN",
    );
  });
});

describe("asking and approving", () => {
  it("files a smurf check with what it found, and the bot tells each linked admin", async () => {
    const admin = await makeUser("Linked Admin", "ADMIN");
    await prisma.user.update({ where: { id: admin.id }, data: { discordId: "300000000000000001" } });
    const player = await flagged();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    expect(await askForMedalApproval({}, form({ note: "my old account was banned" }))).toEqual({
      message: expect.stringMatching(/Request sent/),
    });
    const row = await prisma.medalApproval.findUniqueOrThrow({ where: { userId: player.id } });
    expect(row).toMatchObject({
      status: MEDAL_APPROVAL_STATUS.PENDING,
      reason: APPROVAL_REASON.SMURF,
      note: "my old account was banned",
    });
    expect(JSON.parse(row.signals)).toEqual([
      { key: "young-account", line: "only 190 games on the account, few for a Legend 5 medal" },
    ]);
    expect(mockDm).toHaveBeenCalledTimes(1);
    expect(mockDm.mock.calls[0][1]).toMatch(
      /^🔎 \*\*Young Legend\*\* \(Legend 5\) asks for a smurf check\. It found: only 190 games/,
    );

    // The admin's list reads it, with the box starting where their ranked
    // games put them.
    const [listed] = await loadMedalApprovalAdminRows();
    expect(listed).toMatchObject({
      reason: APPROVAL_REASON.SMURF,
      suggestedMmr: 4000,
      signals: [{ key: "young-account" }],
    });
  });

  it("an approval admits the signup at the admin's number and tells the player", async () => {
    const season = await makeSeason();
    const player = await prisma.user.update({
      where: { id: (await flagged()).id },
      data: { discordId: "300000000000000002" },
    });
    const row = await askAsSmurf(player);
    expect(
      await approveMedalApproval({}, form({ approvalId: row.id, status: row.status, mmr: 4000 })),
    ).toEqual({
      message:
        "Young Legend passed the smurf check at 4,000 MMR: they can sign up for the league and join inhouses.",
    });
    expect(mockDm.mock.calls.at(-1)?.[1]).toMatch(/checked your account and approved you at 4,000 MMR/);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    // The clamp would hold Legend 5 near 3,700; the admin's number stands.
    expect(await saveRegistration({}, form({ type: "PLAYER", mmr: 3700 }))).toEqual({
      message: expect.stringMatching(/checked your account and approved you, so your signup keeps 4,000 MMR/),
    });
    expect(
      await prisma.registration.findUniqueOrThrow({
        where: { seasonId_userId: { seasonId: season.id, userId: player.id } },
      }),
    ).toMatchObject({ status: "ACTIVE", mmr: 4000 });
  });

  it("refuses to ask when nothing refuses them", async () => {
    const player = await makeUser("Clean");
    await prisma.user.update({
      where: { id: player.id },
      data: { rankTier: 55, pubStats: snapshot({ totalGames: 4000 }), pubStatsAt: new Date() },
    });
    expect(await askMedalApproval(sessionFor(player), "")).toEqual({
      ok: false,
      error: expect.stringMatching(/nothing to approve/),
    });
  });
});

describe("a smurf check's approval and the medal line", () => {
  it("doesn't let a medal over the line in, and the player asks again for the medal", async () => {
    await makeSeason();
    const player = await flagged();
    const row = await askAsSmurf(player);
    await approveAs(row.id, 4000);
    // Their medal climbs past Divine 3.
    await prisma.user.update({ where: { id: player.id }, data: { rankTier: 73 } });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    expect(await saveRegistration({}, form({ type: "PLAYER" }))).toEqual({
      error: expect.stringMatching(/Divine 3 medal puts you above it\. An admin can approve you/),
    });
    expect(await joinQueue(sessionFor(player), 0)).toEqual({
      ok: false,
      error: expect.stringMatching(/Divine 3 medal puts you above it/),
    });
    // Asking again turns the row into a fresh medal request.
    expect(await askMedalApproval(sessionFor(player), "climbed")).toMatchObject({
      ok: true,
      reason: APPROVAL_REASON.MEDAL,
    });
    expect(
      await prisma.medalApproval.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      status: MEDAL_APPROVAL_STATUS.PENDING,
      reason: APPROVAL_REASON.MEDAL,
      note: "climbed",
      mmr: null,
      signals: "",
    });
  });

  // The convert claims the APPROVED status it read: a second tab's ask that
  // converted first wins, and the loser is told it already asked.
  it("two tabs asking again convert the row once", async () => {
    const player = await flagged();
    const row = await askAsSmurf(player);
    await approveAs(row.id, 4000);
    await prisma.user.update({ where: { id: player.id }, data: { rankTier: 73 } });
    let fired = false;
    setRaceHook(
      onceAt("medalApproval.ask.beforeWrite", async () => {
        fired = true;
        expect(await askMedalApproval(sessionFor(player), "first tab")).toMatchObject({
          ok: true,
        });
      }),
    );
    expect(await askMedalApproval(sessionFor(player), "second tab")).toEqual({
      ok: false,
      error: expect.stringMatching(/already asked/),
    });
    expect(fired).toBe(true);
    expect(
      (await prisma.medalApproval.findUniqueOrThrow({ where: { id: row.id } })).note,
    ).toBe("first tab");
  });

  it("an approve of a smurf request whose medal is now over the line answers the medal too", async () => {
    const season = await makeSeason();
    const player = await flagged();
    const row = await askAsSmurf(player);
    await prisma.user.update({ where: { id: player.id }, data: { rankTier: 73 } });
    expect(
      await approveMedalRequest(ADMIN, {
        approvalId: row.id,
        judgedStatus: MEDAL_APPROVAL_STATUS.PENDING,
        mmr: 5020,
      }),
    ).toMatchObject({ ok: true, reason: APPROVAL_REASON.MEDAL });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    expect(await saveRegistration({}, form({ type: "PLAYER" }))).toEqual({
      message: expect.any(String),
    });
    expect(
      (await prisma.registration.findUniqueOrThrow({
        where: { seasonId_userId: { seasonId: season.id, userId: player.id } },
      })).mmr,
    ).toBe(5020);
  });
});

describe("the inhouse queue", () => {
  it("refuses a first-time player the check flags, 5v5 and 1v1 alike", async () => {
    const player = await flagged();
    const refusal = expect.stringMatching(
      /^New inhouse players get a smurf check, and yours needs an admin to look before your first game: only 190 games/,
    );
    expect(await joinQueue(sessionFor(player), 3700)).toEqual({ ok: false, error: refusal });
    expect(await duelMmrRefusal(player.id)).toEqual(refusal);
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
  });

  it("lets in a player who has finished an inhouse, 5v5 or 1v1", async () => {
    const fiveVFive = await flagged("Played Five");
    await finishedInhouse(fiveVFive.id);
    expect(await joinQueue(sessionFor(fiveVFive), 3700)).toEqual({ ok: true });

    const duelist = await flagged("Played Duel");
    const rival = await makeUser("Rival");
    await prisma.inhouseDuel.create({
      data: {
        status: INHOUSE_DUEL_STATUS.COMPLETED,
        radiantUserId: rival.id,
        direUserId: duelist.id,
      },
    });
    expect(await duelMmrRefusal(duelist.id)).toBeNull();
  });

  it("lets in an approved player at the approved number, and one an admin set an inhouse MMR for", async () => {
    const approved = await flagged("Approved");
    const row = await askAsSmurf(approved);
    await approveAs(row.id, 4100);
    expect(await joinQueue(sessionFor(approved), 3000)).toEqual({ ok: true });
    expect(
      (await prisma.inhouseQueueEntry.findUniqueOrThrow({ where: { userId: approved.id } })).mmr,
    ).toBe(4100);

    const rated = await flagged("Rated");
    await prisma.user.update({ where: { id: rated.id }, data: { inhouseMmr: 3900 } });
    expect(await joinQueue(sessionFor(rated), 0)).toEqual({ ok: true });
  });

  it("refuses the join when an admin's approval changes mid-join", async () => {
    const player = await flagged();
    const row = await askAsSmurf(player);
    await approveAs(row.id, 4100);
    let fired = false;
    setRaceHook(
      onceAt("inhouse.joinQueue.beforeWrite", async () => {
        fired = true;
        await prisma.medalApproval.delete({ where: { id: row.id } });
      }),
    );
    expect(await joinQueue(sessionFor(player), 0)).toEqual({
      ok: false,
      error: expect.stringMatching(/changed your approval/),
    });
    expect(fired).toBe(true);
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
  });
});
