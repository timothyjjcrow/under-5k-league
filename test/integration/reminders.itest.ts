import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import { DRAFT_STATUS, MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { maybeAnnounceUpcomingWeek } from "@/lib/reminder-service";
import { makeSeason, makeTeam, makeUser } from "./factories";
import { generateSchedule, setMatchTime } from "@/app/actions/admin-schedule-results";
import {
  proposeReschedule,
  respondReschedule,
} from "@/lib/reschedule-service";
import { weekReminderKey } from "@/lib/settings";

// setMatchTime is a server action: stub auth and cache invalidation as
// admin-claims.itest.ts does.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({
    id: "test-admin",
    name: "Test administrator",
    role: "ADMIN",
    steamId: "76561198000000000",
    avatar: null,
  })),
  requireUser: vi.fn(),
}));

// Keep the formatters real; stub the webhook lookup + the network send.
vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return {
    ...actual,
    getWebhookUrl: vi.fn(async () => "https://discord.test/hook"),
    sendDiscordMessage: vi.fn(async () => true),
  };
});
import {
  getWebhookUrl,
  materializeAllowedMentions,
  sendDiscordMessage,
} from "@/lib/discord";

const mockSend = vi.mocked(sendDiscordMessage);
const mockHook = vi.mocked(getWebhookUrl);

beforeEach(() => {
  mockSend.mockClear();
  mockHook.mockReset();
  mockHook.mockResolvedValue("https://discord.test/hook");
});

async function setupWeek(
  offsetHours: number,
  status: string = SEASON_STATUS.REGULAR_SEASON,
) {
  const season = await makeSeason({ status });
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: home.id,
      awayTeamId: away.id,
      scheduledAt: new Date(Date.now() + offsetHours * 3600_000),
    },
  });
  return { season, home, away, match };
}

