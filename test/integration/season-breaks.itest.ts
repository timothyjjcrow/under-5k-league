/**
 * Breaks (holidays): a league night with no games. Adding one moves every
 * round from that night on one league night later, with the fixtures on
 * those nights; removing a future one moves them back. Pure rules are in
 * src/lib/season-breaks.test.ts and src/lib/schedule.test.ts; this file pins
 * the actions, the retime contract and the rounds built after a break against
 * a real database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({ id: "test-admin", name: "Test administrator", role: "ADMIN", steamId: "76561198000000000", avatar: null })),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import { sendDiscordMessage } from "@/lib/discord";
import {
  addSeasonBreak,
  generateSchedule,
  removeSeasonBreak,
  setWeekNight,
} from "@/app/actions/admin-schedule-results";
import { recentAdminActions } from "@/lib/admin-log";
import { loadRescheduleDeadline } from "@/lib/reschedule-service";
import { createPlayoffBracket } from "@/lib/playoff-service";
import { DRAFT_STATUS, MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { leagueDateKey, matchNightForWeek, roundNight } from "@/lib/schedule";
import { weekReminderKey } from "@/lib/settings";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import type { ActionResult } from "@/lib/action-result";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  makeUser,
  ON_POSTGRES,
  raceAll,
  recordMatch,
  scheduleClaim,
} from "./factories";

const DAY = 864e5;
const empty: ActionResult = {};
const fd = (values: Record<string, string>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
};

afterEach(() => {
  setRaceHook(null);
  vi.mocked(sendDiscordMessage).mockClear();
});

/** A regular season of `teams` teams on a weekly night from two days out. */
async function liveSeason(teams = 6) {
  const first = new Date(Math.ceil((Date.now() + 2 * DAY) / 60_000) * 60_000);
  const season = await makeSeason({
    status: SEASON_STATUS.REGULAR_SEASON,
    firstMatchNight: first,
  });
  const made = [];
  for (let i = 0; i < teams; i += 1) made.push(await makeTeam(season.id, `Team ${i}`, i));
  await generateRegularSchedule(season.id);
  const weeks = await prisma.match.findMany({
    where: { seasonId: season.id },
    select: { week: true },
    distinct: ["week"],
  });
  for (const { week } of weeks) {
    await prisma.match.updateMany({
      where: { seasonId: season.id, week },
      data: { scheduledAt: matchNightForWeek(first, week) },
    });
  }
  return { season, first, teams: made, matches: await fixtures(season.id) };
}

function fixtures(seasonId: string) {
  return prisma.match.findMany({
    where: { seasonId },
    orderBy: [{ week: "asc" }, { id: "asc" }],
  });
}

const breakForm = (seasonId: string, date: string, expectedBreaks = "") =>
  fd({ expectedActiveSeasonId: seasonId, expectedBreaks, date });

