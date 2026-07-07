import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { steamIdToAccountId } from "@/lib/dota";
import { MATCH_PHASE } from "@/lib/constants";
import {
  gatherTeamAccounts,
  importGameForMatch,
  recomputeSeries,
} from "@/lib/match-import";
import { makeSeason, makeTeam, makeUser } from "./factories";

// Keep the real module (steamIdToAccountId etc.) but stub the network fetch.
vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return { ...actual, fetchOpenDotaMatch: vi.fn() };
});
import { fetchOpenDotaMatch } from "@/lib/dota";

async function regularMatch(seasonId: string, homeId: string, awayId: string) {
  return prisma.match.create({
    data: {
      seasonId,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: homeId,
      awayTeamId: awayId,
    },
  });
}

async function addGame(matchId: string, dotaMatchId: string, winnerTeamId: string) {
  return prisma.game.create({
    data: { matchId, dotaMatchId, radiantWin: true, winnerTeamId, players: "[]" },
  });
}

async function addMember(seasonId: string, teamId: string, name: string) {
  const user = await makeUser(name);
  await prisma.teamMember.create({
    data: { seasonId, teamId, userId: user.id, isCaptain: false, price: 0 },
  });
  return steamIdToAccountId(user.steamId)!;
}

describe("recomputeSeries", () => {
  it("rolls games up into the match series score + winner", async () => {
    const season = await makeSeason();
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const match = await regularMatch(season.id, home.id, away.id);
    await addGame(match.id, "1", home.id);
    await addGame(match.id, "2", home.id);
    await addGame(match.id, "3", away.id);

    await recomputeSeries(match.id);
    const m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.homeScore).toBe(2);
    expect(m.awayScore).toBe(1);
    expect(m.winnerTeamId).toBe(home.id);
    expect(m.status).toBe("COMPLETED");
  });

  it("reverts a match to SCHEDULED when it has no games", async () => {
    const season = await makeSeason();
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const match = await regularMatch(season.id, home.id, away.id);
    await recomputeSeries(match.id);
    const m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.status).toBe("SCHEDULED");
    expect(m.winnerTeamId).toBeNull();
  });

  it("stays LIVE until a team clinches a best-of-3, then completes", async () => {
    const season = await makeSeason();
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: home.id,
        awayTeamId: away.id,
        bestOf: 3,
      },
    });

    await addGame(match.id, "g1", home.id); // 1-0: not clinched (needs 2)
    await recomputeSeries(match.id);
    let m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.status).toBe("LIVE");
    expect(m.winnerTeamId).toBeNull();

    await addGame(match.id, "g2", home.id); // 2-0: clinched
    await recomputeSeries(match.id);
    m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.status).toBe("COMPLETED");
    expect(m.winnerTeamId).toBe(home.id);
    expect(m.homeScore).toBe(2);
  });
});

describe("gatherTeamAccounts", () => {
  it("puts a standin's account into the team they fill for", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const homePlayer = await makeUser("HomePlayer");
    await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: home.id,
        userId: homePlayer.id,
        isCaptain: false,
        price: 0,
      },
    });
    const match = await regularMatch(season.id, home.id, away.id);
    const standin = await makeUser("Standin");
    await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: home.id,
        standinUserId: standin.id,
        replacingUserId: homePlayer.id,
      },
    });

    const { homeSet, awaySet } = await gatherTeamAccounts({
      id: match.id,
      seasonId: season.id,
      homeTeamId: home.id,
      awayTeamId: away.id,
      phase: match.phase,
    });
    const standinAcc = steamIdToAccountId(standin.steamId)!;
    expect(homeSet.has(standinAcc)).toBe(true);
    expect(awaySet.has(standinAcc)).toBe(false);
  });
});

describe("importGameForMatch", () => {
  afterEach(() => vi.mocked(fetchOpenDotaMatch).mockReset());

  it("imports a valid game, classifies sides, rolls up, and dedupes", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const homeAccts: number[] = [];
    const awayAccts: number[] = [];
    for (let i = 0; i < 3; i++) homeAccts.push(await addMember(season.id, home.id, `H${i}`));
    for (let i = 0; i < 3; i++) awayAccts.push(await addMember(season.id, away.id, `A${i}`));
    const match = await regularMatch(season.id, home.id, away.id);

    vi.mocked(fetchOpenDotaMatch).mockResolvedValue({
      match_id: 555,
      radiant_win: true,
      duration: 2000,
      start_time: 1,
      radiant_score: 30,
      dire_score: 20,
      players: [
        ...homeAccts.map((a, i) => ({
          account_id: a,
          player_slot: i,
          hero_id: 1,
          isRadiant: true,
          kills: 1,
          deaths: 0,
          assists: 0,
        })),
        ...awayAccts.map((a, i) => ({
          account_id: a,
          player_slot: 128 + i,
          hero_id: 2,
          isRadiant: false,
          kills: 0,
          deaths: 1,
          assists: 0,
        })),
      ],
    });

    const r = await importGameForMatch(match.id, "555");
    expect(r.ok).toBe(true);

    const m = await prisma.match.findUniqueOrThrow({
      where: { id: match.id },
      include: { games: true },
    });
    expect(m.games).toHaveLength(1);
    expect(m.winnerTeamId).toBe(home.id); // home = radiant, radiant won
    expect(m.homeScore).toBe(1);
    expect(m.status).toBe("COMPLETED");

    // Same dota match id can't be imported twice.
    const dup = await importGameForMatch(match.id, "555");
    expect(dup.ok).toBe(false);
    expect(
      (await prisma.game.findMany({ where: { matchId: match.id } })).length,
    ).toBe(1);
  });

  it("rejects a game that isn't between the two teams", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    for (let i = 0; i < 3; i++) await addMember(season.id, home.id, `H${i}`);
    for (let i = 0; i < 3; i++) await addMember(season.id, away.id, `A${i}`);
    const match = await regularMatch(season.id, home.id, away.id);

    // Ten unrelated accounts.
    vi.mocked(fetchOpenDotaMatch).mockResolvedValue({
      match_id: 777,
      radiant_win: true,
      duration: 2000,
      start_time: 1,
      players: Array.from({ length: 10 }, (_, i) => ({
        account_id: 900000 + i,
        player_slot: i < 5 ? i : 123 + i,
        hero_id: 1,
        isRadiant: i < 5,
        kills: 0,
        deaths: 0,
        assists: 0,
      })),
    });

    const r = await importGameForMatch(match.id, "777");
    expect(r.ok).toBe(false);
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
  });
});
