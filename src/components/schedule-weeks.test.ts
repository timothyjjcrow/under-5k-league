import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

import { ScheduleWeeks, type MatchView, type WeekView } from "./schedule-weeks";

const baseMatch: MatchView = {
  id: "m1",
  homeTeamId: "home",
  awayTeamId: "away",
  homeName: "Radiant Raiders",
  awayName: "Dire Wolves",
  homeScore: 0,
  awayScore: 0,
  done: false,
  forfeit: false,
  live: false,
  homeWin: false,
  awayWin: false,
  whenFull: "Sun, Sep 6, 6:00 PM",
  whenShort: "Sep 6, 6:00 PM",
  whenTs: Date.parse("2026-09-07T01:00:00Z"),
  isFinalPhase: false,
  standins: [],
  reschedulePending: null,
};

function render(match: Partial<MatchView>) {
  const week: WeekView = {
    week: 3,
    completed: 0,
    total: 1,
    isCurrent: true,
    isOverdue: false,
    matches: [{ ...baseMatch, ...match }],
    byes: [],
  };
  return renderToStaticMarkup(
    createElement(ScheduleWeeks, { weeks: [week], teams: [] }),
  );
}

const hrefs = (html: string) =>
  [...html.matchAll(/<a[^>]*href="([^"]+)"/g)].map((m) => m[1]);

describe("ScheduleWeeks match cards", () => {
  it("open the match from the whole card through one named link", () => {
    const html = render({});
    // No team-page links compete with the match for the card's taps.
    expect(hrefs(html)).toEqual(["/matches/m1"]);
    expect(html).toContain("Match page");
    expect(html).toContain(
      '<span class="sr-only">: Radiant Raiders vs Dire Wolves</span>',
    );
    // The link's ::after overlay covers the positioned card.
    expect(html).toMatch(/<article[^>]*class="relative /);
    expect(html).toMatch(
      /<a class="[^"]*after:absolute after:inset-0[^"]*" href="\/matches\/m1"/,
    );
    expect(html).not.toContain("details →");
  });

  it("keeps the reschedule chip above the card's overlay", () => {
    const html = render({
      reschedulePending: { by: "Cap", ts: null, initial: null },
    });
    expect(html).toMatch(/aria-label="Time change proposed[^"]*"[^>]*relative z-10/);
  });
});
