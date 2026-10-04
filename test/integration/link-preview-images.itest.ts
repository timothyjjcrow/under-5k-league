import { describe, expect, it, vi } from "vitest";

// The record book's cached scan (unstable_cache) needs Next's server runtime;
// its uncached twin reads the same rows (cached-queries.itest.ts).
vi.mock("@/lib/cached-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cached-queries")>();
  return { ...actual, getAllGamesForRecords: actual.fetchAllGamesForRecords };
});

import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  loadMatchCard,
  loadPlayerCard,
  loadSeasonCard,
  loadTeamCard,
} from "@/lib/link-preview-images";
import { makeSeason, makeTeam, makeUser, recordMatch } from "./factories";

// What each link preview picture shows, read from the rows the pages read.
// No team here has a logo, so nothing is fetched: crests draw initials.
const DAY = 86_400_000;

async function league(status: string = SEASON_STATUS.REGULAR_SEASON) {
  const season = await makeSeason({ name: "Season 7", status });
  const a = await makeTeam(season.id, "Radiant Raccoons", 0);
  const b = await makeTeam(season.id, "Dire Straits", 1);
  const c = await makeTeam(season.id, "Mid or Feed", 2);
  const played = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: a.id,
      awayTeamId: b.id,
      bestOf: 2,
    },
  });
  await recordMatch(played.id, 2, 0);
  const next = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 2,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: c.id,
      awayTeamId: a.id,
      bestOf: 3,
      scheduledAt: new Date(Date.now() + DAY),
    },
  });
  return { season, a, b, c, played, next };
}

describe("loadMatchCard", () => {
  it("draws the teams, the round and the kickoff, then the result", async () => {
    const { season, played, next } = await league();
    const upcoming = await loadMatchCard(next.id, Date.now());
    expect(upcoming).toMatchObject({
      seasonName: "Season 7",
      round: "Week 2",
      grandFinal: false,
      home: { name: "Mid or Feed", logo: null },
      away: { name: "Radiant Raccoons", logo: null },
      score: null,
      winner: null,
      status: { tone: "upcoming", text: expect.stringMatching(/ · Best of 3$/) },
    });
    // Each team wears its season hue, the same colours the pages paint.
    expect(upcoming!.home.hue).not.toBe(upcoming!.away.hue);

    expect(await loadMatchCard(played.id, Date.now())).toMatchObject({
      round: "Week 1",
      score: { home: 2, away: 0 },
      winner: "home",
      status: { tone: "final", text: "Radiant Raccoons won 2–0" },
    });

    const final = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 9,
        phase: MATCH_PHASE.FINAL,
        bracketSlot: "R1M0",
        homeTeamId: next.homeTeamId,
        awayTeamId: next.awayTeamId,
        bestOf: 3,
        status: MATCH_STATUS.LIVE,
        homeScore: 1,
      },
    });
    expect(await loadMatchCard(final.id, Date.now())).toMatchObject({
      round: "Grand final",
      grandFinal: true,
      score: { home: 1, away: 0 },
      status: { tone: "live", text: "Live now · Best of 3" },
    });
    expect(await loadMatchCard("not-a-match", Date.now())).toBeNull();
  });
});

