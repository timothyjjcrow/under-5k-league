import { beforeEach, describe, expect, it, vi } from "vitest";

// setAvailability had ZERO integration coverage (only its pure helpers were
// tested) while being the one mutation every rostered player runs weekly.
// Stub the request-scope bits and drive the real action against the test DB.
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

import { setAvailability } from "@/app/actions/availability";
import { requireUser } from "@/lib/auth";
import { sendDiscordMessage } from "@/lib/discord";
import { prisma } from "@/lib/prisma";
import { DRAFT_STATUS, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  makeUser,
  raceN,
  sessionFor,
} from "./factories";

const mockSend = vi.mocked(sendDiscordMessage);

function rsvpForm(matchId: string, status: string): FormData {
  const fd = new FormData();
  fd.set("matchId", matchId);
  fd.set("status", status);
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

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
    expect(res?.message).toMatch(/confirmed/i);
    let row = await prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: match.id, userId: player.id } },
    });
    expect(row?.status).toBe("IN");

    const out = await setAvailability({}, rsvpForm(match.id, "OUT"));
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

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
    expect(res?.error).toMatch(/not playing/i);
  });

  it("refuses a COMPLETED match", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.COMPLETED, homeScore: 2, awayScore: 0 },
    });

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
    expect(res?.error).toMatch(/already finished/i);
  });

  it("refuses a LIVE match — availability must be decided before play starts", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.LIVE },
    });

    const res = await setAvailability({}, rsvpForm(match.id, "OUT"));
    expect(res?.error).toMatch(/closed.*live/i);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(0);
  });

  it("refuses an unscheduled match — IN/OUT needs a concrete night", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.match.update({
      where: { id: match.id },
      data: { scheduledAt: null },
    });

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
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

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
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

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
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

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
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

    const res = await setAvailability({}, rsvpForm(match.id, "OUT"));
    expect(res?.error).toMatch(/archived season/i);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(0);
  });

  it("maps a simultaneous RSVP contention loss to a retryable result", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));

    const results = await raceN(3, () =>
      setAvailability({}, rsvpForm(match.id, "IN")),
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

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
    expect(res?.message).toMatch(/confirmed/i);
    let row = await prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: match.id, userId: standin.id } },
    });
    expect(row?.status).toBe("IN");

    const out = await setAvailability({}, rsvpForm(match.id, "OUT"));
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

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
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

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
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

    const res = await setAvailability({}, rsvpForm(first.id, "IN"));
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

    const res = await setAvailability({}, rsvpForm(match.id, "OUT"));
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

    await setAvailability({}, rsvpForm(match.id, "OUT"));

    const call = mockSend.mock.calls.find(([msg]) =>
      String(msg).includes("line up a standin"),
    );
    expect(call, "a standin's first OUT must announce").toBeTruthy();
    expect(String(call![0])).toContain(`/matches/${match.id}`);
  });
});
