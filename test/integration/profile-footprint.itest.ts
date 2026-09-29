import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  INHOUSE_STATUS,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import { hasJoinedLeague } from "@/lib/profile-footprint";
import { makeSeason, makeTeam, makeUser } from "./factories";

// A Steam sign-in alone creates an account whose /players page every pick'em,
// fantasy and inhouse board links to. Only joining something the league
// records turns that into a full profile; everything else gets the minimal,
// noindex page.
describe("hasJoinedLeague", () => {
  it("is false for an account that only signed in", async () => {
    const lurker = await makeUser("Lurker");
    expect(await hasJoinedLeague(lurker.id)).toBe(false);
  });

  it("counts a season signup in any status, even a removed one", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    const removed = await makeUser("Removed");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: removed.id,
        mmr: 3000,
        status: REGISTRATION_STATUS.REMOVED,
      },
    });
    expect(await hasJoinedLeague(removed.id)).toBe(true);
  });

  it("counts a roster spot, or captaining a team", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const team = await makeTeam(season.id, "Alpha", 0);
    const rostered = await makeUser("Rostered");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: team.id, userId: rostered.id },
    });
    expect(await hasJoinedLeague(rostered.id)).toBe(true);
    // makeTeam's captain holds no TeamMember row.
    expect(await hasJoinedLeague(team.captainId)).toBe(true);
  });

  it("counts a league game, but only a completed inhouse game", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const players = await Promise.all(
      Array.from({ length: 10 }, (_, i) => makeUser(`Played ${i}`)),
    );
    const match = await prisma.match.create({
      data: {
        seasonId: season.id, week: 1, homeTeamId: home.id, awayTeamId: away.id,
        status: MATCH_STATUS.COMPLETED, winnerTeamId: home.id,
        homeScore: 1, awayScore: 0, bestOf: 1,
      },
    });
    await prisma.game.create({
      data: {
        matchId: match.id, dotaMatchId: "footprint-g1", startTime: 1000,
        radiantWin: true, radiantTeamId: home.id, direTeamId: away.id,
        players: JSON.stringify(
          players.map((u, i) => ({
            userId: u.id, teamId: i < 5 ? home.id : away.id,
            accountId: 500 + i, heroId: i + 1, isRadiant: i < 5,
            kills: 1, deaths: 1, assists: 1,
          })),
        ),
      },
    });
    expect(await hasJoinedLeague(players[7].id)).toBe(true);

    const cancelledOnly = await makeUser("Cancelled only");
    const completed = await makeUser("Inhouse regular");
    await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.CANCELLED,
        players: { create: [{ userId: cancelledOnly.id }] },
      },
    });
    await prisma.inhouseLobby.create({
      data: {
        status: INHOUSE_STATUS.COMPLETED,
        winnerTeam: 1,
        players: { create: [{ userId: completed.id, team: 1 }] },
      },
    });
    expect(await hasJoinedLeague(cancelledOnly.id)).toBe(false);
    expect(await hasJoinedLeague(completed.id)).toBe(true);
  });
});
