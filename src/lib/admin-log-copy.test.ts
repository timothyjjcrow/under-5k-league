import { describe, expect, it } from "vitest";
import { fixtureLogLabel } from "./admin-log-copy";

describe("fixtureLogLabel", () => {
  const teams = { homeName: "Alpha", awayName: "Bravo" };

  it("names a regular fixture by its week", () => {
    expect(fixtureLogLabel({ phase: "REGULAR", week: 3, ...teams })).toBe(
      "Week 3: Alpha vs Bravo",
    );
  });

  it("names the round and keeps the week off the regular season", () => {
    expect(
      fixtureLogLabel({ phase: "PLAYOFF", week: 9, bracketSlot: "R1M0", ...teams }),
    ).toBe("Playoffs (week 9): Alpha vs Bravo");
    expect(fixtureLogLabel({ phase: "FINAL", week: 11, ...teams })).toBe(
      "Grand final (week 11): Alpha vs Bravo",
    );
    expect(fixtureLogLabel({ phase: "TIEBREAKER", week: 6, ...teams })).toBe(
      "Tiebreaker (week 6): Alpha vs Bravo",
    );
  });
});
