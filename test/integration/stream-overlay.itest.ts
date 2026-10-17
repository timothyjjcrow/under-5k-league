import { describe, expect, it, vi } from "vitest";

// The stream overlay's reads (stream-overlay-service.ts) over a real
// database: the fixture, both teams' records, tonight's players with a
// booked standin in the seat they cover, season lines from the stored box
// scores, and display fields only.
vi.mock("@/lib/cached-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cached-queries")>();
  // unstable_cache needs Next's runtime: read through the uncached seam.
  return { ...actual, getSeasonGameLeaders: actual.fetchSeasonGameLeaders };
});

import { MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";
import { loadStreamOverlay } from "@/lib/stream-overlay-service";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  makeUser,
  recordMatch,
} from "./factories";

async function roster(seasonId: string, teamId: string, captainId: string, label: string) {
  const ids = [captainId];
  await prisma.teamMember.create({
    data: { seasonId, teamId, userId: captainId, isCaptain: true, price: 0 },
  });
  await prisma.registration.create({
    data: { seasonId, userId: captainId, mmr: 4000, roles: "1,2" },
  });
  for (let i = 1; i <= 4; i++) {
    const player = await makeUser(`${label} ${i}`);
    await prisma.teamMember.create({
      data: { seasonId, teamId, userId: player.id, price: 10 - i },
    });
    await prisma.registration.create({
      data: { seasonId, userId: player.id, mmr: 3000, roles: String(i + 1) },
    });
    ids.push(player.id);
  }
  return ids;
}

/** A complete 5v5 box score for these ten users, radiant first; `star`
 *  plays Anti-Mage and has the game of their life. */
function boxScore(radiant: string[], dire: string[], star: string): string {
  return JSON.stringify(
    [...radiant, ...dire].map((userId, index) => ({
      userId,
      accountId: 5000 + index,
      heroId: userId === star ? 1 : 20 + index,
      isRadiant: index < 5,
      kills: userId === star ? 11 : 2,
      deaths: userId === star ? 1 : 4,
      assists: 6,
      gpm: 450,
    })),
  );
}

