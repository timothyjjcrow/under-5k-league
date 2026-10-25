import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendDiscordMessage: vi.fn(),
}));
// Pass-throughs, so a test can make one post-commit read fail.
vi.mock("@/lib/discord-mentions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/discord-mentions")>();
  return { ...real, mentionUsers: vi.fn(real.mentionUsers) };
});
vi.mock("@/lib/standin-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/standin-service")>();
  return { ...real, clashesAfterRetime: vi.fn(real.clashesAfterRetime) };
});
vi.mock("@/lib/availability-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/availability-service")>();
  return { ...real, loadSidePlayerIds: vi.fn(real.loadSidePlayerIds) };
});

import { setAvailability } from "@/app/actions/availability";
import {
  proposeReschedule,
  respondReschedule,
  voteReschedule,
} from "@/app/actions/reschedule";
import { loadSidePlayerIds } from "@/lib/availability-service";
import { getSessionUser, requireUser } from "@/lib/auth";
import { SEASON_STATUS } from "@/lib/constants";
import { sendDiscordMessage } from "@/lib/discord";
import { mentionUsers } from "@/lib/discord-mentions";
import { clashesAfterRetime } from "@/lib/standin-service";
import { prisma } from "@/lib/prisma";
import { makeCaptain, makeSeason, makeUser, resetDb, sessionFor } from "./factories";

const DAY = 24 * 60 * 60 * 1000;

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

let linked = 0;
async function withDiscord<T extends { id: string }>(user: T): Promise<T & { discordId: string }> {
  linked += 1;
  // An 18-digit snowflake-shaped id (no bigint literal: tsconfig is ES2017).
  const discordId = `1${String(linked).padStart(17, "0")}`;
  await prisma.user.update({ where: { id: user.id }, data: { discordId } });
  return { ...user, discordId };
}

/** The users the last post was allowed to ping. */
function lastPingedUsers(): string[] {
  const calls = vi.mocked(sendDiscordMessage).mock.calls;
  const allow = calls[calls.length - 1]?.[1] as { users?: string[] } | undefined;
  return [...(allow?.users ?? [])].sort();
}

beforeEach(async () => {
  await resetDb();
  vi.mocked(sendDiscordMessage).mockReset();
  vi.mocked(sendDiscordMessage).mockResolvedValue(true);
  // Back to the pass-throughs, dropping any failure a test queued.
  vi.mocked(mentionUsers).mockReset();
  vi.mocked(clashesAfterRetime).mockReset();
  vi.mocked(loadSidePlayerIds).mockReset();
});

// A ready check pinged every seat on both sides on every proposal: two
// captains trading offers rang nine phones each time. The first proposal of
// a kickoff still pings everyone; re-proposals ping only the other captain
// until the window passes or a lock moves the kickoff.
describe("ready-check pings", () => {
  it("rings the rosters once per kickoff, then only the other captain", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeCaptain(season.id, "Home Cap", 100, 0);
    const away = await makeCaptain(season.id, "Away Cap", 100, 1);
    const proposer = await withDiscord(home.user);
    const otherCaptain = await withDiscord(away.user);
    const players = [];
    for (const [teamId, name] of [
      [home.team.id, "Home P"],
      [away.team.id, "Away P"],
    ] as const) {
      const user = await withDiscord(await makeUser(name));
      await prisma.teamMember.create({
        data: { seasonId: season.id, teamId, userId: user.id, price: 10 },
      });
      players.push(user);
    }
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: "REGULAR",
        homeTeamId: home.team.id,
        awayTeamId: away.team.id,
        scheduledAt: new Date(Date.now() + 2 * DAY),
      },
    });
    const session = sessionFor({ ...proposer, role: "USER" });
    vi.mocked(requireUser).mockResolvedValue(session);
    vi.mocked(getSessionUser).mockResolvedValue(session);
    const propose = (days: number) =>
      proposeReschedule(
        null,
        form({ matchId: match.id, optionTs: String(Date.now() + days * DAY) }),
      );
    const everyone = [otherCaptain, ...players].map((u) => u.discordId).sort();

    expect(await propose(3)).toMatchObject({ ok: true });
    expect(lastPingedUsers()).toEqual(everyone);

    // A counter-offer within the window: only the captain who owes an answer.
    expect(await propose(4)).toMatchObject({ ok: true });
    expect(lastPingedUsers()).toEqual([otherCaptain.discordId]);

    // A lock moves the kickoff (a new schedule revision): the next check is a
    // fresh question for everyone.
    await prisma.match.update({
      where: { id: match.id },
      data: { scheduleRevision: { increment: 1 } },
    });
    expect(await propose(5)).toMatchObject({ ok: true });
    expect(lastPingedUsers()).toEqual(everyone);
  });
});

/** Two linked captains, one linked player each side, one fixture. */
async function linkedFixture() {
  const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
  const home = await makeCaptain(season.id, "Home Cap", 100, 0);
  const away = await makeCaptain(season.id, "Away Cap", 100, 1);
  const proposer = await withDiscord(home.user);
  const otherCaptain = await withDiscord(away.user);
  const players = [];
  for (const [teamId, name] of [
    [home.team.id, "Home P"],
    [away.team.id, "Away P"],
  ] as const) {
    const user = await withDiscord(await makeUser(name));
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId, userId: user.id, price: 10 },
    });
    players.push(user);
  }
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: "REGULAR",
      homeTeamId: home.team.id,
      awayTeamId: away.team.id,
      scheduledAt: new Date(Date.now() + 2 * DAY),
    },
  });
  const signIn = (user: typeof proposer) => {
    const session = sessionFor({ ...user, role: "USER" });
    vi.mocked(requireUser).mockResolvedValue(session);
    vi.mocked(getSessionUser).mockResolvedValue(session);
  };
  return { match, proposer, otherCaptain, players, signIn };
}

