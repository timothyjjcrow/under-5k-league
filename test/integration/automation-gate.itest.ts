import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAutomationGateSnapshot } from "@/lib/automation-gate";
import { prisma } from "@/lib/prisma";
import {
  ANNOUNCE_FAILED_PREFIX,
  championAnnouncedKey,
  honorsAnnouncedKey,
  honorsAnnouncedPrefix,
  resultAnnouncedKey,
  SETTING_KEYS,
  weekReminderKey,
  weekReminderPrefix,
} from "@/lib/settings";
import { makeSeason, makeTeam } from "./factories";

const NOW = Date.parse("2026-09-05T20:00:00.000Z");

beforeEach(async () => {
  vi.stubEnv("DISCORD_WEBHOOK_URL", "");
  await prisma.automationRunState.create({
    data: {
      key: "league-maintenance",
      lastStatus: "SUCCEEDED",
      lastFinishedAt: new Date(NOW),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("automation gate database reads", () => {
  it("reads current season markers without old kickoff/removed-week history and keeps the same deadline", async () => {
    const season = await makeSeason({ status: "REGULAR_SEASON" });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const completed = await prisma.match.create({
      data: {
        seasonId: season.id,
        homeTeamId: home.id,
        awayTeamId: away.id,
        week: 1,
        status: "COMPLETED",
        completedAt: new Date(NOW),
      },
    });
    const kickoff = NOW + 20 * 60 * 60_000;
    const scheduled = await prisma.match.create({
      data: {
        seasonId: season.id,
        homeTeamId: home.id,
        awayTeamId: away.id,
        week: 2,
        scheduledAt: new Date(kickoff),
      },
    });
    const currentKeys = [
      resultAnnouncedKey(completed.id),
      honorsAnnouncedKey(season.id, 1),
      weekReminderKey(season.id, 2, kickoff),
    ];
    const historicalKeys = [
      weekReminderKey(season.id, 2, kickoff - 60_000),
      weekReminderKey(season.id, 2),
      honorsAnnouncedKey(season.id, 99),
      resultAnnouncedKey(scheduled.id),
    ];
    for (const key of [...currentKeys, ...historicalKeys]) {
      await prisma.setting.create({ data: { key, value: "sent" } });
    }
    await prisma.setting.create({
      data: {
        key: SETTING_KEYS.DISCORD_WEBHOOK_URL,
        value: "https://discord.com/api/webhooks/123456/fake-test-token-123456",
      },
    });

    const originalRead = prisma.setting.findMany.bind(prisma.setting);
    const read = vi.spyOn(prisma.setting, "findMany");
    const optimized = await loadAutomationGateSnapshot(NOW);
    const fetched: Array<{ key: string }> = await read.mock.results[0]!.value;
    expect(fetched.map((row) => row.key)).toEqual(expect.arrayContaining(currentKeys));
    for (const key of historicalKeys) {
      expect(fetched.map((row) => row.key)).not.toContain(key);
    }

    // Replay the previous broad per-season reads against the exact same rows:
    // dropping unused marker history must not change any deadline or health.
    read.mockImplementationOnce((args) => originalRead({
      ...args,
      where: {
        OR: [
          args?.where ?? {},
          { key: { startsWith: weekReminderPrefix(season.id) } },
          { key: { startsWith: honorsAnnouncedPrefix(season.id) } },
          { key: { in: [resultAnnouncedKey(completed.id), resultAnnouncedKey(scheduled.id)] } },
        ],
      },
    }));
    expect(await loadAutomationGateSnapshot(NOW)).toEqual(optimized);
    expect(optimized.nextWakeAtMs).toBeGreaterThan(NOW);

    // The current kickoff marker is still authoritative: removing it wakes
    // the reminder even though both older reminder generations remain sent.
    await prisma.setting.delete({ where: { key: currentKeys[2] } });
    expect(await loadAutomationGateSnapshot(NOW)).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "REMINDER",
    });
  });

  it("retains failed and claimed orphan recovery markers outside any active season", async () => {
    const failed = resultAnnouncedKey("deleted-match");
    const claimed = championAnnouncedKey("deleted-season");
    const uuid = "00000000-0000-4000-8000-000000000000";
    await prisma.setting.create({ data: { key: failed, value: `${ANNOUNCE_FAILED_PREFIX}retry` } });
    await prisma.setting.create({ data: { key: claimed, value: `claim:v2:${NOW + 30_000}:${uuid}:${uuid}` } });
    const read = vi.spyOn(prisma.setting, "findMany");

    expect(await loadAutomationGateSnapshot(NOW)).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "ANNOUNCEMENT_RETRY",
    });
    const fetched: Array<{ key: string }> = await read.mock.results[0]!.value;
    expect(fetched.map((row) => row.key)).toEqual(expect.arrayContaining([failed, claimed]));
  });
});
