import { afterEach, describe, expect, it, vi } from "vitest";

// setSeriesLengths once wrote only the Season: every fixture copies its length
// when it is created, so a grand final built as a Bo5 stayed Bo5 however often
// an admin saved "Bo3" (the live US final, 2026-09-29). The save now moves
// every fixture that has not started, in a Serializable transaction that the
// bracket build cannot slip a stale-length round past.
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

import { setSeriesLengths } from "@/app/actions/admin-season";
import { recordResult } from "@/app/actions/admin-schedule-results";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import {
  advancePlayoffBracket,
  createPlayoffBracket,
} from "@/lib/playoff-service";
import { playedSeriesFinalError } from "@/lib/standings";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  addGameToMatch,
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  ON_POSTGRES,
  raceAll,
  recordMatch,
} from "./factories";

afterEach(() => setRaceHook(null));

const DAY_MS = 24 * 60 * 60 * 1000;

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

/** The form exactly as /admin renders it for the season's current row. */
async function saveLengths(
  seasonId: string,
  lengths: { regular: number; playoff: number; final: number },
) {
  const season = await prisma.season.findUniqueOrThrow({
    where: { id: seasonId },
  });
  return setSeriesLengths(
    {},
    fd({
      expectedActiveSeasonId: season.id,
      expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
      regularBestOf: String(lengths.regular),
      playoffBestOf: String(lengths.playoff),
      finalBestOf: String(lengths.final),
    }),
  );
}

async function bestOf(matchId: string) {
  return (await prisma.match.findUniqueOrThrow({ where: { id: matchId } }))
    .bestOf;
}

/** Four seeded teams with a finished regular season (team 0 strongest). */
async function playedRegularSeason(seasonId: string) {
  const teams = [];
  for (let i = 0; i < 4; i++) teams.push(await makeTeam(seasonId, `Team ${i}`, i));
  const strength = new Map(teams.map((team, i) => [team.id, i]));
  await prisma.season.update({
    where: { id: seasonId },
    data: { status: SEASON_STATUS.REGULAR_SEASON },
  });
  for (const m of await generateRegularSchedule(seasonId)) {
    const homeStronger =
      strength.get(m.homeTeamId)! < strength.get(m.awayTeamId)!;
    await recordMatch(m.id, homeStronger ? 2 : 0, homeStronger ? 0 : 2);
  }
  return teams;
}

/** Semifinals played and the grand final built at the season's final length. */
async function builtFinal(seasonId: string) {
  await playedRegularSeason(seasonId);
  await createPlayoffBracket(seasonId);
  const semis = await prisma.match.findMany({
    where: { seasonId, phase: MATCH_PHASE.PLAYOFF },
  });
  for (const semi of semis) await recordMatch(semi.id, 2, 1);
  await advancePlayoffBracket(seasonId);
  const final = await prisma.match.findFirstOrThrow({
    where: { seasonId, phase: MATCH_PHASE.FINAL },
  });
  return { semis, final };
}

