import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { recomputeSeries } from "@/lib/match-import";
import { createPlayoffBracket } from "@/lib/playoff-service";
import { regularSeasonStatus } from "@/lib/schedule-status";
import {
  addGameToMatch,
  drivePlayoffsToChampion,
  generateRegularSchedule,
  makeCaptain,
  makePlayer,
  makeSeason,
  makeTeam,
  recordMatch,
  runDraftToCompletion,
  startDraftState,
} from "./factories";

// A fixed regular-season outcome by team index (0 = strongest). Exercises
// draws: T1 draws T3, T2 draws T3, everyone else is decisive.
function seriesResult(homeIdx: number, awayIdx: number): [number, number] {
  const lo = Math.min(homeIdx, awayIdx);
  const hi = Math.max(homeIdx, awayIdx);
  let winnerIdx: number | null;
  if (lo === 0) winnerIdx = 0; // T0 beats everyone
  else if (lo === 1 && hi === 2) winnerIdx = 1; // T1 beats T2
  else winnerIdx = null; // {1,3} and {2,3} draw
  if (winnerIdx === null) return [1, 1];
  return winnerIdx === homeIdx ? [2, 0] : [0, 2];
}

describe("full season with Bo2 draws → seeding → Bo3/Bo5 playoffs", () => {
  it("runs signup → draft → Bo2 regular season (with draws) → playoffs → champion", async () => {
    const season = await makeSeason({
      teamSize: 3,
      minTeams: 4,
      regularBestOf: 2,
      playoffBestOf: 3,
      finalBestOf: 5,
    });

    // ---- signup + draft ----
    const captains = [];
    for (let i = 0; i < 4; i++) {
      captains.push(await makeCaptain(season.id, `Captain ${i}`, 100, i));
    }
    for (let i = 0; i < 8; i++) await makePlayer(season.id, `Player ${i}`, 3000 - i * 50);
    await startDraftState(season.id);
    await runDraftToCompletion(season.id);

    const teams = captains.map((c) => c.team);
    const idxOf = new Map(teams.map((t) => [t.id, t.draftOrder])); // 0 = strongest

    // ---- Bo2 regular season with a fixed result set (incl. draws) ----
    await prisma.season.update({
      where: { id: season.id },
      data: { status: "REGULAR_SEASON" },
    });
    const schedule = await generateRegularSchedule(season.id);
    expect(schedule.every((m) => m.bestOf === 2)).toBe(true); // Bo2 weeks
    for (const m of schedule) {
      const [hs, as] = seriesResult(idxOf.get(m.homeTeamId)!, idxOf.get(m.awayTeamId)!);
      await recordMatch(m.id, hs, as);
    }

    // ---- standings must reflect draws ----
    const standings = computeStandings(
      teams.map((t) => t.id),
      await prisma.match.findMany({ where: { seasonId: season.id, phase: "REGULAR" } }),
    );
    // Final order: T0 (9) > T1 (4) > T3 (2) > T2 (1)
    expect(standings.map((s) => idxOf.get(s.teamId))).toEqual([0, 1, 3, 2]);
    const byIdx = (i: number) => standings.find((s) => idxOf.get(s.teamId) === i)!;
    expect(byIdx(0)).toMatchObject({ wins: 3, draws: 0, losses: 0, points: 9 });
    expect(byIdx(1)).toMatchObject({ wins: 1, draws: 1, losses: 1, points: 4 });
    expect(byIdx(3)).toMatchObject({ wins: 0, draws: 2, losses: 1, points: 2 });
    expect(byIdx(2)).toMatchObject({ wins: 0, draws: 1, losses: 2, points: 1 });

    // ---- playoff seeding must follow the standings (1v4, 2v3) ----
    await createPlayoffBracket(season.id);
    const r0 = await prisma.match.findMany({
      where: { seasonId: season.id, bracketSlot: { startsWith: "R0" } },
    });
    const semi0 = r0.find((m) => m.bracketSlot === "R0M0")!;
    const semi1 = r0.find((m) => m.bracketSlot === "R0M1")!;
    expect([idxOf.get(semi0.homeTeamId), idxOf.get(semi0.awayTeamId)]).toEqual([0, 2]); // 1 v 4
    expect([idxOf.get(semi1.homeTeamId), idxOf.get(semi1.awayTeamId)]).toEqual([1, 3]); // 2 v 3
    expect(r0.every((m) => m.bestOf === 3)).toBe(true); // Bo3 semifinals

    // ---- play the bracket out (Bo5 final) → champion is the #1 seed ----
    const finalSeason = await drivePlayoffsToChampion(season.id);
    expect(finalSeason.status).toBe("COMPLETE");
    expect(idxOf.get(finalSeason.championTeamId!)).toBe(0);
    const finalMatch = await prisma.match.findFirstOrThrow({
      where: { seasonId: season.id, phase: "FINAL" },
    });
    expect(finalMatch.bestOf).toBe(5); // Bo5 grand final
  });

  it("advances a playoff series via game imports only once the Bo3 is clinched", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 2, finalBestOf: 3 });
    for (let i = 0; i < 3; i++) await makeTeam(season.id, `T${i}`, i); // → bracket size 2 (final)
    await createPlayoffBracket(season.id);

    const final = (
      await prisma.match.findMany({
        where: { seasonId: season.id, phase: "FINAL" },
      })
    )[0];
    expect(final.bestOf).toBe(3);
    const winner = final.homeTeamId;

    await addGameToMatch(final.id, "pg1", winner); // 1-0: not clinched
    await recomputeSeries(final.id);
    let s = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });
    expect(s.status).toBe("PLAYOFFS"); // still going
    expect((await prisma.match.findUniqueOrThrow({ where: { id: final.id } })).status).toBe("LIVE");

    await addGameToMatch(final.id, "pg2", winner); // 2-0: clinched
    await recomputeSeries(final.id);
    s = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });
    expect(s.status).toBe("COMPLETE");
    expect(s.championTeamId).toBe(winner);
  });

  it("seeds an all-draws season deterministically (every team tied on points)", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 4, regularBestOf: 2 });
    for (let i = 0; i < 4; i++) await makeTeam(season.id, `Team ${i}`, i);
    const ids = (await prisma.team.findMany({ where: { seasonId: season.id } })).map((t) => t.id);
    await prisma.season.update({ where: { id: season.id }, data: { status: "REGULAR_SEASON" } });

    const schedule = await generateRegularSchedule(season.id);
    for (const m of schedule) await recordMatch(m.id, 1, 1); // every series drawn

    const standings = computeStandings(ids, await prisma.match.findMany({ where: { seasonId: season.id } }));
    expect(standings.every((s) => s.points === 3 && s.draws === 3 && s.wins === 0)).toBe(true);
    // No crash; bracket still seeds a full field.
    await createPlayoffBracket(season.id);
    const r0 = await prisma.match.findMany({
      where: { seasonId: season.id, bracketSlot: { startsWith: "R0" } },
    });
    expect(r0.flatMap((m) => [m.homeTeamId, m.awayTeamId])).toHaveLength(4);
    const finalSeason = await drivePlayoffsToChampion(season.id);
    expect(finalSeason.status).toBe("COMPLETE");
    expect(finalSeason.championTeamId).not.toBeNull();
  });

  it("flags an unfinished Bo2 as outstanding (so playoffs stay locked) until it's entered", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 2, regularBestOf: 2 });
    const a = await makeTeam(season.id, "A", 0);
    await makeTeam(season.id, "B", 1);
    await prisma.season.update({
      where: { id: season.id },
      data: { status: "REGULAR_SEASON" },
    });
    const [match] = await generateRegularSchedule(season.id);

    // Only ONE game of the Bo2 is in → the match is LIVE, not COMPLETED.
    await addGameToMatch(match.id, "g1", a.id);
    await recomputeSeries(match.id);
    let status = regularSeasonStatus(
      await prisma.match.findMany({ where: { seasonId: season.id } }),
    );
    expect(status.pending).toBe(1);
    expect(status.allComplete).toBe(false);

    // Finishing the series clears the outstanding flag.
    await addGameToMatch(match.id, "g2", a.id); // 2-0 → COMPLETED
    await recomputeSeries(match.id);
    status = regularSeasonStatus(
      await prisma.match.findMany({ where: { seasonId: season.id } }),
    );
    expect(status.pending).toBe(0);
    expect(status.allComplete).toBe(true);
  });
});
