import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Medal approvals (docs/features/players-and-registration.md#medal-approvals;
// Tim, 2026-11-21): a player over the medal line asks, an admin approves at
// an MMR or declines, and an approval lets the league signup and the inhouse
// queue past the medal rule at that MMR. Each admin write claims the status
// its list showed; the signup and the join re-read the approval at the write.

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  // logAdminAction resolves its actor from the session.
  getSessionUser: vi.fn(async () => ({ id: "medal-admin", name: "Medal Admin" })),
}));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchPlayerRankTier: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendDiscordMessage: vi.fn(async () => true),
  sendInhouseDiscordMessage: vi.fn(async () => true),
}));
// The bot's DMs: the one Discord call approvals make.
vi.mock("@/lib/discord-roles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord-roles")>()),
  sendDirectMessage: vi.fn(async () => "ok" as const),
}));

import { askForMedalApproval } from "@/app/actions/medal-approval";
import {
  approveMedalApproval,
  declineMedalApproval,
  removeMedalApprovalAction,
} from "@/app/actions/admin-medal-approvals";
import { saveRegistration } from "@/app/actions/registration";
import { requireAdmin, requireUser, type SessionUser } from "@/lib/auth";
import { MEDAL_APPROVAL_STATUS } from "@/lib/constants";
import { sendDirectMessage } from "@/lib/discord-roles";
import { joinQueue } from "@/lib/inhouse-service";
import {
  approveMedalRequest,
  askMedalApproval,
  declineMedalRequest,
  loadMedalApprovalAdminRows,
  removeMedalApproval,
} from "@/lib/medal-approval-service";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { makeSeason, makeUser, raceAll, sessionFor } from "./factories";

const ADMIN: SessionUser = {
  id: "medal-admin",
  steamId: "76561190000009400",
  name: "Medal Admin",
  avatar: null,
  role: "ADMIN",
};
const OTHER_ADMIN: SessionUser = { ...ADMIN, id: "medal-admin-2", name: "Other Admin" };

const mockDm = vi.mocked(sendDirectMessage);

function form(fields: Record<string, string | number>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
}

/** A Divine 5 player (exact floor 5,420): over the line whatever they type. */
async function overTheLine(name = "Divine Five", discordId: string | null = null) {
  const user = await makeUser(name);
  return prisma.user.update({
    where: { id: user.id },
    data: { rankTier: 75, ...(discordId ? { discordId } : {}) },
  });
}

async function pendingFor(user: { id: string; steamId: string; name: string; role: string }) {
  const asked = await askMedalApproval(sessionFor(user), "My medal is old.");
  expect(asked.ok).toBe(true);
  return prisma.medalApproval.findUniqueOrThrow({ where: { userId: user.id } });
}