// Everything after a commit is presentation. A read that threw there used to
// reach the action's catch: the captain was told the move failed, the post
// never went out, and a retry found the request closed.
describe("ready-check posts survive a failed read after the commit", () => {
  it("a failed mention lookup on propose posts unpinged and keeps the roster window", async () => {
    const { match, proposer, otherCaptain, players, signIn } = await linkedFixture();
    signIn(proposer);
    const propose = (days: number) =>
      proposeReschedule(
        null,
        form({ matchId: match.id, optionTs: String(Date.now() + days * DAY) }),
      );

    vi.mocked(mentionUsers).mockRejectedValueOnce(new Error("pool timeout"));
    expect(await propose(3)).toMatchObject({ ok: true });
    expect(vi.mocked(mentionUsers)).toHaveBeenCalled();
    expect(vi.mocked(sendDiscordMessage)).toHaveBeenCalledTimes(1);
    expect(lastPingedUsers()).toEqual([]);

    // The window wasn't spent on that unpinged post: the retry rings everyone.
    expect(await propose(4)).toMatchObject({ ok: true });
    expect(lastPingedUsers()).toEqual(
      [otherCaptain, ...players].map((u) => u.discordId).sort(),
    );
  });

  it("an accept whose follow-up reads fail still moves, posts and says so", async () => {
    const { match, proposer, otherCaptain, signIn } = await linkedFixture();
    signIn(proposer);
    const when = Date.now() + 3 * DAY;
    expect(
      await proposeReschedule(
        null,
        form({ matchId: match.id, optionTs: String(when) }),
      ),
    ).toMatchObject({ ok: true });
    const request = await prisma.rescheduleRequest.findFirstOrThrow({
      where: { matchId: match.id, status: "PENDING" },
    });
    vi.mocked(sendDiscordMessage).mockClear();

    signIn(otherCaptain);
    vi.mocked(clashesAfterRetime).mockRejectedValueOnce(new Error("pool timeout"));
    vi.mocked(mentionUsers).mockRejectedValueOnce(new Error("pool timeout"));
    const res = await respondReschedule(
      null,
      form({ requestId: request.id, response: "accept", optionTs: String(when) }),
    );

    expect(vi.mocked(clashesAfterRetime)).toHaveBeenCalled();
    expect(vi.mocked(mentionUsers)).toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, message: expect.stringMatching(/moved/) });
    // A check that couldn't run is unknown, never "no clash".
    expect(res).toMatchObject({ message: expect.stringMatching(/clash check couldn't run/) });
    expect(
      (await prisma.match.findUniqueOrThrow({ where: { id: match.id } })).scheduledAt?.getTime(),
    ).toBe(when);
    const posts = vi.mocked(sendDiscordMessage).mock.calls.map(([content]) => String(content));
    expect(posts.some((p) => p.includes("Rescheduled"))).toBe(true);
  });

  it("a failed seat read after a proposal still asks the other captain and keeps the roster window", async () => {
    const { match, proposer, otherCaptain, players, signIn } = await linkedFixture();
    signIn(proposer);
    const propose = (days: number) =>
      proposeReschedule(
        null,
        form({ matchId: match.id, optionTs: String(Date.now() + days * DAY) }),
      );

    // The proposal has committed when the audience is read.
    vi.mocked(loadSidePlayerIds).mockRejectedValueOnce(new Error("pool timeout"));
    expect(await propose(3)).toMatchObject({ ok: true });
    expect(vi.mocked(loadSidePlayerIds)).toHaveBeenCalled();
    expect(lastPingedUsers()).toEqual([otherCaptain.discordId]);

    // Unspent: the next proposal still rings both rosters.
    expect(await propose(4)).toMatchObject({ ok: true });
    expect(lastPingedUsers()).toEqual(
      [otherCaptain, ...players].map((u) => u.discordId).sort(),
    );
  });
});

describe("a lock's carried OUT is an announced OUT", () => {
  it("a player a lock checked in as out can still say they can make it after all", async () => {
    const { match, proposer, otherCaptain, players, signIn } = await linkedFixture();
    const awayPlayer = players[1];
    signIn(proposer);
    const when = Date.now() + 3 * DAY;
    expect(
      await proposeReschedule(null, form({ matchId: match.id, optionTs: String(when) })),
    ).toMatchObject({ ok: true });
    const request = await prisma.rescheduleRequest.findFirstOrThrow({
      where: { matchId: match.id, status: "PENDING" },
    });
    signIn(awayPlayer);
    expect(
      await voteReschedule({
        matchId: match.id,
        requestId: request.id,
        timeMs: when,
        ready: false,
      }),
    ).toMatchObject({ ok: true });

    // The other captain accepts; the lock post names the away player as out.
    signIn(otherCaptain);
    expect(
      await respondReschedule(
        null,
        form({ requestId: request.id, response: "accept", optionTs: String(when) }),
      ),
    ).toMatchObject({ ok: true });
    const moved = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(moved.scheduleRevision).toBe(1);
    vi.mocked(sendDiscordMessage).mockClear();

    // They can make it after all: their captain, told they were out, hears it.
    signIn(awayPlayer);
    const res = await setAvailability(
      null,
      form({
        matchId: match.id,
        status: "IN",
        expectedScheduleRevision: String(moved.scheduleRevision),
      }),
    );
    expect(res?.error).toBeUndefined();
    const backIn = vi
      .mocked(sendDiscordMessage)
      .mock.calls.find(([content]) => String(content).includes("after all"));
    expect(backIn).toBeTruthy();
    expect(backIn![1]).toEqual({ users: [otherCaptain.discordId] });
  });
});
