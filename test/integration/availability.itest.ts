import { beforeEach, describe, expect, it, vi } from "vitest";

// setAvailability had ZERO integration coverage (only its pure helpers were
// tested) while being the one mutation every rostered player runs weekly.
// Stub the request-scope bits and drive the real action against the test DB.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { setMatchTime } from "@/app/actions/admin";
import { setAvailability } from "@/app/actions/availability";
import { requireAdmin, requireUser } from "@/lib/auth";
import { sendDiscordMessage } from "@/lib/discord";
import { prisma } from "@/lib/prisma";
import { DRAFT_STATUS, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { assignStandinGuarded, removeStandinGuarded } from "@/lib/standin-service";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  makeUser,
  raceN,
  sessionFor,
} from "./factories";

const mockSend = vi.mocked(sendDiscordMessage);

function rsvpForm(match: { id: string; scheduleRevision: number }, status: string): FormData {
  const fd = new FormData();
  fd.set("matchId", match.id);
  fd.set("status", status);
  fd.set("expectedScheduleRevision", String(match.scheduleRevision));
  return fd;
}

/** Two rostered teams + one scheduled match; returns a home roster player. */
async function setupMatch() {
  const season = await makeSeason({
    teamSize: 3,
    status: SEASON_STATUS.REGULAR_SEASON,
  });
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  const player = await makeUser("Roster Player");
  await prisma.teamMember.create({
    data: {
      seasonId: season.id,
      teamId: home.id,
      userId: player.id,
      isCaptain: false,
      price: 0,
    },
  });
  const [created] = await generateRegularSchedule(season.id);
  const match = await prisma.match.update({
    where: { id: created.id },
    data: { scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) },
  });
  return { season, home, away, match, player };
}

describe("setAvailability", () => {
  beforeEach(() => vi.mocked(requireUser).mockReset());

  it("records a rostered player's RSVP and flips it on resubmit", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));

    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.message).toMatch(/confirmed/i);
    let row = await prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: match.id, userId: player.id } },
    });
    expect(row?.status).toBe("IN");

    const out = await setAvailability({}, rsvpForm(match, "OUT"));
    expect(out?.message).toMatch(/unavailable/i);
    row = await prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: match.id, userId: player.id } },
    });
    expect(row?.status).toBe("OUT");
  });

  it("refuses a non-participant", async () => {
    const { match } = await setupMatch();
    const rando = await makeUser("Rando");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(rando));

    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.error).toMatch(/not playing/i);
  });

  it("refuses a COMPLETED match", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.COMPLETED, homeScore: 2, awayScore: 0 },
    });

    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.error).toMatch(/already finished/i);
  });

  it("accepts a LIVE participant's availability for remaining games", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.LIVE },
    });

    const res = await setAvailability({}, rsvpForm(match, "OUT"));
    expect(res?.message).toMatch(/unavailable/i);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(1);
  });

  it("refuses an unscheduled match — IN/OUT needs a concrete night", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.match.update({
      where: { id: match.id },
      data: { scheduledAt: null },
    });

    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.error).toMatch(/does not have a kickoff/i);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(0);
  });

  it("refuses a stale unreported match — it needs a result, not a new RSVP", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.match.update({
      where: { id: match.id },
      data: { scheduledAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    });

    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.error).toMatch(/kickoff has passed.*result.*outstanding/i);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(0);
  });

  it.each([
    [SEASON_STATUS.SIGNUPS, null],
    [SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS],
    [SEASON_STATUS.COMPLETE, null],
  ])("refuses check-in during %s / %s", async (seasonStatus, draftStatus) => {
    const { season, match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.season.update({
      where: { id: season.id },
      data: { status: seasonStatus },
    });
    if (draftStatus) {
      await prisma.draft.create({
        data: { seasonId: season.id, status: draftStatus },
      });
    }

    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.error).toMatch(/not open.*league phase/i);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(0);
  });

  it("allows check-in during DRAFT only after the auction is complete", async () => {
    const { season, match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.DRAFT },
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });

    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.message).toMatch(/confirmed/i);
  });

  it("refuses an archived season's match — an RSVP is about the active season", async () => {
    // An OUT here would ping a captain (with a mention) about a fixture nobody
    // is playing; the season turned over and this match is history.
    const { season, match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });

    const res = await setAvailability({}, rsvpForm(match, "OUT"));
    expect(res?.error).toMatch(/archived season/i);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(0);
  });

  it("maps a simultaneous RSVP contention loss to a retryable result", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));

    const results = await raceN(3, () =>
      setAvailability({}, rsvpForm(match, "IN")),
    );
    expect(results.some((result) => result?.message)).toBe(true);
    expect(
      results.every(
        (result) =>
          Boolean(result?.message) ||
          /reload.*try.*again/i.test(result?.error ?? ""),
      ),
    ).toBe(true);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(1);
  });
});

