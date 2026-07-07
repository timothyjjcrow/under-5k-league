import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  advancePlayoffBracket,
  createPlayoffBracket,
} from "@/lib/playoff-service";
import { pickBracketSize } from "@/lib/schedule";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  recordMatch,
} from "./factories";

/** Create n teams and play a full regular season so standings are deterministic:
 *  team i beats team j for i < j, making ids[0] the #1 seed. */
async function makeSeededTeams(seasonId: string, n: number) {
  const teams = [];
  for (let i = 0; i < n; i++) teams.push(await makeTeam(seasonId, `Team ${i}`, i));
  const ids = teams.map((t) => t.id);
  const strength = new Map(ids.map((id, i) => [id, i])); // lower index = stronger
  const matches = await generateRegularSchedule(seasonId);
  for (const m of matches) {
    const homeStronger =
      strength.get(m.homeTeamId)! < strength.get(m.awayTeamId)!;
    await recordMatch(m.id, homeStronger ? 2 : 0, homeStronger ? 0 : 2);
  }
  return ids;
}

async function playoffMatches(seasonId: string) {
  return prisma.match.findMany({
    where: { seasonId, phase: { in: ["PLAYOFF", "FINAL"] } },
  });
}

/** Record every open playoff match with the home team winning, advancing after
 *  each result (as recordResult does), until the season is COMPLETE. */
async function driveToChampion(seasonId: string) {
  for (let guard = 0; guard < 10; guard++) {
    const season = await prisma.season.findUniqueOrThrow({
      where: { id: seasonId },
    });
    if (season.status === "COMPLETE") return season;
    const open = await prisma.match.findMany({
      where: {
        seasonId,
        phase: { in: ["PLAYOFF", "FINAL"] },
        status: { not: "COMPLETED" },
      },
    });
    if (open.length === 0) break; // stuck but not complete → bug
    for (const m of open) {
      await recordMatch(m.id, 2, 0); // home (higher seed) wins
      await advancePlayoffBracket(seasonId);
    }
  }
  return prisma.season.findUniqueOrThrow({ where: { id: seasonId } });
}

describe("playoffs bracket + champion (integration)", () => {
  it("seeds 4 teams 1v4/2v3 and crowns the #1 seed", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 4 });
    const ids = await makeSeededTeams(season.id, 4);
    await createPlayoffBracket(season.id);

    const round0 = (await playoffMatches(season.id)).filter((m) =>
      m.bracketSlot?.startsWith("R0"),
    );
    expect(round0).toHaveLength(2);
    const semi0 = round0.find((m) => m.bracketSlot === "R0M0")!;
    expect([semi0.homeTeamId, semi0.awayTeamId]).toEqual([ids[0], ids[3]]);
    const semi1 = round0.find((m) => m.bracketSlot === "R0M1")!;
    expect([semi1.homeTeamId, semi1.awayTeamId]).toEqual([ids[1], ids[2]]);

    const final = await driveToChampion(season.id);
    expect(final.status).toBe("COMPLETE");
    expect(final.championTeamId).toBe(ids[0]);
  });

  it("crowns a champion for an 8-team bracket (QF → SF → F)", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 8 });
    const ids = await makeSeededTeams(season.id, 8);
    await createPlayoffBracket(season.id);
    expect(
      (await playoffMatches(season.id)).filter((m) =>
        m.bracketSlot?.startsWith("R0"),
      ),
    ).toHaveLength(4);
    const final = await driveToChampion(season.id);
    expect(final.status).toBe("COMPLETE");
    expect(final.championTeamId).toBe(ids[0]);
  });

  it("runs a single-match final for 3 teams (bracket size 2)", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 2 });
    const ids = await makeSeededTeams(season.id, 3);
    expect(pickBracketSize(3)).toBe(2);
    await createPlayoffBracket(season.id);
    const pm = await playoffMatches(season.id);
    expect(pm).toHaveLength(1);
    expect(pm[0].phase).toBe("FINAL");
    const final = await driveToChampion(season.id);
    expect(final.championTeamId).toBe(ids[0]);
  });

  it("seeds only the top 4 when 5 teams sign up (non-power-of-two)", async () => {
    const season = await makeSeason({ teamSize: 3, minTeams: 4 });
    const ids = await makeSeededTeams(season.id, 5);
    expect(pickBracketSize(5)).toBe(4);
    await createPlayoffBracket(season.id);
    const inBracket = (await playoffMatches(season.id))
      .filter((m) => m.bracketSlot?.startsWith("R0"))
      .flatMap((m) => [m.homeTeamId, m.awayTeamId]);
    expect(inBracket).toHaveLength(4);
    expect(inBracket).not.toContain(ids[4]); // lowest seed misses the cut
    const final = await driveToChampion(season.id);
    expect(final.championTeamId).toBe(ids[0]);
  });

  it("refuses to create a bracket with fewer than 2 teams", async () => {
    const season = await makeSeason();
    await makeTeam(season.id, "Solo", 0);
    await expect(createPlayoffBracket(season.id)).rejects.toThrow(/at least 2/);
  });
});
