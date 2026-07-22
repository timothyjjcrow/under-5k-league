import { describe, it, expect } from "vitest";
import {
  approxRankTierFromMmr,
  clampMmrToRank,
  formatMmrRange,
  IMMORTAL_MMR_FLOOR,
  MMR_WINDOW_MAX,
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

  it("uses Divine's wider 200-MMR stars (4620/4820/5020/5220/5420)", () => {
    expect(rankMedalName(approxRankTierFromMmr(4620))).toBe("Divine 1");
    expect(rankMedalName(approxRankTierFromMmr(4819))).toBe("Divine 1");
    expect(rankMedalName(approxRankTierFromMmr(4820))).toBe("Divine 2");
    expect(rankMedalName(approxRankTierFromMmr(5300))).toBe("Divine 4");
    expect(rankMedalName(approxRankTierFromMmr(5420))).toBe("Divine 5");
  });
});

describe("mmrRangeForRankTier — the medal's plausible MMR window", () => {
  it("pads the exact star band symmetrically to a 1000-MMR window", () => {
    // Herald 1: star band [0, 153], pad 423 each way; the floor stops at 0.
    expect(mmrRangeForRankTier(11)).toEqual({ min: 0, max: 576 });
    // Legend 4: star band [3542, 3695] → [3119, 4118], exactly 1000 wide.
    expect(mmrRangeForRankTier(54)).toEqual({ min: 3119, max: 4118 });
    // Guardian 5: star band [1386, 1539].
    expect(mmrRangeForRankTier(25)).toEqual({ min: 963, max: 1962 });
  });

  it("uses Divine's 200-wide stars (pad 400 keeps the window at 1000)", () => {
    // Divine 1: band [4620, 4819].
    expect(mmrRangeForRankTier(71)).toEqual({ min: 4220, max: 5219 });
    // Divine 5: band [5420, 5619] — ends at the Immortal floor.
    expect(mmrRangeForRankTier(75)).toEqual({ min: 5020, max: 6019 });
  });

  it("gives Immortal an open-ended range", () => {
    expect(mmrRangeForRankTier(80)).toEqual({ min: 5220, max: null });
    expect(mmrRangeForRankTier(81)).toEqual({ min: 5220, max: null });
  });

  it("falls back to the whole medal band for a starless tier", () => {
    // 46 decodes as "Archon" with no star — validate against Archon at
    // large: band [2310, 3079] is 770 wide, so only 115 of pad fits the cap.
    expect(mmrRangeForRankTier(46)).toEqual({ min: 2195, max: 3194 });
    // Malformed Divine's whole band [4620, 5619] already fills the cap.
    expect(mmrRangeForRankTier(76)).toEqual({ min: 4620, max: 5619 });
  });

  it("never exceeds MMR_WINDOW_MAX for any tier (the ≤1000 rule)", () => {
    for (let medal = 1; medal <= 7; medal++) {
      for (let stars = 0; stars <= 5; stars++) {
        const range = mmrRangeForRankTier(medal * 10 + stars)!;
        expect(range.max).not.toBeNull();
        expect(range.max! - range.min + 1).toBeLessThanOrEqual(MMR_WINDOW_MAX);
      }
    }
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
    expect(clampMmrToRank(3500, 54)).toEqual({
      mmr: 3500,
      adjusted: false,
      range: { min: 3119, max: 4118 },
    });
    expect(clampMmrToRank(3119, 54).adjusted).toBe(false);
    expect(clampMmrToRank(4118, 54).adjusted).toBe(false);
  });

  it("snaps an inflated claim DOWN to the floor (never the ceiling)", () => {
    const r = clampMmrToRank(6800, 54); // Legend 4 claiming Immortal numbers
    expect(r.mmr).toBe(3119);
    expect(r.adjusted).toBe(true);
  });

  it("snaps a sandbagged claim UP to the floor", () => {
    expect(clampMmrToRank(900, 54)).toMatchObject({ mmr: 3119, adjusted: true });
  });

  it("treats a blank (0) claim as implausible when the medal says ranked", () => {
    // Auto-detection: no typed MMR + a Legend 4 medal seeds the floor.
    expect(clampMmrToRank(0, 54)).toMatchObject({ mmr: 3119, adjusted: true });
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
    expect(clampMmrToRank(3000, 80)).toMatchObject({ mmr: 5220, adjusted: true });
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
    expect(formatMmrRange({ min: 3119, max: 4118 })).toBe("3119–4118");
    expect(formatMmrRange({ min: 5220, max: null })).toBe("5220+");
  });
});

describe("rankTierExactMinMmr — the medal's honest floor (no padding)", () => {
  it("returns the exact star-band floor", () => {
    expect(rankTierExactMinMmr(11)).toBe(0); // Herald 1
    expect(rankTierExactMinMmr(54)).toBe(3542); // Legend 4
    expect(rankTierExactMinMmr(72)).toBe(4820); // Divine 2 — under the 5K line
    expect(rankTierExactMinMmr(73)).toBe(5020); // Divine 3 — a 5K+ player
    expect(rankTierExactMinMmr(74)).toBe(5220);
    expect(rankTierExactMinMmr(75)).toBe(5420);
    expect(rankTierExactMinMmr(80)).toBe(IMMORTAL_MMR_FLOOR);
  });

  it("uses the medal floor for starless tiers and null without a medal", () => {
    expect(rankTierExactMinMmr(46)).toBe(2310); // Archon, no star
    expect(rankTierExactMinMmr(null)).toBeNull();
    expect(rankTierExactMinMmr(0)).toBeNull();
    expect(rankTierExactMinMmr(99)).toBeNull();
  });
});
