import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { makeSeason, makeTeam } from "./factories";
import {
  fetchAllGameLines,
  fetchAllGameScores,
  fetchAllGamesForRecords,
  fetchAllGamesForScouting,
  fetchCareerFacts,
  fetchRecordBookView,
  fetchRecordWatchBook,
  fetchSeasonGameLeaders,
  fetchSeasonGameScores,
  fetchSeasonGamesForRecap,
  fetchSeasonHeroGames,
} from "@/lib/cached-queries";
import { fetchPublicGameSnapshot } from "@/lib/public-game-snapshot";
import { appearanceCareers, careersFromFacts } from "@/lib/appearance-careers";
import { hallOfFameGameBoards } from "@/lib/hall-of-fame";
import { leagueRecords, recordWatchBook, toRecordGames } from "@/lib/records";

// The perf pass replaced five inline `prisma.game.findMany(...)` stat scans
// with cached wrappers (unstable_cache, 60s TTL) in src/lib/cached-queries.ts.
// This guards that each scan returns data IDENTICAL to the query it replaced —
// a dropped/renamed field or wrong orderBy would silently corrupt leaders /
// hero-meta / records / hall-of-fame / player profiles.
//
// We exercise the raw `fetch*` query functions (the cache wrappers around them
// are Next's own code and require the server runtime — see cached-queries.ts).
// This proves the QUERY is correct; the live fixture demo proves the caching.

async function seedSeasonWithGames(
  name: string,
  gameCount: number,
  isActive = true,
) {
  const season = await makeSeason({
    name,
    status: SEASON_STATUS.REGULAR_SEASON,
    isActive,
  });
  const home = await makeTeam(season.id, `${name} Home`, 0);
  const away = await makeTeam(season.id, `${name} Away`, 1);
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: home.id,
      awayTeamId: away.id,
      status: MATCH_STATUS.COMPLETED,
    },
  });
  for (let i = 0; i < gameCount; i++) {
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: `${name}-${i}`,
        radiantWin: i % 2 === 0,
        durationSecs: 1800 + i * 60,
        radiantScore: 20 + i,
        direScore: 15 + i,
        startTime: 1000 + i,
        players: JSON.stringify([{ userId: `${name}-u${i}`, kills: i }]),
      },
    });
  }
  return { season, match, home, away };
}