async function approvedFor(
  user: { id: string; steamId: string; name: string; role: string },
  mmr: number,
) {
  const row = await pendingFor(user);
  expect(
    await approveMedalRequest(ADMIN, {
      approvalId: row.id,
      judgedStatus: MEDAL_APPROVAL_STATUS.PENDING,
      mmr,
    }),
  ).toMatchObject({ ok: true });
  return row;
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

describe("asking", () => {
  it("stores one waiting request with the medal and note, and DMs each linked admin", async () => {
    const admin = await makeUser("Linked Admin", "ADMIN");
    await prisma.user.update({
      where: { id: admin.id },
      data: { discordId: "200000000000000001" },
    });
    const player = await overTheLine();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const res = await askForMedalApproval({}, form({ note: "  I play  4,500 now " }));
    expect(res).toEqual({ message: expect.stringMatching(/Request sent/) });
    const row = await prisma.medalApproval.findUniqueOrThrow({
      where: { userId: player.id },
    });
    expect(row).toMatchObject({
      status: MEDAL_APPROVAL_STATUS.PENDING,
      note: "I play 4,500 now",
      rankTier: 75,
      mmr: null,
    });
    expect(mockDm).toHaveBeenCalledTimes(1);
    expect(mockDm.mock.calls[0][0]).toBe("200000000000000001");
    expect(mockDm.mock.calls[0][1]).toMatch(/Divine Five\*\* \(Divine 5\)/);
  });

  it("DMs the allowlist's admins when ADMIN_STEAM_IDS is set, not a stale stored role", async () => {
    const listed = await makeUser("Listed Admin");
    await prisma.user.update({
      where: { id: listed.id },
      data: { discordId: "200000000000000002" },
    });
    const stale = await makeUser("Former Admin", "ADMIN");
    await prisma.user.update({
      where: { id: stale.id },
      data: { discordId: "200000000000000003" },
    });
    vi.stubEnv("ADMIN_STEAM_IDS", listed.steamId);
    const player = await overTheLine();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await askForMedalApproval({}, form({ note: "" }));
    expect(mockDm.mock.calls.map((c) => c[0])).toEqual(["200000000000000002"]);
  });

  it("refuses a medal under the line, and a second ask", async () => {
    const under = await makeUser("Divine Two");
    await prisma.user.update({ where: { id: under.id }, data: { rankTier: 72 } });
    expect(await askMedalApproval(sessionFor(under), "")).toEqual({
      ok: false,
      error: expect.stringMatching(/nothing to approve/),
    });
    const player = await overTheLine();
    await pendingFor(player);
    expect(await askMedalApproval(sessionFor(player), "again")).toEqual({
      ok: false,
      error: expect.stringMatching(/already asked/),
    });
    expect(await prisma.medalApproval.count()).toBe(1);
  });

  it("turns two concurrent asks into one request", async () => {
    const player = await overTheLine();
    const results = await raceAll([
      () => askMedalApproval(sessionFor(player), "one"),
      () => askMedalApproval(sessionFor(player), "two"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      error: expect.stringMatching(/already asked/),
    });
    expect(await prisma.medalApproval.count()).toBe(1);
  });

  it("answers an ask that loses the unique key from the winner's row", async () => {
    const player = await overTheLine();
    let fired = false;
    setRaceHook(
      onceAt("medalApproval.ask.beforeWrite", async () => {
        fired = true;
        await prisma.medalApproval.create({
          data: {
            userId: player.id,
            status: MEDAL_APPROVAL_STATUS.PENDING,
            rankTier: 75,
          },
        });
      }),
    );
    expect(await askMedalApproval(sessionFor(player), "late")).toEqual({
      ok: false,
      error: expect.stringMatching(/already asked/),
    });
    expect(fired).toBe(true);
  });
});

describe("the admin's answers", () => {
  it("approves at the typed MMR, logs it and DMs the player", async () => {
    const player = await overTheLine("Approve Me", "200000000000000010");
    const row = await pendingFor(player);
    const res = await approveMedalApproval(
      {},
      form({ approvalId: row.id, status: "PENDING", mmr: "5100" }),
    );
    expect(res).toEqual({
      message: expect.stringMatching(/Approve Me is approved .* at 5,100 MMR/),
    });
    expect(
      await prisma.medalApproval.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      status: MEDAL_APPROVAL_STATUS.APPROVED,
      mmr: 5100,
      decidedById: ADMIN.id,
      decidedByName: ADMIN.name,
    });
    expect(mockDm).toHaveBeenCalledWith(
      "200000000000000010",
      expect.stringMatching(/approved you .* at 5,100 MMR/),
    );
    const log = await prisma.adminAction.findFirstOrThrow({
      where: { action: "approveMedalApproval" },
    });
    expect(log.summary).toMatch(/Approved Approve Me over the medal limit at 5,100 MMR/);
  });

  it("refuses an MMR the form can't take, and a non-admin", async () => {
    const player = await overTheLine();
    const row = await pendingFor(player);
    expect(
      await approveMedalApproval({}, form({ approvalId: row.id, status: "PENDING", mmr: "0" })),
    ).toEqual({ error: expect.stringMatching(/whole number/) });
    vi.mocked(requireAdmin).mockRejectedValue(new Error("no"));
    expect(
      await approveMedalApproval({}, form({ approvalId: row.id, status: "PENDING", mmr: "5000" })),
    ).toEqual({ error: "Not authorized" });
    expect(
      (await prisma.medalApproval.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe(MEDAL_APPROVAL_STATUS.PENDING);
  });

  it("declines, keeps the row approvable, and removes", async () => {
    const player = await overTheLine("Decline Me", "200000000000000011");
    const row = await pendingFor(player);
    expect(await declineMedalApproval({}, form({ approvalId: row.id }))).toEqual({
      message: expect.stringMatching(/Declined Decline Me's request/),
    });
    expect(mockDm).toHaveBeenCalledWith(
      "200000000000000011",
      expect.stringMatching(/declined/),
    );
    // A declined request can still be approved, claiming DECLINED.
    expect(
      await approveMedalApproval(
        {},
        form({ approvalId: row.id, status: "DECLINED", mmr: "5420" }),
      ),
    ).toEqual({ message: expect.stringMatching(/approved/) });
    expect(
      await removeMedalApprovalAction({}, form({ approvalId: row.id, status: "APPROVED" })),
    ).toEqual({ message: expect.stringMatching(/Removed Decline Me's approval/) });
    expect(await prisma.medalApproval.count()).toBe(0);
    // Back where they started: they may ask again.
    expect((await askMedalApproval(sessionFor(player), "")).ok).toBe(true);
  });

  it("lists waiting requests first for the admin page", async () => {
    const a = await overTheLine("First Asker");
    const b = await overTheLine("Second Asker");
    const c = await overTheLine("Approved Earlier");
    await approvedFor(c, 5000);
    const rowB = await pendingFor(b);
    const rowA = await pendingFor(a);
    // Asked in this order, whatever the clock's resolution.
    await prisma.medalApproval.update({
      where: { id: rowA.id },
      data: { requestedAt: new Date("2026-11-01T10:00:00Z") },
    });
    await prisma.medalApproval.update({
      where: { id: rowB.id },
      data: { requestedAt: new Date("2026-11-02T10:00:00Z") },
    });
    const rows = await loadMedalApprovalAdminRows();
    expect(rows.map((r) => r.user.name)).toEqual([
      "First Asker",
      "Second Asker",
      "Approved Earlier",
    ]);
  });
});

// Two admins answering one request: each write claims the status its list
// showed, so the second is refused instead of overwriting the first.
describe("two admins at once", () => {
  it("an approve whose request another admin approved meanwhile is refused, and the first number stands", async () => {
    const player = await overTheLine();
    const row = await pendingFor(player);
    let fired = false;
    setRaceHook(
      onceAt("medalApproval.approve.beforeWrite", async () => {
        fired = true;
        expect(
          await approveMedalRequest(OTHER_ADMIN, {
            approvalId: row.id,
            judgedStatus: MEDAL_APPROVAL_STATUS.PENDING,
            mmr: 4900,
          }),
        ).toMatchObject({ ok: true });
      }),
    );
    expect(
      await approveMedalRequest(ADMIN, {
        approvalId: row.id,
        judgedStatus: MEDAL_APPROVAL_STATUS.PENDING,
        mmr: 4700,
      }),
    ).toEqual({ ok: false, error: expect.stringMatching(/just changed/) });
    expect(fired).toBe(true);
    expect(
      await prisma.medalApproval.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ status: "APPROVED", mmr: 4900, decidedByName: "Other Admin" });
  });

  it("a decline whose request another admin approved meanwhile is refused", async () => {
    const player = await overTheLine();
    const row = await pendingFor(player);
    let fired = false;
    setRaceHook(
      onceAt("medalApproval.decline.beforeWrite", async () => {
        fired = true;
        await approveMedalRequest(OTHER_ADMIN, {
          approvalId: row.id,
          judgedStatus: MEDAL_APPROVAL_STATUS.PENDING,
          mmr: 5020,
        });
      }),
    );
    expect(await declineMedalRequest(ADMIN, row.id)).toEqual({
      ok: false,
      error: expect.stringMatching(/just changed/),
    });
    expect(fired).toBe(true);
    expect(
      (await prisma.medalApproval.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe("APPROVED");
  });

  it("a remove of a request another admin approved meanwhile is refused, and the approval stays", async () => {
    const player = await overTheLine();
    const row = await pendingFor(player);
    let fired = false;
    setRaceHook(
      onceAt("medalApproval.remove.beforeWrite", async () => {
        fired = true;
        await approveMedalRequest(OTHER_ADMIN, {
          approvalId: row.id,
          judgedStatus: MEDAL_APPROVAL_STATUS.PENDING,
          mmr: 5020,
        });
      }),
    );
    expect(
      await removeMedalApproval(ADMIN, {
        approvalId: row.id,
        judgedStatus: MEDAL_APPROVAL_STATUS.PENDING,
      }),
    ).toEqual({ ok: false, error: expect.stringMatching(/just changed/) });
    expect(fired).toBe(true);
    expect(await prisma.medalApproval.count()).toBe(1);
  });
});

describe("the league signup", () => {
  async function signupsSeason() {
    return makeSeason({ status: "SIGNUPS" });
  }

  it("refuses a player over the line without an approval and points at the ask", async () => {
    const season = await signupsSeason();
    const player = await overTheLine();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const res = await saveRegistration({}, form({ type: "PLAYER", mmr: 4500 }));
    expect(res).toEqual({
      error: expect.stringMatching(/Divine 5 medal puts you above it\. An admin can approve you/),
    });
    expect(
      await prisma.registration.count({ where: { seasonId: season.id } }),
    ).toBe(0);
  });

  it("admits an approved player at the approved MMR, unclamped, whatever was typed", async () => {
    const season = await signupsSeason();
    const player = await overTheLine();
    await approvedFor(player, 4800);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    // Divine 5's window starts at 5,020, so the clamp would raise a typed
    // 4,800; the approval's number is the admin's and stands.
    const typed = await saveRegistration({}, form({ type: "PLAYER", mmr: 4400 }));
    expect(typed).toEqual({ message: expect.stringMatching(/keeps 4,800 MMR/) });
    expect(
      await prisma.registration.findUniqueOrThrow({
        where: { seasonId_userId: { seasonId: season.id, userId: player.id } },
      }),
    ).toMatchObject({ status: "ACTIVE", mmr: 4800 });
  });

  it("admits an approval over the ceiling too: the admin chose the number", async () => {
    const season = await signupsSeason();
    const player = await overTheLine();
    await approvedFor(player, 5420);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    // The /me box is disabled, so it sends no number.
    expect(await saveRegistration({}, form({ type: "PLAYER" }))).toEqual({
      message: expect.not.stringMatching(/keeps/),
    });
    expect(
      (await prisma.registration.findUniqueOrThrow({
        where: { seasonId_userId: { seasonId: season.id, userId: player.id } },
      })).mmr,
    ).toBe(5420);
  });

  it("refuses the save when an admin removes the approval mid-submit", async () => {
    const season = await signupsSeason();
    const player = await overTheLine();
    const row = await approvedFor(player, 5020);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    let fired = false;
    setRaceHook(
      onceAt("registration.saveRegistration.beforeWrite", async () => {
        fired = true;
        await removeMedalApproval(OTHER_ADMIN, {
          approvalId: row.id,
          judgedStatus: MEDAL_APPROVAL_STATUS.APPROVED,
        });
      }),
    );
    expect(await saveRegistration({}, form({ type: "PLAYER" }))).toEqual({
      error: expect.stringMatching(/changed your approval/),
    });
    expect(fired).toBe(true);
    expect(
      await prisma.registration.count({ where: { seasonId: season.id } }),
    ).toBe(0);
  });
});

describe("the inhouse queue", () => {
  it("refuses a player over the line without an approval", async () => {
    const player = await overTheLine();
    expect(await joinQueue(sessionFor(player), 4500)).toEqual({
      ok: false,
      error: expect.stringMatching(/Divine 5 medal puts you above it\. An admin can approve you/),
    });
    expect(await prisma.inhouseQueueEntry.count()).toBe(0);
  });

  it("queues an approved player at the approved MMR, over the cap included", async () => {
    const player = await overTheLine();
    await approvedFor(player, 5420);
    expect(await joinQueue(sessionFor(player), 3000)).toEqual({ ok: true });
    expect(
      await prisma.inhouseQueueEntry.findUniqueOrThrow({ where: { userId: player.id } }),
    ).toMatchObject({ mmr: 5420 });
  });

  it("an admin's inhouse MMR beats the approval's at the queue", async () => {
    const player = await overTheLine();
    await approvedFor(player, 5420);
    await prisma.user.update({ where: { id: player.id }, data: { inhouseMmr: 4900 } });
    expect(await joinQueue(sessionFor(player), 0)).toEqual({ ok: true });
    expect(
      (await prisma.inhouseQueueEntry.findUniqueOrThrow({ where: { userId: player.id } })).mmr,
    ).toBe(4900);
  });

  it("refuses the join when an admin removes the approval mid-join, and queues nothing", async () => {
    const player = await overTheLine();
    const row = await approvedFor(player, 5020);
    let fired = false;
    setRaceHook(
      onceAt("inhouse.joinQueue.beforeWrite", async () => {
        fired = true;
        await removeMedalApproval(OTHER_ADMIN, {
          approvalId: row.id,
          judgedStatus: MEDAL_APPROVAL_STATUS.APPROVED,
        });
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
