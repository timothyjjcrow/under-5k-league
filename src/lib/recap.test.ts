import { describe, expect, it } from "vitest";
import { summarizeRecapGames, type RecapGameInput } from "./recap";

function completeBox(killsPerPlayer: number): string {
  return JSON.stringify(
    Array.from({ length: 10 }, (_, index) => ({
      accountId: 1000 + index,
      userId: `user-${index}`,
      teamId: index < 5 ? "radiant" : "dire",
      heroId: index + 1,
      isRadiant: index < 5,
      kills: killsPerPlayer,
      deaths: 1,
      assists: 2,
      netWorth: 10000,
      gpm: 500,
    })),
  );
}

function game(overrides: Partial<RecapGameInput>): RecapGameInput {
  return {
    matchId: "match",
    radiantWin: true,
    radiantScore: 0,
    direScore: 0,
    durationSecs: 1800,
    players: completeBox(1),
    ...overrides,
  };
}

describe("summarizeRecapGames", () => {
  it("chooses header or player-line kills per game in a mixed legacy season", () => {
    const summary = summarizeRecapGames([
      game({
        matchId: "modern",
        radiantScore: 8,
        direScore: 2,
        players: completeBox(99),
      }),
      game({
        matchId: "legacy",
        radiantScore: 0,
        direScore: 0,
        players: completeBox(2),
      }),
    ]);

    expect(summary.totalKills).toBe(30); // 10 header + 20 line fallback
    expect(summary.trustedStatGames).toBe(2);
    expect(summary.awardGames).toHaveLength(2);
  });

  it("excludes partial box scores from public awards without hiding imports", () => {
    const summary = summarizeRecapGames([
      game({
        radiantScore: 30,
        direScore: 1,
        players: JSON.stringify([
          { heroId: 1, isRadiant: true, kills: 30, deaths: 0, assists: 0 },
        ]),
      }),
    ]);

    expect(summary.awardGames).toEqual([]);
    expect(summary.trustedStatGames).toBe(0);
    expect(summary.totalKills).toBe(0);
    expect(summary.timedGames).toBe(1);
  });
});
