import { describe, expect, it } from "vitest";
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

describe("loadPlayerCard", () => {
  it("shows the player's newest team, and keeps the league's picture for a bare account", async () => {
    const { a } = await league();
    const captain = await loadPlayerCard(a.captainId);
    // A captain has joined: the card names them and their team.
    expect(captain).toMatchObject({
      name: "Radiant Raccoons Captain",
      avatar: null,
      facts: [],
    });
    const member = await makeUser("Rostered");
    await prisma.teamMember.create({
      data: { seasonId: a.seasonId, teamId: a.id, userId: member.id, price: 10 },
    });
    expect(await loadPlayerCard(member.id)).toMatchObject({
      name: "Rostered",
      team: { name: "Radiant Raccoons", logo: null },
      teamSeason: "Season 7",
    });
    const signedInOnly = await makeUser("Just Browsing");
    expect(await loadPlayerCard(signedInOnly.id)).toBe("unjoined");
    expect(await loadPlayerCard("not-a-player")).toBeNull();
  });
});
