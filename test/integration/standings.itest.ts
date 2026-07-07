import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  recordMatch,
} from "./factories";

async function matchesOf(seasonId: string) {
  return prisma.match.findMany({ where: { seasonId } });
}

describe("regular season → standings (integration)", () => {
  it("ranks a fully-played round robin by points, then game diff", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 3 });
    const teams = [];
    for (let i = 0; i < 3; i++) {
      teams.push(await makeTeam(season.id, `Team ${i}`, i));
    }
    const ids = teams.map((t) => t.id);
    const strength = new Map(ids.map((id, i) => [id, i])); // lower index = stronger

    const matches = await generateRegularSchedule(season.id);
    expect(matches).toHaveLength(3); // C(3,2)

    // The stronger team wins every match 2-0, regardless of home/away.
    for (const m of matches) {
      const homeStronger =
        strength.get(m.homeTeamId)! < strength.get(m.awayTeamId)!;
      const [hs, as] = homeStronger ? [2, 0] : [0, 2];
      await recordMatch(m.id, hs, as);
    }

    const standings = computeStandings(ids, await matchesOf(season.id));
    expect(standings.map((s) => s.teamId)).toEqual(ids); // 0 > 1 > 2
    expect(standings[0]).toMatchObject({ points: 6, wins: 2, gameDiff: 4 });
    expect(standings[1]).toMatchObject({ points: 3, wins: 1, gameDiff: 0 });
    expect(standings[2]).toMatchObject({ points: 0, wins: 0, gameDiff: -4 });
  });

  it("counts only completed matches during a partial season", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 4 });
    for (let i = 0; i < 4; i++) await makeTeam(season.id, `Team ${i}`, i);
    const ids = (
      await prisma.team.findMany({ where: { seasonId: season.id } })
    ).map((t) => t.id);

    const matches = await generateRegularSchedule(season.id);
    await recordMatch(matches[0].id, 2, 1); // only one match played

    const standings = computeStandings(ids, await matchesOf(season.id));
    expect(standings.reduce((n, s) => n + s.played, 0)).toBe(2); // 1 match = 2 teams
    expect(standings.filter((s) => s.wins > 0)).toHaveLength(1);
  });

  it("awards a point to each team for a drawn series (e.g. a Bo2 1-1)", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 2 });
    const a = await makeTeam(season.id, "A", 0);
    const b = await makeTeam(season.id, "B", 1);
    const matches = await generateRegularSchedule(season.id);
    expect(await recordMatch(matches[0].id, 1, 1)).toBeNull(); // no winner

    const standings = computeStandings([a.id, b.id], await matchesOf(season.id));
    expect(
      standings.every((s) => s.points === 1 && s.draws === 1 && s.played === 1),
    ).toBe(true);
  });
});
