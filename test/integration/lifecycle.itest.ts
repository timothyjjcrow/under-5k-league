import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { capacityInfo } from "@/lib/capacity";
import { computeStandings } from "@/lib/standings";
import { getDraftState } from "@/lib/draft-service";
import { createPlayoffBracket } from "@/lib/playoff-service";
import {
  drivePlayoffsToChampion,
  generateRegularSchedule,
  makeCaptain,
  makePlayer,
  makeSeason,
  recordMatch,
  runDraftToCompletion,
  startDraftState,
} from "./factories";

describe("full league lifecycle (integration)", () => {
  it("runs a whole season: signup → draft → regular season → playoffs → champion", async () => {
    // ---- SIGNUPS ----
    const season = await makeSeason({ teamSize: 3, minTeams: 4, draftBudget: 100 });
    const captains = [];
    for (let i = 0; i < 4; i++) {
      captains.push(await makeCaptain(season.id, `Captain ${i}`, 100, i));
    }
    const teams = captains.map((c) => c.team);
    const orderOf = new Map(teams.map((t) => [t.id, t.draftOrder])); // lower = stronger
    for (let i = 0; i < 8; i++) {
      await makePlayer(season.id, `Player ${i}`, 3000 - i * 50);
    }

    const playerCount = await prisma.registration.count({
      where: { seasonId: season.id, type: "PLAYER", status: "ACTIVE" },
    });
    expect(playerCount).toBe(12); // 4 captains + 8 players
    expect(capacityInfo(season, playerCount).canDraft).toBe(true);

    // ---- DRAFT ----
    await startDraftState(season.id);
    await runDraftToCompletion(season.id);

    expect((await getDraftState(season.id, null))?.status).toBe("COMPLETE");
    const members = await prisma.teamMember.findMany({
      where: { seasonId: season.id },
    });
    expect(members).toHaveLength(12); // 4 teams x 3 (captain + 2)
    expect(new Set(members.map((m) => m.userId)).size).toBe(12); // no double-picks
    for (const t of teams) {
      expect(members.filter((m) => m.teamId === t.id)).toHaveLength(3);
    }
    for (const t of await prisma.team.findMany({ where: { seasonId: season.id } })) {
      expect(t.budget).toBeGreaterThanOrEqual(0);
    }

    // ---- REGULAR SEASON ----
    await prisma.season.update({
      where: { id: season.id },
      data: { status: "REGULAR_SEASON" },
    });
    const schedule = await generateRegularSchedule(season.id);
    expect(schedule).toHaveLength(6); // round robin of 4 teams = C(4,2)

    for (const m of schedule) {
      const homeStronger = orderOf.get(m.homeTeamId)! < orderOf.get(m.awayTeamId)!;
      await recordMatch(m.id, homeStronger ? 2 : 0, homeStronger ? 0 : 2);
    }
    const regularMatches = await prisma.match.findMany({
      where: { seasonId: season.id, phase: "REGULAR" },
    });
    expect(regularMatches.every((m) => m.status === "COMPLETED")).toBe(true);

    const standings = computeStandings(
      teams.map((t) => t.id),
      regularMatches,
    );
    expect(standings.map((s) => orderOf.get(s.teamId))).toEqual([0, 1, 2, 3]);
    expect(standings[0].wins).toBe(3); // top team swept the round robin

    // ---- PLAYOFFS → CHAMPION ----
    await createPlayoffBracket(season.id);
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .status,
    ).toBe("PLAYOFFS");

    const finalSeason = await drivePlayoffsToChampion(season.id);
    expect(finalSeason.status).toBe("COMPLETE");
    expect(finalSeason.championTeamId).not.toBeNull();
    // The #1 seed (draftOrder 0) wins home games all the way through.
    expect(orderOf.get(finalSeason.championTeamId!)).toBe(0);
  });
});
