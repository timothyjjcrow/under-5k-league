import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../test/support/source-files";
import {
  formatLeagueMatchTime,
  formatMatchTime,
  formatMatchTimeInZone,
} from "./match-time";
import { LEAGUE_CONFIG } from "./league-config";
import { zoneName } from "./zone-label";

// A fixed local date — these tests assert SHAPE (which fields appear per
// variant), not a specific timezone rendering, so they pass in any TZ.
const d = new Date(2026, 6, 11, 18, 5); // Sat Jul 11 2026, 6:05 PM local

// The US final: 22:00 UTC on Saturday Oct 3 2026 (3:00 PM Pacific, PDT).
const final = new Date("2026-10-03T22:00:00.000Z");
// A late Pacific kickoff that is already Monday in UTC.
const lateSunday = new Date("2026-10-12T02:30:00.000Z"); // Sun 7:30 PM PDT

/** Intl may put a narrow no-break space before AM/PM; compare on plain ones. */
const plain = (s: string) => s.replace(/ | /g, " ");

describe("formatMatchTime", () => {
  it("full: weekday + date + time", () => {
    const s = formatMatchTime(d, "full");
    expect(s).toContain("Sat");
    expect(s).toContain("Jul");
    expect(s).toContain("11");
    expect(s).toMatch(/6:05/);
  });

  it("short: drops the weekday, keeps the time", () => {
    const s = formatMatchTime(d, "short");
    expect(s).not.toContain("Sat");
    expect(s).toContain("Jul");
    expect(s).toMatch(/6:05/);
  });

  it("date: weekday + date, no time of day", () => {
    const s = formatMatchTime(d, "date");
    expect(s).toContain("Sat");
    expect(s).toContain("Jul");
    expect(s).not.toMatch(/6:05/);
  });

  it("full and short agree on everything but the weekday", () => {
    // The server fallbacks that delegate here rely on "short" being "full"
    // minus the weekday — pin that relationship rather than exact strings.
    const full = formatMatchTime(d, "full");
    const short = formatMatchTime(d, "short");
    expect(full).toContain(short.split(",")[0].trim());
    expect(full.endsWith(short.slice(short.indexOf(",")))).toBe(true);
  });
});

describe("formatMatchTimeInZone", () => {
  it("writes a US kickoff on the Pacific clock and names the zone", () => {
    const at = (variant: "full" | "short" | "date") =>
      plain(formatMatchTimeInZone(final, variant, "America/Los_Angeles", "en-US"));
    expect(at("full")).toBe("Sat, Oct 3, 3:00 PM Pacific");
    expect(at("short")).toBe("Oct 3, 3:00 PM Pacific");
    expect(at("date")).toBe("Sat, Oct 3");
  });

  it("writes a Europe kickoff on the Berlin clock, 24-hour, day first", () => {
    // Europe's match night: 20:00 Berlin (CEST) is 18:00 UTC.
    const night = new Date("2026-10-07T18:00:00.000Z");
    const at = (variant: "full" | "short" | "date") =>
      plain(formatMatchTimeInZone(night, variant, "Europe/Berlin", "en-GB"));
    expect(at("full")).toBe("Wed 7 Oct, 20:00 Berlin");
    expect(at("short")).toBe("7 Oct, 20:00 Berlin");
    expect(at("date")).toBe("Wed 7 Oct");
  });

  it("dates a late kickoff by the league's day, not UTC's", () => {
    // 02:30 UTC Monday is Sunday evening in Los Angeles: the week header a
    // US visitor sees before the page loads must say Sunday.
    expect(
      plain(formatMatchTimeInZone(lateSunday, "date", "America/Los_Angeles", "en-US")),
    ).toBe("Sun, Oct 11");
  });

  it("gives the same text on any host clock", () => {
    // Pure on the named zone: nothing reads the process's own TZ.
    const a = formatMatchTimeInZone(final, "full", "America/Los_Angeles", "en-US");
    const b = formatMatchTimeInZone(
      new Date(final.getTime()),
      "full",
      "America/Los_Angeles",
      "en-US",
    );
    expect(a).toBe(b);
  });
});

describe("formatLeagueMatchTime", () => {
  it("uses this deployment's league clock and names it", () => {
    const text = formatLeagueMatchTime(final, "full");
    expect(text.endsWith(` ${zoneName(LEAGUE_CONFIG.timeZone)}`)).toBe(true);
    expect(formatLeagueMatchTime(final, "date")).not.toContain(
      zoneName(LEAGUE_CONFIG.timeZone),
    );
  });
});

describe("server code writes times on the league's clock", () => {
  // formatMatchTime reads whichever clock runs it. On the server that was the
  // host's (UTC in production), printed with no zone: every kickoff showed
  // UTC until a phone finished loading, and link previews, screen readers and
  // visitors without scripts only ever got the UTC one. Only the browser half
  // of <LocalTime> may call it; every server string uses
  // formatLeagueMatchTime.
  const files = sourceFiles(["src/**/*.ts", "src/**/*.tsx"], 400);
  const callers = files.filter((f) => /\bformatMatchTime\(/.test(f.text));

  it("calls formatMatchTime only from LocalTime's client snapshot", () => {
    expect(callers.map((f) => f.path).sort()).toEqual([
      "src/components/local-time.tsx",
      "src/lib/match-time.ts",
    ]);
  });

  it("formats server kickoffs with formatLeagueMatchTime across the app", () => {
    const leagueCallers = files.filter((f) =>
      /\bformatLeagueMatchTime\(/.test(f.text),
    );
    // Thirty files wrote a server time when the rule arrived; far fewer
    // means the guard is reading the wrong tree.
    expect(leagueCallers.length).toBeGreaterThanOrEqual(25);
  });

  it("never formats a date on the host clock in a server page", () => {
    const offenders = files.filter(
      (f) =>
        !f.text.startsWith('"use client"') &&
        f.path !== "src/lib/match-time.ts" &&
        /\.toLocale(?:Date|Time)?String\(undefined,\s*\{[^}]*\b(?:hour|month|weekday)\b/.test(
          f.text,
        ),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});
