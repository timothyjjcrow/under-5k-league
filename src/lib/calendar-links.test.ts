import { describe, expect, it } from "vitest";
import { calendarFeedLinks } from "./calendar-links";

describe("calendarFeedLinks", () => {
  it("offers a download path and a webcal subscription for the league", () => {
    expect(calendarFeedLinks(undefined, "https://league.example")).toEqual({
      download: "/api/calendar",
      subscribe: "webcal://league.example/api/calendar",
    });
  });

  it("filters both to one team", () => {
    expect(calendarFeedLinks("team 1", "http://localhost:3000")).toEqual({
      download: "/api/calendar?team=team%201",
      subscribe: "webcal://localhost:3000/api/calendar?team=team%201",
    });
  });
});
