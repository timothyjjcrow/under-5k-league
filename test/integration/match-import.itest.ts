import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { steamIdToAccountId } from "@/lib/dota";
import { MATCH_PHASE } from "@/lib/constants";
import {
  autoDetectGamesForMatch,
  gatherTeamAccounts,
  importGameForMatch,
  recomputeSeries,
  enrichStoredGames,
} from "@/lib/match-import";
import { makeSeason, makeTeam, makeUser } from "./factories";

// Keep the real module (steamIdToAccountId etc.) but stub the network fetches.
vi.mock("@/lib/dota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dota")>();
  return {
    ...actual,
    fetchOpenDotaMatch: vi.fn(),
    fetchRecentMatchIds: vi.fn(async () => [] as number[]),
  };
});
import { fetchOpenDotaMatch, fetchRecentMatchIds } from "@/lib/dota";

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

  it("completes a best-of-2 as a draw when it ends 1-1", async () => {
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
        bestOf: 2,
      },
    });

    await addGame(match.id, "g1", home.id); // 1-0: Bo2 not finished yet
    await recomputeSeries(match.id);
    let m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.status).toBe("LIVE");

    await addGame(match.id, "g2", away.id); // 1-1: all games played → draw
    await recomputeSeries(match.id);
    m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.status).toBe("COMPLETED");
    expect(m.winnerTeamId).toBeNull();
    expect(m.homeScore).toBe(1);
    expect(m.awayScore).toBe(1);
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

