import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { makeSeason, makeTeam } from "./factories";
import {
  fetchAllGameLines,
  fetchAllGameScores,
  fetchAllGamesForRecords,
  fetchAllGamesForScouting,
  fetchSeasonGameLeaders,
  fetchSeasonGameScores,
  fetchSeasonGamesForRecap,
} from "@/lib/cached-queries";

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

    // getAllGamesForRecords === the record-book scan (matchup context, ordered)
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

    // getSeasonGamesForRecap === the recap/awards scan (scores + duration,
    // deliberately NO orderBy — computeSeasonAwards' ties follow row order).
    const recapA = await fetchSeasonGamesForRecap(a.season.id);
    const recapB = await fetchSeasonGamesForRecap(b.season.id);
    expect(recapA).toHaveLength(3);
    expect(recapB).toHaveLength(2);
    expect(recapA).toEqual(
      await prisma.game.findMany({
        where: { match: { seasonId: a.season.id } },
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
});
