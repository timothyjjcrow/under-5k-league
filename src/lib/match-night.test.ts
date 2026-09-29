import { describe, expect, it } from "vitest";
import { MATCH_SCHEDULE } from "./constants";
import {
  fixturesMatchNightLabel,
  seasonMatchNightLabel,
  type FixtureKickoff,
} from "./match-night";
import { matchNightForWeek } from "./schedule";

const BERLIN = "Europe/Berlin";
const LA = "America/Los_Angeles";
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
// Wed 7 Oct 2026, 20:00 in Berlin (CEST, UTC+2).
const EU_WEEK_ONE = new Date(Date.UTC(2026, 9, 7, 18, 0));
// Sun 4 Oct 2026, 6:00 PM in Los Angeles (PDT, UTC-7).
const US_WEEK_ONE = new Date(Date.UTC(2026, 9, 5, 1, 0));

const open = (scheduledAt: Date | null): FixtureKickoff => ({
  scheduledAt,
  status: "SCHEDULED",
});
const played = (scheduledAt: Date): FixtureKickoff => ({
  scheduledAt,
  status: "COMPLETED",
});
/**
 * Two fixtures a week for `weeks` weeks from `first`, all still to play, dated
 * on Berlin's clock the way the schedule dates them (Europe's clocks go back
 * on 25 Oct 2026, inside these seasons).
 */
const season = (first: Date, weeks: number): FixtureKickoff[] =>
  Array.from({ length: weeks * 2 }, (_, i) =>
    open(matchNightForWeek(first, Math.floor(i / 2) + 1, BERLIN)),
  );
const dayLater = (f: FixtureKickoff) =>
  new Date(f.scheduledAt!.getTime() + DAY_MS);

describe("fixturesMatchNightLabel", () => {
  it("names the fixtures' weekly slot on the league's clock, zone in plain words", () => {
    expect(fixturesMatchNightLabel([open(EU_WEEK_ONE)], BERLIN, "en-GB")).toBe(
      "Wednesdays at 20:00 Berlin time",
    );
    expect(fixturesMatchNightLabel([open(US_WEEK_ONE)], LA, "en-US")).toMatch(
      /^Sundays at 6:00\sPM Pacific time$/,
    );
  });

  it("uses the league's clock, never the host's: the UTC day would be Monday", () => {
    expect(US_WEEK_ONE.getUTCDay()).toBe(1);
    expect(fixturesMatchNightLabel([open(US_WEEK_ONE)], LA, "en-US")).toMatch(
      /^Sundays /,
    );
  });

  it("keeps the league's night when one week is moved on its own", () => {
    // Week 3 moved from Wednesday to Thursday. The label used to come from
    // the playoff anchor, which that move shifts, and relabelled every week.
    const fixtures = season(EU_WEEK_ONE, 6).map((f, i) =>
      i === 4 || i === 5 ? open(dayLater(f)) : f,
    );
    expect(fixturesMatchNightLabel(fixtures, BERLIN, "en-GB")).toBe(
      "Wednesdays at 20:00 Berlin time",
    );
  });

  it("follows a move of the rest of the season, counting only games still to play", () => {
    // Weeks 1-4 played on Wednesdays; weeks 5-6 moved to Thursdays.
    const fixtures = season(EU_WEEK_ONE, 6).map((f, i) =>
      i < 8 ? played(f.scheduledAt!) : open(dayLater(f)),
    );
    expect(fixturesMatchNightLabel(fixtures, BERLIN, "en-GB")).toBe(
      "Thursdays at 20:00 Berlin time",
    );
  });

  it("uses every fixture once the season is played, and ignores untimed ones", () => {
    const fixtures = [
      ...season(EU_WEEK_ONE, 3).map((f) => played(f.scheduledAt!)),
      open(null),
    ];
    expect(fixturesMatchNightLabel(fixtures, BERLIN, "en-GB")).toBe(
      "Wednesdays at 20:00 Berlin time",
    );
  });

  it("breaks a tie with the slot that comes first", () => {
    const thursday = new Date(EU_WEEK_ONE.getTime() + WEEK_MS + DAY_MS);
    expect(
      fixturesMatchNightLabel([open(thursday), open(EU_WEEK_ONE)], BERLIN, "en-GB"),
    ).toBe("Wednesdays at 20:00 Berlin time");
  });

  it("is null until a fixture has a kickoff", () => {
    expect(fixturesMatchNightLabel([])).toBeNull();
    expect(fixturesMatchNightLabel([open(null)])).toBeNull();
  });
});

describe("seasonMatchNightLabel", () => {
  it("prefers the slot the fixtures set over the admin's pre-signup text", () => {
    expect(
      seasonMatchNightLabel(
        { matchSchedule: "To be announced" },
        [open(EU_WEEK_ONE)],
        BERLIN,
        "en-GB",
      ),
    ).toBe("Wednesdays at 20:00 Berlin time");
  });

  it("drops a typed full stop, since every sentence quoting it ends itself", () => {
    expect(
      seasonMatchNightLabel({ matchSchedule: " Wednesdays, 8pm ET. " }, []),
    ).toBe("Wednesdays, 8pm ET");
    expect(seasonMatchNightLabel({ matchSchedule: " . " }, [])).toBe(
      MATCH_SCHEDULE.label,
    );
  });

  it("uses the deployment default with no season at all", () => {
    expect(seasonMatchNightLabel(null, [])).toBe(MATCH_SCHEDULE.label);
  });

  it("falls back to the admin's text, then the deployment default", () => {
    expect(
      seasonMatchNightLabel({ matchSchedule: " Thursdays, 19:30 CET " }, [
        open(null),
      ]),
    ).toBe("Thursdays, 19:30 CET");
    expect(seasonMatchNightLabel({ matchSchedule: "  " }, [])).toBe(
      MATCH_SCHEDULE.label,
    );
    expect(seasonMatchNightLabel({ matchSchedule: null }, [])).toBe(
      MATCH_SCHEDULE.label,
    );
  });
});

describe("pages that print the weekly night once fixtures exist", () => {
  // A pure label proves nothing if a page goes back to printing the raw
  // pre-signup text beside real kickoffs, or labels from the playoff anchor.
  it("go through the fixtures, not matchSchedule or firstMatchNight", async () => {
    const { readFileSync } = await import("node:fs");
    for (const [page, call] of [
      ["src/app/me/page.tsx", "label={seasonMatchNightLabel(season, seasonFixtures)}"],
      ["src/app/schedule/page.tsx", "label={seasonMatchNightLabel(season, matches)}"],
      ["src/app/admin/page.tsx", "fixturesMatchNightLabel(data.matches)"],
      ["src/app/how-it-works/page.tsx", "{seasonMatchNightLabel(season, fixtures)}"],
      ["src/lib/link-preview.ts", "announcedMatchNight(season, season.fixtures)"],
    ] as const) {
      const source = readFileSync(page, "utf8");
      expect(source, page).toContain(call);
      expect(source, page).not.toContain("label={season.matchSchedule}");
      expect(source, page).not.toMatch(/MatchNightLabel\(season\.firstMatchNight/);
    }
  });
});