describe("loadTeamCard", () => {
  it("gives the record, the table place and the roster, captain first", async () => {
    const { a, b } = await league();
    const players = await Promise.all(
      ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].map((name) =>
        makeUser(name),
      ),
    );
    await prisma.teamMember.createMany({
      data: [
        { seasonId: a.seasonId, teamId: a.id, userId: a.captainId, isCaptain: true, price: 0 },
        ...players.map((player, index) => ({
          seasonId: a.seasonId,
          teamId: a.id,
          userId: player.id,
          price: 60 - index * 10,
        })),
      ],
    });
    expect(await loadTeamCard(a.id, Date.now())).toMatchObject({
      seasonName: "Season 7",
      team: { name: "Radiant Raccoons", logo: null },
      facts: ["1W 0D 0L", "1st of 3"],
      goldFact: null,
      captain: "Radiant Raccoons Captain",
      // Highest price first, then a count past five.
      roster: ["Alpha", "Bravo", "Charlie", "Delta", "+2 more"],
    });
    expect(await loadTeamCard(b.id, Date.now())).toMatchObject({
      facts: ["0W 0D 1L", "3rd of 3"],
      roster: [],
    });
    expect(await loadTeamCard("not-a-team", Date.now())).toBeNull();
  });

  it("wears the title once the season's champion is confirmed", async () => {
    const { season, a, c } = await league(SEASON_STATUS.PLAYOFFS);
    const final = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 9,
        phase: MATCH_PHASE.FINAL,
        bracketSlot: "R0M0",
        homeTeamId: a.id,
        awayTeamId: c.id,
      },
    });
    await recordMatch(final.id, 2, 1);
    // Won on the board, but the season isn't complete: no title yet.
    expect((await loadTeamCard(a.id, Date.now()))?.goldFact).toBeNull();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.COMPLETE, championTeamId: a.id },
    });
    expect(await loadTeamCard(a.id, Date.now())).toMatchObject({
      goldFact: "Champion",
      facts: ["1W 0D 0L", "Seed 1"],
    });
    expect((await loadTeamCard(c.id, Date.now()))?.facts).toEqual([
      "0W 0D 0L",
      "Seed 2",
      "Runner-up",
    ]);
  });
});

describe("loadSeasonCard", () => {
  it("names the phase and size, and the champion once confirmed", async () => {
    const { season, a, b } = await league();
    expect(await loadSeasonCard(season.id)).toEqual({
      seasonName: "Season 7",
      kicker: "Current season",
      facts: ["Regular season", "3 teams"],
      champion: null,
    });
    const final = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 9,
        phase: MATCH_PHASE.FINAL,
        bracketSlot: "R0M0",
        homeTeamId: a.id,
        awayTeamId: b.id,
      },
    });
    await recordMatch(final.id, 0, 2);
    await prisma.season.update({
      where: { id: season.id },
      data: {
        status: SEASON_STATUS.COMPLETE,
        championTeamId: b.id,
        isActive: false,
      },
    });
    expect(await loadSeasonCard(season.id)).toMatchObject({
      kicker: "Season archive",
      facts: ["Season complete", "3 teams"],
      champion: { name: "Dire Straits", logo: null },
    });
    expect(await loadSeasonCard("not-a-season")).toBeNull();
  });
});

/**
 * A game with a trusted ten-line box score in which `userId` played for
 * `teamId` on Radiant (and won), with a line good enough for Match MVP.
 */
async function playGame(
  matchId: string,
  player: { userId: string; teamId: string; heroId: number },
) {
  const lines: Record<string, unknown>[] = Array.from({ length: 10 }, (_, i) => ({
    heroId: 50 + i,
    isRadiant: i < 5,
    kills: 1,
    deaths: 5,
    assists: 1,
  }));
  lines[0] = {
    heroId: player.heroId,
    isRadiant: true,
    kills: 12,
    deaths: 1,
    assists: 9,
    userId: player.userId,
    teamId: player.teamId,
  };
  return prisma.game.create({
    data: {
      matchId,
      dotaMatchId: `${matchId}-${player.userId}`,
      radiantWin: true,
      durationSecs: 2400,
      startTime: 1_700_000_000,
      players: JSON.stringify(lines),
    },
  });
}