// Field-order-independent comparison keyed on a stable identity.
function sortById<T extends Record<string, unknown>>(rows: T[], key: keyof T) {
  return [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}

describe("cached-queries data-equivalence", () => {
  it("each raw scan matches its inline query and filters correctly by season", async () => {
    const a = await seedSeasonWithGames("Alpha", 3);
    const b = await seedSeasonWithGames("Beta", 2, false);

    // getAllGameLines === prisma.game.findMany({ select: { id, players } })
    const linesCached = await fetchAllGameLines();
    const linesInline = await prisma.game.findMany({
      select: { id: true, players: true },
    });
    expect(sortById(linesCached, "id")).toEqual(sortById(linesInline, "id"));
    expect(linesCached).toHaveLength(5);

    // getAllGameScores === findMany({ select: { players, radiantWin } })
    const scoresCached = await fetchAllGameScores();
    const scoresInline = await prisma.game.findMany({
      select: { players: true, radiantWin: true },
    });
    expect(sortById(scoresCached, "players")).toEqual(
      sortById(scoresInline, "players"),
    );

    // fetchAllGamesForRecords === the record-book scan (matchup context, ordered)
    const recordsCached = await fetchAllGamesForRecords();
    const recordsInline = await prisma.game.findMany({
      select: {
        id: true,
        startTime: true,
        matchId: true,
        radiantWin: true,
        durationSecs: true,
        radiantScore: true,
        direScore: true,
        players: true,
        match: {
          select: {
            seasonId: true,
            homeTeam: { select: { name: true } },
            awayTeam: { select: { name: true } },
          },
        },
      },
    });
    recordsInline.sort((left, right) => {
      const leftTime =
        left.startTime > 0 ? left.startTime : Number.MAX_SAFE_INTEGER;
      const rightTime =
        right.startTime > 0 ? right.startTime : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime || left.id.localeCompare(right.id);
    });
    // The total chronology matters here — compare in exact returned order.
    expect(recordsCached).toEqual(recordsInline);
    expect(recordsCached[0].match.homeTeam.name).toContain("Home");

    // getAllGamesForScouting === the match-preview dossier scan (all seasons)
    const scoutCached = await fetchAllGamesForScouting();
    const scoutInline = await prisma.game.findMany({
      select: {
        players: true,
        radiantWin: true,
        durationSecs: true,
        startTime: true,
      },
    });
    expect(sortById(scoutCached, "players")).toEqual(
      sortById(scoutInline, "players"),
    );
    expect(scoutCached).toHaveLength(5);

    // Per-season scans must scope to their argument — A and B stay separate
    // (the cache wrapper keys on this same arg so entries don't collide).
    const metaA = await fetchSeasonGameScores(a.season.id);
    const metaB = await fetchSeasonGameScores(b.season.id);
    expect(metaA).toHaveLength(3);
    expect(metaB).toHaveLength(2);
    expect(metaA).toEqual(
      await prisma.game.findMany({
        where: { match: { seasonId: a.season.id } },
        select: { players: true, radiantWin: true },
      }),
    );

    const leadersA = await fetchSeasonGameLeaders(a.season.id);
    const leadersB = await fetchSeasonGameLeaders(b.season.id);
    expect(leadersA).toHaveLength(3);
    expect(leadersB).toHaveLength(2);
    expect(leadersA).toEqual(
      await prisma.game.findMany({
        where: { match: { seasonId: a.season.id } },
        select: {
          players: true,
          radiantWin: true,
          match: { select: { week: true, phase: true } },
        },
      }),
    );
    // The season key genuinely partitions: A's rows carry A's week/phase and
    // never leak B's games.
    expect(leadersA.every((g) => g.match.week === 1)).toBe(true);

    // Recap ties follow fetchedAt, then stable ID, independent of query plan.
    const recapA = await fetchSeasonGamesForRecap(a.season.id);
    const recapB = await fetchSeasonGamesForRecap(b.season.id);
    expect(recapA).toHaveLength(3);
    expect(recapB).toHaveLength(2);
    expect(recapA).toEqual(
      await prisma.game.findMany({
        where: { match: { seasonId: a.season.id } },
        orderBy: [{ fetchedAt: "asc" }, { id: "asc" }],
        select: {
          matchId: true,
          radiantWin: true,
          radiantScore: true,
          direScore: true,
          durationSecs: true,
          players: true,
        },
      }),
    );
  });

  it("gives the hero pages one season's games with their week and teams", async () => {
    const a = await seedSeasonWithGames("HeroA", 3);
    await seedSeasonWithGames("HeroB", 2, false);
    const inline = await prisma.game.findMany({
      where: { match: { seasonId: a.season.id } },
      select: {
        id: true, matchId: true, startTime: true, durationSecs: true, radiantWin: true, players: true,
        match: {
          select: {
            week: true,
            homeTeam: { select: { id: true, name: true } },
            awayTeam: { select: { id: true, name: true } },
          },
        },
      },
    });
    const expected = inline.map(({ match, ...game }) => ({
      ...game, week: match.week, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
    }));
    const heroGames = await fetchSeasonHeroGames(a.season.id);
    expect(sortById(heroGames, "id")).toEqual(sortById(expected, "id"));
    expect(heroGames).toHaveLength(3);
    expect(heroGames.every((game) => game.homeTeam.id === a.home.id && game.awayTeam.id === a.away.id)).toBe(true);
    expect(await fetchSeasonHeroGames("missing-season")).toEqual([]);
  });

  it("puts unknown record timestamps last and resolves exact times stably", async () => {
    const seeded = await seedSeasonWithGames("Chronology", 3);
    const rows = await prisma.game.findMany({
      where: { matchId: seeded.match.id },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    await prisma.$transaction([
      prisma.game.update({
        where: { id: rows[0].id },
        data: { startTime: 0 },
      }),
      prisma.game.update({
        where: { id: rows[1].id },
        data: { startTime: 2000 },
      }),
      prisma.game.update({
        where: { id: rows[2].id },
        data: { startTime: 2000 },
      }),
    ]);

    const ordered = await fetchAllGamesForRecords();
    expect(ordered.map((game) => game.id)).toEqual([
      ...[rows[1].id, rows[2].id].sort(),
      rows[0].id,
    ]);
  });

  it("keeps the canonical season snapshot complete and preserves opposing recap chronology", async () => {
    const a = await seedSeasonWithGames("Scoped", 3);
    await seedSeasonWithGames("Other", 2, false);
    const games = await prisma.game.findMany({
      where: { matchId: a.match.id }, orderBy: { id: "asc" },
    });
    for (const [index, game] of games.entries()) {
      await prisma.game.update({
        where: { id: game.id },
        data: { fetchedAt: new Date((3 - index) * 1000) },
      });
    }
    const snapshot = await fetchPublicGameSnapshot(a.season.id);
    expect(snapshot).toHaveLength(3);
    expect(snapshot.every((game) => game.matchId === a.match.id)).toBe(true);
    expect(snapshot.every((game) => typeof game.fetchedAtMs === "number")).toBe(true);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect((await fetchSeasonGamesForRecap(a.season.id)).map((game) => game.players))
      .toEqual([...games].reverse().map((game) => game.players));
    expect(await fetchPublicGameSnapshot("missing-season")).toEqual([]);
  });

  it("keeps score reads to one datasource statement and only loads requested context", async () => {
    const { season } = await seedSeasonWithGames("Statements", 2);
    async function statements() {
      const metrics = await prisma.$metrics.json();
      const counter = metrics.counters.find((entry) => entry.key === "prisma_datasource_queries_total");
      expect(counter, "Prisma engine metrics must be enabled for the SQL regression check").toBeDefined();
      return counter!.value;
    }
    async function measure(read: () => Promise<unknown>) {
      const before = await statements();
      await read();
      return (await statements()) - before;
    }
    expect(await measure(() => prisma.game.findMany({
      where: { match: { seasonId: season.id } }, select: { players: true, radiantWin: true },
    }))).toBe(1);
    expect(await measure(() => fetchSeasonGameScores(season.id))).toBe(1);
    expect(await measure(() => fetchSeasonGamesForRecap(season.id))).toBe(1);
    expect(await measure(() => fetchSeasonGameLeaders(season.id))).toBe(2);
    // The hero pages add the season's team names: one more flat statement.
    expect(await measure(() => fetchSeasonHeroGames(season.id))).toBe(3);
    // One Game, one flat Match context, and one bulk Team-name statement.
    expect(await measure(fetchAllGamesForRecords)).toBe(3);
    // The cached all-history outputs read the same flat statements.
    expect(await measure(fetchRecordWatchBook)).toBe(3);
    expect(await measure(() => fetchRecordBookView(season.id))).toBe(3);
    expect(await measure(fetchCareerFacts)).toBe(2);
  });
});

describe("cached all-history outputs", () => {
  /** A played fixture with two complete five-a-side box scores. */
  async function playedSeason(name: string, isActive: boolean, startTime: number) {
    const season = await makeSeason({ name, status: SEASON_STATUS.COMPLETE, isActive });
    const home = await makeTeam(season.id, `${name} Home`, 0);
    const away = await makeTeam(season.id, `${name} Away`, 1);
    const match = await prisma.match.create({
      data: {
        seasonId: season.id, week: 1, phase: MATCH_PHASE.REGULAR, homeTeamId: home.id,
        awayTeamId: away.id, status: MATCH_STATUS.COMPLETED, winnerTeamId: home.id,
        homeScore: 2, awayScore: 0,
      },
    });
    for (let g = 0; g < 2; g++) {
      await prisma.game.create({
        data: {
          matchId: match.id, dotaMatchId: `${name}-box-${g}`, radiantWin: true,
          durationSecs: 2000 + g, radiantScore: 30 + g, direScore: 10, startTime: startTime + g,
          players: JSON.stringify(Array.from({ length: 10 }, (_, i) => ({
            userId: `${name}-u${i}`, teamId: i < 5 ? home.id : away.id, accountId: 500 + i,
            heroId: i + 1, isRadiant: i < 5, kills: i + g, deaths: 2, assists: 4,
            netWorth: 12000 + i, gpm: 400 + i, lastHits: 90 + i,
          }))),
        },
      });
    }
    return { season, home, match };
  }

  it("work out what the pages showed from the same rows, per season scope", async () => {
    const a = await playedSeason("Archive", false, 1000);
    const b = await playedSeason("Current", true, 5000);
    const rows = await fetchAllGamesForRecords();
    expect(rows).toHaveLength(4);

    expect(await fetchRecordWatchBook()).toEqual(recordWatchBook(toRecordGames(rows)));
    const archive = await fetchRecordBookView(a.season.id);
    expect(archive.book).toEqual(
      leagueRecords(toRecordGames(rows.filter((row) => row.match.seasonId === a.season.id))),
    );
    expect(archive).toMatchObject({ scopedGames: 2, eligibleGames: 2 });
    expect(archive.seasonIdsWithGames.sort()).toEqual([a.season.id, b.season.id].sort());
    expect(archive.book.games.every((record) => record.matchId === a.match.id)).toBe(true);
    expect(archive.matchups).toContainEqual({
      matchId: a.match.id, home: "Archive Home", away: "Archive Away",
    });
    expect((await fetchRecordBookView(null)).scopedGames).toBe(4);

    // Careers fold today's results into the cached appearances.
    const matches = await prisma.match.findMany({
      select: { id: true, seasonId: true, status: true, winnerTeamId: true, homeTeamId: true, awayTeamId: true },
    });
    const champions = [{ seasonId: a.season.id, teamId: a.home.id }];
    const facts = await fetchCareerFacts();
    const careers = careersFromFacts(facts.appearances, matches, champions);
    expect(careers).toEqual(appearanceCareers(await fetchPublicGameSnapshot(null), matches, champions));
    expect(careers.seriesWins.get("Archive-u0")).toBe(1);
    expect(careers.championshipContributions.get("Archive-u0")).toBe(1);
    expect(careers.coverage).toEqual({ importedGames: 4, trustedGames: 4, attributedLines: 40, unattributedLines: 0 });
    const boards = hallOfFameGameBoards(facts.games);
    expect(boards.seasonsWithGames).toBe(2);
    expect(boards.gameCounts.get("Current-u1")).toEqual({ games: 2, wins: 2 });
  });
});
