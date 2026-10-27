import { describe, expect, it, vi } from "vitest";

// Standin requests (the MMR rule) that an admin roster move has made
// impossible to agree to, and the admin's Withdraw in the asking captain's
// place. A request is not cover, so nothing that reads cover sees it; left
// PENDING, it holds its seat and its standin for a player who is gone, and
// the other captain is still asked to answer it.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({ id: "test-admin", name: "Test administrator", role: "ADMIN", steamId: "76561198000000000", avatar: null })),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(async () => ({ id: "test-admin", name: "Test administrator" })),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import { sendDiscordMessage } from "@/lib/discord";
import {
  releasePlayer,
  withdrawStandinRequestAsAdmin,
} from "@/app/actions/admin-roster";
import {
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
  STANDIN_REQUEST_STATUS,
} from "@/lib/constants";
import { makePlayer, makeSeason, makeTeam } from "./factories";

const mockSend = vi.mocked(sendDiscordMessage);

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const ALPHA_CAPTAIN_DISCORD = "710000000000000001";
const BRAVO_CAPTAIN_DISCORD = "710000000000000002";
const STANDIN_DISCORD = "710000000000000003";

/** Alpha (two rostered players) vs Bravo, both captains linked, and a pool. */
async function league() {
  const season = await makeSeason({
    teamSize: 5,
    status: SEASON_STATUS.REGULAR_SEASON,
  });
  const alpha = await makeTeam(season.id, "Alpha", 0);
  const bravo = await makeTeam(season.id, "Bravo", 1);
  await prisma.user.update({
    where: { id: alpha.captainId },
    data: { discordId: ALPHA_CAPTAIN_DISCORD },
  });
  await prisma.user.update({
    where: { id: bravo.captainId },
    data: { discordId: BRAVO_CAPTAIN_DISCORD },
  });
  const released = await makePlayer(season.id, "Released Rook", 3000);
  const stays = await makePlayer(season.id, "Staying Sage", 3000);
  for (const p of [released, stays]) {
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: alpha.id, userId: p.id, price: 0 },
    });
  }
  const fixture = (week: number, status: string = MATCH_STATUS.SCHEDULED) =>
    prisma.match.create({
      data: {
        seasonId: season.id,
        week,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: alpha.id,
        awayTeamId: bravo.id,
        bestOf: 2,
        status,
        scheduledAt: new Date(Date.now() + week * 86_400_000),
      },
    });
  const match = await fixture(2);
  const played = await fixture(1, MATCH_STATUS.COMPLETED);
  const subs = [];
  for (const name of ["Sub One", "Sub Two", "Sub Three", "Sub Four"]) {
    subs.push(await makePlayer(season.id, name, 4000));
  }
  await prisma.user.update({
    where: { id: subs[0].id },
    data: { discordId: STANDIN_DISCORD },
  });
  return { season, alpha, bravo, released, stays, match, played, subs };
}

/** A request from Alpha's captain, written as the MMR rule files one. */
function request(input: {
  matchId: string;
  teamId: string;
  requestedById: string;
  standinUserId: string;
  replacingUserId: string | null;
  status?: string;
}) {
  return prisma.standinRequest.create({
    data: {
      standinMmr: 4000,
      baselineMmr: 3000,
      ...input,
    },
  });
}

async function statusOf(id: string) {
  return (await prisma.standinRequest.findUniqueOrThrow({ where: { id } }))
    .status;
}

