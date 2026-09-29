import { beforeEach, describe, expect, it, vi } from "vitest";

// A captain's "Remind the N who haven't answered" on the match page: one
// Discord post that @-mentions only their own team's unanswered players, at
// most once per team per match per CHECKIN_NUDGE_THROTTLE_SECONDS. Drives the
// real server action against the test DB with Discord and auth stubbed.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => "https://discord.test/api/webhooks/1/x"),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { randomUUID } from "node:crypto";
import { remindUnansweredCheckins } from "@/app/actions/availability";
import {
  recordResult,
  setMatchTime,
} from "@/app/actions/admin-schedule-results";
import { requireAdmin, requireUser } from "@/lib/auth";
import { getWebhookUrl, sendDiscordMessage } from "@/lib/discord";
import { prisma } from "@/lib/prisma";
import {
  checkinNudgeAnnouncementGroup,
  checkinNudgeKey,
} from "@/lib/availability";
import {
  deliverLeagueAnnouncements,
  enqueueLeagueAnnouncement,
} from "@/lib/league-announcement-outbox";
import {
  proposeReschedule,
  respondReschedule,
} from "@/lib/reschedule-service";
import {
  checkinNudgeBlockedSince,
  checkinNudgeToast,
} from "@/lib/checkin-nudge-service";
import {
  CHECKIN_NUDGE_THROTTLE_SECONDS,
  MATCH_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  makeUser,
  raceN,
  sessionFor,
} from "./factories";

const mockSend = vi.mocked(sendDiscordMessage);
const mockWebhook = vi.mocked(getWebhookUrl);

const LINKED_ID = "123456789012345678";
const AWAY_LINKED_ID = "223456789012345678";
const EVIL = "Sneaky [free mmr](https://evil.test)";

/** The action as the match page's form posts it. */
async function nudge(matchId: string) {
  const fd = new FormData();
  fd.set("matchId", matchId);
  return (await remindUnansweredCheckins({}, fd)) ?? {};
}

async function roster(seasonId: string, teamId: string, userId: string, isCaptain = false) {
  await prisma.teamMember.create({
    data: { seasonId, teamId, userId, isCaptain, price: 0 },
  });
}

/**
 * Two rostered teams and one scheduled fixture. Home: a captain, a linked
 * player and an unlinked one who haven't answered, and one who has. Away: a
 * captain and one linked player who hasn't answered.
 */
async function setup() {
  const season = await makeSeason({
    teamSize: 4,
    status: SEASON_STATUS.REGULAR_SEASON,
  });
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  const [homeCaptain, awayCaptain] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: home.captainId } }),
    prisma.user.findUniqueOrThrow({ where: { id: away.captainId } }),
  ]);
  const linked = await makeUser("Linked Larry");
  await prisma.user.update({
    where: { id: linked.id },
    data: { discordId: LINKED_ID },
  });
  const unlinked = await makeUser(EVIL);
  const answered = await makeUser("Answered Annie");
  const awayPlayer = await makeUser("Away Andy");
  await prisma.user.update({
    where: { id: awayPlayer.id },
    data: { discordId: AWAY_LINKED_ID },
  });
  await roster(season.id, home.id, homeCaptain.id, true);
  await roster(season.id, home.id, linked.id);
  await roster(season.id, home.id, unlinked.id);
  await roster(season.id, home.id, answered.id);
  await roster(season.id, away.id, awayCaptain.id, true);
  await roster(season.id, away.id, awayPlayer.id);
  const [created] = await generateRegularSchedule(season.id);
  const match = await prisma.match.update({
    where: { id: created.id },
    data: { scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) },
  });
  await prisma.matchAvailability.create({
    data: {
      matchId: match.id,
      userId: answered.id,
      status: "IN",
      scheduleRevision: match.scheduleRevision,
    },
  });
  // The fixture's home side is whichever team the round robin put there.
  const homeIsHome = match.homeTeamId === home.id;
  return {
    season,
    match,
    home,
    away,
    homeCaptain,
    awayCaptain,
    linked,
    unlinked,
    answered,
    awayPlayer,
    homeIsHome,
  };
}