describe("week reminder (integration)", () => {
  it("announces the upcoming week once — concurrent loads can't double-send", async () => {
    const { season } = await setupWeek(4);

    // Two page loads race: the atomic Setting create lets exactly one through.
    const results = await Promise.all([
      maybeAnnounceUpcomingWeek(season),
      maybeAnnounceUpcomingWeek(season),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toContain("Week 1");
    expect(mockSend.mock.calls[0][0]).toContain("<t:");
    // Kickoff is ahead, so pick'em is still open and the post says so.
    expect(mockSend.mock.calls[0][0]).toContain("Pick'em closes at kickoff");

    // And it stays quiet forever after (marker persisted).
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("leaves pick'em out of a reminder sent after kickoff", async () => {
    const { season } = await setupWeek(-1);
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    expect(mockSend.mock.calls[0][0]).not.toContain("Pick'em");
  });

  it("announces separate kickoff clusters in one numbered week", async () => {
    const { season } = await setupWeek(4);
    const lateHome = await makeTeam(season.id, "Late Home", 2);
    const lateAway = await makeTeam(season.id, "Late Away", 3);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: lateHome.id,
        awayTeamId: lateAway.id,
        scheduledAt: new Date(Date.now() + 8 * 3600_000),
      },
    });

    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(
      await prisma.setting.count({
        where: { key: { startsWith: `weekReminder:${season.id}:1:` } },
      }),
    ).toBe(2);
  });

  it("states the kickoff time and names the playoff round", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.PLAYOFFS });
    const teams = await Promise.all(
      ["Alpha", "Bravo", "Charlie", "Delta"].map((n, i) =>
        makeTeam(season.id, n, i),
      ),
    );
    const kickoff = new Date(Math.floor((Date.now() + 4 * 3600_000) / 1000) * 1000);
    for (const [i, slot] of ["R0M0", "R0M1"].entries()) {
      await prisma.match.create({
        data: {
          seasonId: season.id,
          week: 6,
          phase: MATCH_PHASE.PLAYOFF,
          bracketSlot: slot,
          homeTeamId: teams[i * 2].id,
          awayTeamId: teams[i * 2 + 1].id,
          scheduledAt: kickoff,
        },
      });
    }

    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    const lines = mockSend.mock.calls[0][0].split("\n");
    const t = kickoff.getTime() / 1000;
    expect(lines[0]).toBe("⏰ **Semifinals coming up — check in!**");
    expect(lines[1]).toBe(`Kickoff: <t:${t}:F> (<t:${t}:R>)`);
    expect(lines.filter((l) => l.startsWith("🆚"))).toHaveLength(2);
    // No bye line in the playoffs.
    expect(lines.join("\n")).not.toContain("Bye");
  });

  it("names the team with a bye, and only a team that sits the whole week out", async () => {
    const { season } = await setupWeek(4);
    await makeTeam(season.id, "Rested", 2);
    const gone = await makeTeam(season.id, "Gone", 3);
    await prisma.team.update({ where: { id: gone.id }, data: { withdrawn: true } });
    // Plays this week, on a later night: not a bye.
    const late = await makeTeam(season.id, "Late", 4);
    const lateAway = await makeTeam(season.id, "Late Away", 5);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: late.id,
        awayTeamId: lateAway.id,
        scheduledAt: new Date(Date.now() + 30 * 3600_000),
      },
    });

    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    const msg = mockSend.mock.calls[0][0];
    expect(msg).toContain("💤 Bye: **Rested** — no match this week.");
    expect(msg).not.toMatch(/Bye:.*(Gone|Late)/);
  });

  it("stays quiet outside the window, off-season, and without a webhook", async () => {
    const far = await setupWeek(48); // kickoff too far out
    expect(await maybeAnnounceUpcomingWeek(far.season)).toBe(false);
    await prisma.season.update({
      where: { id: far.season.id },
      data: { isActive: false },
    });

    const off = await setupWeek(4, SEASON_STATUS.SIGNUPS);
    expect(await maybeAnnounceUpcomingWeek(off.season)).toBe(false);
    await prisma.season.update({
      where: { id: off.season.id },
      data: { isActive: false },
    });

    mockHook.mockResolvedValue(null); // no Discord configured
    const bare = await setupWeek(4);
    expect(await maybeAnnounceUpcomingWeek(bare.season)).toBe(false);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("skips completed matches and re-announces nothing for played weeks", async () => {
    const { season, match } = await setupWeek(4);
    await prisma.match.update({
      where: { id: match.id },
      data: { status: "COMPLETED", homeScore: 1, awayScore: 0 },
    });
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never calls an already-live series upcoming", async () => {
    const { season, match } = await setupWeek(4);
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.LIVE, homeScore: 1 },
    });

    expect(await maybeAnnounceUpcomingWeek(season)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      await prisma.setting.count({
        where: { key: { startsWith: `weekReminder:${season.id}:` } },
      }),
    ).toBe(0);
  });
});

