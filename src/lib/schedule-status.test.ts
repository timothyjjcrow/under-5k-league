import { describe, expect, it } from "vitest";
import { regularSeasonStatus, pendingResultsMessage } from "./schedule-status";

function m(week: number, status: string, phase = "REGULAR") {
  return { week, status, phase };
}

describe("regularSeasonStatus", () => {
  it("counts completion per week and overall", () => {
    const s = regularSeasonStatus([
      m(1, "COMPLETED"),
      m(1, "COMPLETED"),
      m(2, "COMPLETED"),
      m(2, "SCHEDULED"),
      m(3, "LIVE"),
    ]);
    expect(s.total).toBe(5);
    expect(s.completed).toBe(3);
    expect(s.pending).toBe(2);
    expect(s.allComplete).toBe(false);
    expect(s.pendingWeeks).toEqual([2, 3]);
    expect(s.weeks.find((w) => w.week === 2)).toMatchObject({
      total: 2,
      completed: 1,
      pending: 1,
    });
  });

  it("is allComplete when every regular match is entered", () => {
    const s = regularSeasonStatus([m(1, "COMPLETED"), m(2, "COMPLETED")]);
    expect(s.allComplete).toBe(true);
    expect(s.pending).toBe(0);
    expect(s.pendingWeeks).toEqual([]);
  });

  it("ignores playoff matches", () => {
    const s = regularSeasonStatus([
      m(1, "COMPLETED"),
      m(2, "SCHEDULED", "PLAYOFF"),
      m(2, "SCHEDULED", "FINAL"),
    ]);
    expect(s.total).toBe(1);
    expect(s.allComplete).toBe(true);
  });

  it("treats an empty schedule as not-yet-complete", () => {
    const s = regularSeasonStatus([]);
    expect(s.total).toBe(0);
    expect(s.allComplete).toBe(false);
    expect(s.pending).toBe(0);
  });
});

describe("pendingResultsMessage", () => {
  it("summarizes what's outstanding, or null when done", () => {
    expect(
      pendingResultsMessage(regularSeasonStatus([m(1, "COMPLETED")])),
    ).toBeNull();
    expect(
      pendingResultsMessage(
        regularSeasonStatus([m(1, "COMPLETED"), m(2, "SCHEDULED")]),
      ),
    ).toMatch(/1 regular-season match still needs results \(week 2\)/);
  });
});
