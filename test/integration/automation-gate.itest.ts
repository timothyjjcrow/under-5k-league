import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAutomationGateSnapshot } from "@/lib/automation-gate";
import { prisma } from "@/lib/prisma";
import {
  ANNOUNCE_FAILED_PREFIX,
  championAnnouncedKey,
  draftReminderKey,
  honorsAnnouncedKey,
  honorsAnnouncedPrefix,
  inhouseNightStartKey,
  playoffRoundAnnouncedKey,
  resultAnnouncedKey,
  resultNudgeKey,
  SETTING_KEYS,
  weekReminderKey,
  weekReminderPrefix,
} from "@/lib/settings";
import { AUTO_SYNC } from "@/lib/constants";
import { RESULT_NUDGE } from "@/lib/result-nudge";
import { makeSeason, makeTeam } from "./factories";
import { serializeInhouseNight } from "@/lib/inhouse-night";

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

  it("reads the draft-night reminder schedule and its current-revision marker", async () => {
    await prisma.setting.create({
      data: {
        key: SETTING_KEYS.DISCORD_WEBHOOK_URL,
        value: "https://discord.com/api/webhooks/123456/fake-test-token-123456",
      },
    });
    const draftAt = NOW + 30 * 60 * 60_000;
    const season = await makeSeason({
      status: "SIGNUPS",
      draftAt: new Date(draftAt),
      draftRevision: 2,
    });

    // Outside the window: the worker is told to wake exactly when it opens.
    expect(await loadAutomationGateSnapshot(NOW)).toMatchObject({
      nextWakeAtMs: draftAt - 24 * 60 * 60_000,
      reason: "REMINDER",
    });

    // Inside it, only the CURRENT revision's marker counts as done.
    await prisma.season.update({
      where: { id: season.id },
      data: { draftAt: new Date(NOW + 2 * 60 * 60_000) },
    });
    await prisma.setting.create({
      data: { key: draftReminderKey(season.id, 1), value: "sent:v2:old:1" },
    });
    expect(await loadAutomationGateSnapshot(NOW)).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "REMINDER",
    });
    await prisma.setting.create({
      data: {
        key: draftReminderKey(season.id, 2),
        value: "sent:v2:11111111-1111-4111-8111-111111111111:1",
      },
    });
    expect(await loadAutomationGateSnapshot(NOW)).toMatchObject({
      nextWakeAtMs: Number.MAX_SAFE_INTEGER,
      reason: null,
    });
  });

  it("reads the inhouse night and its start-post marker, with no season at all", async () => {
    const night = {
      id: "night-gate",
      startsAtMs: NOW + 5 * 60 * 60_000,
      note: "",
      createdAtMs: NOW - 60_000,
      revision: 0,
      discordEventId: null,
    };
    await prisma.setting.create({
      data: { key: SETTING_KEYS.INHOUSE_NIGHT, value: serializeInhouseNight(night) },
    });
    expect(await loadAutomationGateSnapshot(NOW)).toMatchObject({
      nextWakeAtMs: night.startsAtMs,
      reason: "REMINDER",
    });

    // Started: due until its own marker says the post is done.
    const started = { ...night, startsAtMs: NOW - 60_000 };
    await prisma.setting.update({
      where: { key: SETTING_KEYS.INHOUSE_NIGHT },
      data: { value: serializeInhouseNight(started) },
    });
    expect(await loadAutomationGateSnapshot(NOW)).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "REMINDER",
    });
    await prisma.setting.create({
      data: {
        key: inhouseNightStartKey(started.id, started.startsAtMs),
        value: "sent:v2:11111111-1111-4111-8111-111111111111:1",
      },
    });
    expect(await loadAutomationGateSnapshot(NOW)).toMatchObject({
      nextWakeAtMs: Number.MAX_SAFE_INTEGER,
      reason: null,
    });
  });

  it("wakes for the result nudge at the fixture's due time and follows its current-kickoff marker", async () => {
    await prisma.setting.create({
      data: {
        key: SETTING_KEYS.DISCORD_WEBHOOK_URL,
        value: "https://discord.com/api/webhooks/123456/fake-test-token-123456",
      },
    });
    const season = await makeSeason({ status: "REGULAR_SEASON" });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const HOUR = 60 * 60_000;
    // Kicked off 3.5h ago; its automatic scans are backed off for hours.
    const kickoff = NOW - 3.5 * HOUR;
    const fixture = await prisma.match.create({
      data: {
        seasonId: season.id,
        homeTeamId: home.id,
        awayTeamId: away.id,
        week: 2,
        scheduledAt: new Date(kickoff),
        scheduleRevision: 1,
        autoSyncedAt: new Date(NOW - 60_000),
        autoSyncAttempts: AUTO_SYNC.BACKOFF_DOUBLINGS,
      },
    });
    // A decided series elsewhere: its games are never read for a nudge.
    const decided = await prisma.match.create({
      data: {
        seasonId: season.id,
        homeTeamId: home.id,
        awayTeamId: away.id,
        week: 1,
        status: "COMPLETED",
        homeScore: 1,
        winnerTeamId: home.id,
        // Decided a week earlier. Left unset, Postgres's completion trigger
        // stamps the real clock, which is weeks after NOW, and week 1's
        // honors then read as freshly completed and due for recovery.
        completedAt: new Date(NOW - 7 * 24 * HOUR),
      },
    });
    await prisma.setting.create({
      data: { key: resultAnnouncedKey(decided.id), value: "sent:v2:done:1" },
    });
    await prisma.game.create({
      data: {
        matchId: decided.id,
        dotaMatchId: "8800000001",
        radiantWin: true,
        players: "[]",
      },
    });

    const seasonRead = vi.spyOn(prisma.season, "findMany");
    expect(await loadAutomationGateSnapshot(NOW)).toMatchObject({
      nextWakeAtMs: kickoff + RESULT_NUDGE.HOURS_AFTER_KICKOFF * HOUR,
      reason: "REMINDER",
    });
    const [loaded] = (await seasonRead.mock.results[0]!.value) as Array<{
      matches: Array<{ id: string; games: unknown[] }>;
    }>;
    expect(loaded.matches.find((m) => m.id === decided.id)?.games).toEqual([]);

    // A marker from the previous kickoff says nothing about this one.
    await prisma.setting.create({
      data: { key: resultNudgeKey(fixture.id, 0), value: "sent:v2:old:1" },
    });
    expect(await loadAutomationGateSnapshot(NOW)).toMatchObject({
      reason: "REMINDER",
    });
    await prisma.setting.create({
      data: { key: resultNudgeKey(fixture.id, 1), value: "sent:v2:new:1" },
    });
    const done = await loadAutomationGateSnapshot(NOW);
    expect(done.reason).toBe("LEAGUE");
    expect(done.nextWakeAtMs).toBeGreaterThan(
      kickoff + RESULT_NUDGE.HOURS_AFTER_KICKOFF * HOUR,
    );
  });

  it("wakes for a failed playoff-round post", async () => {
    await prisma.setting.create({
      data: {
        key: SETTING_KEYS.DISCORD_WEBHOOK_URL,
        value: "https://discord.com/api/webhooks/123456/fake-test-token-123456",
      },
    });
    const key = playoffRoundAnnouncedKey("some-season", 2);
    await prisma.setting.create({
      data: {
        key,
        value: "failed:v2:11111111-1111-4111-8111-111111111111:1",
      },
    });
    const read = vi.spyOn(prisma.setting, "findMany");

    expect(await loadAutomationGateSnapshot(NOW)).toMatchObject({
      nextWakeAtMs: NOW,
      reason: "ANNOUNCEMENT_RETRY",
    });
    const fetched: Array<{ key: string }> = await read.mock.results[0]!.value;
    expect(fetched.map((row) => row.key)).toContain(key);
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