describe("adding a break", () => {
  it("moves each round from that night on one league night later, keeping the time of day", async () => {
    const { season, first, matches } = await liveSeason();
    const date = leagueDateKey(matchNightForWeek(first, 3));
    const result = await addSeasonBreak(empty, breakForm(season.id, date));
    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(/^Break added: no games on /);
    expect(result?.message).toContain("9 matches moved one night later");
    expect(result?.message).toContain("posted to Discord");

    const after = await fixtures(season.id);
    for (const [index, match] of after.entries()) {
      const before = matches[index];
      expect(match.id).toBe(before.id);
      if (match.week < 3) {
        expect(match.scheduledAt).toEqual(before.scheduledAt);
        expect(match.scheduleRevision).toBe(before.scheduleRevision);
      } else {
        expect(match.scheduledAt).toEqual(matchNightForWeek(first, match.week + 1));
        expect(match.scheduleRevision).toBe(before.scheduleRevision + 1);
      }
    }
    const stored = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });
    expect(stored.breakDates).toBe(JSON.stringify([date]));
    // Week 1's night is still week 1's: a break never moves the anchor.
    expect(stored.firstMatchNight).toEqual(first);

    // The reschedule deadline (the reserved tiebreaker night) follows.
    const deadline = await loadRescheduleDeadline(prisma, after[0], stored, Date.now());
    expect(deadline).toEqual(roundNight(first, 6, [date]));
    expect(deadline).toEqual(matchNightForWeek(first, 7));

    // One post, and the admin log names the date.
    expect(sendDiscordMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendDiscordMessage).mock.calls[0][0]).toContain("**League break: no games on <t:");
    const [log] = await recentAdminActions(1);
    expect(log.action).toBe("addSeasonBreak");
    expect(log.summary).toContain(`the break on ${date}`);
  });

  it("follows the retime contract on the moved fixtures and leaves the rest alone", async () => {
    const { season, first, matches } = await liveSeason();
    const [w2] = matches.filter((m) => m.week === 2);
    const [w3a, w3b] = matches.filter((m) => m.week === 3);
    const [w4kept] = matches.filter((m) => m.week === 4);
    const player = await makeUser("Checked in");
    await prisma.matchAvailability.createMany({
      data: [
        { matchId: w2.id, userId: player.id, status: "IN" },
        { matchId: w3a.id, userId: player.id, status: "IN" },
      ],
    });
    const pending = await prisma.rescheduleRequest.create({
      data: { matchId: w3a.id, proposedById: player.id, proposedTime: new Date(Date.now() + 3 * DAY) },
    });
    const accepted = await prisma.rescheduleRequest.create({
      data: {
        matchId: w3b.id,
        proposedById: player.id,
        proposedTime: w3b.scheduledAt!,
        status: "ACCEPTED",
      },
    });
    // A time week 4's captains agreed: the day after the week's night.
    const agreed = new Date(matchNightForWeek(first, 4).getTime() + DAY);
    await prisma.match.update({ where: { id: w4kept.id }, data: { scheduledAt: agreed } });
    const w2Marker = weekReminderKey(season.id, 2, w2.scheduledAt!.getTime());
    const w3Marker = weekReminderKey(season.id, 3, w3a.scheduledAt!.getTime());
    await prisma.setting.createMany({
      data: [
        { key: w2Marker, value: "posted" },
        { key: w3Marker, value: "posted" },
      ],
    });

    const result = await addSeasonBreak(
      empty,
      breakForm(season.id, leagueDateKey(matchNightForWeek(first, 3))),
    );
    expect(result?.error).toBeUndefined();
    expect(result?.message).toContain("8 matches moved one night later");
    expect(result?.message).toContain("1 kept a time arranged off the league night");
    expect(result?.message).toContain("1 check-in(s) cleared");
    expect(result?.message).toContain("1 open reschedule proposal(s) cancelled");

    expect(await prisma.matchAvailability.findMany({ select: { matchId: true } })).toEqual([
      { matchId: w2.id },
    ]);
    // Only the open proposal is cancelled; an answered one keeps its answer.
    expect((await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("CANCELLED");
    expect((await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: accepted.id } })).status).toBe("ACCEPTED");
    const keys = (await prisma.setting.findMany({ select: { key: true } })).map((s) => s.key);
    expect(keys).toContain(w2Marker);
    expect(keys).not.toContain(w3Marker);
    const kept = await prisma.match.findUniqueOrThrow({ where: { id: w4kept.id } });
    expect(kept.scheduledAt).toEqual(agreed);
    expect(kept.scheduleRevision).toBe(w4kept.scheduleRevision);
    const post = vi.mocked(sendDiscordMessage).mock.calls[0][0];
    expect(post).toContain("Staying at their arranged time:");
  });

  it("stores the night a nearby date covers, and says so", async () => {
    const { season, first } = await liveSeason(4);
    const night = matchNightForWeek(first, 3);
    const dayBefore = leagueDateKey(new Date(night.getTime() - DAY));
    const result = await addSeasonBreak(empty, breakForm(season.id, dayBefore));
    expect(result?.error).toBeUndefined();
    const stored = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });
    expect(stored.breakDates).toBe(JSON.stringify([leagueDateKey(night)]));
  });

  it("refuses a stale form, week 1, a started round and a finished season, changing nothing", async () => {
    const { season, first, matches } = await liveSeason();
    const date = leagueDateKey(matchNightForWeek(first, 3));
    const unchanged = async () => {
      expect(await fixtures(season.id)).toEqual(matches);
      expect((await prisma.season.findUniqueOrThrow({ where: { id: season.id } })).breakDates).toBeNull();
    };

    const stale = await addSeasonBreak(empty, breakForm(season.id, date, '["2030-01-05"]'));
    expect(stale?.error).toMatch(/changed while this page was open/);
    await unchanged();

    const weekOne = await addSeasonBreak(empty, breakForm(season.id, leagueDateKey(first)));
    expect(weekOne?.error).toMatch(/week 1's night/);
    await unchanged();

    const missing = await addSeasonBreak(empty, fd({ expectedBreaks: "", date }));
    expect(missing?.error).toMatch(/stale/);

    const [w3] = matches.filter((m) => m.week === 3);
    await prisma.match.update({ where: { id: w3.id }, data: { status: MATCH_STATUS.LIVE } });
    const started = await addSeasonBreak(empty, breakForm(season.id, date));
    expect(started?.error).toMatch(/Week 3 has already started/);
    expect((await fixtures(season.id)).map((m) => m.scheduledAt)).toEqual(matches.map((m) => m.scheduledAt));
    await prisma.match.update({ where: { id: w3.id }, data: { status: MATCH_STATUS.SCHEDULED } });

    await prisma.season.update({ where: { id: season.id }, data: { status: SEASON_STATUS.COMPLETE } });
    const complete = await addSeasonBreak(empty, breakForm(season.id, date));
    expect(complete?.error).toMatch(/complete/);
    expect(sendDiscordMessage).not.toHaveBeenCalled();
  });

  it("lets only one of two admins adding breaks at once move the fixtures", async () => {
    const { season, first, matches } = await liveSeason(4);
    const results = await raceAll([
      () => addSeasonBreak(empty, breakForm(season.id, leagueDateKey(matchNightForWeek(first, 2)))),
      () => addSeasonBreak(empty, breakForm(season.id, leagueDateKey(matchNightForWeek(first, 3)))),
    ]);
    expect(results.filter((r) => r?.ok)).toHaveLength(1);
    expect(results.filter((r) => r?.error)).toHaveLength(1);
    const stored = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });
    const breaks = JSON.parse(stored.breakDates!) as string[];
    expect(breaks).toHaveLength(1);
    // Each fixture moved at most once, onto its round's night under the one break.
    for (const match of await fixtures(season.id)) {
      expect(match.scheduledAt).toEqual(roundNight(first, match.week, breaks));
      const before = matches.find((m) => m.id === match.id)!;
      expect(match.scheduleRevision - before.scheduleRevision).toBeLessThanOrEqual(1);
    }
  });
});

