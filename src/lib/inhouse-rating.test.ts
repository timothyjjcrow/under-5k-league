import { describe, expect, it } from "vitest";
import {
  inhouseMmrStanding,
  inhouseRatingLogSummary,
  inhouseRatingSavedMessage,
  overInhouseCap,
  parseInhouseRatingForm,
  sameInhouseRating,
  type InhouseRating,
} from "./inhouse-rating";
import { EDITABLE_RANK_TIERS, isEditableRankTier } from "./rank";

function form(fields: Record<string, string | null>) {
  const data = new FormData();
  const all: Record<string, string | null> = {
    userId: "player-1",
    mmr: "4100",
    medalMode: "manual",
    rankTier: "54",
    expectedMmr: "",
    expectedRankTier: "31",
    expectedRankTierManual: "0",
    ...fields,
  };
  for (const [key, value] of Object.entries(all)) {
    if (value !== null) data.set(key, value);
  }
  return data;
}

describe("parseInhouseRatingForm", () => {
  it("reads a set MMR, a manual medal and the editor's snapshot", () => {
    expect(parseInhouseRatingForm(form({}))).toEqual({
      ok: true,
      input: {
        userId: "player-1",
        mmr: 4100,
        medal: { manual: true, rankTier: 54 },
        expected: { mmr: null, rankTier: 31, manual: false },
      },
    });
  });

  it("reads a blank MMR as clearing the admin's number", () => {
    const parsed = parseInhouseRatingForm(form({ mmr: "  " }));
    expect(parsed.ok && parsed.input.mmr).toBeNull();
    const missing = parseInhouseRatingForm(form({ mmr: null }));
    expect(missing.ok && missing.input.mmr).toBeNull();
  });

  it.each(["1", "4999", "5001", "12000"])("accepts %s, over the cap too", (mmr) => {
    const parsed = parseInhouseRatingForm(form({ mmr }));
    expect(parsed.ok && parsed.input.mmr).toBe(Number(mmr));
  });

  it.each(["0", "-1", "12001", "3.5", "3e3", "3100oops", "Infinity", "0x10"])(
    "refuses MMR %j, naming the range and the blank",
    (mmr) => {
      expect(parseInhouseRatingForm(form({ mmr }))).toEqual({
        ok: false,
        error: "Enter a whole-number MMR from 1 to 12,000, or leave it blank.",
      });
    },
  );

  it("reads Unranked (0) as no medal, and refuses a medal that doesn't exist", () => {
    const unranked = parseInhouseRatingForm(form({ rankTier: "0" }));
    expect(unranked.ok && unranked.input.medal).toEqual({ manual: true, rankTier: null });
    for (const rankTier of ["", "10", "16", "76", "81", "54.5", "x"]) {
      expect(parseInhouseRatingForm(form({ rankTier })), rankTier).toEqual({
        ok: false,
        error: "Choose a valid medal and star level.",
      });
    }
  });

  it("ignores the medal field going back to OpenDota (the editor disables it)", () => {
    const parsed = parseInhouseRatingForm(form({ medalMode: "automatic", rankTier: null }));
    expect(parsed.ok && parsed.input.medal).toEqual({ manual: false });
    expect(parseInhouseRatingForm(form({ medalMode: "both" }))).toEqual({
      ok: false,
      error: "Choose a medal source.",
    });
  });

  it("reads the snapshot's admin MMR and manual medal", () => {
    const parsed = parseInhouseRatingForm(
      form({ expectedMmr: "3800", expectedRankTier: "0", expectedRankTierManual: "1" }),
    );
    expect(parsed.ok && parsed.input.expected).toEqual({
      mmr: 3800,
      rankTier: null,
      manual: true,
    });
  });

  it.each<Record<string, string | null>>([
    { expectedMmr: null },
    { expectedMmr: "abc" },
    { expectedRankTier: "" },
    { expectedRankTier: "-1" },
    { expectedRankTierManual: "yes" },
    { expectedRankTierManual: null },
  ])("asks for a reload when the snapshot is malformed: %j", (fields) => {
    expect(parseInhouseRatingForm(form(fields))).toEqual({
      ok: false,
      error: "Reload the page and try again.",
    });
  });

  it("needs a player", () => {
    expect(parseInhouseRatingForm(form({ userId: " " }))).toEqual({
      ok: false,
      error: "Choose a player.",
    });
  });
});

describe("sameInhouseRating", () => {
  const stored: InhouseRating = { mmr: 4000, rankTier: 54, manual: true };

  it("matches the snapshot the editor was drawn with", () => {
    expect(sameInhouseRating(stored, { ...stored })).toBe(true);
    expect(
      sameInhouseRating({ mmr: null, rankTier: null, manual: false }, {
        mmr: null,
        rankTier: null,
        manual: false,
      }),
    ).toBe(true);
  });

  it("tells any change apart", () => {
    expect(sameInhouseRating(stored, { ...stored, mmr: 4001 })).toBe(false);
    expect(sameInhouseRating(stored, { ...stored, mmr: null })).toBe(false);
    expect(sameInhouseRating(stored, { ...stored, rankTier: 55 })).toBe(false);
    expect(sameInhouseRating(stored, { ...stored, rankTier: null })).toBe(false);
    expect(sameInhouseRating(stored, { ...stored, manual: false })).toBe(false);
  });
});

