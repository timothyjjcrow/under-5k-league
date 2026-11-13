import { describe, expect, it } from "vitest";
import { computeSeasonAwards } from "./awards";
import { rankByCell } from "./leader-ranking";
import {
  LEADER_STAT_KEYS,
  buildLeaderTable,
  mvpGamesFloor,
  rateGamesFloor,
  type LeaderGame,
  type LeaderStatKey,
} from "./leader-table";
import type { PlayerStat } from "./match-import";
import { PER_GAME_MIN_GAMES } from "./player-stats";

let heroId = 0;
function line(userId: string | null, partial: Partial<PlayerStat> = {}): PlayerStat {
  heroId += 1;
  return {
    accountId: null,
    heroId,
    isRadiant: true,
    kills: 0,
    deaths: 0,
    assists: 0,
    personaname: null,
    netWorth: null,
    gpm: null,
    lastHits: null,
    xpm: null,
    denies: null,
    level: null,
    heroDamage: null,
    towerDamage: null,
    heroHealing: null,
    benchmarks: null,
    userId,
    teamId: null,
    ...partial,
  } as PlayerStat;
}

/** One game a player appears in, alone on the winning Radiant side. */
const game = (userId: string, partial: Partial<PlayerStat> = {}): LeaderGame => ({
  radiantWin: true,
  lines: [line(userId, partial)],
});

/** Ids in a stat's ranking, best first. */
function order(games: LeaderGame[], key: LeaderStatKey): string[] {
  const table = buildLeaderTable(games);
  return rankByCell(table.rows, (row) => row.cells[key]).map(({ row }) => row.id);
}

