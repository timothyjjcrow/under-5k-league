import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// When automatic import can't find a fixture's games, the worker asks the two
// captains to report them: once per fixture and kickoff, never anyone else.
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => "https://discord.test/hook"),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { getWebhookUrl, sendDiscordMessage } from "@/lib/discord";
import { maybeNudgeMissingResults } from "@/lib/result-nudge-service";
import { RESULT_NUDGE } from "@/lib/result-nudge";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { AUTO_SYNC, MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { resultNudgeKey } from "@/lib/settings";
import { makeSeason, makeTeam, raceN } from "./factories";

const mockSend = vi.mocked(sendDiscordMessage);
const mockHook = vi.mocked(getWebhookUrl);
const HOUR = 3_600_000;
let snowflake = 0;
const nextSnowflake = () => `9000000000${String((snowflake += 1)).padStart(8, "0")}`;

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue(true);
  mockHook.mockReset();
  mockHook.mockResolvedValue("https://discord.test/hook");
});

afterEach(() => setRaceHook(null));

/** A season with two teams whose captains linked Discord, and one fixture. */
async function setup(opts: {
  kickoffHoursAgo: number | null;
  seasonStatus?: string;
  phase?: string;
  status?: string;
  bestOf?: number;
  homeScore?: number;
}) {
  const season = await makeSeason({
    status: opts.seasonStatus ?? SEASON_STATUS.REGULAR_SEASON,
  });
  const home = await makeTeam(season.id, "Alpha", 0);
  const away = await makeTeam(season.id, "Delta", 1);
  await prisma.user.update({
    where: { id: home.captainId! },
    data: { discordId: nextSnowflake() },
  });
  await prisma.user.update({
    where: { id: away.captainId! },
    data: { discordId: nextSnowflake() },
  });
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 2,
      phase: opts.phase ?? MATCH_PHASE.REGULAR,
      homeTeamId: home.id,
      awayTeamId: away.id,
      bestOf: opts.bestOf ?? 1,
      status: opts.status ?? MATCH_STATUS.SCHEDULED,
      homeScore: opts.homeScore ?? 0,
      scheduledAt:
        opts.kickoffHoursAgo === null
          ? null
          : new Date(Date.now() - opts.kickoffHoursAgo * HOUR),
    },
  });
  return { season, home, away, match };
}

const markerOf = (matchId: string, revision = 0) =>
  prisma.setting.findUnique({ where: { key: resultNudgeKey(matchId, revision) } });

