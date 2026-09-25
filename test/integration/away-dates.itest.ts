import { beforeEach, describe, expect, it, vi } from "vitest";

// "I'm away weeks 3-4": markAwayDates marks a player OUT for every fixture of
// theirs in a date range, in one save, and tells the captain once. Drive the
// real action (and the /me card's own fixture list) against the test DB.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(), requireAdmin: vi.fn() }));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { markAwayDates, setAvailability } from "@/app/actions/availability";
import { requireUser } from "@/lib/auth";
import { sendDiscordMessage } from "@/lib/discord";
import { prisma } from "@/lib/prisma";
import { listAwayFixtures } from "@/lib/availability-service";
import { seenFixturesField, type SeenFixture } from "@/lib/away-range";
import { MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  makeUser,
  raceN,
  sessionFor,
} from "./factories";

const mockSend = vi.mocked(sendDiscordMessage);
const DAY = 24 * 60 * 60 * 1000;
const CAPTAIN_DISCORD = "111222333444555666";

/**
 * Four teams, three weeks, the player on Alpha. Week N kicks off (7N - 5)
 * days from now: +2d, +9d, +16d. `mine` is Alpha's three fixtures in week
 * order; `others` is everyone else's.
 */
async function setupSeason() {
  const season = await makeSeason({
    teamSize: 3,
    status: SEASON_STATUS.REGULAR_SEASON,
  });
  const alpha = await makeTeam(season.id, "Alpha", 0);
  await makeTeam(season.id, "Bravo", 1);
  await makeTeam(season.id, "Charlie", 2);
  await makeTeam(season.id, "Delta", 3);
  const player = await makeUser("Away Player");
  await prisma.teamMember.create({
    data: {
      seasonId: season.id,
      teamId: alpha.id,
      userId: player.id,
      isCaptain: false,
      price: 0,
    },
  });
  const now = Date.now();
  for (const m of await generateRegularSchedule(season.id)) {
    await prisma.match.update({
      where: { id: m.id },
      data: { scheduledAt: new Date(now + (m.week * 7 - 5) * DAY) },
    });
  }
  const all = await prisma.match.findMany({
    where: { seasonId: season.id },
    orderBy: [{ week: "asc" }, { id: "asc" }],
    include: { homeTeam: true, awayTeam: true },
  });
  const isAlpha = (m: (typeof all)[number]) =>
    m.homeTeamId === alpha.id || m.awayTeamId === alpha.id;
  const mine = all.filter(isAlpha);
  const others = all.filter((m) => !isAlpha(m));
  const opponentOf = (m: (typeof all)[number]) =>
    m.homeTeamId === alpha.id ? m.awayTeam.name : m.homeTeam.name;
  return {
    season,
    alpha,
    player,
    mine,
    others,
    opponentOf,
    days: (n: number) => now + n * DAY,
  };
}

/** What the /me card shows this user right now. */
async function page(userId: string) {
  return listAwayFixtures(userId, Date.now());
}

function awayForm(
  seasonId: string,
  fromMs: number,
  backMs: number,
  seen: SeenFixture[],
): FormData {
  const fd = new FormData();
  fd.set("awayFromTs", String(fromMs));
  fd.set("awayBackTs", String(backMs));
  fd.set("expectedSeasonId", seasonId);
  fd.set("seen", seenFixturesField(seen));
  return fd;
}

function rsvpForm(match: { id: string; scheduleRevision: number }, status: string) {
  const fd = new FormData();
  fd.set("matchId", match.id);
  fd.set("status", status);
  fd.set("expectedScheduleRevision", String(match.scheduleRevision));
  return fd;
}

async function rows(userId: string) {
  return prisma.matchAvailability.findMany({
    where: { userId },
    orderBy: { matchId: "asc" },
  });
}

beforeEach(() => {
  vi.mocked(requireUser).mockReset();
  mockSend.mockClear();
});

describe("listAwayFixtures — the /me card's list and render gate", () => {
  it("lists the player's own upcoming fixtures in kickoff order, and nobody else's", async () => {
    const { season, player, mine, opponentOf } = await setupSeason();
    const view = await page(player.id);
    expect(view?.seasonId).toBe(season.id);
    expect(view!.fixtures.map((f) => f.matchId)).toEqual(mine.map((m) => m.id));
    expect(view!.fixtures.map((f) => f.label)).toEqual(
      mine.map((m) => `Week ${m.week} vs ${opponentOf(m)}`),
    );
    expect(view!.fixtures.every((f) => !f.standin && f.rsvp === null)).toBe(true);
  });

  it("renders nothing for a non-participant or outside the check-in phases", async () => {
    const { season, player } = await setupSeason();
    const rando = await makeUser("Rando");
    expect(await page(rando.id)).toBeNull();

    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.COMPLETE },
    });
    expect(await page(player.id)).toBeNull();
  });
});