describe("week reminder — reaching the people who owe an answer", () => {
  /** Roster `n` players on a team; the first gets a linked Discord account. */
  async function roster(
    seasonId: string,
    teamId: string,
    n: number,
    tag: string,
  ) {
    const users = [];
    for (let i = 0; i < n; i++) {
      const u = await makeUser(`${tag}${i}`);
      if (i === 0) {
        await prisma.user.update({
          where: { id: u.id },
          data: { discordId: `9990000000000000${tag === "H" ? "1" : "2"}` },
        });
      }
      await prisma.teamMember.create({
        data: { seasonId, teamId, userId: u.id, price: 0 },
      });
      users.push(u);
    }
    return users;
  }

  it("mentions the un-RSVP'd by id and passes an allowlist of exactly them", async () => {
    const { season, home, away, match } = await setupWeek(4);
    const hs = await roster(season.id, home.id, 3, "H");
    await roster(season.id, away.id, 3, "A");
    // One home player checks in — they must NOT be pinged.
    await prisma.matchAvailability.create({
      data: { matchId: match.id, userId: hs[0].id, status: "IN" },
    });

    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    const [content, mentions] = mockSend.mock.calls[0];

    expect(content).toContain("Still waiting on:");
    // The player who answered is not in the ping list...
    expect(mentions?.users ?? []).not.toContain("99900000000000001");
    // ...but the away team's linked player, who hasn't, is.
    expect(mentions?.users ?? []).toContain("99900000000000002");
    // Unlinked players are still named so a captain knows who to chase.
    expect(content).toContain("H1");
  });

  it("says nothing about waiting when everyone has answered", async () => {
    const { season, home, away, match } = await setupWeek(4);
    const hs = await roster(season.id, home.id, 2, "H");
    const as = await roster(season.id, away.id, 2, "A");
    for (const u of [...hs, ...as]) {
      await prisma.matchAvailability.create({
        data: { matchId: match.id, userId: u.id, status: "IN" },
      });
    }
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    const [content, mentions] = mockSend.mock.calls[0];
    expect(content).not.toContain("Still waiting");
    expect(mentions?.users ?? []).toHaveLength(0);
  });

  it("pings nobody when no one has linked, and still names them", async () => {
    const { season, home, away } = await setupWeek(4);
    for (let i = 0; i < 2; i++) {
      const u = await makeUser(`NL${i}`);
      await prisma.teamMember.create({
        data: {
          seasonId: season.id,
          teamId: i === 0 ? home.id : away.id,
          userId: u.id,
          price: 0,
        },
      });
    }
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    const [content, mentions] = mockSend.mock.calls[0];
    expect(mentions?.users ?? []).toHaveLength(0);
    expect(content).toContain("NL0");
    expect(content).not.toContain("<@null>");
  });

  it("splits a 32-team kickoff into parts that list every fixture and ping every waiter", async () => {
    const { season, home, away, match } = await setupWeek(4);
    const kickoff = match.scheduledAt!;
    const teams = [home, away];
    for (let i = 2; i < 32; i += 1) {
      teams.push(
        await makeTeam(
          season.id,
          `League Team ${String(i + 1).padStart(2, "0")} Long Name`,
          i,
        ),
      );
    }
    const fixtures = [{ matchId: match.id, teamIndexes: [0, 1] }];
    for (let i = 2; i < teams.length; i += 2) {
      const fixture = await prisma.match.create({
        data: {
          seasonId: season.id,
          week: 1,
          phase: MATCH_PHASE.REGULAR,
          homeTeamId: teams[i].id,
          awayTeamId: teams[i + 1].id,
          scheduledAt: kickoff,
        },
      });
      fixtures.push({ matchId: fixture.id, teamIndexes: [i, i + 1] });
    }

    const discordIds: string[] = [];
    for (let i = 0; i < teams.length; i += 1) {
      const user = await makeUser(
        `Waiting Player ${String(i + 1).padStart(2, "0")}`,
      );
      const discordId = (
        BigInt("800000000000000000") + BigInt(i)
      ).toString();
      discordIds.push(discordId);
      await prisma.user.update({
        where: { id: user.id },
        data: { discordId },
      });
      await prisma.teamMember.create({
        data: {
          seasonId: season.id,
          teamId: teams[i].id,
          userId: user.id,
          price: 0,
        },
      });
    }

    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    const calls = mockSend.mock.calls;
    // One post used to carry part of the slate and summarize the rest.
    expect(calls.length).toBeGreaterThan(1);
    const [, , firstOptions] = calls[0];
    calls.forEach(([content, mentions, options], index) => {
      const delivered = materializeAllowedMentions(content, mentions);
      // Each part allowlists exactly the waiters it shows, within the limits.
      expect(delivered).toBe(content);
      expect(delivered.length).toBeLessThanOrEqual(2_000);
      const visibleIds = [...content.matchAll(/<@(\d{17,20})>/g)].map(
        (item) => item[1],
      );
      expect(new Set(mentions?.users ?? [])).toEqual(new Set(visibleIds));
      // One claim for every part; each part its own dedupe key.
      expect(options?.marker).toEqual({
        key: expect.stringMatching(`^weekReminder:${season.id}:1:`),
        eventId: expect.any(String),
      });
      expect(options?.marker).toEqual(firstOptions?.marker);
      expect(options?.expiresAt).toEqual(firstOptions?.expiresAt);
      expect(options?.dedupeKey).toBe(
        index === 0
          ? firstOptions?.dedupeKey
          : `${firstOptions?.dedupeKey}:${index + 1}`,
      );
    });
    const all = calls.map(([content]) => content).join("\n");
    expect(all).not.toMatch(/more fixtures?/);
    for (const fixture of fixtures) {
      expect(all.split(`/matches/${fixture.matchId}>`).length - 1).toBe(1);
    }
    const pinged = calls.flatMap(([, mentions]) => mentions?.users ?? []);
    expect(pinged).toHaveLength(discordIds.length);
    expect(new Set(pinged)).toEqual(new Set(discordIds));
  });
});