describe("autoDetectGamesForMatch", () => {
  afterEach(() => {
    vi.mocked(fetchOpenDotaMatch).mockReset();
    vi.mocked(fetchRecentMatchIds).mockReset();
  });

  // An OpenDota match with the given accounts on each side.
  function gameOf(
    matchId: number,
    radiant: number[],
    dire: number[],
    radiantWin: boolean,
    startTime = 1_700_000_000,
  ) {
    return {
      match_id: matchId,
      radiant_win: radiantWin,
      duration: 2100,
      start_time: startTime,
      radiant_score: 25,
      dire_score: 18,
      players: [
        ...radiant.map((a, i) => ({
          account_id: a,
          player_slot: i,
          hero_id: i + 1,
          isRadiant: true,
          kills: 5,
          deaths: 2,
          assists: 7,
        })),
        ...dire.map((a, i) => ({
          account_id: a,
          player_slot: 128 + i,
          hero_id: i + 20,
          isRadiant: false,
          kills: 2,
          deaths: 5,
          assists: 4,
        })),
      ],
    };
  }

  async function roster(seasonId: string, teamId: string, prefix: string, n: number) {
    const accts: number[] = [];
    for (let i = 0; i < n; i++) accts.push(await addMember(seasonId, teamId, `${prefix}${i}`));
    return accts;
  }

  it("finds the real match from the players who played and skips an unrelated pub", async () => {
    const season = await makeSeason({ teamSize: 5 });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const homeAccts = await roster(season.id, home.id, "H", 5);
    const awayAccts = await roster(season.id, away.id, "A", 5);
    const match = await regularMatch(season.id, home.id, away.id);

    const REAL = 8001;
    const PUB = 9999; // a 4-stack pub some home players queued — must be ignored
    const recent = new Map<number, number[]>();
    homeAccts.forEach((a, i) => recent.set(a, i < 4 ? [REAL, PUB] : [REAL]));
    awayAccts.forEach((a) => recent.set(a, [REAL]));
    vi.mocked(fetchRecentMatchIds).mockImplementation(async (acc) => recent.get(acc) ?? []);

    vi.mocked(fetchOpenDotaMatch).mockImplementation(async (id) => {
      if (id === String(REAL)) return gameOf(REAL, homeAccts, awayAccts, true);
      if (id === String(PUB))
        // Home 4-stack + 6 strangers: classifyGame can't find the away team.
        return gameOf(PUB, homeAccts.slice(0, 4), [70001, 70002, 70003, 70004, 70005, 70006], true);
      return null;
    });

    const res = await autoDetectGamesForMatch(match.id);
    expect(res.imported).toBe(1); // only the real match, not the pub

    const games = await prisma.game.findMany({ where: { matchId: match.id } });
    expect(games).toHaveLength(1);
    expect(games[0].dotaMatchId).toBe(String(REAL));
    const m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.winnerTeamId).toBe(home.id); // home = Radiant, Radiant won
    expect(m.status).toBe("COMPLETED");
  });

  it("attributes a standin's game to the team they filled in for", async () => {
    const season = await makeSeason({ teamSize: 5 });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    // Home fields 4 regulars + a benched 5th who a standin replaces this week.
    const homeRegulars = await roster(season.id, home.id, "H", 4);
    const benched = await makeUser("Benched");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: home.id, userId: benched.id, isCaptain: false, price: 0 },
    });
    const awayAccts = await roster(season.id, away.id, "A", 5);
    const match = await regularMatch(season.id, home.id, away.id);

    const standin = await makeUser("Standin");
    const standinAcc = steamIdToAccountId(standin.steamId)!;
    await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: home.id,
        standinUserId: standin.id,
        replacingUserId: benched.id,
      },
    });

    // The lineup that actually played: 4 regulars + the standin (benched sat out).
    const homeOnField = [...homeRegulars, standinAcc];
    const REAL = 8100;
    const recent = new Map<number, number[]>();
    [...homeOnField, ...awayAccts].forEach((a) => recent.set(a, [REAL]));
    vi.mocked(fetchRecentMatchIds).mockImplementation(async (acc) => recent.get(acc) ?? []);
    vi.mocked(fetchOpenDotaMatch).mockImplementation(async (id) =>
      id === String(REAL) ? gameOf(REAL, homeOnField, awayAccts, false) : null,
    );

    const res = await autoDetectGamesForMatch(match.id);
    expect(res.imported).toBe(1);

    const game = await prisma.game.findFirstOrThrow({ where: { matchId: match.id } });
    const players = JSON.parse(game.players) as { userId: string | null; teamId: string | null }[];
    const standinRow = players.find((p) => p.userId === standin.id);
    expect(standinRow?.teamId).toBe(home.id); // counted for the team they covered
    const m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.winnerTeamId).toBe(away.id); // home was Radiant, Radiant lost
  });

  it("imports every game of a best-of-3 and rolls the series up", async () => {
    const season = await makeSeason({ teamSize: 5 });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const homeAccts = await roster(season.id, home.id, "H", 5);
    const awayAccts = await roster(season.id, away.id, "A", 5);
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

    const G1 = 8201;
    const G2 = 8202;
    const recent = new Map<number, number[]>();
    [...homeAccts, ...awayAccts].forEach((a) => recent.set(a, [G1, G2]));
    vi.mocked(fetchRecentMatchIds).mockImplementation(async (acc) => recent.get(acc) ?? []);
    vi.mocked(fetchOpenDotaMatch).mockImplementation(async (id) => {
      if (id === String(G1)) return gameOf(G1, homeAccts, awayAccts, true); // home wins
      if (id === String(G2)) return gameOf(G2, homeAccts, awayAccts, true); // home wins
      return null;
    });

    const res = await autoDetectGamesForMatch(match.id);
    expect(res.imported).toBe(2);
    const m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.homeScore).toBe(2);
    expect(m.awayScore).toBe(0);
    expect(m.winnerTeamId).toBe(home.id);
    expect(m.status).toBe("COMPLETED");
  });

  it("never mistakes an older game with the same players for the one just played", async () => {
    const season = await makeSeason({ teamSize: 5 });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const homeAccts = await roster(season.id, home.id, "H", 5);
    const awayAccts = await roster(season.id, away.id, "A", 5);
    const match = await regularMatch(season.id, home.id, away.id); // bestOf 1

    // The exact same 10 players appear in TWO games in everyone's recent list:
    // an old meeting (last month) and the one they just played.
    const OLD = 8400;
    const NEW = 8401;
    const recent = new Map<number, number[]>();
    [...homeAccts, ...awayAccts].forEach((a) => recent.set(a, [NEW, OLD]));
    vi.mocked(fetchRecentMatchIds).mockImplementation(async (acc) => recent.get(acc) ?? []);
    vi.mocked(fetchOpenDotaMatch).mockImplementation(async (id) => {
      if (id === String(OLD)) return gameOf(OLD, awayAccts, homeAccts, true, 1_600_000_000); // away won the old one
      if (id === String(NEW)) return gameOf(NEW, homeAccts, awayAccts, true, 1_700_000_000); // home won today
      return null;
    });

    const res = await autoDetectGamesForMatch(match.id);
    expect(res.imported).toBe(1); // bestOf 1 → only the most recent valid game

    const games = await prisma.game.findMany({ where: { matchId: match.id } });
    expect(games).toHaveLength(1);
    expect(games[0].dotaMatchId).toBe(String(NEW)); // the game just played, not the old one
    const m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(m.winnerTeamId).toBe(home.id); // today's result, not last month's
  });

  it("won't re-attribute a game already recorded for another match", async () => {
    const season = await makeSeason({ teamSize: 5 });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const homeAccts = await roster(season.id, home.id, "H", 5);
    const awayAccts = await roster(season.id, away.id, "A", 5);
    // Same two teams meet twice (e.g. regular season + a playoff rematch).
    const week1 = await regularMatch(season.id, home.id, away.id);
    const rematch = await regularMatch(season.id, home.id, away.id);

    const REAL = 8300;
    vi.mocked(fetchOpenDotaMatch).mockImplementation(async (id) =>
      id === String(REAL) ? gameOf(REAL, homeAccts, awayAccts, true) : null,
    );
    // The week-1 game is recorded against week 1.
    expect((await importGameForMatch(week1.id, String(REAL))).ok).toBe(true);

    // Auto-detecting the rematch must NOT steal week 1's game.
    const recent = new Map<number, number[]>();
    [...homeAccts, ...awayAccts].forEach((a) => recent.set(a, [REAL]));
    vi.mocked(fetchRecentMatchIds).mockImplementation(async (acc) => recent.get(acc) ?? []);

    const res = await autoDetectGamesForMatch(rematch.id);
    expect(res.imported).toBe(0);
    expect(await prisma.game.count({ where: { matchId: rematch.id } })).toBe(0);
    expect(await prisma.game.count({ where: { matchId: week1.id } })).toBe(1);
  });
});

