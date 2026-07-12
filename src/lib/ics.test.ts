import { describe, it, expect } from "vitest";
import { buildCalendar, escapeIcsText, foldIcsLine, icsDate } from "./ics";

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

describe("foldIcsLine", () => {
  it("leaves short lines alone", () => {
    expect(foldIcsLine("SUMMARY:short")).toEqual(["SUMMARY:short"]);
  });

  it("folds at 75 octets with space-prefixed continuations", () => {
    const line = "SUMMARY:" + "x".repeat(100);
    const folded = foldIcsLine(line);
    expect(folded).toHaveLength(2);
    expect(folded[0]).toHaveLength(75);
    expect(folded[1].startsWith(" ")).toBe(true);
    // Unfolding (drop CRLF+space) reproduces the original exactly.
    expect(folded[0] + folded[1].slice(1)).toBe(line);
    for (const l of folded) {
      expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(75);
    }
  });

  it("counts octets, not characters, and never splits a codepoint", () => {
    const line = "SUMMARY:" + "é".repeat(60); // 2 octets each → 128 octets total
    const folded = foldIcsLine(line);
    expect(folded.length).toBeGreaterThan(1);
    for (const l of folded) {
      expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(75);
      // Every piece must re-encode/decode cleanly (no torn codepoints).
      expect(Buffer.from(l, "utf8").toString("utf8")).toBe(l);
    }
    expect(folded[0] + folded.slice(1).map((l) => l.slice(1)).join("")).toBe(line);
  });

  it("keeps every emitted calendar line within 75 octets", () => {
    const doc = buildCalendar("League", [
      {
        uid: "m1@ld2l",
        start: new Date("2026-07-15T01:00:00Z"),
        durationMinutes: 150,
        summary:
          "Week 5: Roshan's Revenge vs The Couriers of Catastrophe With Very Long Name",
      },
    ]);
    for (const l of doc.split("\r\n")) {
      expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(75);
    }
    expect(doc).toContain("SUMMARY:Week 5: Roshan's Revenge vs The Couriers");
    expect(doc).toContain("\r\n "); // a folded continuation exists
  });
});