describe("overInhouseCap", () => {
  it("is the queue's own line: an MMR over 5,000 or a Divine 3+ medal", () => {
    expect(overInhouseCap({ mmr: 5000, rankTier: 72 })).toBe(false);
    expect(overInhouseCap({ mmr: null, rankTier: null })).toBe(false);
    expect(overInhouseCap({ mmr: 5001, rankTier: null })).toBe(true);
    expect(overInhouseCap({ mmr: 3000, rankTier: 73 })).toBe(true);
    expect(overInhouseCap({ mmr: null, rankTier: 80 })).toBe(true);
  });
});

describe("inhouseRatingSavedMessage", () => {
  const none: InhouseRating = { mmr: null, rankTier: null, manual: false };

  it("says a set MMR is on a queued player's spot already", () => {
    expect(
      inhouseRatingSavedMessage({
        name: "Smurfy",
        before: none,
        after: { mmr: 4100, rankTier: 54, manual: true },
        queued: true,
      }),
    ).toBe("Smurfy: inhouse MMR 4,100, their queue spot too · Legend 4 medal (manual).");
  });

  it("says when an MMR counts for a player who isn't queued", () => {
    expect(
      inhouseRatingSavedMessage({
        name: "Smurfy",
        before: none,
        after: { mmr: 4100, rankTier: 31, manual: false },
        queued: false,
      }),
    ).toBe("Smurfy: inhouse MMR 4,100 from their next join · Crusader 1 medal (from OpenDota).");
  });

  it("names a clear, and a save that only touched the medal", () => {
    expect(
      inhouseRatingSavedMessage({
        name: "Smurfy",
        before: { mmr: 4100, rankTier: 54, manual: true },
        after: { mmr: null, rankTier: 54, manual: true },
        queued: true,
      }),
    ).toBe("Smurfy: inhouse MMR cleared from their next join · Legend 4 medal (manual).");
    expect(
      inhouseRatingSavedMessage({
        name: "Smurfy",
        before: none,
        after: { mmr: null, rankTier: null, manual: true },
        queued: false,
      }),
    ).toBe("Smurfy: no inhouse MMR set · Unranked medal (manual).");
  });

  it("warns when the save puts them over the cap, and that a queued player stays", () => {
    expect(
      inhouseRatingSavedMessage({
        name: "FuzBea",
        before: none,
        after: { mmr: 6000, rankTier: null, manual: false },
        queued: false,
      }),
    ).toMatch(/ Over the 5,000 cap: they can't join the queue\.$/);
    expect(
      inhouseRatingSavedMessage({
        name: "FuzBea",
        before: none,
        after: { mmr: null, rankTier: 74, manual: true },
        queued: true,
      }),
    ).toMatch(/ Over the 5,000 cap: they stay queued until you remove them, then can't join again\.$/);
  });
});

describe("inhouseRatingLogSummary", () => {
  it("records both values before and after", () => {
    expect(
      inhouseRatingLogSummary({
        name: "Smurfy",
        before: { mmr: null, rankTier: 31, manual: false },
        after: { mmr: 4100, rankTier: 54, manual: true },
      }),
    ).toBe(
      "Set Smurfy's inhouse MMR none → 4,100; Crusader 1 medal (from OpenDota) → Legend 4 medal (manual)",
    );
  });
});

describe("inhouseMmrStanding", () => {
  it("follows the join's own order: the admin's, the signup's, then typed", () => {
    expect(inhouseMmrStanding({ adminMmr: 4100, signupMmr: 2500, lastGameMmr: 3000 })).toEqual({
      mmr: 4100,
      source: "set by an admin",
    });
    expect(inhouseMmrStanding({ adminMmr: null, signupMmr: 2500, lastGameMmr: 3000 })).toEqual({
      mmr: 2500,
      source: "from their league signup",
    });
    expect(inhouseMmrStanding({ adminMmr: null, signupMmr: 0, lastGameMmr: 3000 })).toEqual({
      mmr: null,
      source: "typed at each join (last game 3,000)",
    });
    expect(inhouseMmrStanding({ adminMmr: null, signupMmr: 0, lastGameMmr: null })).toEqual({
      mmr: null,
      source: "typed at each join",
    });
  });
});

describe("EDITABLE_RANK_TIERS", () => {
  it("lists Unranked, every star from Herald 1 to Divine 5, then Immortal", () => {
    expect(EDITABLE_RANK_TIERS).toHaveLength(37);
    expect(EDITABLE_RANK_TIERS[0]).toBe(0);
    expect(EDITABLE_RANK_TIERS.slice(1, 6)).toEqual([11, 12, 13, 14, 15]);
    expect(EDITABLE_RANK_TIERS.at(-2)).toBe(75);
    expect(EDITABLE_RANK_TIERS.at(-1)).toBe(80);
    expect(EDITABLE_RANK_TIERS.every(isEditableRankTier)).toBe(true);
    expect([...EDITABLE_RANK_TIERS].sort((a, b) => a - b)).toEqual(EDITABLE_RANK_TIERS);
  });

});