// Tim's call, 2026-10-24: ping on a change, not on the calendar. A side on
// the weekly slot its schedule gave it already knows the kickoff, so the
// reminder names who owes an answer without pinging them.
describe("week reminder — only a kickoff that is news pings", () => {
  let linked = 0;
  /** One linked, unanswered player on `teamId`; returns their snowflake. */
  async function linkedPlayer(seasonId: string, teamId: string, name: string) {
    linked += 1;
    const discordId = `7770000000000${String(linked).padStart(5, "0")}`;
    const user = await makeUser(name);
    await prisma.user.update({ where: { id: user.id }, data: { discordId } });
    await prisma.teamMember.create({
      data: { seasonId, teamId, userId: user.id, price: 0 },
    });
    return discordId;
  }

  /** A played week-1 fixture, so week 2 is not either side's first. */
  async function playedWeek1(
    seasonId: string,
    homeTeamId: string,
    awayTeamId: string,
    forfeit = false,
  ) {
    await prisma.match.create({
      data: {
        seasonId,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        status: MATCH_STATUS.COMPLETED,
        forfeit,
        homeTeamId,
        awayTeamId,
        scheduledAt: new Date(Date.now() - 7 * 864e5),
      },
    });
  }

  async function week2(
    seasonId: string,
    homeTeamId: string,
    awayTeamId: string,
    scheduleRevision = 0,
  ) {
    return prisma.match.create({
      data: {
        seasonId,
        week: 2,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId,
        awayTeamId,
        scheduleRevision,
        scheduledAt: new Date(Date.now() + 4 * 3600_000),
      },
    });
  }

  it("names the unanswered on a routine weekly kickoff without pinging them", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    await linkedPlayer(season.id, home.id, "Routine H");
    await linkedPlayer(season.id, away.id, "Routine A");
    await playedWeek1(season.id, home.id, away.id);
    await week2(season.id, home.id, away.id);

    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    const [content, mentions] = mockSend.mock.calls[0];
    expect(content).toContain("Week 2 matches coming up");
    expect(content).toContain("Still waiting on:");
    expect(content).toContain("Routine H");
    expect(content).toContain("Routine A");
    expect(content).not.toContain("<@");
    expect(mentions).toBeUndefined();
  });

  it("pings a side whose first fixture this is, after a week-1 bye", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const bye = await makeTeam(season.id, "Bye", 2);
    const homeId = await linkedPlayer(season.id, home.id, "Played H");
    const byeId = await linkedPlayer(season.id, bye.id, "Rested B");
    await linkedPlayer(season.id, away.id, "Played A");
    await playedWeek1(season.id, home.id, away.id);
    await week2(season.id, home.id, bye.id);

    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    const [content, mentions] = mockSend.mock.calls[0];
    // The rested team hears about its first opponent and kickoff...
    expect(mentions).toEqual({ users: [byeId] });
    expect(content).toContain(`<@${byeId}>`);
    // ...while the side that already played names its waiter plainly.
    expect(content).toContain("Played H");
    expect(content).not.toContain(`<@${homeId}>`);
  });

  it("pings a side whose only earlier fixture was a forfeit nobody played", async () => {
    // An opponent withdrew before week 1: the forfeit never put a game in
    // front of anyone, so week 2 is still the first one they're told about.
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const homeId = await linkedPlayer(season.id, home.id, "Forfeit H");
    const awayId = await linkedPlayer(season.id, away.id, "Forfeit A");
    await playedWeek1(season.id, home.id, away.id, true);
    await week2(season.id, home.id, away.id);

    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    const [, mentions] = mockSend.mock.calls[0];
    expect(new Set(mentions?.users)).toEqual(new Set([homeId, awayId]));
  });

  it("pings both sides when the kickoff moved", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const homeId = await linkedPlayer(season.id, home.id, "Moved H");
    const awayId = await linkedPlayer(season.id, away.id, "Moved A");
    await playedWeek1(season.id, home.id, away.id);
    await week2(season.id, home.id, away.id, 1);

    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    const [, mentions] = mockSend.mock.calls[0];
    expect(new Set(mentions?.users)).toEqual(new Set([homeId, awayId]));
  });

  it("a regenerated schedule's first week pings everyone again", async () => {
    // Regenerate rebuilds every fixture at revision 0 and posts nothing, even
    // after week 1's reminder went out. Its new week 1 is each side's first
    // fixture, so the reminder that names the new kickoff pings again.
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const team = await makeTeam(season.id, `Regen${i}`, i + 1);
      ids.push(await linkedPlayer(season.id, team.id, `Regen P${i}`));
    }
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });
    const generate = (first: Date) => {
      const fd = new FormData();
      fd.set("expectedActiveSeasonId", season.id);
      fd.set("firstNight", "2026-10-25T20:00");
      fd.set("firstNightTs", String(first.getTime()));
      return generateSchedule({}, fd);
    };
    const pinged = () =>
      new Set(mockSend.mock.calls.flatMap(([, m]) => m?.users ?? []));
    expect((await generate(new Date(Date.now() + 3 * 3600_000)))?.error).toBeUndefined();
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    expect(pinged()).toEqual(new Set(ids));

    // The admin moves the whole schedule two hours later.
    mockSend.mockClear();
    expect((await generate(new Date(Date.now() + 5 * 3600_000)))?.error).toBeUndefined();
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    expect(mockSend.mock.calls[0][0]).toContain("Week 1 matches coming up");
    expect(pinged()).toEqual(new Set(ids));
  });
});