describe("setSeriesLengths — existing fixtures", () => {
  it("moves a grand final built before the setting changed", async () => {
    const season = await makeSeason({
      teamSize: 3,
      minTeams: 4,
      regularBestOf: 2,
      playoffBestOf: 3,
      finalBestOf: 5,
    });
    const { semis, final } = await builtFinal(season.id);
    expect(final.bestOf).toBe(5);
    // The admin saved Bo3 once already: the Season says Bo3, the final Bo5,
    // and the final is days away (the live US final on 2026-09-29).
    await prisma.season.update({
      where: { id: season.id },
      data: { finalBestOf: 3 },
    });
    await prisma.match.update({
      where: { id: final.id },
      data: { scheduledAt: new Date(Date.now() + 4 * DAY_MS) },
    });

    const result = await saveLengths(season.id, {
      regular: 2,
      playoff: 3,
      final: 3,
    });

    expect(result?.error).toBeUndefined();
    expect(result?.message).toBe(
      "Series lengths saved · regular Bo2, playoffs Bo3, final Bo3 · the grand final is now Bo3",
    );
    expect(await bestOf(final.id)).toBe(3);
    for (const semi of semis) expect(await bestOf(semi.id)).toBe(3);
    const regular = await prisma.match.findMany({
      where: { seasonId: season.id, phase: MATCH_PHASE.REGULAR },
      select: { bestOf: true },
    });
    expect(regular.length).toBeGreaterThan(0);
    expect(regular.every((m) => m.bestOf === 2)).toBe(true);
    const logged = await prisma.adminAction.findFirstOrThrow({
      where: { action: "setSeriesLengths" },
    });
    expect(logged.summary).toContain("the grand final is now Bo3");
  });

  it("keeps finished and under-way series at the length they are played at", async () => {
    const season = await makeSeason({
      status: SEASON_STATUS.REGULAR_SEASON,
      regularBestOf: 2,
    });
    const other = await makeSeason({ name: "Archived", isActive: false });
    const [a, b] = [
      await makeTeam(season.id, "Alpha", 0),
      await makeTeam(season.id, "Bravo", 1),
    ];
    const [c, d] = [
      await makeTeam(other.id, "Charlie", 0),
      await makeTeam(other.id, "Delta", 1),
    ];
    const fixture = (
      week: number,
      extra: Partial<{
        phase: string;
        status: string;
        homeScore: number;
        winnerTeamId: string;
        bestOf: number;
        scheduledAt: Date;
      }> = {},
    ) =>
      prisma.match.create({
        data: {
          seasonId: season.id,
          week,
          phase: MATCH_PHASE.REGULAR,
          homeTeamId: a.id,
          awayTeamId: b.id,
          bestOf: 2,
          ...extra,
        },
      });
    const finished = await fixture(1, {
      status: MATCH_STATUS.COMPLETED,
      homeScore: 2,
      winnerTeamId: a.id,
    });
    const unstarted = await fixture(2);
    const scored = await fixture(3, { homeScore: 1 });
    const withGame = await fixture(4);
    await addGameToMatch(withGame.id, "9000000001", a.id);
    const live = await fixture(5, { status: MATCH_STATUS.LIVE });
    const tiebreaker = await fixture(6, {
      phase: MATCH_PHASE.TIEBREAKER,
      bestOf: 1,
    });
    // Kicked off yesterday with nothing imported: it may have been played.
    const pastKickoff = await fixture(7, {
      scheduledAt: new Date(Date.now() - DAY_MS),
    });
    const nextWeek = await fixture(8, {
      scheduledAt: new Date(Date.now() + 7 * DAY_MS),
    });
    const elsewhere = await prisma.match.create({
      data: {
        seasonId: other.id,
        week: 1,
        homeTeamId: c.id,
        awayTeamId: d.id,
        bestOf: 2,
      },
    });

    const result = await saveLengths(season.id, {
      regular: 3,
      playoff: 3,
      final: 5,
    });

    expect(result?.message).toBe(
      "Series lengths saved · regular Bo3, playoffs Bo3, final Bo5" +
        " · 2 regular-season matches are now Bo3" +
        " · 3 regular-season matches are already under way and keep their length" +
        " · 1 regular-season match is past its kickoff with no result yet and keeps its length",
    );
    expect(await bestOf(unstarted.id)).toBe(3);
    expect(await bestOf(nextWeek.id)).toBe(3);
    expect(await bestOf(pastKickoff.id)).toBe(2);
    expect(await bestOf(finished.id)).toBe(2);
    expect(await bestOf(scored.id)).toBe(2);
    expect(await bestOf(withGame.id)).toBe(2);
    expect(await bestOf(live.id)).toBe(2);
    expect(await bestOf(tiebreaker.id)).toBe(1);
    expect(await bestOf(elsewhere.id)).toBe(2);
  });

  it("moves nothing when the form was rendered from an older season row", async () => {
    const season = await makeSeason({
      status: SEASON_STATUS.PLAYOFFS,
      finalBestOf: 5,
    });
    const [a, b] = [
      await makeTeam(season.id, "Alpha", 0),
      await makeTeam(season.id, "Bravo", 1),
    ];
    const final = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 8,
        phase: MATCH_PHASE.FINAL,
        bracketSlot: "R1M0",
        homeTeamId: a.id,
        awayTeamId: b.id,
        bestOf: 5,
      },
    });
    const rendered = await prisma.season.findUniqueOrThrow({
      where: { id: season.id },
    });
    // Another admin saves something first; this form is now stale.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await prisma.season.update({
      where: { id: season.id },
      data: { name: "Renamed meanwhile" },
    });

    const result = await setSeriesLengths(
      {},
      fd({
        expectedActiveSeasonId: rendered.id,
        expectedSeasonUpdatedAt: rendered.updatedAt.toISOString(),
        regularBestOf: "2",
        playoffBestOf: "3",
        finalBestOf: "3",
      }),
    );

    expect(result?.error).toMatch(/reload/i);
    expect(await bestOf(final.id)).toBe(5);
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .finalBestOf,
    ).toBe(5);
  });
});

