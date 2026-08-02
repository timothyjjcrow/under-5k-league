import { describe, expect, it } from "vitest";
import { membershipChipView, signupFlags } from "./signup-readiness";
import { mmrRangeForRankTier } from "./rank";

const baseReg = {
  mmr: 3200,
  roles: "1,2",
  favoriteHeroes: "Pudge",
  statement: "here to learn",
  captainNote: "",
  rankTier: null as number | null,
};

describe("signupFlags", () => {
  it("flags an MMR outside the medal's plausible window, naming medal and range", () => {
    // Crusader 2 (tier 32) can't plausibly be a 4000 MMR player.
    const flags = signupFlags({ ...baseReg, mmr: 4000, rankTier: 32 });
    const flag = flags.find((f) => f.key === "mmr-off-medal");
    expect(flag).toBeDefined();
    expect(flag!.detail).toContain("4000");
    expect(flag!.detail).toContain("Crusader 2");
    const range = mmrRangeForRankTier(32)!;
    expect(flag!.detail).toContain(String(range.min));
    // Advisory contract: a stored MMR is league-approved, never "refused".
    expect(flag!.detail).toContain("heads-up");
  });

  it("stays silent for an MMR inside the medal window", () => {
    const range = mmrRangeForRankTier(32)!;
    const flags = signupFlags({ ...baseReg, mmr: range.min, rankTier: 32 });
    expect(flags.find((f) => f.key === "mmr-off-medal")).toBeUndefined();
  });

  it("has no medal opinion when the player has no medal", () => {
    const flags = signupFlags({ ...baseReg, mmr: 9000, rankTier: null });
    expect(flags.find((f) => f.key === "mmr-off-medal")).toBeUndefined();
  });

  it("flags a 0 MMR with no medal as unknown, not as a mismatch", () => {
    const flags = signupFlags({ ...baseReg, mmr: 0, rankTier: null });
    expect(flags.map((f) => f.key)).toContain("no-mmr");
    expect(flags.find((f) => f.key === "mmr-off-medal")).toBeUndefined();
  });

  it("a 0 MMR WITH a medal is a mismatch (the medal proves they're ranked), not unknown", () => {
    const flags = signupFlags({ ...baseReg, mmr: 0, rankTier: 45 });
    expect(flags.find((f) => f.key === "mmr-off-medal")).toBeDefined();
    expect(flags.find((f) => f.key === "no-mmr")).toBeUndefined();
  });

  it("a 0 MMR with a floor-0 medal (Herald 1-3) is unknown, and the copy names the medal instead of denying it", () => {
    // Herald 1-3 windows are padded down to min 0, so a blank claim is
    // "plausible" and never clamped — the flag must not say "no OpenDota
    // medal" beside a rendered Herald medal.
    for (const tier of [10, 11, 12, 13]) {
      const flags = signupFlags({ ...baseReg, mmr: 0, rankTier: tier });
      const flag = flags.find((f) => f.key === "no-mmr");
      expect(flag, `tier ${tier}`).toBeDefined();
      expect(flag!.detail).not.toContain("no OpenDota medal");
      expect(flag!.detail).toContain("Herald");
      expect(flags.find((f) => f.key === "mmr-off-medal")).toBeUndefined();
    }
    // Herald 4 is the first band whose padded floor is above 0 — a blank
    // claim there clamps, so it correctly reads as a mismatch instead.
    const flags = signupFlags({ ...baseReg, mmr: 0, rankTier: 14 });
    expect(flags.find((f) => f.key === "mmr-off-medal")).toBeDefined();
    expect(flags.find((f) => f.key === "no-mmr")).toBeUndefined();
  });

  it("flags a signup with nothing filled in, treating whitespace as empty", () => {
    const flags = signupFlags({
      ...baseReg,
      roles: "",
      favoriteHeroes: "  ",
      statement: "\n",
      captainNote: "",
    });
    expect(flags.find((f) => f.key === "blank-signup")).toBeDefined();
  });

  it("any single filled field clears the blank flag", () => {
    const flags = signupFlags({
      ...baseReg,
      roles: "",
      favoriteHeroes: "",
      statement: "",
      captainNote: "will be there every week",
    });
    expect(flags.find((f) => f.key === "blank-signup")).toBeUndefined();
  });
});

describe("membershipChipView", () => {
  it("member is a positive chip", () => {
    const chip = membershipChipView("member", "gone4");
    expect(chip.tone).toBe("success");
    expect(chip.label).toBe("in server");
  });

  it("pending says the rules screen is the blocker", () => {
    const chip = membershipChipView("pending", "gone4");
    expect(chip.tone).toBe("accent");
    expect(chip.detail).toContain("rules");
  });

  it("not-member names the LINKED account and both remedies", () => {
    const chip = membershipChipView("not-member", "gone4");
    expect(chip.tone).toBe("danger");
    // Membership is a fact about the linked account, not always the human —
    // the handle is what makes the verdict checkable against the member list.
    expect(chip.detail).toContain("@gone4");
    expect(chip.detail).toContain("different account");
    expect(chip.detail).toContain("re-link");
  });

  it("not-member without a stored handle still reads cleanly", () => {
    const chip = membershipChipView("not-member", "");
    expect(chip.detail).not.toContain("(@");
    expect(chip.detail).not.toContain("  ");
  });

  it("unknown is NEUTRAL — never a negative — and points at the checklist, not a reload", () => {
    const chip = membershipChipView(null, "gone4");
    expect(chip.tone).toBe("neutral");
    expect(chip.label).toBe("couldn't check");
    expect(chip.detail).toContain("not a verdict");
    expect(chip.detail).toContain("Discord notifications");
    expect(chip.detail.toLowerCase()).not.toContain("reload");
  });
});
