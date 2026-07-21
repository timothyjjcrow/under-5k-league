import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { announceSeriesResultOnce } from "@/lib/match-import";
import { maybeAnnounceWeekHonors } from "@/lib/honors-service";
import { maybeAnnounceUpcomingWeek } from "@/lib/reminder-service";
import { runResultSync } from "@/lib/result-sync-service";
import { makeSeason, makeTeam, makeUser } from "./factories";

// A Discord blip (timeout, 5xx, revoked webhook) must never permanently eat a
// once-only announcement: every claim-then-send path releases its idempotency
// marker when the send fails, so the next trigger retries — and a successful
// send still can't double-post.

vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return {
    ...actual,
    getWebhookUrl: vi.fn(async () => "https://discord.test/hook"),
    sendDiscordMessage: vi.fn(async () => true),
  };
});
import { getWebhookUrl, sendDiscordMessage } from "@/lib/discord";
const mockSend = vi.mocked(sendDiscordMessage);
const mockHook = vi.mocked(getWebhookUrl);

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue(true);
  mockHook.mockReset();
  mockHook.mockResolvedValue("https://discord.test/hook");
});

const markerCount = (prefix: string) =>
  prisma.setting.count({ where: { key: { startsWith: prefix } } });

describe("series-result announcement retry", () => {
  async function setupDecidedMatch() {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: home.id,
        awayTeamId: away.id,
        homeScore: 2,
        awayScore: 0,
        status: MATCH_STATUS.COMPLETED,
        winnerTeamId: home.id,
      },
    });
    return {
      id: match.id,
      homeTeamId: home.id,
      awayTeamId: away.id,
      homeScore: 2,
      awayScore: 0,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
    };
  }

  it("flags the marker failed on a bad send; a retry claims it exactly once", async () => {
    const match = await setupDecidedMatch();
    mockSend.mockResolvedValue(false); // Discord down

    expect(await announceSeriesResultOnce(match)).toBe(false);
    const failed = await prisma.setting.findUnique({
      where: { key: `resultAnnounced:${match.id}` },
    });
    expect(failed?.value).toMatch(/^failed:/); // flagged, not lost

    mockSend.mockResolvedValue(true); // Discord back
    expect(await announceSeriesResultOnce(match)).toBe(true);
    const sent = await prisma.setting.findUnique({
      where: { key: `resultAnnounced:${match.id}` },
    });
    expect(sent?.value).not.toMatch(/^failed:/);
    // …and it stays once-only afterwards.
    expect(await announceSeriesResultOnce(match)).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(2); // 1 failed + 1 success
  });

  it("the sync sweep retries a failed announcement — no import needed", async () => {
    const match = await setupDecidedMatch();
    mockSend.mockResolvedValue(false);
    await announceSeriesResultOnce(match); // marker now failed:

    // Discord recovers; the next sitewide sync ping drains the retry queue —
    // crucial because the run whose send failed is the run that COMPLETED
    // the match, so no import path would ever call announce again.
    mockSend.mockResolvedValue(true);
    await runResultSync();

    const marker = await prisma.setting.findUnique({
      where: { key: `resultAnnounced:${match.id}` },
    });
    expect(marker?.value).not.toMatch(/^failed:/);
    const messages = mockSend.mock.calls.map((c) => c[0]);
    expect(messages.filter((s) => s.startsWith("⚔️"))).toHaveLength(2); // fail + retry
    // A second sweep has nothing to do.
    await prisma.setting.deleteMany({
      where: { key: "announceRetryAt" }, // un-throttle
    });
    await runResultSync();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("never burns the marker when no webhook is configured", async () => {
    const match = await setupDecidedMatch();
    mockHook.mockResolvedValue(null);
    expect(await announceSeriesResultOnce(match)).toBe(false);
    expect(await markerCount(`resultAnnounced:${match.id}`)).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();

    // Webhook wired up later → the announcement still goes out.
    mockHook.mockResolvedValue("https://discord.test/hook");
    expect(await announceSeriesResultOnce(match)).toBe(true);
  });
});

describe("weekly-honors announcement retry", () => {
  async function setupCompletedWeek() {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const star = await makeUser("Star Carry");
    await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: home.id,
        userId: star.id,
        isCaptain: false,
        price: 10,
      },
    });
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: home.id,
        awayTeamId: away.id,
        homeScore: 1,
        awayScore: 0,
        status: MATCH_STATUS.COMPLETED,
        winnerTeamId: home.id,
      },
    });
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: `${Date.now()}`,
        radiantWin: true,
        winnerTeamId: home.id,
        players: JSON.stringify([
          {
            userId: star.id,
            teamId: home.id,
            isRadiant: true,
            heroId: 1,
            kills: 10,
            deaths: 1,
            assists: 8,
            gpm: 550,
            lastHits: 200,
          },
        ]),
      },
    });
    return season;
  }

  it("retries after a failed send, then stays once-only", async () => {
    const season = await setupCompletedWeek();
    mockSend.mockResolvedValue(false);

    await maybeAnnounceWeekHonors(season.id, 1);
    expect(await markerCount(`honorsAnnounced:${season.id}:1`)).toBe(0);

    mockSend.mockResolvedValue(true);
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(await markerCount(`honorsAnnounced:${season.id}:1`)).toBe(1);
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(mockSend).toHaveBeenCalledTimes(2); // 1 failed + 1 success

    // No webhook → quiet, marker untouched (nothing burned).
    await prisma.setting.deleteMany({
      where: { key: `honorsAnnounced:${season.id}:1` },
    });
    mockHook.mockResolvedValue(null);
    await maybeAnnounceWeekHonors(season.id, 1);
    expect(await markerCount(`honorsAnnounced:${season.id}:1`)).toBe(0);
  });
});

describe("week-reminder announcement retry", () => {
  it("releases the week marker on a failed send so the next load retries", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: home.id,
        awayTeamId: away.id,
        scheduledAt: new Date(Date.now() + 4 * 3600_000),
      },
    });

    mockSend.mockResolvedValue(false);
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(false);
    expect(await markerCount(`weekReminder:${season.id}:1`)).toBe(0);

    mockSend.mockResolvedValue(true);
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    expect(await markerCount(`weekReminder:${season.id}:1`)).toBe(1);
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(false); // once-only
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
