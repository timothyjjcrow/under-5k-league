import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

import { ScheduleWeeks, type MatchView, type WeekView } from "./schedule-weeks";
import { sourceFile, stripLineComments } from "../../test/support/source-files";

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

const weekOf = (
  matches: Partial<MatchView>[],
  overrides: Partial<WeekView> = {},
): WeekView => ({
  week: 3,
  completed: 0,
  total: matches.length,
  isCurrent: true,
  isOverdue: false,
  matches: matches.map((match, index) => ({
    ...baseMatch,
    id: `m${index + 1}`,
    ...match,
  })),
  byes: [],
  ...overrides,
});

function render(match: Partial<MatchView>) {
  return renderToStaticMarkup(
    createElement(ScheduleWeeks, { weeks: [weekOf([match])], teams: [] }),
  );
}

const articles = (html: string) =>
  [...html.matchAll(/<article[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);

const hrefs = (html: string) =>
  [...html.matchAll(/<a[^>]*href="([^"]+)"/g)].map((m) => m[1]);

describe("ScheduleWeeks match cards", () => {
  it("open the match from the whole card through one named link", () => {
    const html = render({});
    // No team-page links compete with the match for the card's taps.
    expect(hrefs(html)).toEqual(["/matches/m1"]);
    // "Match page" is the link's spoken name; the card shows an arrow.
    expect(html).toContain(
      '<span class="sr-only">Match page: Radiant Raiders vs Dire Wolves</span>',
    );
    expect(html).not.toMatch(/>Match page</);
    // The link's ::after overlay covers the positioned card.
    expect(html).toMatch(/<article[^>]*class="relative /);
    expect(html).toMatch(
      /<a class="[^"]*after:absolute after:inset-0[^"]*" href="\/matches\/m1"/,
    );
    expect(html).not.toContain("details →");
  });

  // The live tint was a second background COLOUR, which tailwind-merge
  // resolved by dropping bg-surface: the card went translucent over the
  // grid's gap colour and its red LIVE label fell under AA.
  it("tints a live card over its surface and labels it in danger-soft", () => {
    const html = render({ live: true, homeScore: 1 });
    const article = html.match(/<article[^>]*class="([^"]*)"/)?.[1] ?? "";
    expect(article.split(" ")).toContain("bg-surface");
    expect(article).toContain("from-danger/[0.04]");
    expect(html).toMatch(/aria-label="Live — series at 1–0"[^>]*text-danger-soft/);
  });

  it("keeps the reschedule chip above the card's overlay", () => {
    const html = render({
      reschedulePending: { by: "Cap", ts: null, initial: null },
    });
    expect(html).toMatch(/aria-label="Time change proposed[^"]*"[^>]*relative z-10/);
  });

  it("asks the captain of an overdue fixture to report it", () => {
    const html = render({ awaitingResult: true, reportResult: true });
    expect(html).toContain('aria-label="Radiant Raiders vs Dire Wolves · Result needed"');
    expect(html).not.toContain("Awaiting result");
    expect(hrefs(html)).toEqual(["/matches/m1", "/matches/m1#match-report"]);
    expect(html).toContain("Report result");
  });

  it("tells everyone else the result is awaited, with no report link", () => {
    const html = render({ awaitingResult: true });
    expect(html).toContain("Awaiting result");
    expect(hrefs(html)).toEqual(["/matches/m1"]);
  });
});

describe("ScheduleWeeks: what a card leaves unsaid", () => {
  const two = [
    { homeTeamId: "a", awayTeamId: "b", homeName: "Alpha", awayName: "Bravo" },
    { homeTeamId: "c", awayTeamId: "d", homeName: "Charlie", awayName: "Delta" },
  ];

  it("keeps an ordinary upcoming fixture's status in its name, not on the card", () => {
    const html = render({});
    expect(articles(html)).toEqual(["Radiant Raiders vs Dire Wolves · Upcoming"]);
    expect(html).not.toMatch(/>Upcoming</);
    // A state worth noticing still shows.
    expect(render({ whenTs: null, whenFull: null, whenShort: null })).toMatch(
      />Time TBD</,
    );
    expect(render({ done: true, homeWin: true, homeScore: 2 })).toMatch(
      />Final score</,
    );
  });

  it("prints a week's shared kickoff once, in the header", () => {
    const html = renderToStaticMarkup(
      createElement(ScheduleWeeks, { weeks: [weekOf(two)], teams: [] }),
    );
    expect(html.match(/Sun, Sep 6, 6:00 PM/g)).toHaveLength(1);
    expect(html).not.toContain(">Sep 6, 6:00 PM<");
  });

  it("keeps a moved series' own kickoff on its card", () => {
    const html = renderToStaticMarkup(
      createElement(ScheduleWeeks, {
        weeks: [
          weekOf([
            two[0],
            {
              ...two[1],
              whenTs: baseMatch.whenTs! + 86_400_000,
              whenFull: "Mon, Sep 7, 6:00 PM",
              whenShort: "Sep 7, 6:00 PM",
            },
          ]),
        ],
        teams: [],
      }),
    );
    expect(html).toContain("Sep 6, 6:00 PM");
    expect(html).toContain("Sep 7, 6:00 PM");
  });

  it("leads each week with the reader's series and marks it", () => {
    const html = renderToStaticMarkup(
      createElement(ScheduleWeeks, {
        weeks: [weekOf(two)],
        teams: [],
        viewerTeamId: "d",
      }),
    );
    expect(articles(html)).toEqual([
      "Charlie vs Delta · Upcoming",
      "Alpha vs Bravo · Upcoming",
    ]);
    expect(html.match(/>Your match</g)).toHaveLength(1);
  });

  it("opens on the whole league and names the reader's team in the filter", () => {
    const teams = ["a", "b", "c", "d"].map((id) => ({ id, name: `Team ${id}` }));
    const html = renderToStaticMarkup(
      createElement(ScheduleWeeks, {
        weeks: [weekOf(two)],
        teams,
        viewerTeamId: "c",
      }),
    );
    expect(articles(html)).toHaveLength(2);
    expect(html).toMatch(/<option value="all" selected="">All teams<\/option>/);
    const options = [...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)</g)].map(
      (m) => `${m[1]}=${m[2]}`,
    );
    expect(options.slice(0, 3)).toEqual([
      "all=All teams",
      "c=My team · Team c",
      "a=Team a",
    ]);
    expect(options.filter((option) => option.startsWith("c="))).toHaveLength(1);
  });

  it("starts the weeks after the focus week as one line a series", () => {
    const html = renderToStaticMarkup(
      createElement(ScheduleWeeks, {
        weeks: [
          weekOf(two),
          weekOf(two, { week: 4, isCurrent: false }),
        ],
        teams: [],
        openThrough: 3,
        viewerTeamId: "a",
      }),
    );
    expect(articles(html)).toHaveLength(2);
    expect(html).toContain('aria-label="Week 4 results"');
    expect(html).toContain('<span class="sr-only">Your match: </span>');
  });

  it("says a settled side in the words Home uses, in place of its paths", () => {
    const html = render({
      playoffPaths: {
        home: [],
        away: [{ key: "win", label: "Win", description: "Qualify", detail: "" }],
      },
      playoffSettled: {
        home: { text: "Qualified for playoffs", tone: "success" },
        away: null,
      },
    });
    expect(html).toMatch(/text-success[^>]*>Qualified for playoffs</);
    expect(html).not.toContain("Any result");
    expect(html).toContain(">Win<");
  });
});

