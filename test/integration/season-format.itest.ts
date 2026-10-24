/**
 * The season format (2026-10-19): the team count decides one table or two
 * groups, the site draws the groups by roster MMR, an admin can swap one team
 * from each, and the playoffs seed the groups crosswise after a reserved
 * tiebreaker week. Pure rules are in src/lib/season-format.test.ts; this file
 * pins the actions and the bracket against a real database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { generateSchedule, swapGroupTeams } from "@/app/actions/admin-schedule-results";
import { createPlayoffBracket } from "@/lib/playoff-service";
import { advanceTiebreakerWeek, createTiebreakerWeek } from "@/lib/tiebreaker-service";
import { FORMAT_UNREADABLE_MESSAGE, serializeFormatConfig } from "@/lib/season-format";
import { projectPlayoffField } from "@/lib/playoff-field";
import { matchNightForWeek } from "@/lib/schedule";
import { DRAFT_STATUS, MATCH_PHASE, SEASON_STATUS } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import { setRaceHook } from "@/lib/race-hook";
import { seedLegacyTiebreaker } from "../fixtures/legacy-tiebreaker";
import {
  generateRegularSchedule,
  makePlayer,
  makeSeason,
  makeTeam,
  ON_POSTGRES,
  raceAll,
  recordMatch,
  resetDb,
  scheduleClaim,
} from "./factories";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};
const empty: ActionResult = {};
const firstNight = () => new Date(Date.now() + 7 * 864e5);
const firstNightFields = (night = firstNight()) => ({
  firstNight: "2026-11-07T14:00",
  firstNightTs: String(night.getTime()),
});

beforeEach(resetDb);
afterEach(() => setRaceHook(null));

/**
 * A post-auction season of `count` teams. Team i's two drafted players sign up
 * at 5000 − 100·i, so team 0 is the strongest roster; draft order runs the
 * other way round so the draw can't be mistaken for draft order.
 */
async function draftedSeason(count: number) {
  const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
  await prisma.draft.create({
    data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
  });
  const teams = [];
  for (let i = 0; i < count; i++) {
    const team = await makeTeam(season.id, `Roster ${i}`, count - i);
    for (let p = 0; p < 2; p++) {
      const player = await makePlayer(season.id, `R${i} player ${p}`, 5000 - 100 * i);
      await prisma.teamMember.create({
        data: { seasonId: season.id, teamId: team.id, userId: player.id, price: 10 },
      });
    }
    teams.push(team);
  }
  return { season, teams };
}

async function groupsOf(seasonId: string) {
  const teams = await prisma.team.findMany({ where: { seasonId }, orderBy: { name: "asc" } });
  return {
    A: teams.filter((t) => t.groupKey === "A").map((t) => t.name).sort(),
    B: teams.filter((t) => t.groupKey === "B").map((t) => t.name).sort(),
    none: teams.filter((t) => t.groupKey === null).map((t) => t.name),
  };
}

const names = (indices: number[]) => indices.map((i) => `Roster ${i}`).sort();

