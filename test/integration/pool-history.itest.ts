import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { loadPoolLastSeasons } from "@/lib/pool-history";
import { fetchPublicGameSnapshot } from "@/lib/public-game-snapshot";
import { makeTeam, makeUser } from "./factories";

// The /players "last season" token reads real appearances and roster rows.
// Outside a Next request the games snapshot can't use its cache, so the test
// passes the uncached query through the loader's seam.
const readGames = () => fetchPublicGameSnapshot(null);

async function season(name: string, createdAt: string, extra: {
  status?: string; isActive?: boolean;
} = {}) {
  return prisma.season.create({
    data: {
      name,
      createdAt: new Date(createdAt),
      status: extra.status ?? SEASON_STATUS.COMPLETE,
      isActive: extra.isActive ?? false,
    },
  });
}

async function playedSeason(name: string, createdAt: string) {
  const s = await season(name, createdAt);
  const home = await makeTeam(s.id, `${name} Home`, 0);
  const away = await makeTeam(s.id, `${name} Away`, 1);
  const users = await Promise.all(
    Array.from({ length: 10 }, (_, i) => makeUser(`${name} P${i}`)),
  );
  // Five on each roster: home's first player captains, the rest were bought.
  await prisma.teamMember.createMany({
    data: users.map((u, i) => ({
      seasonId: s.id,
      teamId: i < 5 ? home.id : away.id,
      userId: u.id,
      isCaptain: i === 0 || i === 5,
      price: i === 0 || i === 5 ? 0 : 10 + i,
    })),
  });
  const match = await prisma.match.create({
    data: {
      seasonId: s.id, week: 1, homeTeamId: home.id, awayTeamId: away.id,
      status: MATCH_STATUS.COMPLETED, winnerTeamId: home.id,
      homeScore: 1, awayScore: 0, bestOf: 1,
    },
  });
  const lines = users.map((u, i) => ({
    userId: u.id, teamId: i < 5 ? home.id : away.id, accountId: 100 + i,
    heroId: i + 1, isRadiant: i < 5, kills: i, deaths: 1, assists: 2,
  }));
  await prisma.game.create({
    data: {
      matchId: match.id, dotaMatchId: `${name}-g1`, startTime: 1000,
      radiantWin: true, radiantTeamId: home.id, direTeamId: away.id,
      players: JSON.stringify(lines),
    },
  });
  await prisma.season.update({
    where: { id: s.id },
    data: { championTeamId: home.id },
  });
  return { season: s, home, away, users };
}

describe("loadPoolLastSeasons", () => {
  it("returns nothing in a league's first season", async () => {
    const active = await season("Season 1", "2026-01-01", {
      status: SEASON_STATUS.SIGNUPS, isActive: true,
    });
    const u = await makeUser("First Timer");
    expect(await loadPoolLastSeasons(active, [u.id], readGames)).toEqual({});
  });

  it("names each returning player's team, series record, price and title", async () => {
    const past = await playedSeason("Season 1", "2026-01-01");
    const active = await season("Season 2", "2026-06-01", {
      status: SEASON_STATUS.SIGNUPS, isActive: true,
    });
    const newcomer = await makeUser("Newcomer");
    const [captain, bought] = past.users;
    const loser = past.users[7];

    const out = await loadPoolLastSeasons(
      active,
      [captain.id, bought.id, loser.id, newcomer.id],
      readGames,
    );

    expect(out[captain.id]).toEqual({
      seasonName: "Season 1",
      teamName: "Season 1 Home",
      record: { wins: 1, losses: 0, draws: 0 },
      price: null,
      captain: true,
      champion: true,
    });
    expect(out[bought.id]).toMatchObject({ price: 11, captain: false, champion: true });
    expect(out[loser.id]).toEqual({
      seasonName: "Season 1",
      teamName: "Season 1 Away",
      record: { wins: 0, losses: 1, draws: 0 },
      price: 17,
      captain: false,
      champion: false,
    });
    expect(out[newcomer.id]).toBeUndefined();
  });

  it("never treats a season created after the active one as the last season", async () => {
    // A reactivated older season: the later archive is not its "last season".
    const active = await season("Season 1", "2026-01-01", {
      status: SEASON_STATUS.SIGNUPS, isActive: true,
    });
    const later = await playedSeason("Season 2", "2026-06-01");
    expect(
      await loadPoolLastSeasons(active, [later.users[0].id], readGames),
    ).toEqual({});
  });
});