async function setUp() {
  const season = await makeSeason({
    name: "Season 7",
    status: SEASON_STATUS.REGULAR_SEASON,
    teamSize: 5,
  });
  const [alpha, bravo, charlie, delta] = await Promise.all([
    makeTeam(season.id, "Alpha Wolves", 0),
    makeTeam(season.id, "Bravo Bears", 1),
    makeTeam(season.id, "Charlie Cats", 2),
    makeTeam(season.id, "Delta Dogs", 3),
  ]);
  const alphaIds = await roster(season.id, alpha.id, alpha.captainId, "Alpha");
  const bravoIds = await roster(season.id, bravo.id, bravo.captainId, "Bravo");
  await prisma.user.update({ where: { id: alpha.captainId }, data: { rankTier: 64 } });

  const matches = await generateRegularSchedule(season.id);
  const pairs = (m: { homeTeamId: string; awayTeamId: string }, a: string, b: string) =>
    (m.homeTeamId === a && m.awayTeamId === b) || (m.homeTeamId === b && m.awayTeamId === a);
  const tonight = matches.find((m) => pairs(m, alpha.id, bravo.id))!;
  // Every other fixture is final: the home side wins, except Delta, who
  // lose everything.
  for (const m of matches) {
    if (m.id === tonight.id) continue;
    const homeWins = m.homeTeamId !== delta.id;
    await recordMatch(m.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
  }
  // Alpha's series against Charlie has its box score: the home side played
  // Radiant and won, as every home side did.
  const alphaCharlie = matches.find((m) => pairs(m, alpha.id, charlie.id))!;
  const fillers = ["c1", "c2", "c3", "c4", "c5"];
  const alphaHome = alphaCharlie.homeTeamId === alpha.id;
  await prisma.game.create({
    data: {
      matchId: alphaCharlie.id,
      dotaMatchId: "7000000001",
      radiantWin: true,
      radiantTeamId: alphaCharlie.homeTeamId,
      direTeamId: alphaCharlie.awayTeamId,
      winnerTeamId: alphaCharlie.homeTeamId,
      players: alphaHome
        ? boxScore(alphaIds, fillers, alpha.captainId)
        : boxScore(fillers, alphaIds, alpha.captainId),
    },
  });
  await prisma.match.update({
    where: { id: tonight.id },
    data: {
      status: MATCH_STATUS.LIVE,
      homeScore: 1,
      scheduledAt: new Date("2026-10-11T01:00:00Z"),
    },
  });
  // A standin covers Bravo's last player tonight.
  const standin = await makeUser("Sub Stitute");
  await prisma.standinAssignment.create({
    data: {
      matchId: tonight.id,
      teamId: bravo.id,
      standinUserId: standin.id,
      replacingUserId: bravoIds[4],
    },
  });
  return { season, alpha, bravo, tonight, alphaIds, bravoIds, standin };
}

describe("loadStreamOverlay", () => {
  it("is null for a match that doesn't exist", async () => {
    expect(await loadStreamOverlay("no-such-match")).toBeNull();
  });

  it("loads the fixture, both teams' records and tonight's ten", async () => {
    const { alpha, bravo, tonight, alphaIds, bravoIds, standin } = await setUp();
    const payload = (await loadStreamOverlay(tonight.id))!;
    expect(payload.seasonName).toBe("Season 7");
    expect(payload.match).toMatchObject({
      id: tonight.id,
      round: `Week ${tonight.week}`,
      status: "LIVE",
      homeScore: 1,
      awayScore: 0,
      kickoffMs: Date.parse("2026-10-11T01:00:00Z"),
    });
    // The server writes the kickoff on the league's clock, zone named.
    expect(payload.match.kickoffText).toBe(
      formatLeagueMatchTime(new Date("2026-10-11T01:00:00Z"), "full"),
    );

    const side = (id: string) => (payload.home.id === id ? payload.home : payload.away);
    expect(side(alpha.id).name).toBe("Alpha Wolves");
    expect(side(bravo.id).name).toBe("Bravo Bears");
    for (const team of [payload.home, payload.away]) {
      expect(team.record).toMatch(/^\dW 0D \dL$/);
      expect(team.standing).toMatch(/^\d(st|nd|rd|th) of 4$/);
      expect(team.form.length).toBe(2);
    }

    const ids = payload.players.map((p) => p.id);
    expect(ids).toHaveLength(10);
    const homeIds = payload.home.id === alpha.id ? alphaIds : bravoIds;
    // Home first, captain first.
    expect(ids[0]).toBe(homeIds[0]);
    expect(payload.players[0].captain).toBe(true);
    // The standin sits in the covered player's seat; the covered player is out.
    expect(ids).toContain(standin.id);
    expect(ids).not.toContain(bravoIds[4]);
    expect(payload.players.find((p) => p.id === standin.id)).toMatchObject({
      standin: true,
      standinFor: "Bravo 4",
      season: null,
    });
  });

  it("gives each player their positions, medal and season line", async () => {
    const { alpha, tonight } = await setUp();
    const payload = (await loadStreamOverlay(tonight.id))!;
    const captain = payload.players.find((p) => p.id === alpha.captainId)!;
    expect(captain).toMatchObject({
      captain: true,
      roles: ["Carry", "Mid"],
      medal: { name: "Ancient 4" },
      heroesFrom: "league",
    });
    expect(captain.season).toMatchObject({ games: 1, kills: 11, deaths: 1, assists: 6, mvps: 1 });
    expect(captain.heroes[0]).toMatchObject({ name: "Anti-Mage", games: 1 });
  });

  it("sends display fields only", async () => {
    const { tonight } = await setUp();
    // Ids are random cuids, so one can spell "mmr" by chance (the likely cause
    // of a red mutation shard, 2026-10-17): mask them, check everything else.
    const text = JSON.stringify(
      await loadStreamOverlay(tonight.id),
      (key, value) => (key === "id" ? "<id>" : value),
    ).toLowerCase();
    for (const word of ["mmr", "discord", "steamid", "pubstats", "accountid"]) {
      expect(text).not.toContain(word);
    }
  });
});