describe("enrichStoredGames", () => {
  afterEach(() => vi.mocked(fetchOpenDotaMatch).mockReset());

  const LEGACY_LINE = {
    accountId: 111,
    heroId: 7,
    isRadiant: true,
    kills: 3,
    deaths: 1,
    assists: 9,
    personaname: "old",
    netWorth: 12000,
    gpm: 480,
    lastHits: 150,
    userId: "user-legacy",
    teamId: "team-legacy",
  };

  async function legacyGame(dotaMatchId: string, lines: unknown[] = [LEGACY_LINE]) {
    const season = await makeSeason();
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const match = await regularMatch(season.id, home.id, away.id);
    return prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId,
        radiantWin: true,
        winnerTeamId: home.id,
        players: JSON.stringify(lines),
      },
    });
  }

  it("merges report-card fields into legacy lines without touching attribution", async () => {
    const game = await legacyGame("9001");
    vi.mocked(fetchOpenDotaMatch).mockResolvedValue({
      match_id: 9001,
      radiant_win: true,
      duration: 2000,
      start_time: 1,
      players: [
        {
          account_id: 111,
          player_slot: 0,
          hero_id: 7,
          isRadiant: true,
          kills: 3,
          deaths: 1,
          assists: 9,
          xp_per_min: 610,
          denies: 12,
          hero_damage: 24000,
          benchmarks: { gold_per_min: { raw: 480, pct: 0.66 } },
        },
      ],
    });

    const res = await enrichStoredGames();
    expect(res.enriched).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.remaining).toBe(0);

    const stored = await prisma.game.findUniqueOrThrow({ where: { id: game.id } });
    const lines = JSON.parse(stored.players);
    expect(lines[0]).toMatchObject({
      // attribution and original stats untouched
      userId: "user-legacy",
      teamId: "team-legacy",
      kills: 3,
      netWorth: 12000,
      // new fields merged in
      xpm: 610,
      denies: 12,
      heroDamage: 24000,
      benchmarks: { gold_per_min: { raw: 480, pct: 0.66 } },
    });

    // Second run finds nothing left to enrich and never hits the network.
    vi.mocked(fetchOpenDotaMatch).mockClear();
    const again = await enrichStoredGames();
    expect(again.enriched).toBe(0);
    expect(again.remaining).toBe(0);
    expect(vi.mocked(fetchOpenDotaMatch)).not.toHaveBeenCalled();
  });

  it("matches an accountless line by side + hero and stamps benchmarks: null", async () => {
    const game = await legacyGame("9002", [
      { ...LEGACY_LINE, accountId: null, heroId: 42, isRadiant: false },
    ]);
    vi.mocked(fetchOpenDotaMatch).mockResolvedValue({
      match_id: 9002,
      radiant_win: true,
      duration: 2000,
      start_time: 1,
      players: [
        {
          account_id: null,
          player_slot: 128,
          hero_id: 42,
          isRadiant: false,
          kills: 0,
          deaths: 0,
          assists: 0,
          xp_per_min: 333,
          // no benchmarks from OpenDota for this one
        },
      ],
    });

    const res = await enrichStoredGames();
    expect(res.enriched).toBe(1);
    const stored = await prisma.game.findUniqueOrThrow({ where: { id: game.id } });
    const lines = JSON.parse(stored.players);
    expect(lines[0].xpm).toBe(333);
    // the null marker still lands, so this game never rescans
    expect(lines[0].benchmarks).toBeNull();
    expect(await enrichStoredGames()).toMatchObject({ enriched: 0, remaining: 0 });
  });

  it("counts a game OpenDota can't return as failed and leaves it for retry", async () => {
    await legacyGame("9003");
    vi.mocked(fetchOpenDotaMatch).mockResolvedValue(null);

    const res = await enrichStoredGames();
    expect(res.enriched).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.remaining).toBe(1); // still waiting on OpenDota

    // The stored JSON is untouched — no benchmarks marker was stamped.
    const count = await prisma.game.count({
      where: { NOT: { players: { contains: '"benchmarks"' } } },
    });
    expect(count).toBe(1);
  });
});
