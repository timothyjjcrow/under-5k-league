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
import {
  generateSchedule,
  recordResult,
  swapGroupTeams,
} from "@/app/actions/admin-schedule-results";
import { saveSeasonFormat } from "@/app/actions/admin-season";
import { recentAdminActions } from "@/lib/admin-log";
import { SETTING_KEYS } from "@/lib/settings";
import { createPlayoffBracket } from "@/lib/playoff-service";
import { advanceTiebreakerWeek, createTiebreakerWeek } from "@/lib/tiebreaker-service";
import { FORMAT_UNREADABLE_MESSAGE, serializeFormatConfig } from "@/lib/season-format";
import { projectPlayoffField } from "@/lib/playoff-field";
import { matchNightForWeek } from "@/lib/schedule";
import { DRAFT_STATUS, MATCH_PHASE, SEASON_STATUS } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import { onceAt, setRaceHook } from "@/lib/race-hook";
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
    expect(res?.message).toMatch(/One table · the top 4 make the playoffs · 36 matches over 9 week\(s\)/);
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

async function storeFormat(seasonId: string, formatConfig: string | null) {
  await prisma.season.update({ where: { id: seasonId }, data: { formatConfig } });
}
const generate = async (seasonId: string) =>
  generateSchedule(empty, fd({ ...firstNightFields(), ...(await scheduleClaim(seasonId)) }));