describe("result nudge — the captains hear when a fixture's games can't be found", () => {
  it("asks both captains once, and nobody else", async () => {
    const { match, home, away } = await setup({ kickoffHoursAgo: 5 });
    const captains = await prisma.user.findMany({
      where: { id: { in: [home.captainId!, away.captainId!] } },
      select: { discordId: true },
    });

    const queued = await raceN(4, () => maybeNudgeMissingResults());
    expect(queued.reduce((a, b) => a + b, 0)).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const [content, mentions, options] = mockSend.mock.calls[0]!;
    expect(content).toContain(
      "We couldn't find the games for **Alpha** vs **Delta** (Week 2).",
    );
    expect(content).toContain(`/matches/${match.id}>`);
    expect(mentions?.users?.slice().sort()).toEqual(
      captains.map((c) => c.discordId).sort(),
    );
    expect(mentions?.users).toHaveLength(2);
    expect(mentions?.roles).toBeUndefined();
    expect(options?.dedupeKey).toMatch(/^nudge:/);
    expect(options?.marker?.key).toBe(resultNudgeKey(match.id, 0));
    const expires = options?.expiresAt?.getTime() ?? 0;
    expect(expires).toBeGreaterThan(
      Date.now() + (RESULT_NUDGE.EXPIRES_AFTER_HOURS - 1) * HOUR,
    );
    expect((await markerOf(match.id))?.value).toMatch(/^sent:v2:/);

    // A later pass says nothing more about the same kickoff.
    expect(await maybeNudgeMissingResults()).toBe(0);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("names the score a part-played series is stuck at", async () => {
    const { match } = await setup({
      kickoffHoursAgo: 6,
      status: MATCH_STATUS.LIVE,
      bestOf: 3,
      homeScore: 1,
    });
    const startMs = Date.now() - 6 * HOUR;
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: "7000000001",
        radiantWin: true,
        startTime: Math.floor(startMs / 1000),
        durationSecs: 40 * 60,
        players: "[]",
      },
    });

    expect(await maybeNudgeMissingResults()).toBe(1);
    const [content] = mockSend.mock.calls[0]!;
    expect(content).toContain("**Alpha** vs **Delta** (Week 2) is stuck at 1–0");
  });

  it("stays quiet while a part-played series is still being played", async () => {
    const { match } = await setup({
      kickoffHoursAgo: 5,
      status: MATCH_STATUS.LIVE,
      bestOf: 3,
      homeScore: 1,
    });
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: "7000000002",
        radiantWin: true,
        startTime: Math.floor((Date.now() - HOUR) / 1000),
        durationSecs: 40 * 60,
        players: "[]",
      },
    });
    expect(await maybeNudgeMissingResults()).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
    expect(await markerOf(match.id)).toBeNull();
  });

  it("leaves alone what isn't the captains' to report", async () => {
    const early = await setup({
      kickoffHoursAgo: RESULT_NUDGE.HOURS_AFTER_KICKOFF - 0.5,
    });
    const stale = await setup({ kickoffHoursAgo: AUTO_SYNC.WINDOW_HOURS + 1 });
    const done = await setup({
      kickoffHoursAgo: 5,
      status: MATCH_STATUS.COMPLETED,
    });
    const unscheduled = await setup({ kickoffHoursAgo: null });
    const ids = [early, stale, done, unscheduled].map((s) => s.match.id);
    // Only one season can be active; each setup made a new active one, so
    // run the check once per fixture's season.
    for (const s of [early, stale, done, unscheduled]) {
      await prisma.season.updateMany({ data: { isActive: false } });
      await prisma.season.update({
        where: { id: s.season.id },
        data: { isActive: true },
      });
      expect(await maybeNudgeMissingResults()).toBe(0);
    }
    expect(mockSend).not.toHaveBeenCalled();
    for (const id of ids) expect(await markerOf(id)).toBeNull();
  });

  it("never nudges about a regular week left open once the playoffs start", async () => {
    const { match } = await setup({
      kickoffHoursAgo: 5,
      seasonStatus: SEASON_STATUS.PLAYOFFS,
    });
    expect(await maybeNudgeMissingResults()).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
    expect(await markerOf(match.id)).toBeNull();
  });

  it("burns no marker when no webhook is configured", async () => {
    mockHook.mockResolvedValue(null);
    const { match } = await setup({ kickoffHoursAgo: 5 });
    expect(await maybeNudgeMissingResults()).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
    expect(await markerOf(match.id)).toBeNull();
  });

  it("marks a post that could not be queued as failed, and the next pass tries again", async () => {
    const { match } = await setup({ kickoffHoursAgo: 5 });
    mockSend.mockResolvedValueOnce(false);
    expect(await maybeNudgeMissingResults()).toBe(0);
    expect((await markerOf(match.id))?.value).toMatch(/^failed:v2:/);

    expect(await maybeNudgeMissingResults()).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect((await markerOf(match.id))?.value).toMatch(/^sent:v2:/);
    // The retry keeps the event identity, so the outbox can dedupe it.
    const first = mockSend.mock.calls[0]![2]?.dedupeKey;
    expect(mockSend.mock.calls[1]![2]?.dedupeKey).toBe(first);
  });

  it("releases its claim when the result lands between the probe and the post", async () => {
    const { match } = await setup({ kickoffHoursAgo: 5 });
    let fired = false;
    setRaceHook(
      onceAt("resultNudge.nudgeFixture.afterClaim", async () => {
        fired = true;
        await prisma.match.update({
          where: { id: match.id },
          data: { status: MATCH_STATUS.COMPLETED, homeScore: 1 },
        });
      }),
    );
    expect(await maybeNudgeMissingResults()).toBe(0);
    expect(fired).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
    expect(await markerOf(match.id)).toBeNull();
  });

  it("asks again for a fixture moved to a new night", async () => {
    const { match } = await setup({ kickoffHoursAgo: 5 });
    expect(await maybeNudgeMissingResults()).toBe(1);

    await prisma.match.update({
      where: { id: match.id },
      data: {
        scheduledAt: new Date(Date.now() - 4.5 * HOUR),
        scheduleRevision: { increment: 1 },
      },
    });
    expect(await maybeNudgeMissingResults()).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect((await markerOf(match.id, 1))?.value).toMatch(/^sent:v2:/);
  });

  it("stops when the worker's budget runs out", async () => {
    await setup({ kickoffHoursAgo: 5 });
    expect(await maybeNudgeMissingResults({ shouldContinue: () => false })).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
