import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, SEASON_STATUS } from "@/lib/constants";
import { maybeAnnounceUpcomingWeek } from "@/lib/reminder-service";
import { makeSeason, makeTeam } from "./factories";

// Keep the formatters real; stub the webhook lookup + the network send.
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

  it("stays quiet outside the window, off-season, and without a webhook", async () => {
    const far = await setupWeek(48); // kickoff too far out
    expect(await maybeAnnounceUpcomingWeek(far.season)).toBe(false);

    const off = await setupWeek(4, SEASON_STATUS.SIGNUPS);
    expect(await maybeAnnounceUpcomingWeek(off.season)).toBe(false);

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
});
