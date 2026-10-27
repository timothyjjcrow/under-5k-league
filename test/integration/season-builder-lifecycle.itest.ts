/**
 * Every layout the season builder offers, played from Generate to a champion
 * (2026-10-24). Each layout runs twice: once with decided results (no tie
 * anywhere), once with every regular match drawn, so every place in every
 * group is settled by the tiebreaker week before the playoffs seed. The rules
 * themselves are unit-tested (season-builder.test.ts, season-format.test.ts,
 * playoff-field.test.ts); this pins that the services agree with them end to
 * end: the fixtures the preview promised, the post that names the cut, the
 * tiebreakers judged against each layout's own cut, the bracket the field
 * sizes, and its rounds on the weeks the plan printed.
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
import { generateSchedule, recordResult } from "@/app/actions/admin-schedule-results";
import { setSeasonPhase } from "@/app/actions/admin-season";
import { sendDiscordMessage } from "@/lib/discord";
import { createPlayoffBracket } from "@/lib/playoff-service";
import { advanceTiebreakerWeek, createTiebreakerWeek } from "@/lib/tiebreaker-service";
import { projectPlayoffField } from "@/lib/playoff-field";
import { regularFixtureCount } from "@/lib/season-builder";
import {
  buildSeasonFormat,
  firstPlayoffWeek,
  formatName,
  playoffEntrantsPhrase,
  seasonPlan,
  serializeFormatConfig,
  type FormatKnobs,
  type SeasonFormat,
} from "@/lib/season-format";
import { DRAFT_STATUS, MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import { setRaceHook } from "@/lib/race-hook";
import {
  drivePlayoffsToChampion,
  makePlayer,
  makeSeason,
  makeTeam,
  recordMatch,
  resetDb,
  scheduleClaim,
} from "./factories";

const fd = (values: Record<string, string>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.append(key, value);
  return form;
};
const empty: ActionResult = {};

beforeEach(resetDb);
afterEach(() => {
  setRaceHook(null);
  vi.mocked(sendDiscordMessage).mockClear();
});

/** A post-auction season; team 0's roster has the highest signup MMR. */
async function draftedSeason(count: number) {
  const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
  await prisma.draft.create({ data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE } });
  const teams = [];
  for (let i = 0; i < count; i++) {
    const team = await makeTeam(season.id, `Roster ${i}`, i);
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

const matchesOf = (seasonId: string) =>
  prisma.match.findMany({ where: { seasonId }, orderBy: [{ week: "asc" }, { id: "asc" }] });

async function fieldOf(seasonId: string) {
  const season = await prisma.season.findUniqueOrThrow({ where: { id: seasonId } });
  return projectPlayoffField(
    await prisma.team.findMany({ where: { seasonId } }),
    await matchesOf(seasonId),
    season,
  );
}

/** Play every scheduled tiebreaker game (home side wins) until the field settles. */
async function settleTiebreakers(seasonId: string): Promise<number> {
  await createTiebreakerWeek(seasonId);
  let played = 0;
  for (let guard = 0; guard < 200; guard++) {
    const pending = (await matchesOf(seasonId)).find(
      (m) => m.phase === MATCH_PHASE.TIEBREAKER && m.status !== MATCH_STATUS.COMPLETED,
    );
    if (pending) {
      const res = await recordResult(
        empty,
        fd({ matchId: pending.id, homeScore: "1", awayScore: "0" }),
      );
      expect(res?.error, "a tiebreaker result").toBeUndefined();
      played++;
      continue;
    }
    await advanceTiebreakerWeek(seasonId);
    const field = await fieldOf(seasonId);
    if (field.tiebreakers.resolved) return played;
    // Nothing scheduled and still unresolved: the next reviewed stage.
    await createTiebreakerWeek(seasonId);
  }
  throw new Error("the tiebreakers never settled");
}

type Layout = { teams: number } & FormatKnobs;

// Every builder choice, at counts that reach the shapes the Recommended rule
// never made: a final straight after the table, a top 8 of 9 or 10, tables
// and groups played twice, groups of 3, group winners only, the top 2 of each.
const LAYOUTS: Layout[] = [
  { teams: 5, groups: 1, meet: 1, playoffs: 2 },
  { teams: 6, groups: 1, meet: 1, playoffs: 4 },
  { teams: 9, groups: 1, meet: 1, playoffs: 8 },
  { teams: 10, groups: 1, meet: 1, playoffs: 8 },
  { teams: 5, groups: 1, meet: 2, playoffs: 2 },
  { teams: 6, groups: 1, meet: 2, playoffs: 4 },
  { teams: 6, groups: 2, meet: 2, playoffs: 2 },
  { teams: 7, groups: 2, meet: 1, playoffs: 2 },
  { teams: 8, groups: 2, meet: 1, playoffs: 8 },
  { teams: 12, groups: 2, meet: 2, playoffs: 4 },
  { teams: 12, groups: 2, meet: 2, playoffs: 8 },
  { teams: 13, groups: 2, meet: 1, playoffs: 4 },
  { teams: 13, groups: 2, meet: 1, playoffs: 8 },
];

const label = ({ teams, ...knobs }: Layout) =>
  `${teams} teams, ${knobs.groups === 2 ? "two groups" : "one table"}, ${knobs.meet === 2 ? "twice" : "once"}, top ${knobs.playoffs}`;

/**
 * Generate the layout through the builder's form, start the regular season,
 * play it with `result`, and return what the schedule promised.
 */
async function playRegularSeason(
  layout: Layout,
  result: (home: number, away: number) => [number, number],
) {
  const { teams: count, ...knobs } = layout;
  const { season, teams } = await draftedSeason(count);
  const format = buildSeasonFormat(knobs, count)!;
  const night = new Date(Date.now() + 7 * 864e5);
  const generated = await generateSchedule(
    empty,
    fd({
      firstNight: "2026-11-07T14:00",
      firstNightTs: String(night.getTime()),
      ...(await scheduleClaim(season.id)),
      expectedFormat: "RECOMMENDED",
      formatChoice: "CUSTOM",
      groups: String(knobs.groups),
      meet: String(knobs.meet),
      playoffs: String(knobs.playoffs),
    }),
  );
  expect(generated?.error, "generate").toBeUndefined();
  const seasonRow = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });
  expect(seasonRow.formatConfig).toBe(serializeFormatConfig(knobs));

  // The fixtures the preview promised: count, weeks, groups, meetings.
  const regular = (await matchesOf(season.id)).filter((m) => m.phase === MATCH_PHASE.REGULAR);
  expect(regular).toHaveLength(regularFixtureCount(format));
  expect(Math.max(...regular.map((m) => m.week))).toBe(format.regularWeeks);
  const teamRows = await prisma.team.findMany({ where: { seasonId: season.id } });
  const groupOf = new Map(teamRows.map((team) => [team.id, team.groupKey]));
  if (format.kind === "GROUPS") {
    const sizes = ["A", "B"].map((key) => teamRows.filter((t) => t.groupKey === key).length);
    expect(sizes.sort((a, b) => b - a)).toEqual([...format.groupSizes].sort((a, b) => b - a));
    for (const m of regular) expect(groupOf.get(m.homeTeamId)).toBe(groupOf.get(m.awayTeamId));
  } else {
    expect(teamRows.every((team) => team.groupKey === null)).toBe(true);
  }
  const meetings = new Map<string, number>();
  for (const m of regular) {
    const pair = [m.homeTeamId, m.awayTeamId].sort().join(":");
    meetings.set(pair, (meetings.get(pair) ?? 0) + 1);
  }
  expect(new Set(meetings.values())).toEqual(new Set([knobs.meet]));
  for (const week of new Set(regular.map((m) => m.week))) {
    const playing = regular.filter((m) => m.week === week).flatMap((m) => [m.homeTeamId, m.awayTeamId]);
    expect(new Set(playing).size, `week ${week}: nobody plays twice`).toBe(playing.length);
  }

  // The season-start post names this layout's cut.
  const started = await setSeasonPhase(
    empty,
    fd({ phase: SEASON_STATUS.REGULAR_SEASON, expectedActiveSeasonId: season.id }),
  );
  expect(started?.error, "start the regular season").toBeUndefined();
  const post = vi.mocked(sendDiscordMessage).mock.calls.map(([content]) => String(content)).join("\n");
  expect(post).toContain(`${formatName(format)}: ${playoffEntrantsPhrase(format)} make the playoffs.`);

  const rank = new Map(teams.map((team, index) => [team.id, index]));
  for (const m of regular) {
    const [home, away] = result(rank.get(m.homeTeamId)!, rank.get(m.awayTeamId)!);
    await recordMatch(m.id, home, away);
  }
  return { season, teams, format, groupOf, lastRegularWeek: format.regularWeeks, firstNight: seasonRow.firstMatchNight! };
}