function lastSend() {
  const call = mockSend.mock.calls.at(-1);
  if (!call) throw new Error("no Discord send");
  return { content: call[0] as string, mentions: call[1], options: call[2] };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

describe("remindUnansweredCheckins", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockReset();
    mockSend.mockReset();
    mockSend.mockResolvedValue(true);
    mockWebhook.mockReset();
    mockWebhook.mockResolvedValue("https://discord.test/api/webhooks/1/x");
  });

  it("pings only the captain's own unanswered players, escaped, with the match link", async () => {
    const s = await setup();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));

    const res = await nudge(s.match.id);

    expect(res.error).toBeUndefined();
    expect(res.message).toBe(
      "Posted a check-in reminder in Discord for the 2 players who haven't answered. 1 of them hasn't linked Discord, so they were named without a ping.",
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
    const { content, mentions } = lastSend();
    expect(content).toContain(`<@${LINKED_ID}>`);
    expect(content).toContain(`/matches/${s.match.id}>`);
    // The unlinked player is named, escaped: no live masked link.
    expect(content).toContain("Sneaky");
    expect(content).not.toContain("](");
    // Nobody who answered, not the captain, nobody from the other team.
    expect(content).not.toContain("Answered Annie");
    expect(content).not.toContain(`<@${AWAY_LINKED_ID}>`);
    expect(content).not.toContain("Away Andy");
    expect(mentions).toEqual({ users: [LINKED_ID] });
    // Dropped from the outbox at kickoff, and grouped so a retime or a result
    // can drop it earlier.
    expect(lastSend().options).toEqual({
      expiresAt: s.match.scheduledAt,
      expiryGroup: `checkin-nudge:${s.match.id}:`,
    });
    expect(
      await prisma.setting.findUnique({
        where: {
          key: checkinNudgeKey(s.match.id, s.home.id, s.match.scheduleRevision),
        },
      }),
    ).not.toBeNull();
  });

  it("refuses anyone who isn't a captain in the match, and burns nothing", async () => {
    const s = await setup();
    const outsider = await makeUser("Outsider");
    for (const user of [s.linked, outsider]) {
      vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
      const res = await nudge(s.match.id);
      expect(res.error).toMatch(/only a captain in this match/i);
    }
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      await prisma.setting.count({
        where: { key: { startsWith: `checkinNudge:${s.match.id}:` } },
      }),
    ).toBe(0);
  });

  it("gives each captain their own window, pinging only their own side", async () => {
    const s = await setup();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));
    expect((await nudge(s.match.id)).message).toBeTruthy();

    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.awayCaptain));
    const res = await nudge(s.match.id);
    expect(res.message).toBe(
      "Posted a check-in reminder in Discord for the 1 player who hasn't answered.",
    );
    const { content, mentions } = lastSend();
    expect(mentions).toEqual({ users: [AWAY_LINKED_ID] });
    expect(content).not.toContain(`<@${LINKED_ID}>`);
    expect(content).not.toContain("Sneaky");
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("throttles a team to one reminder per window, then allows the next", async () => {
    const s = await setup();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));
    expect((await nudge(s.match.id)).message).toBeTruthy();

    const again = await nudge(s.match.id);
    expect(again.error).toMatch(/already got a check-in reminder in the last 3 hours/);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const rev = s.match.scheduleRevision;
    const key = checkinNudgeKey(s.match.id, s.home.id, rev);
    expect(
      await checkinNudgeBlockedSince(s.match.id, s.home.id, rev, Date.now()),
    ).toBeInstanceOf(Date);

    // Once the window has passed, the page offers the button again and the
    // next reminder goes out.
    const expired = new Date(
      Date.now() - (CHECKIN_NUDGE_THROTTLE_SECONDS + 60) * 1000,
    ).toISOString();
    await prisma.setting.update({ where: { key }, data: { value: expired } });
    expect(
      await checkinNudgeBlockedSince(s.match.id, s.home.id, rev, Date.now()),
    ).toBeNull();
    expect((await nudge(s.match.id)).message).toBeTruthy();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("allows a fresh reminder as soon as a reschedule moves the kickoff", async () => {
    const s = await setup();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));
    expect((await nudge(s.match.id)).message).toBeTruthy();
    expect((await nudge(s.match.id)).error).toMatch(/already got a check-in reminder/);

    // The other captain accepts a new time: every answer is wiped and the
    // reminder already in Discord quotes the old kickoff.
    const newTime = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await proposeReschedule(s.homeCaptain.id, s.match.id, newTime);
    const request = await prisma.rescheduleRequest.findFirstOrThrow({
      where: { matchId: s.match.id, status: "PENDING" },
    });
    await respondReschedule(s.awayCaptain.id, request.id, true);
    const moved = await prisma.match.findUniqueOrThrow({
      where: { id: s.match.id },
    });
    expect(moved.scheduleRevision).toBe(s.match.scheduleRevision + 1);

    expect(
      await checkinNudgeBlockedSince(
        s.match.id,
        s.home.id,
        moved.scheduleRevision,
        Date.now(),
      ),
    ).toBeNull();
    const res = await nudge(s.match.id);
    expect(res.error).toBeUndefined();
    // Annie's answer was about the old night, so she is asked again too, and
    // the post quotes the new kickoff.
    expect(res.message).toMatch(/the 3 players who haven't answered/);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(lastSend().content).toContain(
      `<t:${Math.floor(newTime.getTime() / 1000)}:`,
    );
    // The new kickoff's window is held like any other.
    expect((await nudge(s.match.id)).error).toMatch(/already got a check-in reminder/);
  });

  it("gives a reminder sent after kickoff an hour in the outbox", async () => {
    const s = await setup();
    // Check-in stays open after kickoff while the lobby is late.
    const kickoff = new Date(Date.now() - 30 * 60 * 1000);
    await prisma.match.update({
      where: { id: s.match.id },
      data: { scheduledAt: kickoff },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));

    const before = Date.now();
    expect((await nudge(s.match.id)).message).toBeTruthy();
    const expiresAt = (lastSend().options as { expiresAt: Date }).expiresAt;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  // A Discord outage holds the reminder in the outbox. When the kickoff moves
  // or a result lands before it goes out, it must be dropped: it would ping
  // players to check in for a night nobody is playing or a decided match.
  it.each([
    {
      event: "a reschedule is accepted",
      run: async (s: Awaited<ReturnType<typeof setup>>) => {
        await proposeReschedule(
          s.awayCaptain.id,
          s.match.id,
          new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        );
        const request = await prisma.rescheduleRequest.findFirstOrThrow({
          where: { matchId: s.match.id, status: "PENDING" },
        });
        await respondReschedule(s.homeCaptain.id, request.id, true);
      },
    },
    {
      event: "an admin moves the kickoff",
      run: async (s: Awaited<ReturnType<typeof setup>>) => {
        const when = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
        const res = await setMatchTime(
          {},
          form({
            matchId: s.match.id,
            expectedActiveSeasonId: s.season.id,
            scheduledAt: when.toISOString(),
            scheduledAtTs: String(when.getTime()),
          }),
        );
        expect(res?.error).toBeUndefined();
      },
    },
    {
      event: "an admin records the result",
      run: async (s: Awaited<ReturnType<typeof setup>>) => {
        const res = await recordResult(
          {},
          form({ matchId: s.match.id, homeScore: "2", awayScore: "0" }),
        );
        expect(res?.error).toBeUndefined();
      },
    },
  ])("drops a queued reminder when $event", async ({ run }) => {
    const s = await setup();
    const admin = await makeUser("Admin Ada");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));
    // Queue the reminder the way sendDiscordMessage does, then let Discord be
    // down: nothing is delivered yet.
    mockSend.mockImplementationOnce(async (content, mentions, options) => {
      await enqueueLeagueAnnouncement({
        content,
        mentions,
        dedupeKey: `${options?.expiryGroup}${randomUUID()}`,
        expiresAt: options?.expiresAt ?? null,
      });
      return true;
    });
    expect((await nudge(s.match.id)).message).toBeTruthy();
    // Another fixture's reminder is not this event's business.
    const other = await enqueueLeagueAnnouncement({
      content: "other fixture reminder",
      dedupeKey: `${checkinNudgeAnnouncementGroup("other-match")}${randomUUID()}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await run(s);

    const send = vi.fn(async () => true);
    await deliverLeagueAnnouncements({ send, limit: 5 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("other fixture reminder", undefined);
    const queued = await prisma.leagueAnnouncement.findFirstOrThrow({
      where: {
        dedupeKey: { startsWith: checkinNudgeAnnouncementGroup(s.match.id) },
      },
    });
    expect(queued.status).toBe("CANCELLED");
    expect(
      (
        await prisma.leagueAnnouncement.findUniqueOrThrow({
          where: { id: other.id },
        })
      ).status,
    ).toBe("SENT");
  });

  it("sends exactly once when a captain double-clicks", async () => {
    const s = await setup();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));

    const results = await raceN(4, () => nudge(s.match.id));

    expect(results.filter((r) => r.message)).toHaveLength(1);
    expect(results.filter((r) => r.error)).toHaveLength(3);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("refuses without a Discord channel and leaves the window unclaimed", async () => {
    const s = await setup();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));
    mockWebhook.mockResolvedValueOnce("");

    const res = await nudge(s.match.id);
    expect(res.error).toMatch(/no Discord channel/);
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      await prisma.setting.findUnique({
        where: {
          key: checkinNudgeKey(s.match.id, s.home.id, s.match.scheduleRevision),
        },
      }),
    ).toBeNull();

    expect((await nudge(s.match.id)).message).toBeTruthy();
  });

  it("gives the window back when the post can't be queued", async () => {
    const s = await setup();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));
    // sendDiscordMessage is durable: false means the post was never queued
    // (no webhook, preview, invalid content, enqueue failure). Once queued it
    // returns true whatever Discord answers, and the outbox retries it.
    mockSend.mockResolvedValueOnce(false);

    const res = await nudge(s.match.id);
    expect(res.error).toMatch(/Couldn't post the reminder/);
    expect(
      await prisma.setting.findUnique({
        where: {
          key: checkinNudgeKey(s.match.id, s.home.id, s.match.scheduleRevision),
        },
      }),
    ).toBeNull();

    expect((await nudge(s.match.id)).message).toBeTruthy();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("gives the window back when building or sending the post throws", async () => {
    const s = await setup();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));
    mockSend.mockRejectedValueOnce(new Error("socket hang up"));

    const res = await nudge(s.match.id);
    expect(res.error).toBeTruthy();
    expect(
      await prisma.setting.findUnique({
        where: {
          key: checkinNudgeKey(s.match.id, s.home.id, s.match.scheduleRevision),
        },
      }),
    ).toBeNull();
    expect((await nudge(s.match.id)).message).toBeTruthy();
  });

  it("refuses when everyone else on the side has answered", async () => {
    const s = await setup();
    await prisma.matchAvailability.createMany({
      data: [s.linked.id, s.unlinked.id].map((userId) => ({
        matchId: s.match.id,
        userId,
        status: "OUT",
        scheduleRevision: s.match.scheduleRevision,
      })),
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));

    const res = await nudge(s.match.id);
    expect(res.error).toMatch(/already answered/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("counts an answer about an older kickoff as no answer", async () => {
    const s = await setup();
    await prisma.match.update({
      where: { id: s.match.id },
      data: { scheduleRevision: { increment: 1 } },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));

    const res = await nudge(s.match.id);
    expect(res.message).toMatch(/the 3 players who haven't answered/);
    expect(lastSend().content).toContain("Answered Annie");
  });

  it("pings the standin covering a seat, not the covered player", async () => {
    const s = await setup();
    const standin = await makeUser("Standin Sam");
    await prisma.standinAssignment.create({
      data: {
        matchId: s.match.id,
        teamId: s.home.id,
        standinUserId: standin.id,
        replacingUserId: s.linked.id,
      },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));

    await nudge(s.match.id);
    const { content, mentions } = lastSend();
    expect(content).toContain("Standin Sam");
    expect(content).not.toContain(`<@${LINKED_ID}>`);
    expect(mentions).toBeUndefined();
  });

  it("refuses once check-in is closed, and burns nothing", async () => {
    const s = await setup();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));
    const cases: [Parameters<typeof prisma.match.update>[0]["data"], RegExp][] = [
      [{ status: MATCH_STATUS.LIVE }, /series has started/],
      [
        { status: MATCH_STATUS.COMPLETED, homeScore: 2, awayScore: 0 },
        /already finished/,
      ],
      [
        { status: MATCH_STATUS.SCHEDULED, scheduledAt: null },
        /does not have a kickoff/,
      ],
      [
        {
          status: MATCH_STATUS.SCHEDULED,
          scheduledAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
        /kickoff has passed/,
      ],
    ];
    for (const [data, message] of cases) {
      await prisma.match.update({ where: { id: s.match.id }, data });
      const res = await nudge(s.match.id);
      expect(res.error).toMatch(message);
    }
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      await prisma.setting.count({
        where: { key: { startsWith: `checkinNudge:${s.match.id}:` } },
      }),
    ).toBe(0);
  });

  it("refuses a fixture from an archived season", async () => {
    const s = await setup();
    await prisma.season.update({
      where: { id: s.season.id },
      data: { isActive: false },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(s.homeCaptain));

    const res = await nudge(s.match.id);
    expect(res.error).toMatch(/archived season/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request", async () => {
    const s = await setup();
    vi.mocked(requireUser).mockRejectedValue(new Error("unauthenticated"));
    const res = await nudge(s.match.id);
    expect(res.error).toMatch(/sign in/i);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("checkinNudgeToast", () => {
  it("says who was reminded and who couldn't be pinged", () => {
    expect(checkinNudgeToast(1, 1)).toBe(
      "Posted a check-in reminder in Discord for the 1 player who hasn't answered.",
    );
    expect(checkinNudgeToast(1, 0)).toMatch(
      /They haven't linked Discord, so they were named without a ping\.$/,
    );
    expect(checkinNudgeToast(3, 0)).toMatch(/None of them have linked Discord/);
    expect(checkinNudgeToast(3, 1)).toMatch(/2 of them haven't linked Discord/);
  });
});