// The participant guard is "on either roster OR holds a StandinAssignment for
// THIS match" — the standin half had zero coverage, and a standin is exactly
// who a check-in count most needs an answer from (they're the cover).
describe("setAvailability — assigned standins", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockReset();
    mockSend.mockClear();
  });

  /** Book `standin` as cover on `matchId` (named seat when `replacing` given). */
  async function assign(
    matchId: string,
    teamId: string,
    standinUserId: string,
    replacingUserId: string | null,
  ) {
    return prisma.standinAssignment.create({
      data: { matchId, teamId, standinUserId, replacingUserId },
    });
  }

  // Pins: standinSeat (match.standins) satisfies the participation guard.
  it("lets a named-cover standin RSVP IN and flip to OUT", async () => {
    const { match, home, player } = await setupMatch();
    const standin = await makeUser("Named Cover");
    await assign(match.id, home.id, standin.id, player.id);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(standin));

    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.message).toMatch(/confirmed/i);
    let row = await prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: match.id, userId: standin.id } },
    });
    expect(row?.status).toBe("IN");

    const out = await setAvailability({}, rsvpForm(match, "OUT"));
    expect(out?.message).toMatch(/unavailable/i);
    row = await prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: match.id, userId: standin.id } },
    });
    expect(row?.status).toBe("OUT");
  });

  // Pins: an EMPTY-SEAT booking (replacingUserId null — a short roster) is a
  // participant too; the guard must not require a replaced player behind it.
  it("lets an empty-seat standin RSVP", async () => {
    const { match, home } = await setupMatch();
    const standin = await makeUser("Seat Filler");
    await assign(match.id, home.id, standin.id, null);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(standin));

    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.message).toMatch(/confirmed/i);
    const row = await prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: match.id, userId: standin.id } },
    });
    expect(row?.status).toBe("IN");
  });

  it("refuses the roster player whose named seat a standin replaced", async () => {
    const { match, home, player } = await setupMatch();
    const standin = await makeUser("Replacement Cover");
    await assign(match.id, home.id, standin.id, player.id);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));

    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.error).toMatch(/standin is covering your seat/i);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(0);
  });

  // Pins: cover is per-MATCH. A booking elsewhere in the season must not open
  // this fixture's RSVP — the guard reads match.standins, never a season scan.
  it("refuses a standin whose assignment is on a DIFFERENT match", async () => {
    const season = await makeSeason({
      teamSize: 3,
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    await makeTeam(season.id, "Alpha", 0);
    await makeTeam(season.id, "Bravo", 1);
    await makeTeam(season.id, "Charlie", 2);
    const [first, second] = await generateRegularSchedule(season.id);
    await prisma.match.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) },
    });
    const standin = await makeUser("Elsewhere Cover");
    await assign(second.id, second.homeTeamId, standin.id, null);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(standin));

    const res = await setAvailability({}, rsvpForm(first, "IN"));
    expect(res?.error).toMatch(/not playing/i);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: first.id } }),
    ).toBe(0);
  });

  // Pins: the OUT ping resolves the COVERED team's captain via standinSeat's
  // teamId — the person who now has to find replacement cover for the cover.
  it("OUT from a standin mentions the covered team's captain", async () => {
    const { match, home, player } = await setupMatch();
    await prisma.user.update({
      where: { id: home.captainId },
      data: { discordId: "555666777888999000" },
    });
    const standin = await makeUser("Bailing Cover");
    await assign(match.id, home.id, standin.id, player.id);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(standin));

    const res = await setAvailability({}, rsvpForm(match, "OUT"));
    expect(res?.message).toMatch(/unavailable/i);

    const call = mockSend.mock.calls.find(([msg]) =>
      String(msg).includes("line up a standin"),
    );
    expect(call, "a standin's first OUT must announce").toBeTruthy();
    expect(String(call![0])).toContain("Bailing Cover");
    // …and PING the captain, not just state it into the channel.
    expect(call![1]).toEqual({ users: ["555666777888999000"] });
  });

  // Pins: the OUT ping deep-links the match page — the mentioned captain is by
  // definition NOT on the site, and that page holds the Standins card.
  it("the OUT announcement links the match page", async () => {
    const { match, home, player } = await setupMatch();
    const standin = await makeUser("Linked-To Cover");
    await assign(match.id, home.id, standin.id, player.id);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(standin));

    await setAvailability({}, rsvpForm(match, "OUT"));

    const call = mockSend.mock.calls.find(([msg]) =>
      String(msg).includes("line up a standin"),
    );
    expect(call, "a standin's first OUT must announce").toBeTruthy();
    expect(String(call![0])).toContain(`/matches/${match.id}`);
  });
});

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) fd.set(key, value);
  return fd;
}