describe("markAwayDates", () => {
  it("marks OUT on every fixture in the range and nothing else", async () => {
    const { season, player, mine, others, opponentOf, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const view = await page(player.id);

    // Away from tomorrow, back on day 10: weeks 1 and 2, not week 3.
    const res = await markAwayDates(
      {},
      awayForm(season.id, days(1), days(10), view!.fixtures),
    );
    expect(res).toEqual({
      message: `Marked you out for 2 fixtures: Week 1 vs ${opponentOf(mine[0])} and Week 2 vs ${opponentOf(mine[1])}. Captains can now line up cover.`,
    });

    const written = await rows(player.id);
    expect(written.map((r) => r.matchId).sort()).toEqual(
      [mine[0].id, mine[1].id].sort(),
    );
    expect(written.every((r) => r.status === "OUT")).toBe(true);
    expect(
      await prisma.matchAvailability.count({
        where: { matchId: { in: [mine[2].id, ...others.map((m) => m.id)] } },
      }),
    ).toBe(0);
  });

  it("sends ONE Discord message for the range, pinging the captain", async () => {
    const { season, alpha, player, mine, days } = await setupSeason();
    await prisma.user.update({
      where: { id: alpha.captainId },
      data: { discordId: CAPTAIN_DISCORD },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const view = await page(player.id);

    await markAwayDates({}, awayForm(season.id, days(1), days(20), view!.fixtures));

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [msg, mentions] = mockSend.mock.calls[0];
    expect(msg).toContain("Away Player");
    expect(msg).toContain("3 matches");
    for (const m of mine) {
      expect(msg).toContain(`<t:${Math.floor(m.scheduledAt!.getTime() / 1000)}:F>`);
      expect(msg).toContain(`/matches/${m.id}`);
    }
    expect(mentions).toEqual({ users: [CAPTAIN_DISCORD] });
  });

  it("never pings a captain about their own absence", async () => {
    const { season, alpha, days } = await setupSeason();
    await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: alpha.id,
        userId: alpha.captainId,
        isCaptain: true,
        price: 0,
      },
    });
    const captain = await prisma.user.update({
      where: { id: alpha.captainId },
      data: { discordId: CAPTAIN_DISCORD },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(captain));
    const view = await page(captain.id);

    const res = await markAwayDates(
      {},
      awayForm(season.id, days(1), days(10), view!.fixtures),
    );
    expect(res).toHaveProperty("message");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][1]).toBeUndefined();
  });

  it("is idempotent: a second save changes nothing and pings nobody", async () => {
    const { season, player, mine, opponentOf, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const form = async () =>
      awayForm(season.id, days(1), days(10), (await page(player.id))!.fixtures);

    await markAwayDates({}, await form());
    const before = await rows(player.id);
    const again = await markAwayDates({}, await form());

    expect(again).toEqual({
      message: `You were already out for Week 1 vs ${opponentOf(mine[0])} and Week 2 vs ${opponentOf(mine[1])}. Nothing changed.`,
    });
    expect(await rows(player.id)).toEqual(before);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("flips an IN to OUT, and treats an answer for an old kickoff as no answer", async () => {
    const { season, player, mine, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    // Week 1: an OUT given for a kickoff that has since been retimed.
    await prisma.matchAvailability.create({
      data: { matchId: mine[0].id, userId: player.id, status: "OUT", scheduleRevision: 0 },
    });
    await prisma.match.update({
      where: { id: mine[0].id },
      data: { scheduleRevision: 1 },
    });
    // Week 2: a current IN.
    await prisma.matchAvailability.create({
      data: { matchId: mine[1].id, userId: player.id, status: "IN", scheduleRevision: 0 },
    });
    const view = await page(player.id);
    expect(view!.fixtures.map((f) => f.rsvp)).toEqual([null, "IN", null]);

    const res = await markAwayDates(
      {},
      awayForm(season.id, days(1), days(10), view!.fixtures),
    );
    expect(res).toHaveProperty("message");
    expect(res?.message).toMatch(/^Marked you out for 2 fixtures/);

    const byMatch = new Map((await rows(player.id)).map((r) => [r.matchId, r]));
    expect(byMatch.get(mine[0].id)).toMatchObject({ status: "OUT", scheduleRevision: 1 });
    expect(byMatch.get(mine[1].id)).toMatchObject({ status: "OUT", scheduleRevision: 0 });
    expect(mockSend.mock.calls[0][0]).toContain(`/matches/${mine[0].id}`);
  });

  it("only answers for the kickoff the page showed", async () => {
    const { season, player, mine, opponentOf, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const view = await page(player.id);
    // An admin moves week 2 a day earlier after the page loaded.
    await prisma.match.update({
      where: { id: mine[1].id },
      data: { scheduledAt: new Date(days(8)), scheduleRevision: { increment: 1 } },
    });

    const res = await markAwayDates(
      {},
      awayForm(season.id, days(1), days(10), view!.fixtures),
    );
    expect(res).toEqual({
      message: `Marked you out for 1 fixture: Week 1 vs ${opponentOf(mine[0])}. Skipped Week 2 vs ${opponentOf(mine[1])} (kickoff moved, reload to check it). Captains can now line up cover.`,
    });
    expect((await rows(player.id)).map((r) => r.matchId)).toEqual([mine[0].id]);
  });

  it("reports a fixture retimed OUT of the range instead of dropping it", async () => {
    const { season, player, mine, opponentOf, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const view = await page(player.id);
    await prisma.match.update({
      where: { id: mine[0].id },
      data: { scheduledAt: new Date(days(12)), scheduleRevision: { increment: 1 } },
    });

    const res = await markAwayDates(
      {},
      awayForm(season.id, days(1), days(4), view!.fixtures),
    );
    expect(res).toEqual({
      error: `Nothing was marked. Skipped Week 1 vs ${opponentOf(mine[0])} (kickoff moved, reload to check it).`,
    });
    expect(await rows(player.id)).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never marks a fixture the page didn't show", async () => {
    const { season, player, mine, opponentOf, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const view = await page(player.id);
    const seen = view!.fixtures.filter((f) => f.matchId !== mine[1].id);

    const res = await markAwayDates({}, awayForm(season.id, days(1), days(10), seen));
    expect(res?.message).toContain(
      `Skipped Week 2 vs ${opponentOf(mine[1])} (new since you opened the page, reload to include it).`,
    );
    expect((await rows(player.id)).map((r) => r.matchId)).toEqual([mine[0].id]);
  });

  it("skips played and covered fixtures and says why", async () => {
    const { season, alpha, player, mine, opponentOf, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    // Week 1 already happened; a standin has taken the player's seat for week 2.
    await prisma.match.update({
      where: { id: mine[0].id },
      data: {
        scheduledAt: new Date(days(-1)),
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        awayScore: 0,
      },
    });
    const cover = await makeUser("Cover");
    await prisma.standinAssignment.create({
      data: {
        matchId: mine[1].id,
        teamId: alpha.id,
        standinUserId: cover.id,
        replacingUserId: player.id,
      },
    });
    const view = await page(player.id);
    // The card doesn't offer either of them.
    expect(view!.fixtures.map((f) => f.matchId)).toEqual([mine[2].id]);

    const res = await markAwayDates(
      {},
      awayForm(season.id, days(-3), days(20), view!.fixtures),
    );
    expect(res).toEqual({
      message: `Marked you out for 1 fixture: Week 3 vs ${opponentOf(mine[2])}. Skipped Week 1 vs ${opponentOf(mine[0])} (already played) and Week 2 vs ${opponentOf(mine[1])} (a standin covers your seat). Captains can now line up cover.`,
    });
    expect((await rows(player.id)).map((r) => r.matchId)).toEqual([mine[2].id]);
  });

  it("leaves a series that has started alone", async () => {
    const { season, player, mine, opponentOf, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.match.update({
      where: { id: mine[0].id },
      data: { scheduledAt: new Date(days(0) - 60 * 60 * 1000), status: MATCH_STATUS.LIVE },
    });

    const res = await markAwayDates({}, awayForm(season.id, days(-1), days(3), []));
    expect(res).toEqual({
      error: `Nothing was marked. Skipped Week 1 vs ${opponentOf(mine[0])} (already under way).`,
    });
    expect(await rows(player.id)).toEqual([]);
  });

  it("refuses another team's fixture smuggled into the form", async () => {
    const { season, player, others, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const theirs = others[0];

    const res = await markAwayDates(
      {},
      awayForm(season.id, days(1), days(4), [
        {
          matchId: theirs.id,
          scheduleRevision: theirs.scheduleRevision,
          kickoffMs: theirs.scheduledAt!.getTime(),
        },
      ]),
    );
    // Their own week-1 fixture is in range but unseen; the smuggled one is
    // not theirs. Neither is written.
    expect(res?.error).toMatch(/^Nothing was marked\./);
    expect(res?.error).toContain("(not yours)");
    expect(await prisma.matchAvailability.count()).toBe(0);
  });

  it("counts a fixture that left the schedule since the page loaded", async () => {
    // A regenerated schedule deletes the old fixtures outright.
    const { season, player, mine, opponentOf, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const view = await page(player.id);
    await prisma.match.delete({ where: { id: mine[1].id } });

    const res = await markAwayDates(
      {},
      awayForm(season.id, days(1), days(10), view!.fixtures),
    );
    expect(res).toEqual({
      message: `Marked you out for 1 fixture: Week 1 vs ${opponentOf(mine[0])}. 1 fixture you saw is no longer on the schedule. Reload the page. Captains can now line up cover.`,
    });
  });

  it("says so when none of their fixtures fall in the range", async () => {
    const { season, player, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const view = await page(player.id);

    const res = await markAwayDates(
      {},
      awayForm(season.id, days(20), days(25), view!.fixtures),
    );
    expect(res).toEqual({ error: "None of your fixtures fall between those dates." });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses once the season is archived", async () => {
    const { season, player, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const view = await page(player.id);
    await prisma.season.update({ where: { id: season.id }, data: { isActive: false } });

    const res = await markAwayDates(
      {},
      awayForm(season.id, days(1), days(10), view!.fixtures),
    );
    expect(res).toEqual({
      error: "Those fixtures belong to an archived season. Reload the page.",
    });
    expect(await rows(player.id)).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("marks a standin's booked cover and pings the covered team's captain", async () => {
    const { season, alpha, player, mine, opponentOf, days } = await setupSeason();
    await prisma.user.update({
      where: { id: alpha.captainId },
      data: { discordId: CAPTAIN_DISCORD },
    });
    const cover = await makeUser("Booked Cover");
    await prisma.standinAssignment.create({
      data: {
        matchId: mine[1].id,
        teamId: alpha.id,
        standinUserId: cover.id,
        replacingUserId: player.id,
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(cover));
    const view = await page(cover.id);
    expect(view!.fixtures).toEqual([
      expect.objectContaining({
        matchId: mine[1].id,
        standin: true,
        label: `Week 2 vs ${opponentOf(mine[1])}`,
      }),
    ]);

    const res = await markAwayDates(
      {},
      awayForm(season.id, days(1), days(20), view!.fixtures),
    );
    expect(res).toHaveProperty("message");
    expect((await rows(cover.id)).map((r) => [r.matchId, r.status])).toEqual([
      [mine[1].id, "OUT"],
    ]);
    // One fixture reads exactly like a one-match OUT.
    expect(mockSend.mock.calls[0][0]).toContain("line up a standin");
    expect(mockSend.mock.calls[0][1]).toEqual({ users: [CAPTAIN_DISCORD] });
  });
});

describe("markAwayDates + setAvailability share one OUT ping per match", () => {
  it("a range leaves out a match the player just announced one-by-one", async () => {
    const { season, player, mine, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));

    await setAvailability({}, rsvpForm(mine[0], "OUT"));
    await setAvailability({}, rsvpForm(mine[0], "IN"));
    expect(mockSend).toHaveBeenCalledTimes(1);

    const view = await page(player.id);
    const res = await markAwayDates(
      {},
      awayForm(season.id, days(1), days(10), view!.fixtures),
    );
    expect(res?.message).toMatch(/^Marked you out for 2 fixtures/);
    expect(mockSend).toHaveBeenCalledTimes(2);
    const msg = String(mockSend.mock.calls[1][0]);
    expect(msg).toContain(`/matches/${mine[1].id}`);
    expect(msg).not.toContain(`/matches/${mine[0].id}`);
  });

  it("a one-match OUT after a range doesn't ping again", async () => {
    const { season, player, mine, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const view = await page(player.id);
    await markAwayDates({}, awayForm(season.id, days(1), days(10), view!.fixtures));
    expect(mockSend).toHaveBeenCalledTimes(1);

    await setAvailability({}, rsvpForm(mine[0], "IN"));
    const out = await setAvailability({}, rsvpForm(mine[0], "OUT"));
    expect(out).toHaveProperty("message");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("a double submit marks once and announces once", async () => {
    const { season, player, days } = await setupSeason();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    const view = await page(player.id);
    const form = () => awayForm(season.id, days(1), days(10), view!.fixtures);

    const results = await raceN(3, () => markAwayDates({}, form()));
    expect(
      results.every(
        (r) =>
          Boolean(r?.message) || /reload.*try.*again/i.test(r?.error ?? ""),
      ),
    ).toBe(true);
    expect(results.some((r) => Boolean(r?.message))).toBe(true);
    expect(await prisma.matchAvailability.count({ where: { userId: player.id } })).toBe(2);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
