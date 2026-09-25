import { describe, it, expect } from "vitest";
import {
  captainMmrWarning,
  captainNameRun,
  classifyCaptainMmr,
  unverifiedCaptainMmrs,
  type CaptainMmrInput,
} from "./captain-mmr";
import { mmrWeightedBudgets } from "./draft";

// Legend 3 (53) plausibly covers 2965–3964; Herald 1 (11) is padded down to
// 0–576; Immortal (80) is open-ended from 5220.
const LEGEND_3 = 53;
const HERALD_1 = 11;
const IMMORTAL = 80;

describe("classifyCaptainMmr", () => {
  it("is medal-backed when a medal exists and the MMR sits inside its window", () => {
    expect(classifyCaptainMmr({ mmr: 3400, rankTier: LEGEND_3 })).toEqual({
      status: "medal-backed",
    });
    // Both edges of the window are inside it (the signup clamp's own rule).
    expect(classifyCaptainMmr({ mmr: 2965, rankTier: LEGEND_3 }).status).toBe(
      "medal-backed",
    );
    expect(classifyCaptainMmr({ mmr: 3964, rankTier: LEGEND_3 }).status).toBe(
      "medal-backed",
    );
    // Immortal is open-ended above.
    expect(classifyCaptainMmr({ mmr: 7000, rankTier: IMMORTAL }).status).toBe(
      "medal-backed",
    );
  });

  it("flags an MMR outside the medal's window, in either direction", () => {
    for (const mmr of [2964, 1200, 3965, 4900]) {
      expect(classifyCaptainMmr({ mmr, rankTier: LEGEND_3 })).toEqual({
        status: "unverified",
        problem: "outside-range",
      });
    }
    expect(classifyCaptainMmr({ mmr: 5000, rankTier: IMMORTAL })).toEqual({
      status: "unverified",
      problem: "outside-range",
    });
  });

  it("flags a typed MMR with no medal to check it against (the budget exploit)", () => {
    for (const rankTier of [null, undefined, 0, 7]) {
      expect(classifyCaptainMmr({ mmr: 1200, rankTier })).toEqual({
        status: "unverified",
        problem: "no-medal",
      });
    }
  });

  it("flags unknown MMR before looking at the medal", () => {
    // No medal, and a medal whose window doesn't reach 0: both unknown.
    expect(classifyCaptainMmr({ mmr: 0, rankTier: null })).toEqual({
      status: "unverified",
      problem: "unknown",
    });
    expect(classifyCaptainMmr({ mmr: 0, rankTier: LEGEND_3 })).toEqual({
      status: "unverified",
      problem: "unknown",
    });
    // The trap: Herald 1's window is padded down to 0, so 0 is "plausible"
    // for the clamp, yet the budget code still treats it as unknown.
    expect(classifyCaptainMmr({ mmr: 0, rankTier: HERALD_1 })).toEqual({
      status: "unverified",
      problem: "unknown",
    });
    expect(classifyCaptainMmr({ mmr: NaN, rankTier: LEGEND_3 }).status).toBe(
      "unverified",
    );
  });

  it("calls MMR unknown exactly where the budget weighting ignores it", () => {
    // Start and the admin projection both map a stored 0 to null (`|| null`)
    // and mmrWeightedBudgets then hands that captain the flat base. The
    // "unknown" problem must line up with that mapping, or the flag would
    // describe a budget the auction doesn't actually give.
    const asBudgetMmr = (stored: number) => stored || null;
    const budgets = mmrWeightedBudgets(100, 20, [
      { teamId: "low", mmr: asBudgetMmr(2000) },
      { teamId: "high", mmr: asBudgetMmr(4000) },
      { teamId: "blank", mmr: asBudgetMmr(0) },
    ]);
    expect(budgets.get("blank")).toBe(100);
    expect(classifyCaptainMmr({ mmr: 0, rankTier: null })).toMatchObject({
      problem: "unknown",
    });
  });
});

