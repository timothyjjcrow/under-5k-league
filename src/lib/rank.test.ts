import { describe, it, expect } from "vitest";
import {
  approxRankTierFromMmr,
  rankMedalName,
  rankMedalTier,
  rankStars,
} from "./rank";

describe("rank decoding", () => {
  it("names medals with stars", () => {
    expect(rankMedalName(11)).toBe("Herald 1");
    expect(rankMedalName(55)).toBe("Legend 5");
    expect(rankMedalName(71)).toBe("Divine 1");
    expect(rankMedalName(46)).toBe("Archon"); // star out of range -> no star
  });

  it("treats Immortal as starless", () => {
    expect(rankMedalName(80)).toBe("Immortal");
    expect(rankMedalName(81)).toBe("Immortal");
  });

  it("returns Unranked for null/0/invalid", () => {
    expect(rankMedalName(null)).toBe("Unranked");
    expect(rankMedalName(0)).toBe("Unranked");
    expect(rankMedalName(99)).toBe("Unranked");
  });

  it("exposes medal tier and stars", () => {
    expect(rankMedalTier(55)).toBe(5);
    expect(rankStars(55)).toBe(5);
    expect(rankMedalTier(null)).toBe(0);
    expect(rankStars(80)).toBe(0);
  });

  it("approximates a plausible rank tier from MMR", () => {
    expect(rankMedalName(approxRankTierFromMmr(100))).toBe("Herald 1");
    // Close MMRs land in the same medal, a star apart.
    expect(rankMedalName(approxRankTierFromMmr(4200))).toBe("Ancient 3");
    expect(rankMedalName(approxRankTierFromMmr(4375))).toBe("Ancient 4");
    // Star/medal never exceed their ranges; Immortal above the ladder.
    expect(rankMedalName(approxRankTierFromMmr(5619))).toBe("Divine 5");
    expect(rankMedalName(approxRankTierFromMmr(5620))).toBe("Immortal");
    expect(rankMedalName(approxRankTierFromMmr(0))).toBe("Herald 1");
  });
});