describe("buildLeaderTable", () => {
  it("ranks kills and assists per game, not as season totals", () => {
    // "extra" played twice as many games (a tiebreaker series, playoffs) and
    // so has the bigger total; per game, the steadier "sharp" leads.
    const games = [
      ...Array.from({ length: 6 }, () => game("extra", { kills: 4, assists: 9 })),
      ...Array.from({ length: 3 }, () => game("sharp", { kills: 7, assists: 12 })),
    ];
    const table = buildLeaderTable(games);
    const kills = rankByCell(table.rows, (row) => row.cells.killsPerGame);
    expect(kills.map(({ row }) => [row.id, row.cells.killsPerGame?.value])).toEqual([
      ["sharp", 7],
      ["extra", 4],
    ]);
    expect(order(games, "assistsPerGame")).toEqual(["sharp", "extra"]);
  });

  it("holds kills and assists per game to the flat minimum, however early the season", () => {
    // Nobody has played three games, so the adaptive floor would be 2. The
    // per-game rankings don't follow it: they stay empty.
    const early = [
      game("a", { kills: 9, assists: 9 }),
      game("a", { kills: 9, assists: 9 }),
      game("b", { kills: 5, assists: 5 }),
    ];
    expect(PER_GAME_MIN_GAMES).toBe(3);
    expect(order(early, "killsPerGame")).toEqual([]);
    expect(order(early, "assistsPerGame")).toEqual([]);
    // KDA follows the season: both-game "a" qualifies at the capped floor.
    expect(order(early, "kda")).toEqual(["a"]);
    // The unranked value is still on the row, for the dimmed figure.
    const row = buildLeaderTable(early).rows.find((r) => r.id === "a")!;
    expect(row.cells.killsPerGame).toMatchObject({ label: "9.0", ranked: false });
  });

  it("keeps a one-game outlier off a per-game ranking", () => {
    const games = [
      game("oneshot", { kills: 20 }),
      ...[6, 8, 7, 5].map((kills) => game("grinder", { kills })),
    ];
    expect(order(games, "killsPerGame")).toEqual(["grinder"]);
  });

  it("applies economy floors to reported samples, not the games played", () => {
    const games = [
      game("one-sample", { gpm: 900 }),
      game("one-sample"),
      game("one-sample"),
      ...[500, 550, 600].map((gpm) => game("qualified", { gpm })),
      game("nodata"),
    ];
    expect(order(games, "gpm")).toEqual(["qualified"]);
    const table = buildLeaderTable(games);
    // No economy data is no cell at all, never a zero.
    expect(table.rows.find((row) => row.id === "nodata")!.cells.gpm).toBeUndefined();
    expect(table.rows.find((row) => row.id === "one-sample")!.cells.gpm).toMatchObject({
      value: 900,
      ranked: false,
    });
  });

  it("gives a zero no cell: nothing to rank", () => {
    const games = [game("a", { kills: 3 }), game("b"), game("b")];
    const b = buildLeaderTable(games).rows.find((row) => row.id === "b")!;
    expect(b.cells.killsPerGame).toBeUndefined();
    expect(b.cells.kda).toBeUndefined();
  });

  it("counts attendance with wins and losses in words", () => {
    const games = [
      ...Array.from({ length: 3 }, () => game("regular")),
      { radiantWin: false, lines: [line("standin", { kills: 9 })] },
    ];
    expect(order(games, "games")).toEqual(["regular", "standin"]);
    const table = buildLeaderTable(games);
    expect(table.rows.find((row) => row.id === "regular")!.cells.games).toMatchObject({
      label: "3",
      hint: "3 wins, 0 losses",
      ranked: true,
    });
    // A bare "0–1" beside a games count read as a score.
    expect(table.rows.find((row) => row.id === "standin")!.cells.games?.hint).toBe(
      "0 wins, 1 loss",
    );
  });

  it("ranks the MVP race as the season award would crown it", () => {
    // "cameo" has the best night but under half the most games played.
    const games: LeaderGame[] = [
      ...Array.from({ length: 6 }, () => game("steady", { kills: 8, assists: 10, deaths: 2 })),
      ...Array.from({ length: 6 }, () => game("solid", { kills: 6, assists: 9, deaths: 3 })),
      ...Array.from({ length: 2 }, () => game("cameo", { kills: 20, assists: 20 })),
    ];
    expect(mvpGamesFloor(6)).toBe(3);
    expect(order(games, "impact")).toEqual(["steady", "solid"]);
    const awards = computeSeasonAwards(
      games.map((g, index) => ({
        matchId: `m${index}`,
        radiantWin: g.radiantWin,
        radiantScore: 20,
        direScore: 10,
        lines: g.lines,
      })),
    );
    expect(awards.find((award) => award.key === "mvp")?.userId).toBe("steady");
    const stat = buildLeaderTable(games).stats.find((s) => s.key === "impact")!;
    expect(stat.minimum).toBe("Min 3 games: half the most anyone has played");
  });

  it("leaves out an optional ranking nobody is on, and keeps the rest", () => {
    const bare = buildLeaderTable(
      Array.from({ length: 3 }, () => game("a", { kills: 3 })),
    );
    expect(bare.stats.map((stat) => stat.key)).toEqual(
      LEADER_STAT_KEYS.filter((key) => key !== "healing" && key !== "report"),
    );
    // Kill involvement needs scored games: a scoreless one has no share.
    const scoreless = buildLeaderTable([game("a", { kills: 3 }), game("a"), game("a")]);
    expect(scoreless.stats.map((stat) => stat.key)).not.toContain("participation");
    const healed = buildLeaderTable(
      Array.from({ length: 3 }, () => game("a", { kills: 3, heroHealing: 4000 })),
    );
    expect(healed.stats.map((stat) => stat.key)).toContain("healing");
    // A missing healing value is never a zero: only reported games count.
    const mixed = buildLeaderTable([
      game("a", { heroHealing: 6000 }),
      game("a"),
      game("a", { heroHealing: 2000 }),
    ]);
    expect(mixed.rows[0].cells.healing).toMatchObject({
      value: 4000,
      sample: 2,
      hint: "8,000 total · 2 reported games",
    });
  });

  it("skips unlinked lines and lists a player's most-played heroes", () => {
    const table = buildLeaderTable([
      { radiantWin: true, lines: [line(null, { kills: 30 }), line("a", { heroId: 9 })] },
      game("a", { heroId: 9 }),
      game("a", { heroId: 4 }),
    ]);
    expect(table.rows.map((row) => row.id)).toEqual(["a"]);
    expect(table.rows[0].heroes[0]).toEqual({ heroId: 9, games: 2, wins: 2 });
  });

  it("caps the following floors at the most-played count", () => {
    expect(rateGamesFloor(0)).toBe(1);
    expect(rateGamesFloor(2)).toBe(2);
    expect(rateGamesFloor(9)).toBe(PER_GAME_MIN_GAMES);
    expect(mvpGamesFloor(1)).toBe(1);
    expect(mvpGamesFloor(7)).toBe(4);
  });
});