describe("week reminder — the empty-week race releases the claim", () => {
  // The claim is created BEFORE the fixtures fetch, and an auto-sync
  // completion (any page view) can flip the week's sole in-window match
  // COMPLETED in that gap. The empty-fetch branch used to bare-return with
  // the marker held — permanently suppressing the week even if a retime
  // brought fixtures back. It now releases the claim like the failed-send
  // path. No consistent DB state can stage this (probe and fetch share
  // predicates), hence the seam.
  afterEach(() => setRaceHook(null));

  it("releases the marker when the week empties mid-call, and can announce later", async () => {
    const { season, match } = await setupWeek(4);

    let fired = false;
    setRaceHook(
      onceAt("weekReminder.afterClaim", async () => {
        fired = true;
        // The rival commits on its own connection; no transaction is open at
        // the hook point, so this is SQLite-safe (the leaveLeague placement).
        await prisma.match.update({
          where: { id: match.id },
          data: { status: "COMPLETED" },
        });
      }),
    );

    expect(await maybeAnnounceUpcomingWeek(season)).toBe(false);
    expect(fired).toBe(true); // seam reached — not a vacuous pass
    expect(mockSend).not.toHaveBeenCalled();
    const marker = await prisma.setting.findFirst({
      where: { key: { startsWith: `weekReminder:${season.id}:1` } },
    });
    expect(marker).toBeNull(); // claim released, not burned

    // The week comes back (reopened / retimed) → the reminder still fires.
    setRaceHook(null);
    await prisma.match.update({
      where: { id: match.id },
      data: { status: "SCHEDULED" },
    });
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe("week reminder — retiming one fixture of a kickoff cluster", () => {
  // Two fixtures share week 1's kickoff and the reminder has posted. Moving
  // ONE of them used to release every marker of the week, so the next pass
  // re-posted the unmoved fixture's reminder and re-pinged its players.
  async function sharedKickoff() {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const [moverHome, moverAway, stayerHome, stayerAway] = await Promise.all(
      ["Mover Home", "Mover Away", "Stayer Home", "Stayer Away"].map(
        (name, i) => makeTeam(season.id, name, i),
      ),
    );
    const kickoff = new Date(Math.floor((Date.now() + 4 * 3600_000) / 60_000) * 60_000);
    const fixture = (homeTeamId: string, awayTeamId: string) =>
      prisma.match.create({
        data: {
          seasonId: season.id,
          week: 1,
          phase: MATCH_PHASE.REGULAR,
          homeTeamId,
          awayTeamId,
          scheduledAt: kickoff,
        },
      });
    const mover = await fixture(moverHome.id, moverAway.id);
    const stayer = await fixture(stayerHome.id, stayerAway.id);
    return { season, kickoff, mover, stayer, moverHome, moverAway };
  }
  const reminders = () =>
    mockSend.mock.calls
      .map((call) => call[0])
      .filter((content) => content.startsWith("⏰"));

  it.each(["Set time", "ready-check lock"])(
    "%s: the unmoved fixture is not reminded twice; the moved one is reminded at its new kickoff",
    async (path) => {
      const { season, kickoff, mover, stayer, moverHome, moverAway } =
        await sharedKickoff();
      expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
      expect(reminders()).toHaveLength(1);
      expect(reminders()[0]).toContain("Stayer Home");
      expect(reminders()[0]).toContain("Mover Home");

      const moved = new Date(kickoff.getTime() + 5 * 3600_000);
      if (path === "Set time") {
        const fd = new FormData();
        fd.set("expectedActiveSeasonId", season.id);
        fd.set("matchId", mover.id);
        fd.set("scheduledAt", moved.toISOString());
        fd.set("scheduledAtTs", String(moved.getTime()));
        expect(await setMatchTime({}, fd)).not.toHaveProperty("error");
      } else {
        await proposeReschedule(moverHome.captainId, mover.id, moved);
        const request = await prisma.rescheduleRequest.findFirstOrThrow({
          where: { matchId: mover.id, status: "PENDING" },
        });
        await respondReschedule(moverAway.captainId, request.id, true);
      }
      expect(
        (await prisma.match.findUniqueOrThrow({ where: { id: mover.id } }))
          .scheduledAt?.getTime(),
      ).toBe(moved.getTime());
      // The stayer still kicks off at the old time, so its marker stands.
      expect(
        await prisma.setting.findUnique({
          where: { key: weekReminderKey(season.id, 1, kickoff.getTime()) },
        }),
      ).not.toBeNull();

      // The next passes remind the moved fixture once, and only it.
      expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
      expect(await maybeAnnounceUpcomingWeek(season)).toBe(false);
      expect(reminders()).toHaveLength(2);
      expect(reminders()[1]).toContain("Mover Home");
      expect(reminders()[1]).not.toContain("Stayer Home");
      expect(
        (await prisma.match.findUniqueOrThrow({ where: { id: stayer.id } }))
          .scheduledAt?.getTime(),
      ).toBe(kickoff.getTime());
    },
  );

  it("releases the old kickoff's marker once nothing kicks off there", async () => {
    const { season, kickoff, mover, stayer } = await sharedKickoff();
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    const oldKey = weekReminderKey(season.id, 1, kickoff.getTime());
    for (const [index, match] of [mover, stayer].entries()) {
      const moved = new Date(kickoff.getTime() + (index + 5) * 3600_000);
      const fd = new FormData();
      fd.set("expectedActiveSeasonId", season.id);
      fd.set("matchId", match.id);
      fd.set("scheduledAt", moved.toISOString());
      fd.set("scheduledAtTs", String(moved.getTime()));
      expect(await setMatchTime({}, fd)).not.toHaveProperty("error");
      const marker = await prisma.setting.findUnique({ where: { key: oldKey } });
      // First move: the stayer still sits there. Second: the kickoff is empty.
      if (index === 0) expect(marker).not.toBeNull();
      else expect(marker).toBeNull();
    }
  });
});
