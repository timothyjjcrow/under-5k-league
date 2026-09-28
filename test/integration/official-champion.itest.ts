import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  getDefendingChampion,
  hasOfficialChampion,
} from "@/lib/official-champion";
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

// Home names the last champion from the offseason until the next season
// crowns someone.
describe("getDefendingChampion", () => {
  async function season(
    name: string,
    status: string,
    createdAt: string,
    { isActive = false, champion = false } = {},
  ) {
    const created = await makeSeason({ name, status, isActive });
    const row = await prisma.season.update({
      where: { id: created.id },
      data: { createdAt: new Date(createdAt) },
    });
    const home = await makeTeam(row.id, `${name} Home`, 0);
    const away = await makeTeam(row.id, `${name} Away`, 1);
    if (champion) {
      await prisma.season.update({
        where: { id: row.id },
        data: { championTeamId: home.id },
      });
    }
    return { season: row, home, away };
  }

  it("is null with no archived completed season", async () => {
    expect(await getDefendingChampion(null)).toBeNull();
    // Archived before it finished: nobody was crowned.
    await season("Cancelled", SEASON_STATUS.SIGNUPS, "2026-01-01");
    // The active season's own champion is the Complete view's to show.
    await season("Current", SEASON_STATUS.COMPLETE, "2026-02-01", {
      isActive: true,
      champion: true,
    });
    expect(await getDefendingChampion(null)).toBeNull();
  });

  it("names the newest completed season's champion and its team", async () => {
    await season("Season 8", SEASON_STATUS.COMPLETE, "2026-01-01", {
      champion: true,
    });
    const { season: s9, home } = await season(
      "Season 9",
      SEASON_STATUS.COMPLETE,
      "2026-03-01",
      { champion: true },
    );
    const next = await season("Season 10", SEASON_STATUS.SIGNUPS, "2026-06-01", {
      isActive: true,
    });
    expect(await getDefendingChampion(next.season.createdAt)).toEqual({
      seasonId: s9.id,
      seasonName: "Season 9",
      teamId: home.id,
      teamName: "Season 9 Home",
      logoUrl: null,
    });
  });

  it("keeps the reign through a season cancelled before it finished", async () => {
    const { home } = await season("Season 9", SEASON_STATUS.COMPLETE, "2026-03-01", {
      champion: true,
    });
    await season("Season 10", SEASON_STATUS.DRAFT, "2026-05-01");
    expect((await getDefendingChampion(null))?.teamId).toBe(home.id);
  });

  it("never falls back to an older title while the newest one needs review", async () => {
    await season("Season 8", SEASON_STATUS.COMPLETE, "2026-01-01", {
      champion: true,
    });
    const { season: s9, home, away } = await season(
      "Season 9",
      SEASON_STATUS.COMPLETE,
      "2026-03-01",
      { champion: true },
    );
    // The saved final says Away won; the stored champion says Home.
    await prisma.match.create({
      data: {
        seasonId: s9.id, week: 9, phase: MATCH_PHASE.FINAL, bracketSlot: "R1M1",
        homeTeamId: home.id, awayTeamId: away.id, status: MATCH_STATUS.COMPLETED,
        homeScore: 1, awayScore: 2, winnerTeamId: away.id,
      },
    });
    expect(await getDefendingChampion(null)).toBeNull();
  });

  it("ignores a season created after the active one", async () => {
    const { home } = await season("Season 8", SEASON_STATUS.COMPLETE, "2026-01-01", {
      champion: true,
    });
    const active = await season("Season 9", SEASON_STATUS.SIGNUPS, "2026-03-01", {
      isActive: true,
    });
    await season("Season 10", SEASON_STATUS.COMPLETE, "2026-06-01", {
      champion: true,
    });
    expect(
      (await getDefendingChampion(active.season.createdAt))?.teamId,
    ).toBe(home.id);
  });
});