describe("loadPlayerCard", () => {
  it("draws the profile's season card, and keeps the league's picture for a bare account", async () => {
    const { a } = await league();
    // A captain has joined, but this one holds no roster row or game: the
    // card is their name alone, as on their profile.
    expect(await loadPlayerCard(a.captainId)).toMatchObject({
      name: "Radiant Raccoons Captain",
      avatar: null,
      seasonLine: null,
      team: null,
      medal: null,
      titles: [],
      facts: [],
    });
    const member = await makeUser("Rostered");
    await prisma.user.update({ where: { id: member.id }, data: { rankTier: 64 } });
    await prisma.teamMember.create({
      data: { seasonId: a.seasonId, teamId: a.id, userId: member.id, price: 10 },
    });
    const card = await loadPlayerCard(member.id);
    expect(card).toMatchObject({
      name: "Rostered",
      seasonLine: "Season 7 · Drafted for $10",
      team: { name: "Radiant Raccoons", logo: null },
      medal: { name: "Ancient 4", icon: expect.stringMatching(/^data:image\/png;base64,/) },
    });
    // The medal is the site's own picture, with its star ring.
    expect(card !== "unjoined" && card?.medal?.stars).toMatch(/^data:image\/png;/);
    const signedInOnly = await makeUser("Just Browsing");
    expect(await loadPlayerCard(signedInOnly.id)).toBe("unjoined");
    expect(await loadPlayerCard("not-a-player")).toBeNull();
  });

  it("takes the team from the season they played, not an older roster row", async () => {
    const { a, played } = await league();
    // Rostered last season on another team, then played for Radiant Raccoons
    // this season and released: no roster row now, and no signup.
    const old = await makeSeason({
      name: "Season 6",
      status: SEASON_STATUS.COMPLETE,
      isActive: false,
    });
    // Seasons run in the order they were created.
    await prisma.season.update({
      where: { id: old.id },
      data: { createdAt: new Date(Date.now() - 365 * DAY) },
    });
    const oldTeam = await makeTeam(old.id, "Old Guard", 0);
    const player = await makeUser("Released");
    await prisma.teamMember.create({
      data: { seasonId: old.id, teamId: oldTeam.id, userId: player.id, price: 25 },
    });
    await playGame(played.id, { userId: player.id, teamId: a.id, heroId: 2 });

    const card = await loadPlayerCard(player.id);
    expect(card).toMatchObject({
      seasonLine: "Season 7",
      team: { name: "Radiant Raccoons" },
      titles: [],
      // The only named line in the league holds its kills and assists
      // records too.
      facts: ["Axe", "1 Match MVP", "2 league records"],
    });
    // The crest wears Season 7's colour, the one the match page paints.
    const match = await loadMatchCard(played.id, Date.now());
    expect(card !== "unjoined" && card?.team?.hue).toBe(match?.home.hue);
  });

  it("names the team a standin covered without wearing its colours", async () => {
    const { season, b, played } = await league();
    const standin = await makeUser("Sub");
    const signup = await prisma.registration.create({
      data: { seasonId: season.id, userId: standin.id, type: "STANDIN", mmr: 2900 },
    });
    await prisma.standinAssignment.create({
      data: { matchId: played.id, teamId: b.id, standinUserId: standin.id },
    });
    // Signed up as a standin this season: the season, as a standin.
    expect(await loadPlayerCard(standin.id)).toMatchObject({
      seasonLine: "Season 7 · Standin",
      team: null,
    });
    // Withdrawn since: the season they spent covering, by the team covered.
    await prisma.registration.update({
      where: { id: signup.id },
      data: { status: "WITHDRAWN" },
    });
    expect(await loadPlayerCard(standin.id)).toMatchObject({
      seasonLine: "Season 7 · Stood in for Dire Straits",
      team: null,
      titles: [],
      facts: [],
    });
  });

  it("carries a champion's title in gold", async () => {
    const { season, a, b } = await league();
    const final = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 9,
        phase: MATCH_PHASE.FINAL,
        bracketSlot: "R0M0",
        homeTeamId: a.id,
        awayTeamId: b.id,
      },
    });
    await recordMatch(final.id, 2, 0);
    const champion = await makeUser("Champ");
    await playGame(final.id, { userId: champion.id, teamId: a.id, heroId: 14 });
    await prisma.season.update({
      where: { id: season.id },
      data: {
        status: SEASON_STATUS.COMPLETE,
        championTeamId: a.id,
        isActive: false,
      },
    });
    expect(await loadPlayerCard(champion.id)).toMatchObject({
      seasonLine: "Season 7",
      team: { name: "Radiant Raccoons" },
      titles: ["Season 7 champion"],
      facts: ["Pudge", "1 Match MVP", "2 league records"],
    });
  });
});