describe("generateSchedule draws two groups from ten teams", () => {
  it("snakes the rosters by MMR and plays each group's round robin on the same weeks", async () => {
    const { season, teams } = await draftedSeason(10);
    const res = await generateSchedule(
      empty,
      fd({ ...firstNightFields(), ...(await scheduleClaim(season.id)) }),
    );
    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/Two groups of 5, drawn by roster MMR/);
    expect(res?.message).toMatch(/20 matches over 5 week\(s\)/);
    expect(res?.message).toMatch(/tiebreaker week .* playoffs from /);
    // Strongest first: A, B, B, A, A, B, B, A, A, B.
    expect(await groupsOf(season.id)).toEqual({
      A: names([0, 3, 4, 7, 8]),
      B: names([1, 2, 5, 6, 9]),
      none: [],
    });
    const groupOf = new Map(
      (await prisma.team.findMany({ where: { seasonId: season.id } })).map((t) => [t.id, t.groupKey]),
    );
    const matches = await prisma.match.findMany({ where: { seasonId: season.id } });
    expect(matches).toHaveLength(20);
    // No fixture crosses the groups, and every week has both groups playing.
    for (const m of matches) expect(groupOf.get(m.homeTeamId)).toBe(groupOf.get(m.awayTeamId));
    for (let week = 1; week <= 5; week++) {
      const keys = new Set(matches.filter((m) => m.week === week).map((m) => groupOf.get(m.homeTeamId)));
      expect([...keys].sort()).toEqual(["A", "B"]);
    }
    expect(teams).toHaveLength(10);
  });

  it("spreads a smaller group's rounds so both groups finish the same night", async () => {
    const { season } = await draftedSeason(13);
    const res = await generateSchedule(
      empty,
      fd({ ...firstNightFields(), ...(await scheduleClaim(season.id)) }),
    );
    expect(res?.message).toMatch(/Two groups of 7 and 6/);
    const teams = await prisma.team.findMany({ where: { seasonId: season.id } });
    const small = new Set(
      teams.filter((t) => teams.filter((u) => u.groupKey === t.groupKey).length === 6).map((t) => t.id),
    );
    expect(small.size).toBe(6);
    const matches = await prisma.match.findMany({ where: { seasonId: season.id } });
    const smallWeeks = [...new Set(matches.filter((m) => small.has(m.homeTeamId)).map((m) => m.week))].sort((a, b) => a - b);
    expect(smallWeeks).toEqual([1, 3, 4, 6, 7]);
    expect(Math.max(...matches.map((m) => m.week))).toBe(7);
  });

  it("clears the groups when a regenerate finds a one-table team count", async () => {
    const { season, teams } = await draftedSeason(10);
    await generateSchedule(empty, fd({ ...firstNightFields(), ...(await scheduleClaim(season.id)) }));
    await prisma.match.deleteMany({ where: { seasonId: season.id } });
    await prisma.team.delete({ where: { id: teams[9].id } });
    const res = await generateSchedule(
      empty,
      fd({ ...firstNightFields(), ...(await scheduleClaim(season.id)) }),
    );
    expect(res?.message).toMatch(/One table · 36 matches over 9 week\(s\)/);
    expect((await groupsOf(season.id)).none).toHaveLength(9);
  });
});

