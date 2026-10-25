import { describe, expect, it } from "vitest";
import { MATCH_PHASE } from "./constants";
import { firstFixtureBySide, kickoffIsRoutine } from "./kickoff-routine";

const regular = (id: string, scheduleRevision = 0) => ({
  id,
  phase: MATCH_PHASE.REGULAR,
  scheduleRevision,
});

describe("kickoffIsRoutine", () => {
  it("is quiet for a regular fixture still on its scheduled weekly slot", () => {
    expect(kickoffIsRoutine(regular("w3"), "w1")).toBe(true);
  });

  it("pings a side's first fixture", () => {
    expect(kickoffIsRoutine(regular("w1"), "w1")).toBe(false);
  });

  it("pings a fixture whose kickoff moved", () => {
    expect(kickoffIsRoutine(regular("w3", 1), "w1")).toBe(false);
  });

  it("pings tiebreakers and playoff rounds", () => {
    for (const phase of [MATCH_PHASE.TIEBREAKER, MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL]) {
      expect(kickoffIsRoutine({ id: "p", phase, scheduleRevision: 0 }, "w1"), phase).toBe(false);
    }
  });

  it("pings when the side's first fixture is unknown", () => {
    expect(kickoffIsRoutine(regular("w3"), undefined)).toBe(false);
  });
});

describe("firstFixtureBySide", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 10, day, 20));
  const fixture = (id: string, week: number, day: number, home: string, away: string) => ({
    id,
    week,
    scheduledAt: at(day),
    homeTeamId: home,
    awayTeamId: away,
  });

  it("is each team's earliest kickoff, so a week-1 bye starts at week 2", () => {
    const first = firstFixtureBySide([
      fixture("w2-ac", 2, 8, "A", "C"),
      fixture("w1-ab", 1, 1, "A", "B"),
    ]);
    expect(first.get("A")).toBe("w1-ab");
    expect(first.get("B")).toBe("w1-ab");
    expect(first.get("C")).toBe("w2-ac");
  });

  it("goes by kickoff, not week number, when week 1 moved past week 2", () => {
    const first = firstFixtureBySide([
      fixture("w1-moved", 1, 12, "A", "B"),
      fixture("w2-ab", 2, 8, "A", "B"),
    ]);
    expect(first.get("A")).toBe("w2-ab");
  });

  it("breaks a kickoff tie by week, then id", () => {
    const first = firstFixtureBySide([
      fixture("b", 1, 1, "A", "B"),
      fixture("a", 1, 1, "A", "C"),
    ]);
    expect(first.get("A")).toBe("a");
  });
});
