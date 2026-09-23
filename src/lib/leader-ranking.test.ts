import { describe, expect, it } from "vitest";
import {
  competitionRanks,
  killParticipationByPlayer,
  leaderIdentity,
} from "./leader-ranking";

describe("competitionRanks", () => {
  it("gives equal displayed values the same placement", () => {
    expect(competitionRanks([10, 10, 8, 7, 7])).toEqual([1, 1, 3, 4, 4]);
  });

  it("handles empty and untied boards", () => {
    expect(competitionRanks([])).toEqual([]);
    expect(competitionRanks([9, 8, 7])).toEqual([1, 2, 3]);
  });

  it("keeps equal rounded display values tied", () => {
    const displayPrecision = [0.724, 0.721, 0.709].map((value) =>
      Math.round(value * 100),
    );
    expect(competitionRanks(displayPrecision)).toEqual([1, 1, 3]);
  });
});

describe("leaderIdentity", () => {
  it("preserves a live profile and labels a retained historical line", () => {
    expect(
      leaderIdentity({ name: "Axe", avatar: "axe.png", rankTier: 42 }),
    ).toEqual({
      name: "Axe",
      avatar: "axe.png",
      rankTier: 42,
      hasProfile: true,
    });
    expect(leaderIdentity(undefined)).toEqual({
      name: "Former player",
      avatar: null,
      rankTier: null,
      hasProfile: false,
    });
  });
});

describe("killParticipationByPlayer", () => {
  it("credits assists and includes unlinked teammates in the denominator", () => {
    const results = killParticipationByPlayer([
      {
        lines: [
          { userId: "support", isRadiant: true, kills: 0, assists: 4 },
          { userId: "carry", isRadiant: true, kills: 3, assists: 1 },
          { userId: null, isRadiant: true, kills: 2, assists: 0 },
          { userId: "opponent", isRadiant: false, kills: 1, assists: 0 },
        ],
      },
    ]);
    expect(results.get("support")).toEqual({
      involved: 4,
      teamKills: 5,
      scoredGames: 1,
      rate: 80,
    });
    expect(results.get("carry")?.rate).toBe(80);
  });

  it("weights games by team kills and skips scoreless sides", () => {
    const results = killParticipationByPlayer([
      {
        lines: [
          { userId: "player", isRadiant: true, kills: 1, assists: 0 },
          { userId: null, isRadiant: true, kills: 1, assists: 0 },
        ],
      },
      {
        lines: [
          { userId: "player", isRadiant: false, kills: 0, assists: 1 },
          { userId: null, isRadiant: false, kills: 2, assists: 0 },
        ],
      },
      { lines: [{ userId: "player", isRadiant: true, kills: 0, assists: 0 }] },
    ]);
    expect(results.get("player")).toEqual({
      involved: 2,
      teamKills: 4,
      scoredGames: 2,
      rate: 50,
    });
  });
});
