import { beforeEach, describe, expect, it } from "vitest";
import {
  getCaptainTeam,
  loadCaptainTodoRows,
} from "@/lib/captains-service";
import { prisma } from "@/lib/prisma";
import { SEASON_STATUS } from "@/lib/constants";
import { makeCaptain, makeSeason, makeUser, resetDb } from "./factories";

// The Captains page reads what waits on a captain across every open match
// of their team (loadCaptainTodoRows), deciding each with the match page's
// own captainTodos. These pin what the service gathers around it: only the
// team's open matches, only check-ins for the fixture's current time, the
// other captain's requests, and fixture order.

async function setup() {
  const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
  const home = await makeCaptain(season.id, "Home", 100, 1);
  const away = await makeCaptain(season.id, "Away", 100, 2);
  const other = await makeCaptain(season.id, "Other", 100, 3);
  const player = await makeUser("Paz");
  await prisma.teamMember.create({
    data: { seasonId: season.id, teamId: home.team.id, userId: player.id, price: 10 },
  });
  const sub = await makeUser("Sub");
  const match = (week: number, data: Record<string, unknown> = {}) =>
    prisma.match.create({
      data: {
        seasonId: season.id,
        week,
        homeTeamId: home.team.id,
        awayTeamId: away.team.id,
        scheduledAt: new Date(Date.now() + week * 7 * 86400_000),
        ...data,
      },
    });
  return { season, home, away, other, player, sub, match };
}

const load = (
  season: { id: string; status: string; isActive: boolean; teamSize: number },
  teamId: string,
  viewerId: string,
) =>
  loadCaptainTodoRows({
    season,
    draftStatus: null,
    teamId,
    viewerId,
    nowMs: Date.now(),
  });

describe("loadCaptainTodoRows", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("gathers every open match's to-dos in fixture order, with its opponent", async () => {
    const { season, home, away, player, sub, match } = await setup();
    const week2 = await match(2);
    const week1 = await match(1);
    await prisma.matchAvailability.create({
      data: { matchId: week1.id, userId: player.id, status: "OUT" },
    });
    // The other captain's request (over the MMR allowance) in week 2.
    await prisma.standinRequest.create({
      data: {
        matchId: week2.id,
        teamId: away.team.id,
        standinUserId: sub.id,
        requestedById: away.user.id,
        standinMmr: 4000,
        baselineMmr: 3000,
      },
    });
    const rows = await load(season, home.team.id, home.user.id);
    expect(rows).toEqual([
      {
        matchId: week1.id,
        roundLabel: "Week 1",
        opponentName: away.team.name,
        todo: { kind: "uncovered", names: ["Paz"] },
      },
      {
        matchId: week2.id,
        roundLabel: "Week 2",
        opponentName: away.team.name,
        todo: {
          kind: "standin-request",
          requesterName: away.user.name,
          standinName: "Sub",
          count: 1,
        },
      },
    ]);
    // The asking captain owes nothing on their own request.
    expect(await load(season, away.team.id, away.user.id)).toEqual([]);
  });

  it("ignores a check-in from an older kickoff, a played match and other teams' matches", async () => {
    const { season, home, other, player, match } = await setup();
    const moved = await match(1, { scheduleRevision: 1 });
    await prisma.matchAvailability.create({
      // Answered for the old time (revision 0): it asks nothing now.
      data: { matchId: moved.id, userId: player.id, status: "OUT", scheduleRevision: 0 },
    });
    const played = await match(2, {
      status: "COMPLETED",
      homeScore: 2,
      awayScore: 0,
      winnerTeamId: home.team.id,
    });
    await prisma.matchAvailability.create({
      data: { matchId: played.id, userId: player.id, status: "OUT" },
    });
    expect(await load(season, home.team.id, home.user.id)).toEqual([]);
    expect(await load(season, other.team.id, other.user.id)).toEqual([]);
  });

  it("reads nothing before the auction is done or on an archived season", async () => {
    const { season, home, player, match } = await setup();
    const week1 = await match(1);
    await prisma.matchAvailability.create({
      data: { matchId: week1.id, userId: player.id, status: "OUT" },
    });
    expect(
      await load({ ...season, status: SEASON_STATUS.SIGNUPS }, home.team.id, home.user.id),
    ).toEqual([]);
    expect(
      await load({ ...season, isActive: false }, home.team.id, home.user.id),
    ).toEqual([]);
    expect(await load(season, home.team.id, home.user.id)).toHaveLength(1);
  });
});

describe("getCaptainTeam", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("finds the team by Team.captainId, never a roster row's isCaptain", async () => {
    const { season, home, player } = await setup();
    expect((await getCaptainTeam(season.id, home.user.id))?.id).toBe(home.team.id);
    // A roster row marked captain doesn't make a player the captain.
    await prisma.teamMember.updateMany({
      where: { userId: player.id },
      data: { isCaptain: true },
    });
    expect(await getCaptainTeam(season.id, player.id)).toBeNull();
  });
});