describe("/schedule wires the page to the tested rules", () => {
  const page = stripLineComments(sourceFile("src/app/schedule/page.tsx").text);

  it("opens on the whole league: the reader's team marks, it never filters", () => {
    expect(page).not.toContain("<ScheduleWeeks\n      weeks={orderScheduleWeeks(weekViews, progress.focusWeek)}\n      initialTeamId");
    expect(page.match(/viewerTeamId=\{\[\.\.\.myTeamIds\]\[0\]\}/g)?.length).toBeGreaterThanOrEqual(3);
    // Only the calendar still starts on the reader's own team.
    expect(page.match(/initialTeamId=/g)).toHaveLength(1);
    expect(page).toMatch(/<AddToCalendar[\s\S]{0,120}initialTeamId=/);
  });

  it("takes each card's stake, counts and the race lists from lib", () => {
    expect(page).toContain("fixtureStake(stakesReport?.teams.get(m.homeTeamId), m.id)");
    expect(page).toContain("fixtureStake(stakesReport?.teams.get(m.awayTeamId), m.id)");
    expect(page).not.toContain("playoffPathLines(");
    expect(page).toContain("checkinCountsShown({");
    expect(page).toContain("playoffRaceGroups(order, report, viewerTeamId)");
    expect(page).toContain("openThrough={");
  });

  it("draws the playoff race into the standings card, not a card of its own", () => {
    const race = page.slice(page.indexOf("function PlayoffPicture("), page.indexOf("function ProjectedSide("));
    expect(race.length).toBeGreaterThan(500);
    expect(race).not.toContain("<Card");
  });
});