/** Two full 3-player rosters, all registered and checked IN for tomorrow. */
async function setupFullSides() {
  const season = await makeSeason({
    teamSize: 3,
    status: SEASON_STATUS.REGULAR_SEASON,
  });
  const people = await Promise.all(
    Array.from({ length: 6 }, (_, i) => makeUser(`Side player ${i}`)),
  );
  const home = await prisma.team.create({
    data: { seasonId: season.id, name: "Home", captainId: people[0].id },
  });
  const away = await prisma.team.create({
    data: { seasonId: season.id, name: "Away", captainId: people[3].id },
  });
  await prisma.teamMember.createMany({
    data: people.map((p, i) => ({
      seasonId: season.id,
      teamId: i < 3 ? home.id : away.id,
      userId: p.id,
      isCaptain: i === 0 || i === 3,
    })),
  });
  await prisma.registration.createMany({
    data: people.map((p) => ({ seasonId: season.id, userId: p.id, mmr: 2800, roles: "4,5" })),
  });
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      homeTeamId: home.id,
      awayTeamId: away.id,
      scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      bestOf: 3,
    },
  });
  await prisma.matchAvailability.createMany({
    data: people.map((p) => ({
      matchId: match.id,
      userId: p.id,
      status: "IN",
      scheduleRevision: match.scheduleRevision,
    })),
  });
  return { season, people, home, away, match };
}