describe("removing a break", () => {
  it("moves the rounds after it back onto their nights", async () => {
    const { season, first, matches } = await liveSeason();
    const date = leagueDateKey(matchNightForWeek(first, 3));
    expect((await addSeasonBreak(empty, breakForm(season.id, date)))?.error).toBeUndefined();
    vi.mocked(sendDiscordMessage).mockClear();
    const removed = await removeSeasonBreak(
      empty,
      breakForm(season.id, date, JSON.stringify([date])),
    );
    expect(removed?.error).toBeUndefined();
    expect(removed?.message).toMatch(/^Break on .* removed · 9 matches moved one night earlier/);
    const after = await fixtures(season.id);
    expect(after.map((m) => m.scheduledAt)).toEqual(matches.map((m) => m.scheduledAt));
    expect((await prisma.season.findUniqueOrThrow({ where: { id: season.id } })).breakDates).toBeNull();
    expect(vi.mocked(sendDiscordMessage).mock.calls[0][0]).toContain("is off.**");
  });

  it("keeps a break whose night has passed", async () => {
    const { season } = await liveSeason(4);
    const yesterday = leagueDateKey(new Date(Date.now() - 7 * DAY));
    const stored = JSON.stringify([yesterday]);
    await prisma.season.update({ where: { id: season.id }, data: { breakDates: stored } });
    const result = await removeSeasonBreak(empty, breakForm(season.id, yesterday, stored));
    expect(result?.error).toMatch(/passed/);
    expect((await prisma.season.findUniqueOrThrow({ where: { id: season.id } })).breakDates).toBe(stored);
  });
});

