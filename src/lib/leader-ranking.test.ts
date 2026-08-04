import { describe, expect, it } from "vitest";
import { competitionRanks, leaderIdentity } from "./leader-ranking";

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