describe("releasePlayer closes the standin requests to cover the player", () => {
  it("cancels that player's request only, and tells the asking captain alone", async () => {
    const fx = await league();
    const theirs = await request({
      matchId: fx.match.id,
      teamId: fx.alpha.id,
      requestedById: fx.alpha.captainId,
      standinUserId: fx.subs[0].id,
      replacingUserId: fx.released.id,
    });
    // Same match, another seat: still a live question for Bravo's captain.
    const teammate = await request({
      matchId: fx.match.id,
      teamId: fx.alpha.id,
      requestedById: fx.alpha.captainId,
      standinUserId: fx.subs[1].id,
      replacingUserId: fx.stays.id,
    });
    // Answered already: the booking it made is release's to cancel, the
    // request's answer is history.
    const answered = await request({
      matchId: fx.match.id,
      teamId: fx.alpha.id,
      requestedById: fx.alpha.captainId,
      standinUserId: fx.subs[2].id,
      replacingUserId: fx.released.id,
      status: STANDIN_REQUEST_STATUS.APPROVED,
    });
    // On a series that is over: nothing left to agree to, nor to tidy.
    const finished = await request({
      matchId: fx.played.id,
      teamId: fx.alpha.id,
      requestedById: fx.alpha.captainId,
      standinUserId: fx.subs[3].id,
      replacingUserId: fx.released.id,
    });
    const member = await prisma.teamMember.findFirstOrThrow({
      where: { userId: fx.released.id },
    });
    mockSend.mockClear();

    const res = await releasePlayer({}, fd({ memberId: member.id }));

    expect(res?.error).toBeUndefined();
    expect(
      await prisma.standinRequest.findUniqueOrThrow({ where: { id: theirs.id } }),
    ).toMatchObject({
      status: STANDIN_REQUEST_STATUS.CANCELLED,
      decidedById: "test-admin",
      decidedAt: expect.any(Date),
    });
    expect(await statusOf(teammate.id)).toBe(STANDIN_REQUEST_STATUS.PENDING);
    expect(await statusOf(answered.id)).toBe(STANDIN_REQUEST_STATUS.APPROVED);
    expect(await statusOf(finished.id)).toBe(STANDIN_REQUEST_STATUS.PENDING);

    // One post about it, pinging only the captain who has to line up
    // someone else: not the other captain, not the standin.
    const posts = mockSend.mock.calls.filter(([msg]) =>
      String(msg).includes("is off"),
    );
    expect(posts).toHaveLength(1);
    expect(String(posts[0][0])).toContain("Sub One");
    expect(String(posts[0][0])).toContain("was released");
    expect(posts[0][1]).toEqual({ users: [ALPHA_CAPTAIN_DISCORD] });
    for (const [, mentions] of mockSend.mock.calls) {
      expect(mentions?.users ?? []).not.toContain(BRAVO_CAPTAIN_DISCORD);
      expect(mentions?.users ?? []).not.toContain(STANDIN_DISCORD);
    }

    expect(res?.message).toMatch(
      /1 standin request\(s\) waiting to cover them cancelled/,
    );
    const log = await prisma.adminAction.findFirstOrThrow({
      where: { action: "releasePlayer" },
    });
    expect(log.summary).toMatch(/1 pending standin request\(s\)/);
  });

  it("says nothing about requests when there were none", async () => {
    const fx = await league();
    const member = await prisma.teamMember.findFirstOrThrow({
      where: { userId: fx.released.id },
    });
    mockSend.mockClear();

    const res = await releasePlayer({}, fd({ memberId: member.id }));

    expect(res?.message).not.toMatch(/standin request/);
    expect(
      mockSend.mock.calls.some(([msg]) => String(msg).includes("is off")),
    ).toBe(false);
  });
});

describe("withdrawStandinRequestAsAdmin", () => {
  it("withdraws in the asking captain's place, logs it and posts nothing", async () => {
    const fx = await league();
    const pending = await request({
      matchId: fx.match.id,
      teamId: fx.alpha.id,
      requestedById: fx.alpha.captainId,
      standinUserId: fx.subs[0].id,
      replacingUserId: fx.released.id,
    });
    mockSend.mockClear();

    const res = await withdrawStandinRequestAsAdmin(
      {},
      fd({ requestId: pending.id }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/Request withdrawn/);
    expect(
      await prisma.standinRequest.findUniqueOrThrow({ where: { id: pending.id } }),
    ).toMatchObject({
      status: STANDIN_REQUEST_STATUS.CANCELLED,
      decidedById: "test-admin",
    });
    expect(mockSend).not.toHaveBeenCalled();
    const log = await prisma.adminAction.findFirstOrThrow({
      where: { action: "withdrawStandinRequestAsAdmin" },
    });
    expect(log).toMatchObject({
      actorId: "test-admin",
      seasonId: fx.season.id,
      summary: expect.stringContaining("Sub One"),
    });
  });

  it("refuses a request already answered, and logs nothing", async () => {
    const fx = await league();
    const declined = await request({
      matchId: fx.match.id,
      teamId: fx.alpha.id,
      requestedById: fx.alpha.captainId,
      standinUserId: fx.subs[0].id,
      replacingUserId: fx.released.id,
      status: STANDIN_REQUEST_STATUS.DECLINED,
    });

    const res = await withdrawStandinRequestAsAdmin(
      {},
      fd({ requestId: declined.id }),
    );

    expect(res?.error).toBeTruthy();
    expect(await statusOf(declined.id)).toBe(STANDIN_REQUEST_STATUS.DECLINED);
    expect(
      await prisma.adminAction.count({
        where: { action: "withdrawStandinRequestAsAdmin" },
      }),
    ).toBe(0);
  });
});
