import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { hasOfficialChampion } from "@/lib/official-champion";
import { makeSeason, makeTeam } from "./factories";

// Links into the Hall of Fame show only once it has a champion to show, and
// "champion" means exactly what the Hall of Fame itself resolves.
describe("hasOfficialChampion", () => {
  async function seasonWithTeams(status: string) {
    const season = await makeSeason({ status, isActive: false });
    const home = await makeTeam(season.id, `Home ${season.id}`, 0);
    const away = await makeTeam(season.id, `Away ${season.id}`, 1);
    return { season, home, away };
  }

  it("is false with no seasons, or a champion id outside a completed season", async () => {
    expect(await hasOfficialChampion()).toBe(false);
    const { season, home } = await seasonWithTeams(SEASON_STATUS.PLAYOFFS);
    await prisma.season.update({ where: { id: season.id }, data: { championTeamId: home.id } });
    expect(await hasOfficialChampion()).toBe(false);
  });

  it("accepts a legacy completed season that recorded its champion without a bracket", async () => {
    const { season, home } = await seasonWithTeams(SEASON_STATUS.COMPLETE);
    expect(await hasOfficialChampion()).toBe(false);
    await prisma.season.update({ where: { id: season.id }, data: { championTeamId: home.id } });
    expect(await hasOfficialChampion()).toBe(true);
  });

  it("follows the saved final when a bracket exists", async () => {
    const { season, home, away } = await seasonWithTeams(SEASON_STATUS.COMPLETE);
    const final = await prisma.match.create({
      data: {
        seasonId: season.id, week: 9, phase: MATCH_PHASE.FINAL, bracketSlot: "R1M1",
        homeTeamId: home.id, awayTeamId: away.id, status: MATCH_STATUS.COMPLETED,
        homeScore: 2, awayScore: 1, winnerTeamId: home.id,
      },
    });
    // The stored champion disagrees with the final: not an official title.
    await prisma.season.update({ where: { id: season.id }, data: { championTeamId: away.id } });
    expect(await hasOfficialChampion()).toBe(false);
    await prisma.season.update({ where: { id: season.id }, data: { championTeamId: final.winnerTeamId } });
    expect(await hasOfficialChampion()).toBe(true);
  });
});