describe("setAvailability — retimes and live cover", () => {
  beforeEach(() => vi.mocked(requireUser).mockReset());

  it("refuses an unscheduled LIVE fixture with a clear error", async () => {
    const { match, people } = await setupFullSides();
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.LIVE, scheduledAt: null },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[0]));

    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.error).toMatch(/does not have a kickoff/);
  });

  it("an admin retime to the same time keeps check-ins; a real one clears them and refuses the old form", async () => {
    const { season, match, people } = await setupFullSides();
    const admin = await makeUser("Scheduler", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    const retime = (when: Date) =>
      setMatchTime(
        {},
        form({
          matchId: match.id,
          expectedActiveSeasonId: season.id,
          scheduledAt: when.toISOString(),
          scheduledAtTs: String(when.getTime()),
        }),
      );

    expect((await retime(match.scheduledAt!))?.error).toBeUndefined();
    expect(await prisma.match.findUnique({ where: { id: match.id } })).toMatchObject({ scheduleRevision: 0 });
    expect(await prisma.matchAvailability.count({ where: { matchId: match.id } })).toBe(6);

    expect((await retime(new Date(match.scheduledAt!.getTime() + 60 * 60 * 1000)))?.error).toBeUndefined();
    expect(await prisma.match.findUnique({ where: { id: match.id } })).toMatchObject({ scheduleRevision: 1 });
    expect(await prisma.matchAvailability.count({ where: { matchId: match.id } })).toBe(0);

    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[0]));
    expect((await setAvailability({}, rsvpForm(match, "IN")))?.error).toMatch(/kickoff changed/);
    expect((await setAvailability({}, rsvpForm({ id: match.id, scheduleRevision: 1 }, "IN")))?.message).toBeTruthy();
    expect(await prisma.matchAvailability.findFirst({ where: { matchId: match.id } })).toMatchObject({ status: "IN", scheduleRevision: 1 });
  });

  it("repeating the same answer writes nothing; changing it flips the row", async () => {
    const { match, people } = await setupFullSides();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[1]));
    const where = { matchId_userId: { matchId: match.id, userId: people[1].id } };
    const before = await prisma.matchAvailability.findUniqueOrThrow({ where });

    expect((await setAvailability({}, rsvpForm(match, "IN")))?.message).toBeTruthy();
    expect(await prisma.matchAvailability.findUniqueOrThrow({ where })).toEqual(before);

    expect((await setAvailability({}, rsvpForm(match, "OUT")))?.message).toBeTruthy();
    expect(await prisma.matchAvailability.findUniqueOrThrow({ where })).toMatchObject({ status: "OUT", scheduleRevision: 0 });
  });

  it("a stale or missing kickoff revision cannot post a fresh RSVP", async () => {
    const { match, people } = await setupFullSides();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[1]));
    await prisma.match.update({
      where: { id: match.id },
      data: { scheduleRevision: { increment: 1 } },
    });

    expect((await setAvailability({}, rsvpForm(match, "IN")))?.error).toMatch(/kickoff changed/);
    expect((await setAvailability({}, form({ matchId: match.id, status: "IN" })))?.error).toMatch(/Reload/);
    expect(await prisma.matchAvailability.count({ where: { matchId: match.id, scheduleRevision: 1 } })).toBe(0);
  });

  it("mid-series cover: the standin answers for the seat until the cover is removed", async () => {
    const { season, match, people } = await setupFullSides();
    const standin = await makeUser("Mid-series cover");
    await prisma.registration.create({
      data: { seasonId: season.id, userId: standin.id, type: "STANDIN", mmr: 0 },
    });
    await prisma.match.update({ where: { id: match.id }, data: { status: MATCH_STATUS.LIVE } });
    expect(
      await assignStandinGuarded({
        matchId: match.id,
        standinUserId: standin.id,
        replacingUserId: people[1].id,
        actingCaptainId: people[0].id,
      }),
    ).toMatchObject({ ok: true });

    vi.mocked(requireUser).mockResolvedValue(sessionFor(standin));
    expect((await setAvailability({}, rsvpForm(match, "IN")))?.message).toMatch(/next game/);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[1]));
    expect((await setAvailability({}, rsvpForm(match, "OUT")))?.error).toMatch(/standin is covering your seat/);

    const assignment = await prisma.standinAssignment.findFirstOrThrow({ where: { matchId: match.id } });
    expect(
      await removeStandinGuarded({ assignmentId: assignment.id, actingCaptainId: people[0].id }),
    ).toMatchObject({ ok: true });

    vi.mocked(requireUser).mockResolvedValue(sessionFor(standin));
    expect((await setAvailability({}, rsvpForm(match, "OUT")))?.error).toMatch(/not playing/i);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[1]));
    expect((await setAvailability({}, rsvpForm(match, "OUT")))?.message).toBeTruthy();
  });

  it("a standin answers only while their signup is active, they hold no roster seat and the seat still exists", async () => {
    const { season, match, home, people } = await setupFullSides();
    const [withdrawn, rostered, unregistered, staleCover, gone, elsewhereCaptain] = await Promise.all(
      ["Withdrawn cover", "Rostered cover", "Unregistered cover", "Stale cover", "Released player", "Elsewhere captain"].map((name) => makeUser(name)),
    );
    const elsewhere = await prisma.team.create({
      data: { seasonId: season.id, name: "Elsewhere", captainId: elsewhereCaptain.id },
    });
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: elsewhere.id, userId: rostered.id },
    });
    await prisma.registration.create({
      data: { seasonId: season.id, userId: withdrawn.id, type: "STANDIN", mmr: 0, status: "WITHDRAWN" },
    });
    // Written directly: assignStandinGuarded refuses every one of these, and
    // the check-in rule has to hold for rows that predate that refusal.
    await prisma.standinAssignment.createMany({
      data: [
        { matchId: match.id, teamId: home.id, standinUserId: withdrawn.id, replacingUserId: people[1].id },
        { matchId: match.id, teamId: home.id, standinUserId: rostered.id, replacingUserId: people[2].id },
        { matchId: match.id, teamId: home.id, standinUserId: unregistered.id, replacingUserId: null },
        { matchId: match.id, teamId: home.id, standinUserId: staleCover.id, replacingUserId: gone.id },
      ],
    });
    const answer = async (user: { id: string; steamId: string; name: string; role: string }) => {
      vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
      return setAvailability({}, rsvpForm(match, "IN"));
    };

    for (const refused of [withdrawn, rostered, staleCover]) {
      expect((await answer(refused))?.error, refused.name).toMatch(/roster or cover assignment changed/);
    }
    expect((await answer(unregistered))?.message).toBeTruthy();
    expect(
      await prisma.matchAvailability.findMany({
        where: { matchId: match.id, userId: { in: [withdrawn.id, rostered.id, staleCover.id, unregistered.id] } },
        select: { userId: true },
      }),
    ).toEqual([{ userId: unregistered.id }]);
  });
});

