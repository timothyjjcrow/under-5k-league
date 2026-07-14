import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { makeSeason, makeTeam } from "./factories";
import {
  fetchAllGameLines,
  fetchAllGameScores,
  fetchAllGamesForRecords,
  fetchSeasonGameLeaders,
  fetchSeasonGameScores,
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

async function seedSeasonWithGames(name: string, gameCount: number) {
  const season = await makeSeason({
    name,
    status: SEASON_STATUS.REGULAR_SEASON,
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
    const b = await seedSeasonWithGames("Beta", 2);

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
      orderBy: [{ startTime: "asc" }, { fetchedAt: "asc" }],
      select: {
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
    // orderBy matters here — compare in exact returned order.
    expect(recordsCached).toEqual(recordsInline);
    expect(recordsCached[0].match.homeTeam.name).toContain("Home");

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
  });
});