describe("swapGroupTeams", () => {
  async function grouped() {
    const { season, teams } = await draftedSeason(10);
    await generateSchedule(empty, fd({ ...firstNightFields(), ...(await scheduleClaim(season.id)) }));
    return { season, teams };
  }

  it("refuses a swap or regenerate from a tab opened before another admin rebuilt", async () => {
    const { season, teams } = await grouped();
    const oldTab = await scheduleClaim(season.id);
    // Another admin regenerates: every fixture gets a new id.
    const rebuilt = await generateSchedule(
      empty,
      fd({ ...firstNightFields(), ...(await scheduleClaim(season.id)) }),
    );
    expect(rebuilt?.error).toBeUndefined();
    const fixturesNow = async () =>
      (
        await prisma.match.findMany({
          where: { seasonId: season.id },
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((match) => match.id);
    const before = { fixtures: await fixturesNow(), groups: await groupsOf(season.id) };
    const stale =
      "The schedule was generated or rebuilt while this page was open. Nothing was changed; reload to see it.";

    // Teams 0 and 1 are in different groups, so only the claim can refuse.
    const swap = await swapGroupTeams(
      empty,
      fd({ ...oldTab, teamA: teams[0].id, teamB: teams[1].id }),
    );
    expect(swap?.error).toBe(stale);
    const regenerate = await generateSchedule(empty, fd({ ...firstNightFields(), ...oldTab }));
    expect(regenerate?.error).toBe(stale);
    expect({ fixtures: await fixturesNow(), groups: await groupsOf(season.id) }).toEqual(before);
  });

  it("trades one team from each group and rebuilds the fixtures around them", async () => {
    const { season, teams } = await grouped();
    const res = await swapGroupTeams(
      empty,
      fd({ ...(await scheduleClaim(season.id)), teamA: teams[0].id, teamB: teams[1].id }),
    );
    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/Groups swapped and schedule regenerated/);
    expect(await groupsOf(season.id)).toEqual({
      A: names([1, 3, 4, 7, 8]),
      B: names([0, 2, 5, 6, 9]),
      none: [],
    });
    const groupOf = new Map(
      (await prisma.team.findMany({ where: { seasonId: season.id } })).map((t) => [t.id, t.groupKey]),
    );
    const matches = await prisma.match.findMany({ where: { seasonId: season.id } });
    expect(matches).toHaveLength(20);
    for (const m of matches) expect(groupOf.get(m.homeTeamId)).toBe(groupOf.get(m.awayTeamId));
    // The rebuilt fixtures keep the season's week-1 night.
    const anchor = (await prisma.season.findUniqueOrThrow({ where: { id: season.id } })).firstMatchNight!;
    for (const m of matches) expect(m.scheduledAt?.getTime()).toBe(matchNightForWeek(anchor, m.week).getTime());
  });

  it("keeps a swap through a plain regenerate, and redraws only when asked", async () => {
    const { season, teams } = await grouped();
    await swapGroupTeams(empty, fd({ ...(await scheduleClaim(season.id)), teamA: teams[0].id, teamB: teams[1].id }));
    const kept = await generateSchedule(
      empty,
      fd({ ...firstNightFields(), ...(await scheduleClaim(season.id)) }),
    );
    expect(kept?.message).toMatch(/the groups kept as they were/);
    expect((await groupsOf(season.id)).A).toEqual(names([1, 3, 4, 7, 8]));
    const redrawn = await generateSchedule(
      empty,
      fd({ ...firstNightFields(), redrawGroups: "on", ...(await scheduleClaim(season.id)) }),
    );
    expect(redrawn?.message).toMatch(/drawn by roster MMR/);
    expect((await groupsOf(season.id)).A).toEqual(names([0, 3, 4, 7, 8]));
  });

  it("refuses two teams from the same group, and changes nothing", async () => {
    const { season, teams } = await grouped();
    const before = await prisma.match.findMany({ where: { seasonId: season.id }, orderBy: { id: "asc" } });
    const res = await swapGroupTeams(
      empty,
      fd({ ...(await scheduleClaim(season.id)), teamA: teams[0].id, teamB: teams[3].id }),
    );
    expect(res?.error).toMatch(/aren't in different groups/);
    expect(await prisma.match.findMany({ where: { seasonId: season.id }, orderBy: { id: "asc" } })).toEqual(before);
  });

  it("refuses once a result is in", async () => {
    const { season, teams } = await grouped();
    const first = await prisma.match.findFirstOrThrow({ where: { seasonId: season.id } });
    await recordMatch(first.id, 2, 0);
    const res = await swapGroupTeams(
      empty,
      fd({ ...(await scheduleClaim(season.id)), teamA: teams[0].id, teamB: teams[1].id }),
    );
    expect(res?.error).toMatch(/Results are already recorded/);
    expect((await groupsOf(season.id)).A).toEqual(names([0, 3, 4, 7, 8]));
  });

  it("refuses a one-table season", async () => {
    const { season, teams } = await draftedSeason(6);
    await generateSchedule(empty, fd({ ...firstNightFields(), ...(await scheduleClaim(season.id)) }));
    const res = await swapGroupTeams(
      empty,
      fd({ ...(await scheduleClaim(season.id)), teamA: teams[0].id, teamB: teams[1].id }),
    );
    expect(res?.error).toMatch(/aren't in different groups/);
  });

  // Raced, not staged: two admins swap at once. Serializable lets one
  // commit; the other must change nothing, so the fixtures always match the
  // groups (a lost update would leave fixtures from one swap under the
  // other's groups).
  it.skipIf(!ON_POSTGRES)("two swaps at once leave fixtures that match the groups", async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await resetDb();
      const { season, teams } = await grouped();
      // Both admins' pages showed the same schedule.
      const claim = await scheduleClaim(season.id);
      const results = await raceAll([
        () => swapGroupTeams(empty, fd({ ...claim, teamA: teams[0].id, teamB: teams[1].id })),
        () => swapGroupTeams(empty, fd({ ...claim, teamA: teams[3].id, teamB: teams[2].id })),
      ]);
      expect(results.some((r) => !r?.error)).toBe(true);
      const groupOf = new Map(
        (await prisma.team.findMany({ where: { seasonId: season.id } })).map((t) => [t.id, t.groupKey]),
      );
      const matches = await prisma.match.findMany({ where: { seasonId: season.id } });
      expect(matches).toHaveLength(20);
      for (const m of matches) expect(groupOf.get(m.homeTeamId)).toBe(groupOf.get(m.awayTeamId));
    }
  });
});

describe("a group season's playoffs", () => {
  /** Ten teams in two groups; in each group the stronger roster wins 2–0. */
  async function playedGroupStage(overrides: (a: number, b: number) => [number, number] | null = () => null) {
    const { season, teams } = await draftedSeason(10);
    await generateSchedule(empty, fd({ ...firstNightFields(), ...(await scheduleClaim(season.id)) }));
    await prisma.season.update({ where: { id: season.id }, data: { status: SEASON_STATUS.REGULAR_SEASON } });
    const rank = new Map(teams.map((t, i) => [t.id, i]));
    for (const m of await prisma.match.findMany({ where: { seasonId: season.id } })) {
      const home = rank.get(m.homeTeamId)!;
      const away = rank.get(m.awayTeamId)!;
      const [h, a] = overrides(home, away) ?? (home < away ? [2, 0] : [0, 2]);
      await recordMatch(m.id, h, a);
    }
    return { season, teams };
  }

  it("seeds A1–B4, B2–A3, B1–A4, A2–B3 and plays round one after the tiebreaker week", async () => {
    const { season, teams } = await playedGroupStage();
    await createPlayoffBracket(season.id);
    const roundOne = (await prisma.match.findMany({
      where: { seasonId: season.id, phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] } },
    })).sort((a, b) => a.bracketSlot!.localeCompare(b.bracketSlot!));
    const id = (i: number) => teams[i].id;
    // A: 0, 3, 4, 7, 8 → A1 0, A2 3, A3 4, A4 7. B: 1, 2, 5, 6, 9 → B1 1, B2 2, B3 5, B4 6.
    expect(roundOne.map((m) => [m.homeTeamId, m.awayTeamId])).toEqual([
      [id(0), id(6)],
      [id(2), id(4)],
      [id(1), id(7)],
      [id(3), id(5)],
    ]);
    const seasonRow = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });
    // Five group weeks, the reserved tiebreaker week 6, round one in week 7.
    expect(roundOne.every((m) => m.week === 7)).toBe(true);
    expect(roundOne[0].scheduledAt?.getTime()).toBe(
      matchNightForWeek(seasonRow.firstMatchNight!, 7).getTime(),
    );
  });

  it("plays off a tie on one group's cut in that group only", async () => {
    // Group A's 4th and 5th (rosters 7 and 8) draw each other: dead level.
    const { season, teams } = await playedGroupStage((a, b) =>
      (a === 7 && b === 8) || (a === 8 && b === 7) ? [1, 1] : null,
    );
    const field = projectPlayoffField(
      await prisma.team.findMany({ where: { seasonId: season.id } }),
      await prisma.match.findMany({ where: { seasonId: season.id } }), { formatConfig: null },
    );
    expect(field.seedingDeadHeatTeamIds.sort()).toEqual([teams[7].id, teams[8].id].sort());
    await expect(createPlayoffBracket(season.id)).rejects.toThrow(/still tied/);
    await createTiebreakerWeek(season.id);
    const tiebreakers = await prisma.match.findMany({
      where: { seasonId: season.id, phase: MATCH_PHASE.TIEBREAKER },
    });
    expect(tiebreakers).toHaveLength(1);
    expect([tiebreakers[0].homeTeamId, tiebreakers[0].awayTeamId].sort()).toEqual(
      [teams[7].id, teams[8].id].sort(),
    );
    // It plays in the reserved week, straight after the group stage.
    expect(tiebreakers[0].week).toBe(6);
  });
});