describe("setAvailability — closing the OUT loop", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockReset();
    mockSend.mockClear();
  });

  const backIns = () =>
    mockSend.mock.calls.filter(([msg]) => String(msg).includes("after all"));
  const outs = () =>
    mockSend.mock.calls.filter(([msg]) => String(msg).includes("line up a standin"));

  it("tells the same captain when a player who said OUT can make it after all", async () => {
    const { match, home, player } = await setupMatch();
    await prisma.user.update({
      where: { id: home.captainId },
      data: { discordId: "555666777888999001" },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));

    await setAvailability({}, rsvpForm(match, "OUT"));
    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.error).toBeUndefined();

    expect(outs()).toHaveLength(1);
    expect(backIns()).toHaveLength(1);
    const [content, mentions] = backIns()[0]!;
    expect(content).toContain("**Roster Player** can make the week 1 match after all");
    expect(content).toContain(`/matches/${match.id}#match-standins>`);
    expect(mentions).toEqual({ users: ["555666777888999001"] });
  });

  it("buzzes a captain at most three times while a player flips back and forth", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));

    for (const status of ["OUT", "IN", "OUT", "IN", "OUT", "IN", "OUT"]) {
      await setAvailability({}, rsvpForm(match, status));
    }
    // OUT, "after all", OUT again — then quiet until the window passes.
    expect(outs()).toHaveLength(2);
    expect(backIns()).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("says nothing for an IN when no OUT was ever announced", async () => {
    const { match, player } = await setupMatch();
    // An OUT on file with no ping behind it (answered before, or never sent).
    await prisma.matchAvailability.create({
      data: {
        matchId: match.id,
        userId: player.id,
        status: "OUT",
        scheduleRevision: match.scheduleRevision,
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));

    const res = await setAvailability({}, rsvpForm(match, "IN"));
    expect(res?.message).toMatch(/confirmed/i);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never pings a captain about their own answer", async () => {
    const { match, home } = await setupMatch();
    const captain = await prisma.user.update({
      where: { id: home.captainId },
      data: { discordId: "555666777888999002" },
    });
    await prisma.teamMember.create({
      data: {
        seasonId: match.seasonId,
        teamId: home.id,
        userId: captain.id,
        isCaptain: true,
        price: 0,
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(captain));

    await setAvailability({}, rsvpForm(match, "OUT"));
    await setAvailability({}, rsvpForm(match, "IN"));
    expect(backIns()).toHaveLength(1);
    expect(backIns()[0]![1]).toBeUndefined();
  });
});
