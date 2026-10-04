import { describe, expect, it } from "vitest";
import {
  NEXT_SEASON_MAX_LEAD_DAYS,
  nextSeasonDateProblem,
  parseNextSeasonPlan,
  serializeNextSeasonPlan,
} from "./next-season";

const AT = Date.UTC(2026, 9, 17, 1, 0); // Sat Oct 17, 6 PM in Los Angeles
const NOW = Date.UTC(2026, 9, 4, 12, 0);
const DAY = 24 * 60 * 60 * 1000;

describe("parseNextSeasonPlan", () => {
  it("reads back what was saved, for the season it was saved during", () => {
    const raw = serializeNextSeasonPlan({ seasonId: "s1", signupsAtMs: AT });
    expect(parseNextSeasonPlan(raw, "s1")).toEqual({
      seasonId: "s1",
      signupsAtMs: AT,
    });
  });

  it("lapses once another season is active (the handoff happened)", () => {
    const raw = serializeNextSeasonPlan({ seasonId: "s1", signupsAtMs: AT });
    expect(parseNextSeasonPlan(raw, "s2")).toBeNull();
  });

  it("is null with nothing saved or no active season", () => {
    expect(parseNextSeasonPlan(null, "s1")).toBeNull();
    expect(parseNextSeasonPlan("", "s1")).toBeNull();
    const raw = serializeNextSeasonPlan({ seasonId: "s1", signupsAtMs: AT });
    expect(parseNextSeasonPlan(raw, null)).toBeNull();
  });

  it("ignores a value that doesn't parse instead of throwing", () => {
    for (const raw of [
      "not json",
      "null",
      "42",
      '"s1"',
      "[]",
      JSON.stringify({ seasonId: "s1" }),
      JSON.stringify({ seasonId: "s1", signupsAt: 5 }),
      JSON.stringify({ seasonId: "s1", signupsAt: "someday" }),
      JSON.stringify({ seasonId: 1, signupsAt: new Date(AT).toISOString() }),
    ]) {
      expect(parseNextSeasonPlan(raw, "s1"), raw).toBeNull();
    }
  });
});

describe("nextSeasonDateProblem", () => {
  it("accepts a future date within a year", () => {
    expect(nextSeasonDateProblem(AT, NOW)).toBeNull();
    expect(
      nextSeasonDateProblem(NOW + NEXT_SEASON_MAX_LEAD_DAYS * DAY, NOW),
    ).toBeNull();
  });

  it("refuses now and anything earlier", () => {
    expect(nextSeasonDateProblem(NOW, NOW)).toMatch(/future/);
    expect(nextSeasonDateProblem(NOW - DAY, NOW)).toMatch(/future/);
    expect(nextSeasonDateProblem(Number.NaN, NOW)).toMatch(/future/);
  });

  it("refuses a date more than a year out", () => {
    expect(
      nextSeasonDateProblem(NOW + NEXT_SEASON_MAX_LEAD_DAYS * DAY + 1, NOW),
    ).toMatch(/within the next year/);
  });
});