describe("rounds built after a break", () => {
  it("generates the schedule around a break planned before week 1's night was set", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    await prisma.draft.create({ data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE } });
    for (let i = 0; i < 4; i += 1) await makeTeam(season.id, `Roster ${i}`, i);
    const first = new Date(Math.ceil((Date.now() + 7 * DAY) / 60_000) * 60_000);
    const planned = leagueDateKey(new Date(first.getTime() + 7 * DAY));
    const added = await addSeasonBreak(empty, breakForm(season.id, planned));
    expect(added?.error).toBeUndefined();
    expect(added?.message).toMatch(/^Break planned for the week of /);
    expect(sendDiscordMessage).not.toHaveBeenCalled();

    const generated = await generateSchedule(
      empty,
      fd({
        firstNight: "2026-11-07T14:00",
        firstNightTs: String(first.getTime()),
        ...(await scheduleClaim(season.id)),
      }),
    );
    expect(generated?.error).toBeUndefined();
    expect(generated?.message).toContain(": break)");
    const regular = await fixtures(season.id);
    expect(regular.length).toBeGreaterThan(0);
    for (const match of regular) {
      // Week 1 plays on the first night, then week 2 skips the break.
      expect(match.scheduledAt).toEqual(matchNightForWeek(first, match.week === 1 ? 1 : match.week + 1));
    }
  });

  it("dates round one past a break on its planned night", async () => {
    const { season, first, teams, matches } = await liveSeason(4);
    // No ties: the lower draft order wins every series.
    const order = new Map(teams.map((team) => [team.id, team.draftOrder]));
    for (const match of matches) {
      const homeWins = order.get(match.homeTeamId)! < order.get(match.awayTeamId)!;
      await recordMatch(match.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
    const lastWeek = Math.max(...matches.map((m) => m.week));
    // Round one plays two weeks after the last regular week.
    const roundOne = matchNightForWeek(first, lastWeek + 2);
    const added = await addSeasonBreak(empty, breakForm(season.id, leagueDateKey(roundOne)));
    expect(added?.error).toBeUndefined();
    expect(added?.message).toContain("no fixtures to move yet");
    await createPlayoffBracket(season.id);
    const bracket = await prisma.match.findMany({
      where: { seasonId: season.id, phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] } },
    });
    expect(bracket.length).toBeGreaterThan(0);
    for (const match of bracket) {
      expect(match.week).toBe(lastWeek + 2);
      expect(match.scheduledAt).toEqual(matchNightForWeek(first, lastWeek + 3));
    }
  });
});

describe.skipIf(!ON_POSTGRES)("a break racing the week mover (Postgres)", () => {
  it("refuses the break when a cascade commits between its read and its write", async () => {
    const { season, first } = await liveSeason();
    let fired = false;
    const moved = new Date(matchNightForWeek(first, 4).getTime() + DAY);
    setRaceHook(
      onceAt("seasonBreaks.change.beforeWrite", async () => {
        fired = true;
        const rival = await setWeekNight(
          empty,
          fd({
            expectedActiveSeasonId: season.id,
            week: "4",
            cascade: "on",
            night: "2026-11-07T14:00",
            nightTs: String(moved.getTime()),
          }),
        );
        expect(rival?.error).toBeUndefined();
      }),
    );
    const result = await addSeasonBreak(
      empty,
      breakForm(season.id, leagueDateKey(matchNightForWeek(first, 3))),
    );
    expect(fired).toBe(true);
    expect(result?.error).toMatch(/changed while this page was open/);
    const stored = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });
    expect(stored.breakDates).toBeNull();
    // The week mover's result stands untouched by a half-applied break.
    const week3 = await prisma.match.findMany({ where: { seasonId: season.id, week: 3 } });
    for (const match of week3) expect(match.scheduledAt).toEqual(matchNightForWeek(first, 3));
    const week4 = await prisma.match.findMany({ where: { seasonId: season.id, week: 4 } });
    for (const match of week4) expect(match.scheduledAt).toEqual(moved);
  });
});
