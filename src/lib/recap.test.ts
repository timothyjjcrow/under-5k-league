import { describe, expect, it } from "vitest";
import {
  recapDestination,
  summarizeRecapGames,
  type RecapGameInput,
} from "./recap";

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

  it("passes the extended stat fields the MVP's points read into award lines", () => {
    const box = JSON.parse(completeBox(1)) as Record<string, unknown>[];
    box[0] = {
      ...box[0],
      lastHits: 210,
      denies: 12,
      heroDamage: 18000,
      towerDamage: 2500,
      heroHealing: 6000,
    };
    const summary = summarizeRecapGames([
      game({ players: JSON.stringify(box) }),
    ]);

    expect(summary.awardGames[0].lines[0]).toMatchObject({
      userId: "user-0",
      lastHits: 210,
      denies: 12,
      heroDamage: 18000,
      towerDamage: 2500,
      heroHealing: 6000,
    });
    // A legacy line without those fields still reads as "unknown", not 0.
    expect(summary.awardGames[0].lines[1].heroHealing).toBeNull();
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

describe("recapDestination", () => {
  const active = (status: string) => ({ id: "live", status });
  const last = { id: "s9" };

  it("sends a season link to that season's page once it is finished", () => {
    for (const requested of [
      { id: "s9", isActive: false, status: "COMPLETE" },
      // Archived before the final (a cancelled season) still has its page.
      { id: "s8", isActive: false, status: "REGULAR_SEASON" },
      { id: "live", isActive: true, status: "COMPLETE" },
    ]) {
      expect(
        recapDestination({ requested, active: null, lastArchived: null }),
      ).toBe(`/seasons/${requested.id}`);
    }
  });

  it("sends a link to the running season to Leaders", () => {
    for (const status of ["SIGNUPS", "DRAFT", "REGULAR_SEASON", "PLAYOFFS"]) {
      expect(
        recapDestination({
          requested: { id: "live", isActive: true, status },
          active: null,
          lastArchived: null,
        }),
      ).toBe("/leaders");
    }
  });

  it("opens the current season's page once the final is played", () => {
    expect(
      recapDestination({
        requested: null,
        active: active("COMPLETE"),
        lastArchived: last,
      }),
    ).toBe("/seasons/live");
  });

  it("sends the bare /recap to Leaders while the season is being played", () => {
    for (const status of ["REGULAR_SEASON", "PLAYOFFS"]) {
      expect(
        recapDestination({
          requested: null,
          active: active(status),
          lastArchived: last,
        }),
      ).toBe("/leaders");
    }
  });

  it("recaps the last finished season before the new one has games, and between seasons", () => {
    for (const current of [active("SIGNUPS"), active("DRAFT"), null]) {
      expect(
        recapDestination({ requested: null, active: current, lastArchived: last }),
      ).toBe("/seasons/s9");
    }
  });

  it("falls back to Leaders when there is no season to recap", () => {
    expect(
      recapDestination({
        requested: null,
        active: active("SIGNUPS"),
        lastArchived: null,
      }),
    ).toBe("/leaders");
    expect(
      recapDestination({ requested: null, active: null, lastArchived: null }),
    ).toBe("/leaders");
  });

  it("encodes the season id into the path", () => {
    expect(
      recapDestination({
        requested: { id: "a/b", isActive: false, status: "COMPLETE" },
        active: null,
        lastArchived: null,
      }),
    ).toBe("/seasons/a%2Fb");
  });
});
