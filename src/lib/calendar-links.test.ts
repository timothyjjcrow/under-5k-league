import { describe, expect, it } from "vitest";
import { calendarFeedLinks } from "./calendar-links";

describe("calendarFeedLinks", () => {
  it("offers a download, a webcal subscription and a Google Calendar link for the league", () => {
    expect(calendarFeedLinks(undefined, "https://league.example")).toEqual({
      download: "/api/calendar",
      subscribe: "webcal://league.example/api/calendar",
      google:
        "https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2Fleague.example%2Fapi%2Fcalendar",
    });
  });

  it("filters every link to one team", () => {
    const links = calendarFeedLinks("team 1", "http://localhost:3000");
    expect(links.download).toBe("/api/calendar?team=team%201");
    expect(links.subscribe).toBe(
      "webcal://localhost:3000/api/calendar?team=team%201",
    );
    // Google receives the whole subscription URL as one encoded value.
    expect(
      new URL(links.google).searchParams.get("cid"),
    ).toBe(links.subscribe);
  });

  it("treats a null team as the whole league", () => {
    expect(calendarFeedLinks(null, "https://league.example").download).toBe(
      "/api/calendar",
    );
  });
});
