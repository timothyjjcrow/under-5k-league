import { describe, it, expect } from "vitest";
import { buildCalendar, escapeIcsText, icsDate } from "./ics";

describe("escapeIcsText", () => {
  it("escapes backslash, semicolon, comma, and newlines", () => {
    expect(escapeIcsText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
  });
});

describe("icsDate", () => {
  it("formats UTC basic form", () => {
    expect(icsDate(new Date("2026-07-12T02:00:00.000Z"))).toBe(
      "20260712T020000Z",
    );
  });
});

describe("buildCalendar", () => {
  const event = {
    uid: "m1@league.test",
    start: new Date("2026-07-12T02:00:00.000Z"),
    durationMinutes: 120,
    summary: "Week 1: Raiders vs Wolves",
    description: "Under 4.5K League match",
    url: "https://league.test/matches/m1",
  };

  it("wraps events in a valid VCALENDAR with CRLF endings", () => {
    const cal = buildCalendar("League", [event]);
    expect(cal.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(cal.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(cal).toContain("X-WR-CALNAME:League");
    expect(cal).toContain("BEGIN:VEVENT");
    expect(cal).toContain("UID:m1@league.test");
    expect(cal).toContain("DTSTART:20260712T020000Z");
    expect(cal).toContain("DTEND:20260712T040000Z");
    expect(cal).toContain("SUMMARY:Week 1: Raiders vs Wolves");
    expect(cal).toContain("URL:https://league.test/matches/m1");
  });

  it("emits an empty calendar without events", () => {
    const cal = buildCalendar("League", []);
    expect(cal).not.toContain("BEGIN:VEVENT");
    expect(cal).toContain("END:VCALENDAR");
  });

  it("escapes summaries", () => {
    const cal = buildCalendar("L", [
      { ...event, summary: "A; B, C" },
    ]);
    expect(cal).toContain("SUMMARY:A\\; B\\, C");
  });
});