const cap = (
  teamId: string,
  mmr: number,
  rankTier: number | null = null,
): CaptainMmrInput => ({ teamId, name: `Cap ${teamId}`, mmr, rankTier });

describe("unverifiedCaptainMmrs", () => {
  const pool = [
    cap("a", 3400, LEGEND_3), // medal-backed
    cap("b", 1200), // no medal
    cap("c", 1500, LEGEND_3), // outside the window
    cap("d", 0), // unknown
  ];

  it("lists only the unverified captains, in the order given", () => {
    const out = unverifiedCaptainMmrs(20, pool);
    expect(out.map((c) => [c.teamId, c.problem])).toEqual([
      ["b", "no-medal"],
      ["c", "outside-range"],
      ["d", "unknown"],
    ]);
  });

  it("says nothing when MMR moves no money (weighting off or nonsense)", () => {
    for (const weight of [0, -5, NaN, Infinity]) {
      expect(unverifiedCaptainMmrs(weight, pool)).toEqual([]);
    }
  });

  it("gives each flag a one-line reason naming the fact that failed", () => {
    const [noMedal, outside, unknown] = unverifiedCaptainMmrs(20, pool);
    expect(noMedal.reason).toBe("No medal on record to check 1200 MMR against.");
    expect(outside.reason).toBe(
      "1500 MMR is outside their Legend 3 medal's range (2965–3964).",
    );
    expect(unknown.reason).toMatch(/No MMR on file.*flat base budget/);
    for (const c of [noMedal, outside, unknown]) {
      expect(c.reason).not.toContain("\n");
    }
  });
});

describe("captainMmrWarning", () => {
  it("is empty when every captain is medal-backed, so the confirm is unchanged", () => {
    expect(captainMmrWarning([])).toBe("");
    expect(
      captainMmrWarning(unverifiedCaptainMmrs(20, [cap("a", 3400, LEGEND_3)])),
    ).toBe("");
  });

  it("names each unverified captain with a short reason and the control that fixes it", () => {
    const line = captainMmrWarning(
      unverifiedCaptainMmrs(20, [
        cap("a", 3400, LEGEND_3),
        cap("b", 1200),
        cap("c", 1500, LEGEND_3),
        cap("d", 0),
      ]),
    );
    // Leading space: it is appended to the base confirm sentence.
    expect(line.startsWith(" ")).toBe(true);
    expect(line).toContain(
      "Cap b (no medal), Cap c (outside the Legend 3 range), Cap d (no MMR on file)",
    );
    expect(line).not.toContain("Cap a");
    expect(line).toContain("Edit medal & MMR");
    // Warn-and-name, never a block.
    expect(line).toContain("Starting anyway is allowed.");
  });

  it("caps the names so a confirm stays a dialog", () => {
    const many = Array.from({ length: 9 }, (_, i) => cap(String(i), 1000 + i));
    const line = captainMmrWarning(unverifiedCaptainMmrs(20, many));
    expect(line).toContain("Cap 5 (no medal) +3 more");
    expect(line).not.toContain("Cap 6");
  });

  it("uses no em-dashes in any copy it produces", () => {
    const flags = unverifiedCaptainMmrs(20, [
      cap("b", 1200),
      cap("c", 1500, LEGEND_3),
      cap("d", 0),
    ]);
    for (const text of [
      captainMmrWarning(flags),
      ...flags.map((f) => f.reason),
      ...flags.map((f) => f.short),
    ]) {
      expect(text).not.toContain("—");
    }
  });
});

describe("captainNameRun", () => {
  it("joins up to six names and counts the rest", () => {
    expect(captainNameRun(["A"])).toBe("A");
    expect(captainNameRun(["A", "B", "C", "D", "E", "F"])).toBe(
      "A, B, C, D, E, F",
    );
    expect(captainNameRun(["A", "B", "C", "D", "E", "F", "G", "H"])).toBe(
      "A, B, C, D, E, F +2 more",
    );
  });
});
