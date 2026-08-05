import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { maybeAnnounceUpcomingWeek } from "@/lib/reminder-service";
import { makeSeason, makeTeam, makeUser } from "./factories";

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

    // And it stays quiet forever after (marker persisted).
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(1);
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

  it("keeps a 32-team kickoff deliverable and never allowlists hidden waiters", async () => {
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
    for (let i = 2; i < teams.length; i += 2) {
      await prisma.match.create({
        data: {
          seasonId: season.id,
          week: 1,
          phase: MATCH_PHASE.REGULAR,
          homeTeamId: teams[i].id,
          awayTeamId: teams[i + 1].id,
          scheduledAt: kickoff,
        },
      });
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
    const [content, mentions, options] = mockSend.mock.calls[0];
    const delivered = materializeAllowedMentions(content, mentions);
    expect(delivered).toBe(content);
    expect(delivered.length).toBeLessThanOrEqual(2_000);

    const visibleIds = [...content.matchAll(/<@(\d{17,20})>/g)].map(
      (item) => item[1],
    );
    expect(new Set(mentions?.users ?? [])).toEqual(new Set(visibleIds));
    const shownFixtures = content
      .split("\n")
      .filter((line) => line.startsWith("🆚")).length;
    const summary = content.match(/…and (\d+) more fixtures? at this kickoff/);
    expect(summary).not.toBeNull();
    expect(shownFixtures + Number(summary?.[1])).toBe(16);
    expect(content).toContain("/schedule>");
    expect(mentions?.users ?? []).not.toContain(discordIds.at(-1));
    expect(options?.marker).toEqual({
      key: expect.stringMatching(`^weekReminder:${season.id}:1:`),
      eventId: expect.any(String),
    });
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
