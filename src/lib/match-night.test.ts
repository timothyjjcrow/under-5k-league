import { describe, expect, it } from "vitest";
import { MATCH_SCHEDULE } from "./constants";
import { seasonMatchNightLabel, weeklyMatchNightLabel } from "./match-night";

const BERLIN = "Europe/Berlin";
const LA = "America/Los_Angeles";
// Wed 7 Oct 2026, 20:00 in Berlin (CEST, UTC+2).
const EU_WEEK_ONE = new Date(Date.UTC(2026, 9, 7, 18, 0));
// Sun 4 Oct 2026, 6:00 PM in Los Angeles (PDT, UTC-7).
const US_WEEK_ONE = new Date(Date.UTC(2026, 9, 5, 1, 0));

describe("weeklyMatchNightLabel", () => {
  it("names week 1's slot on the league's clock, zone in plain words", () => {
    expect(weeklyMatchNightLabel(EU_WEEK_ONE, BERLIN, "en-GB")).toBe(
      "Wednesdays at 20:00 Berlin time",
    );
    expect(weeklyMatchNightLabel(US_WEEK_ONE, LA, "en-US")).toMatch(
      /^Sundays at 6:00\sPM Pacific time$/,
    );
  });

  it("uses the league's clock, never the host's: the UTC day would be Monday", () => {
    expect(US_WEEK_ONE.getUTCDay()).toBe(1);
    expect(weeklyMatchNightLabel(US_WEEK_ONE, LA, "en-US")).toMatch(/^Sundays /);
  });
});

describe("seasonMatchNightLabel", () => {
  it("prefers the slot the fixtures set over the admin's pre-signup text", () => {
    expect(
      seasonMatchNightLabel(
        { firstMatchNight: EU_WEEK_ONE, matchSchedule: "To be announced" },
        BERLIN,
        "en-GB",
      ),
    ).toBe("Wednesdays at 20:00 Berlin time");
  });

  it("falls back to the admin's text, then the deployment default", () => {
    expect(
      seasonMatchNightLabel({ firstMatchNight: null, matchSchedule: " Thursdays, 19:30 CET " }),
    ).toBe("Thursdays, 19:30 CET");
    expect(seasonMatchNightLabel({ firstMatchNight: null, matchSchedule: "  " })).toBe(
      MATCH_SCHEDULE.label,
    );
    expect(seasonMatchNightLabel({ firstMatchNight: null, matchSchedule: null })).toBe(
      MATCH_SCHEDULE.label,
    );
  });
});

describe("pages that print the weekly night once fixtures exist", () => {
  // A pure label proves nothing if a page goes back to printing the raw
  // pre-signup text beside real kickoffs.
  it("go through seasonMatchNightLabel, not the raw matchSchedule column", async () => {
    const { readFileSync } = await import("node:fs");
    for (const page of ["src/app/me/page.tsx", "src/app/schedule/page.tsx"]) {
      const source = readFileSync(page, "utf8");
      expect(source, page).toContain("label={seasonMatchNightLabel(season)}");
      expect(source, page).not.toContain("label={season.matchSchedule}");
    }
  });
});