describe("setSeriesLengths — races", () => {
  it("never leaves a recorded final scored for a length it no longer has", async () => {
    const rounds = ON_POSTGRES ? 4 : 1;
    for (let round = 0; round < rounds; round++) {
      const season = await makeSeason({
        name: `Race ${round}`,
        teamSize: 3,
        minTeams: 4,
        regularBestOf: 2,
        playoffBestOf: 3,
        finalBestOf: 5,
      });
      const { final } = await builtFinal(season.id);

      // 3-1 is a finished Bo5 but impossible in a Bo3.
      await raceAll([
        () => saveLengths(season.id, { regular: 2, playoff: 3, final: 3 }),
        () =>
          recordResult(
            {},
            fd({
              matchId: final.id,
              homeScore: "3",
              awayScore: "1",
              expectedActiveSeasonId: season.id,
            }),
          ),
      ]);

      const after = await prisma.match.findUniqueOrThrow({
        where: { id: final.id },
      });
      if (after.status === MATCH_STATUS.COMPLETED) {
        expect(
          playedSeriesFinalError(after.bestOf, after.homeScore, after.awayScore),
        ).toBeNull();
      } else {
        expect(after.bestOf).toBe(3);
      }
      await prisma.season.update({
        where: { id: season.id },
        data: { isActive: false },
      });
    }
  });

  it("refuses a result judged against the old length when a save lands first", async () => {
    const season = await makeSeason({
      teamSize: 3,
      minTeams: 4,
      regularBestOf: 2,
      playoffBestOf: 3,
      finalBestOf: 5,
    });
    const { final } = await builtFinal(season.id);
    // recordResult has validated 3-1 against Bo5; the Bo3 save commits before
    // its transaction re-reads the match.
    let fired = false;
    setRaceHook(
      onceAt("recordResult.beforeSwap", async () => {
        fired = true;
        await saveLengths(season.id, { regular: 2, playoff: 3, final: 3 });
      }),
    );

    const result = await recordResult(
      {},
      fd({
        matchId: final.id,
        homeScore: "3",
        awayScore: "1",
        expectedActiveSeasonId: season.id,
      }),
    );

    expect(fired).toBe(true);
    expect(result?.error).toMatch(/best-of-3/i);
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: final.id } }),
    ).toMatchObject({ status: MATCH_STATUS.SCHEDULED, bestOf: 3 });
  });

  it("moves nothing when another settings save lands before its transaction", async () => {
    const season = await makeSeason({
      status: SEASON_STATUS.PLAYOFFS,
      finalBestOf: 5,
    });
    const [a, b] = [
      await makeTeam(season.id, "Alpha", 0),
      await makeTeam(season.id, "Bravo", 1),
    ];
    const final = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 8,
        phase: MATCH_PHASE.FINAL,
        bracketSlot: "R1M0",
        homeTeamId: a.id,
        awayTeamId: b.id,
        bestOf: 5,
      },
    });
    let fired = false;
    setRaceHook(
      onceAt("admin.setSeriesLengths.beforeTransaction", async () => {
        fired = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await prisma.season.update({
          where: { id: season.id },
          data: { name: "Renamed meanwhile" },
        });
      }),
    );

    const result = await saveLengths(season.id, {
      regular: 2,
      playoff: 3,
      final: 3,
    });

    expect(fired).toBe(true);
    expect(result?.error).toMatch(/season changed before this setting/i);
    expect(await bestOf(final.id)).toBe(5);
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .finalBestOf,
    ).toBe(5);
  });

  describe.skipIf(!ON_POSTGRES)("Postgres interleavings", () => {
    it("does not let a bracket build that read the old length commit the final at it", async () => {
      const season = await makeSeason({
        teamSize: 3,
        minTeams: 4,
        regularBestOf: 2,
        playoffBestOf: 3,
        finalBestOf: 5,
      });
      await playedRegularSeason(season.id);
      await createPlayoffBracket(season.id);
      const semis = await prisma.match.findMany({
        where: { seasonId: season.id, phase: MATCH_PHASE.PLAYOFF },
      });
      for (const semi of semis) await recordMatch(semi.id, 2, 1);

      // The build has read finalBestOf 5 inside its transaction; the admin's
      // Bo3 save commits before it writes the final.
      let fired = false;
      let saved: Awaited<ReturnType<typeof saveLengths>> | null = null;
      setRaceHook(
        onceAt("playoffs.advance.afterConfigRead", async () => {
          fired = true;
          saved = await saveLengths(season.id, {
            regular: 2,
            playoff: 3,
            final: 3,
          });
        }),
      );
      await advancePlayoffBracket(season.id);
      setRaceHook(null);
      // A build that lost the conflict is retried by the worker's next run.
      await advancePlayoffBracket(season.id);

      expect(fired).toBe(true);
      expect(saved).toMatchObject({
        message: expect.stringContaining("final Bo3"),
      });
      const finals = await prisma.match.findMany({
        where: { seasonId: season.id, phase: MATCH_PHASE.FINAL },
      });
      expect(finals).toHaveLength(1);
      expect(finals[0].bestOf).toBe(3);
    });
  });
});
