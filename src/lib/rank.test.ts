import { describe, it, expect } from "vitest";
import {
  approxRankTierFromMmr,
  clampMmrToRank,
  formatMmrRange,
  IMMORTAL_MMR_FLOOR,
  MMR_MEDAL_TOLERANCE,
  mmrRangeForRankTier,
  rankMedalName,
  rankMedalTier,
  rankStars,
  rankTierExactMinMmr,
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

describe("mmrRangeForRankTier — the medal's plausible MMR window", () => {
  it("wraps the exact star band in a full medal of tolerance each way", () => {
    // Herald 1: star band [0, 153]; the lower tolerance floors at 0.
    expect(mmrRangeForRankTier(11)).toEqual({ min: 0, max: 153 + 770 });
    // Legend 4: star band [3542, 3695].
    expect(mmrRangeForRankTier(54)).toEqual({ min: 2772, max: 4465 });
    // Guardian 5: star band [1386, 1539].
    expect(mmrRangeForRankTier(25)).toEqual({ min: 616, max: 2309 });
  });

  it("stretches Divine 5 to the Immortal floor", () => {
    // Divine 5's band is [5236, 5619] — wider than a uniform star.
    expect(mmrRangeForRankTier(75)).toEqual({ min: 4466, max: 5619 + 770 });
  });

  it("gives Immortal an open-ended range", () => {
    expect(mmrRangeForRankTier(80)).toEqual({
      min: IMMORTAL_MMR_FLOOR - MMR_MEDAL_TOLERANCE,
      max: null,
    });
    expect(mmrRangeForRankTier(81)).toEqual({ min: 4850, max: null });
  });

  it("falls back to the whole medal band for a starless tier", () => {
    // 46 decodes as "Archon" with no star — validate against Archon at large.
    expect(mmrRangeForRankTier(46)).toEqual({
      min: 2310 - 770,
      max: 3079 + 770,
    });
    // Malformed Divine likewise stretches to the Immortal floor.
    expect(mmrRangeForRankTier(76)).toEqual({ min: 3850, max: 5619 + 770 });
  });

  it("has no opinion without a medal", () => {
    expect(mmrRangeForRankTier(null)).toBeNull();
    expect(mmrRangeForRankTier(undefined)).toBeNull();
    expect(mmrRangeForRankTier(0)).toBeNull();
    expect(mmrRangeForRankTier(99)).toBeNull();
  });
});

describe("clampMmrToRank — snap implausible claims to the range floor", () => {
  it("keeps a claim inside the window, boundaries included", () => {
    expect(clampMmrToRank(3000, 54)).toEqual({
      mmr: 3000,
      adjusted: false,
      range: { min: 2772, max: 4465 },
    });
    expect(clampMmrToRank(2772, 54).adjusted).toBe(false);
    expect(clampMmrToRank(4465, 54).adjusted).toBe(false);
  });

  it("snaps an inflated claim DOWN to the floor (never the ceiling)", () => {
    const r = clampMmrToRank(6800, 54); // Legend 4 claiming Immortal numbers
    expect(r.mmr).toBe(2772);
    expect(r.adjusted).toBe(true);
  });

  it("snaps a sandbagged claim UP to the floor", () => {
    expect(clampMmrToRank(900, 54)).toMatchObject({ mmr: 2772, adjusted: true });
  });

  it("treats a blank (0) claim as implausible when the medal says ranked", () => {
    // Auto-detection: no typed MMR + a Legend 4 medal seeds the floor.
    expect(clampMmrToRank(0, 54)).toMatchObject({ mmr: 2772, adjusted: true });
    // …but 0 is INSIDE Herald 1's window, so low ranks stay untouched.
    expect(clampMmrToRank(0, 11)).toMatchObject({ mmr: 0, adjusted: false });
  });

  it("never clamps without a medal", () => {
    expect(clampMmrToRank(9999, null)).toEqual({
      mmr: 9999,
      adjusted: false,
      range: null,
    });
    expect(clampMmrToRank(0, 0)).toMatchObject({ mmr: 0, adjusted: false });
  });

  it("accepts any high value for Immortal (open ceiling), floors low ones", () => {
    expect(clampMmrToRank(11000, 80).adjusted).toBe(false);
    expect(clampMmrToRank(3000, 80)).toMatchObject({ mmr: 4850, adjusted: true });
  });

  it("never disputes its own approximation (inverse consistency)", () => {
    // Every MMR must sit inside the window of the tier it approximates to —
    // otherwise seeded/demo data would flag itself as implausible.
    for (let mmr = 0; mmr <= 12000; mmr += 7) {
      const tier = approxRankTierFromMmr(mmr);
      expect(clampMmrToRank(mmr, tier).adjusted).toBe(false);
    }
  });
});

describe("formatMmrRange", () => {
  it("renders closed and open-ended ranges", () => {
    expect(formatMmrRange({ min: 2772, max: 4465 })).toBe("2772–4465");
    expect(formatMmrRange({ min: 4850, max: null })).toBe("4850+");
  });
});

describe("rankTierExactMinMmr — the medal's honest floor (no tolerance)", () => {
  it("returns the exact star-band floor", () => {
    expect(rankTierExactMinMmr(11)).toBe(0); // Herald 1
    expect(rankTierExactMinMmr(54)).toBe(3542); // Legend 4
    expect(rankTierExactMinMmr(73)).toBe(4928); // Divine 3 — under the 5K line
    expect(rankTierExactMinMmr(74)).toBe(5082); // Divine 4 — a 5K+ player
    expect(rankTierExactMinMmr(75)).toBe(5236); // Divine 5
    expect(rankTierExactMinMmr(80)).toBe(IMMORTAL_MMR_FLOOR);
  });

  it("uses the medal floor for starless tiers and null without a medal", () => {
    expect(rankTierExactMinMmr(46)).toBe(2310); // Archon, no star
    expect(rankTierExactMinMmr(null)).toBeNull();
    expect(rankTierExactMinMmr(0)).toBeNull();
    expect(rankTierExactMinMmr(99)).toBeNull();
  });
});