/** Seed the bracket and play it out; assert its shape and weeks on the way. */
async function playPlayoffs(
  seasonId: string,
  format: SeasonFormat,
  groupOf: Map<string, string | null>,
  lastRegularWeek: number,
  firstNight: Date,
) {
  const field = await fieldOf(seasonId);
  expect(field.tiebreakers.resolved).toBe(true);
  expect(field.kind).toBe(format.kind);
  expect(field.bracketSize).toBe(format.playoffSpots);
  expect(field.seededTeamIds).toHaveLength(format.playoffSpots);
  if (format.kind === "GROUPS") {
    // Each group sends its share.
    for (const key of ["A", "B"]) {
      expect(field.seededTeamIds.filter((id) => groupOf.get(id) === key)).toHaveLength(
        format.qualifiersPerGroup,
      );
    }
  }

  await createPlayoffBracket(seasonId);
  const all = await matchesOf(seasonId);
  const tiebreakerWeeks = all.filter((m) => m.phase === MATCH_PHASE.TIEBREAKER).map((m) => m.week);
  const lastTiebreakerWeek = tiebreakerWeeks.length ? Math.max(...tiebreakerWeeks) : 0;
  const roundOne = all.filter((m) => m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL);
  expect(roundOne).toHaveLength(format.playoffSpots / 2);
  // A bracket of two is the grand final itself.
  expect(roundOne.every((m) => m.phase === (format.playoffSpots === 2 ? MATCH_PHASE.FINAL : MATCH_PHASE.PLAYOFF))).toBe(true);
  // Round one plays where the plan printed it: two weeks after the last
  // regular week, the tiebreaker week between.
  const expectedWeek = firstPlayoffWeek(lastRegularWeek, lastTiebreakerWeek);
  expect(new Set(roundOne.map((m) => m.week))).toEqual(new Set([expectedWeek]));
  const plan = seasonPlan(format, firstNight, lastRegularWeek);
  expect(plan.find((step) => step.kind === "PLAYOFF")!.fromWeek).toBe(expectedWeek);
  if (format.kind === "GROUPS") {
    // A full field never pairs group-mates in round one.
    for (const m of roundOne) expect(groupOf.get(m.homeTeamId)).not.toBe(groupOf.get(m.awayTeamId));
  }

  const done = await drivePlayoffsToChampion(seasonId);
  expect(done.status).toBe(SEASON_STATUS.COMPLETE);
  expect(done.championTeamId).not.toBeNull();
  const bracket = (await matchesOf(seasonId)).filter(
    (m) => m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL,
  );
  // One match fewer than the field, one round per playoff week the plan
  // printed, the last of them the grand final.
  expect(bracket).toHaveLength(format.playoffSpots - 1);
  const weeks = [...new Set(bracket.map((m) => m.week))].sort((a, b) => a - b);
  expect(weeks).toHaveLength(format.playoffRounds);
  expect(weeks).toEqual(plan.filter((step) => step.kind === "PLAYOFF").map((step) => step.fromWeek));
  const final = bracket.filter((m) => m.phase === MATCH_PHASE.FINAL);
  expect(final).toHaveLength(1);
  expect(final[0].week).toBe(weeks[weeks.length - 1]);
  expect(done.championTeamId).toBe(final[0].winnerTeamId);
}

