import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { draftRecap, draftRecapTitle, type DraftedPlayer } from "./draft-recap";

const p = (
  name: string,
  teamName: string,
  price: number,
  mmr: number | null = 3000,
  isCaptain = false,
): DraftedPlayer => ({ name, teamName, price, mmr, isCaptain });

describe("draftRecap", () => {
  it("finds the biggest spend and best value", () => {
    const r = draftRecap([
      p("Star", "A", 40, 4400),
      p("Steal", "B", 1, 4200),
      p("Mid", "A", 10, 3000),
    ]);
    expect(r.biggestSpend?.name).toBe("Star");
    expect(r.bestValue?.name).toBe("Steal");
    expect(r.bestValue?.perDollar).toBe(4200);
    expect(r.totalSpent).toBe(51);
  });

  it("tallies team spending extremes", () => {
    const r = draftRecap([
      p("a1", "A", 30),
      p("a2", "A", 20),
      p("b1", "B", 5),
      p("b2", "B", 3),
    ]);
    expect(r.topSpender).toEqual({ teamName: "A", spent: 50 });
    expect(r.bargainHunter).toEqual({ teamName: "B", spent: 8 });
  });

  it("ignores captains and unknown-MMR players for value", () => {
    const r = draftRecap([
      p("Cap", "A", 0, 4800, true),
      p("NoMmr", "A", 2, null),
      p("Known", "B", 4, 2000),
    ]);
    expect(r.biggestSpend?.name).toBe("Known");
    expect(r.bestValue?.name).toBe("Known");
  });

  it("returns nulls with no purchases", () => {
    const r = draftRecap([p("Cap", "A", 0, 4000, true)]);
    expect(r.biggestSpend).toBeNull();
    expect(r.bestValue).toBeNull();
    expect(r.topSpender).toBeNull();
    expect(r.totalSpent).toBe(0);
  });

  it("keeps a renamed team's purchases together and distinct same-name teams apart", () => {
    const recap = draftRecap([
      { ...p("Latest", "New name", 12), teamId: "a" },
      { ...p("Earlier", "Old name", 20), teamId: "a" },
      { ...p("Other", "New name", 5), teamId: "b" },
    ]);
    expect(recap.topSpender).toEqual({ teamId: "a", teamName: "New name", spent: 32 });
    expect(recap.bargainHunter).toEqual({ teamId: "b", teamName: "New name", spent: 5 });
    expect(recap.totalSpent).toBe(37);
  });
});

describe("draftRecapTitle", () => {
  it('says "so far" only while the auction can still sell', () => {
    expect(draftRecapTitle("IN_PROGRESS")).toBe("Draft night — so far");
    expect(draftRecapTitle("PAUSED")).toBe("Draft night — so far");
  });

  it("drops it once the auction is over or not running", () => {
    expect(draftRecapTitle("COMPLETE")).toBe("Draft night");
    expect(draftRecapTitle("NOT_STARTED")).toBe("Draft night");
    expect(draftRecapTitle(null)).toBe("Draft night");
    expect(draftRecapTitle(undefined)).toBe("Draft night");
  });

  // REGRESSION (2026-10-19 mock draft): /teams keyed the title on the season
  // phase, which stays Draft after the last sale, so a finished auction read
  // "so far" until the Regular season started.
  it("is what /teams titles its recap with", () => {
    const page = readFileSync(
      new URL("../app/teams/page.tsx", import.meta.url),
      "utf8",
    );
    expect(page).toContain("title={draftRecapTitle(draft?.status)}");
    expect(page).not.toContain("so far");
  });
});
