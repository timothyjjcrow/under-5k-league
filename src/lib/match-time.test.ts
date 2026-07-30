import { describe, expect, it } from "vitest";
import { formatMatchTime } from "./match-time";

// A fixed local date — these tests assert SHAPE (which fields appear per
// variant), not a specific timezone rendering, so they pass in any TZ.
const d = new Date(2026, 6, 11, 18, 5); // Sat Jul 11 2026, 6:05 PM local

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