describe("a season that stores its format", () => {
  async function storeFormat(seasonId: string, formatConfig: string | null) {
    await prisma.season.update({ where: { id: seasonId }, data: { formatConfig } });
  }
  const generate = async (seasonId: string) =>
    generateSchedule(empty, fd({ ...firstNightFields(), ...(await scheduleClaim(seasonId)) }));

  it("generates the stored format, not the one the team count recommends", async () => {
    // Eight teams would play one table; the stored format splits them.
    const { season } = await draftedSeason(8);
    await storeFormat(season.id, serializeFormatConfig({ groups: 2, meet: 1, playoffs: 4 }));
    const res = await generate(season.id);
    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/Two groups of 4, drawn by roster MMR/);
    expect(res?.message).toMatch(/12 matches over 3 week\(s\)/);
    const groups = await groupsOf(season.id);
    expect([groups.A.length, groups.B.length, groups.none.length]).toEqual([4, 4, 0]);
  });

  it("plays each group twice when the stored format says so", async () => {
    const { season } = await draftedSeason(6);
    await storeFormat(season.id, serializeFormatConfig({ groups: 2, meet: 2, playoffs: 2 }));
    const res = await generate(season.id);
    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/Two groups of 3, each played twice/);
    expect(res?.message).toMatch(/12 matches over 6 week\(s\)/);
  });

  it("seeds the group winners into the grand final when that is the format", async () => {
    const { season, teams } = await draftedSeason(10);
    await storeFormat(season.id, serializeFormatConfig({ groups: 2, meet: 1, playoffs: 2 }));
    await generate(season.id);
    await prisma.season.update({ where: { id: season.id }, data: { status: SEASON_STATUS.REGULAR_SEASON } });
    const rank = new Map(teams.map((t, i) => [t.id, i]));
    for (const m of await prisma.match.findMany({ where: { seasonId: season.id } })) {
      const stronger = rank.get(m.homeTeamId)! < rank.get(m.awayTeamId)!;
      await recordMatch(m.id, stronger ? 2 : 0, stronger ? 0 : 2);
    }
    await createPlayoffBracket(season.id);
    const bracket = await prisma.match.findMany({
      where: { seasonId: season.id, phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] } },
    });
    // A1 is roster 0, B1 roster 1 (the MMR snake); the final is week 7.
    expect(bracket.map((m) => [m.phase, m.homeTeamId, m.awayTeamId, m.week])).toEqual([
      [MATCH_PHASE.FINAL, teams[0].id, teams[1].id, 7],
    ]);
  });

  it("refuses to build from a stored format it can't read, and changes nothing", async () => {
    const { season } = await draftedSeason(10);
    await storeFormat(season.id, '{"v":2,"groups":3}');
    const res = await generate(season.id);
    expect(res?.error).toBe(FORMAT_UNREADABLE_MESSAGE);
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(0);
    expect((await groupsOf(season.id)).none).toHaveLength(10);

    // Built under a readable format, then unreadable (a newer release
    // wrote it): no bracket and no tiebreaker week from it.
    await storeFormat(season.id, null);
    await generate(season.id);
    await prisma.season.update({ where: { id: season.id }, data: { status: SEASON_STATUS.REGULAR_SEASON } });
    for (const m of await prisma.match.findMany({ where: { seasonId: season.id } })) {
      await recordMatch(m.id, 1, 1);
    }
    await storeFormat(season.id, "junk");
    await expect(createPlayoffBracket(season.id)).rejects.toThrow(FORMAT_UNREADABLE_MESSAGE);
    await expect(createTiebreakerWeek(season.id)).rejects.toThrow(FORMAT_UNREADABLE_MESSAGE);
    expect(
      await prisma.match.count({
        where: { seasonId: season.id, phase: { not: MATCH_PHASE.REGULAR } },
      }),
    ).toBe(0);
  });

  it("lets the worker's tiebreaker pass wait on a format it can't read", async () => {
    // A tiebreaker week started under a readable format (three teams level),
    // its first game played, so the automatic pass has the next game due.
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    for (let i = 0; i < 3; i++) await makeTeam(season.id, `Level ${i}`, i);
    for (const m of await generateRegularSchedule(season.id)) await recordMatch(m.id, 1, 1);
    await seedLegacyTiebreaker(season.id);
    const opening = await prisma.match.findFirstOrThrow({
      where: { seasonId: season.id, phase: MATCH_PHASE.TIEBREAKER },
    });
    await recordMatch(opening.id, 1, 0);
    const tiebreakers = () =>
      prisma.match.count({ where: { seasonId: season.id, phase: MATCH_PHASE.TIEBREAKER } });

    // Every worker run and import calls it: it waits instead of failing.
    await storeFormat(season.id, "junk");
    await expect(advanceTiebreakerWeek(season.id)).resolves.toBeUndefined();
    expect(await tiebreakers()).toBe(1);
    await expect(createTiebreakerWeek(season.id)).rejects.toThrow(FORMAT_UNREADABLE_MESSAGE);

    // The same pass under a readable format schedules that game, so the wait
    // above was the format check and not a pass with nothing to do.
    await storeFormat(season.id, null);
    await advanceTiebreakerWeek(season.id);
    expect(await tiebreakers()).toBe(2);
  });
});