describe("every season-builder layout, from Generate to a champion", () => {
  it.each(LAYOUTS)("decided results: $teams teams ($groups group(s), meet $meet, top $playoffs)", async (layout) => {
    // The stronger roster always wins 2–0: no tie anywhere, no tiebreaker.
    const { season, format, groupOf, lastRegularWeek, firstNight } = await playRegularSeason(
      layout,
      (home, away) => (home < away ? [2, 0] : [0, 2]),
    );
    const field = await fieldOf(season.id);
    expect(field.tiebreakers.groups.filter((group) => group.status === "needed"), label(layout)).toEqual([]);
    await playPlayoffs(season.id, format, groupOf, lastRegularWeek, firstNight);
    // The strongest roster tops its table or group and hosts every round.
    const done = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });
    const strongest = (await prisma.team.findFirstOrThrow({ where: { seasonId: season.id, draftOrder: 0 } })).id;
    expect(done.championTeamId).toBe(strongest);
  });

  it.each(LAYOUTS)("every match drawn: $teams teams ($groups group(s), meet $meet, top $playoffs)", async (layout) => {
    // Every team level in its table or group: the tiebreaker week settles
    // the cut and every seed before the playoffs can start.
    const { season, format, groupOf, lastRegularWeek, firstNight } = await playRegularSeason(
      layout,
      () => [1, 1],
    );
    await expect(createPlayoffBracket(season.id), "seeding waits for the tiebreakers").rejects.toThrow();
    const played = await settleTiebreakers(season.id);
    expect(played, label(layout)).toBeGreaterThan(0);
    // The opening tiebreaker games play in the reserved week.
    const tiebreakers = (await matchesOf(season.id)).filter((m) => m.phase === MATCH_PHASE.TIEBREAKER);
    expect(Math.min(...tiebreakers.map((m) => m.week))).toBe(lastRegularWeek + 1);
    await playPlayoffs(season.id, format, groupOf, lastRegularWeek, firstNight);
  });
});