describe("a season that stores its format", () => {
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

describe("the season builder", () => {
  const claimOf = async (seasonId: string) => {
    const season = await prisma.season.findUniqueOrThrow({ where: { id: seasonId } });
    return {
      expectedActiveSeasonId: season.id,
      expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
    };
  };
  const custom = (groups: number, meet: number, playoffs: number) => ({
    formatChoice: "CUSTOM",
    groups: String(groups),
    meet: String(meet),
    playoffs: String(playoffs),
  });
  const save = async (seasonId: string, fields: Record<string, string>) =>
    saveSeasonFormat(empty, fd({ ...(await claimOf(seasonId)), ...fields }));
  const stored = async (seasonId: string) =>
    (await prisma.season.findUniqueOrThrow({ where: { id: seasonId } })).formatConfig;
  const fixtureIds = async (seasonId: string) =>
    (await prisma.match.findMany({ where: { seasonId }, orderBy: { id: "asc" } })).map((m) => m.id);
  const generateWith = async (
    seasonId: string,
    fields: Record<string, string>,
    expectedFormat = "RECOMMENDED",
  ) =>
    generateSchedule(
      empty,
      fd({ ...firstNightFields(), ...(await scheduleClaim(seasonId)), expectedFormat, ...fields }),
    );

  it("saves a layout during signups, even one today's captains can't fill, and resets it", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    for (let i = 0; i < 5; i++) await makeTeam(season.id, `Captain ${i}`, i);
    const saved = await save(season.id, custom(2, 1, 4));
    expect(saved?.error).toBeUndefined();
    expect(saved?.message).toMatch(/^Season format saved · Two groups, top 2 of each/);
    // Captains can still change, so it saves, and the toast says what fails.
    expect(saved?.message).toMatch(
      /with 5 captains today it can't be generated: Two groups need at least 6 teams, 3 in each; there are 5\./,
    );
    expect(await stored(season.id)).toBe(serializeFormatConfig({ groups: 2, meet: 1, playoffs: 4 }));
    const [logged] = await recentAdminActions(1);
    expect(logged).toMatchObject({ action: "saveSeasonFormat", seasonId: season.id });
    expect(logged.summary).toMatch(/→ Two groups, top 2 of each/);

    const reset = await save(season.id, { formatChoice: "RECOMMENDED" });
    expect(reset?.message).toMatch(/^Season format saved · Recommended/);
    expect(await stored(season.id)).toBeNull();
  });

  it("refuses a layout the final team count can't build, once the auction has run", async () => {
    const { season } = await draftedSeason(5);
    const res = await save(season.id, custom(2, 1, 4));
    expect(res?.error).toBe(
      "This layout doesn't fit the season's 5 teams: Two groups need at least 6 teams, 3 in each; there are 5. Nothing was changed.",
    );
    expect(await stored(season.id)).toBeNull();
  });

  it("refuses a malformed choice instead of clamping it", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    for (const fields of [custom(3, 1, 4), custom(2, 3, 4), custom(2, 1, 6), { formatChoice: "BOTH" }]) {
      const res = await save(season.id, fields);
      expect(res?.error, JSON.stringify(fields)).toMatch(/^Pick Recommended, or a layout/);
    }
    expect(await stored(season.id)).toBeNull();
  });

  it("refuses a stale form: another save landed after the page rendered", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    for (let i = 0; i < 8; i++) await makeTeam(season.id, `Captain ${i}`, i);
    const rendered = await claimOf(season.id);
    expect((await save(season.id, custom(2, 1, 4)))?.error).toBeUndefined();
    const stale = await saveSeasonFormat(empty, fd({ ...rendered, ...custom(1, 1, 8) }));
    expect(stale?.error).toMatch(/while this page was open — reload/);
    expect(await stored(season.id)).toBe(serializeFormatConfig({ groups: 2, meet: 1, playoffs: 4 }));
  });

  it("changes only the playoff places of a built season, keeping every fixture and check-in", async () => {
    const { season } = await draftedSeason(10);
    expect((await generate(season.id))?.error).toBeUndefined();
    const before = await fixtureIds(season.id);
    const player = await makePlayer(season.id, "Checked in", 3000);
    await prisma.matchAvailability.create({
      data: { matchId: before[0], userId: player.id, status: "IN" },
    });
    const groups = await groupsOf(season.id);
    const stampOf = async () =>
      (await prisma.setting.findUnique({ where: { key: SETTING_KEYS.RESULT_CHANGED_AT } }))?.value ??
      null;
    await prisma.setting.deleteMany({ where: { key: SETTING_KEYS.RESULT_CHANGED_AT } });

    // Two groups, top 4 of each, saved as a custom layout: Recommended's own
    // cut, so nothing a player sees moves and the stamp stays put.
    const same = await save(season.id, custom(2, 1, 8));
    expect(same?.message).toMatch(/the fixtures and the playoff places stay as they are/);
    expect(same?.message).not.toMatch(/only the playoff places changed/);
    expect(await stampOf()).toBeNull();

    const res = await save(season.id, custom(2, 1, 4));
    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/the fixtures stay as they are; only the playoff places changed/);
    // Public snapshots are keyed on the result stamp: the cut moved.
    expect(await stampOf()).not.toBeNull();
    expect(await stored(season.id)).toBe(serializeFormatConfig({ groups: 2, meet: 1, playoffs: 4 }));
    expect(await fixtureIds(season.id)).toEqual(before);
    expect(await groupsOf(season.id)).toEqual(groups);
    expect(await prisma.matchAvailability.count({ where: { matchId: before[0] } })).toBe(1);
    // The field now sends the top 2 of each group.
    const field = projectPlayoffField(
      await prisma.team.findMany({ where: { seasonId: season.id } }),
      await prisma.match.findMany({ where: { seasonId: season.id } }),
      { formatConfig: await stored(season.id) },
    );
    expect(field.bracketSize).toBe(4);
  });

  it("sends a change to the groups or rounds of a built season through Regenerate", async () => {
    const { season } = await draftedSeason(10);
    await generate(season.id);
    const before = await fixtureIds(season.id);
    for (const fields of [custom(1, 1, 4), custom(2, 2, 8)]) {
      const res = await save(season.id, fields);
      expect(res?.error, JSON.stringify(fields)).toBe(
        "That changes the groups or how often teams meet, so the fixtures must be rebuilt. Use Regenerate schedule, which saves the layout with its new fixtures. Nothing was changed.",
      );
    }
    expect(await stored(season.id)).toBeNull();
    expect(await fixtureIds(season.id)).toEqual(before);
  });

  it("locks the format while a regular result stands, and a reopen unlocks it", async () => {
    const { season } = await draftedSeason(6);
    await generate(season.id);
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.REGULAR_SEASON },
    });
    const [first] = await prisma.match.findMany({ where: { seasonId: season.id }, orderBy: { id: "asc" } });
    await recordMatch(first.id, 2, 0);
    const locked = await save(season.id, custom(1, 1, 2));
    expect(locked?.error).toBe(
      "Results are in, so this season's format is locked: it decides the playoff places those results count towards. Nothing was changed.",
    );
    expect(await stored(season.id)).toBeNull();

    await prisma.match.update({
      where: { id: first.id },
      data: { status: "SCHEDULED", homeScore: 0, awayScore: 0, winnerTeamId: null },
    });
    expect((await save(season.id, custom(1, 1, 2)))?.error).toBeUndefined();
    expect(await stored(season.id)).toBe(serializeFormatConfig({ groups: 1, meet: 1, playoffs: 2 }));
  });

  it("locks the format in the playoffs", async () => {
    const { season } = await draftedSeason(4);
    await prisma.season.update({ where: { id: season.id }, data: { status: SEASON_STATUS.PLAYOFFS } });
    const res = await save(season.id, custom(1, 1, 2));
    expect(res?.error).toBe("The playoffs have started, so this season's format is locked. Nothing was changed.");
  });

  it("generates the layout the card posted and saves it with the fixtures", async () => {
    const { season } = await draftedSeason(8);
    const res = await generateWith(season.id, custom(2, 1, 4));
    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/Two groups of 4, drawn by roster MMR/);
    // The cut isn't the team count's any more, so the toast and log name it.
    expect(res?.message).toMatch(/ · the top 2 of each group make the playoffs · /);
    const [logged] = await recentAdminActions(1);
    expect(logged.summary).toMatch(/two groups of 4 · the top 2 of each group make the playoffs/);
    expect(await stored(season.id)).toBe(serializeFormatConfig({ groups: 2, meet: 1, playoffs: 4 }));
    const groups = await groupsOf(season.id);
    expect([groups.A.length, groups.B.length, groups.none.length]).toEqual([4, 4, 0]);
  });

  it("regenerates a built season as the new layout: groups, fixtures and format together", async () => {
    const { season } = await draftedSeason(10);
    await generate(season.id);
    const before = await fixtureIds(season.id);
    const res = await generateWith(season.id, custom(1, 1, 4));
    expect(res?.error).toBeUndefined();
    const after = await fixtureIds(season.id);
    expect(after).toHaveLength(45);
    expect(after.some((id) => before.includes(id))).toBe(false);
    expect((await groupsOf(season.id)).none).toHaveLength(10);
    expect(await stored(season.id)).toBe(serializeFormatConfig({ groups: 1, meet: 1, playoffs: 4 }));
  });

  it("generates Recommended over a stored custom layout and clears it", async () => {
    const { season } = await draftedSeason(8);
    const customJson = serializeFormatConfig({ groups: 2, meet: 1, playoffs: 4 })!;
    await storeFormat(season.id, customJson);
    const res = await generateWith(season.id, { formatChoice: "RECOMMENDED" }, customJson);
    expect(res?.error).toBeUndefined();
    // One table of 8, as the card previewed, not the stored two groups.
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(28);
    expect((await groupsOf(season.id)).none).toHaveLength(8);
    expect(await stored(season.id)).toBeNull();
  });

  it("replaces a format it can't read only with a layout the admin posted", async () => {
    const unreadable = '{"v":2,"groups":3}';
    const { season } = await draftedSeason(8);
    await storeFormat(season.id, unreadable);
    // The card's Generate posts its layout: that replaces the value.
    const res = await generateWith(season.id, custom(2, 1, 4), unreadable);
    expect(res?.error).toBeUndefined();
    expect(await stored(season.id)).toBe(serializeFormatConfig({ groups: 2, meet: 1, playoffs: 4 }));
    const built = await fixtureIds(season.id);
    expect(built).toHaveLength(12);

    // Built, then unreadable again (a rollback past a newer release that
    // rebuilt it): a save can't tell whether the fixtures fit, so it refuses
    // and sends the admin to Regenerate, which may still replace it.
    await storeFormat(season.id, unreadable);
    const saved = await save(season.id, custom(2, 1, 2));
    expect(saved?.error).toBe(
      "These fixtures were built from a format saved by a newer version of the site, so this version can't tell whether a new layout keeps them. Use Regenerate schedule, which saves the layout with its new fixtures. Nothing was changed.",
    );
    expect(await stored(season.id)).toBe(unreadable);
    expect(await fixtureIds(season.id)).toEqual(built);
    // A form with no layout (a swap, an old tab) still refuses.
    const plain = await generate(season.id);
    expect(plain?.error).toBe(FORMAT_UNREADABLE_MESSAGE);
    const regenerated = await generateWith(season.id, { formatChoice: "RECOMMENDED" }, unreadable);
    expect(regenerated?.error).toBeUndefined();
    expect(await stored(season.id)).toBeNull();
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(28);
  });

  it("refuses a posted layout when the format changed after the page rendered", async () => {
    const { season } = await draftedSeason(8);
    // Another admin saved two groups; this page still showed Recommended.
    await storeFormat(season.id, serializeFormatConfig({ groups: 2, meet: 1, playoffs: 4 }));
    const res = await generateWith(season.id, custom(1, 1, 8), "RECOMMENDED");
    expect(res?.error).toBe(
      "The season format changed while this page was open. Nothing was changed; reload to see it.",
    );
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(0);
    expect(await stored(season.id)).toBe(serializeFormatConfig({ groups: 2, meet: 1, playoffs: 4 }));
  });

  it("refuses a posted layout the teams can't fill, and a form that doesn't say what it showed", async () => {
    const { season } = await draftedSeason(5);
    const unfit = await generateWith(season.id, custom(2, 1, 4));
    expect(unfit?.error).toBe(
      "This layout doesn't fit the season's teams: Two groups need at least 6 teams, 3 in each; there are 5. Nothing was changed.",
    );
    const unclaimed = await generateSchedule(
      empty,
      fd({ ...firstNightFields(), ...(await scheduleClaim(season.id)), ...custom(1, 1, 4) }),
    );
    expect(unclaimed?.error).toBe("This schedule form is stale — reload before generating the schedule.");
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(0);
    expect(await stored(season.id)).toBeNull();
  });

  // The two write-skew pairs. SQLite serializes writers, so only Postgres
  // can interleave them; each rival commits between the reads and the write.
  describe.skipIf(!ON_POSTGRES)("against a rival in the same moment", () => {
    it("a save loses to the season's first result and is refused as locked", async () => {
      const { season } = await draftedSeason(10);
      await generate(season.id);
      await prisma.season.update({
        where: { id: season.id },
        data: { status: SEASON_STATUS.REGULAR_SEASON },
      });
      const [first] = await prisma.match.findMany({
        where: { seasonId: season.id },
        orderBy: { id: "asc" },
      });
      let fired = false;
      setRaceHook(
        onceAt("admin.updateRenderedSeason.beforeWrite", async () => {
          fired = true;
          const recorded = await recordResult(
            empty,
            fd({ matchId: first.id, homeScore: "2", awayScore: "0" }),
          );
          expect(recorded?.error).toBeUndefined();
        }),
      );
      // Read with no result in: a playoff-places change is allowed then.
      const res = await save(season.id, custom(2, 1, 4));
      expect(fired).toBe(true);
      expect(res?.error).toMatch(/^Results are in, so this season's format is locked/);
      expect(await stored(season.id)).toBeNull();
      expect(
        (await prisma.match.findUniqueOrThrow({ where: { id: first.id } })).status,
      ).toBe("COMPLETED");
    });

    it("a rebuild loses to a format save and builds nothing from the old format", async () => {
      const { season } = await draftedSeason(8);
      let fired = false;
      let saved: ActionResult | undefined;
      setRaceHook(
        onceAt("admin.generateSchedule.afterRead", async () => {
          fired = true;
          saved = await save(season.id, custom(1, 1, 2));
        }),
      );
      // Built from Recommended (one table, top 4) as the page showed it.
      const res = await generateWith(season.id, { formatChoice: "RECOMMENDED" });
      expect(fired).toBe(true);
      expect(saved?.error).toBeUndefined();
      expect(res?.error).toMatch(/nothing was changed/i);
      expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(0);
      expect(await stored(season.id)).toBe(serializeFormatConfig({ groups: 1, meet: 1, playoffs: 2 }));
    });
  });
});
