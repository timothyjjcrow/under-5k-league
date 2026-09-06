import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlayoffOutlook, outlookSummary } from "./playoff-outlook";
import type { ScenarioOutlook, TeamScenario } from "@/lib/scenarios";

const result = (overrides: Partial<ScenarioOutlook> = {}): ScenarioOutlook => ({
  total: 1, qualified: 0, qualificationTiebreaker: 0, eliminated: 0,
  seedingTiebreaker: 0, bestRank: 3, worstRank: 5, qualificationTies: [],
  ...overrides,
});
const team = (overrides: Partial<TeamScenario> = {}): TeamScenario => ({
  teamId: "alpha", status: null, winAndIn: false, loseAndOut: false,
  magicNumber: null, eliminationLosses: null, bestRank: 3, worstRank: 5,
  exact: true, madeCount: 0, leafCount: 1, nextMatchId: null, ...overrides,
});
const render = (scenario: TeamScenario, matchId?: string) => renderToStaticMarkup(
  createElement(PlayoffOutlook, {
    scenario, matchId,
    teamNames: new Map([["alpha", "Alpha"], ["bravo", "Bravo"]]),
  }),
);

describe("playoff outlook presentation", () => {
  it.each([
    [result({ qualified: 1 }), "Qualified for playoffs."],
    [result({ qualified: 1, seedingTiebreaker: 1 }), "Qualified for playoffs; seeding tiebreaker required."],
    [result({ qualificationTiebreaker: 1 }), "Qualification tiebreaker required."],
    [result({ eliminated: 1 }), "Eliminated from playoffs."],
  ])("renders final classification without stale waiting language", (outlook, expected) => {
    const html = render(team({ outlook }));
    expect(html).toContain(expected);
    expect(html).toContain('data-testid="playoff-outlook" data-team-id="alpha"');
    expect(html).not.toMatch(/waiting|rest of the league|Regular matches complete/i);
  });

  it("shows feasible BO2 win/draw paths and excludes an impossible loss at 1–0", () => {
    const scenario = team({
      nextMatchId: "live-match",
      outlook: result({ total: 6, qualified: 4, qualificationTiebreaker: 2 }),
      paths: {
        win: result({ total: 3, qualified: 3 }),
        draw: result({ total: 3, qualified: 1, qualificationTiebreaker: 2 }),
        loss: null,
      },
    });
    const html = render(scenario, "live-match");
    expect(html).toContain(">Win</dt>");
    expect(html).toContain(">Draw</dt>");
    expect(html).not.toContain(">Loss</dt>");
    expect(html).toContain("qualification tiebreaker in 2 of 3");
    expect(html).toContain("not qualification odds");
    expect(html).toContain("normally completed series");
    expect(html).toContain("administrative rulings or score corrections");
    expect(html).toContain("two teams play BO3");
    expect(html).toContain("three teams play BO1");
    expect(render(scenario, "different-match")).not.toContain(">Win</dt>");
  });

  it("names the qualification tiebreaker participants and available places", () => {
    const html = render(team({
      outlook: result({
        qualificationTiebreaker: 1,
        qualificationTies: [{ teamIds: ["alpha", "bravo"], spots: 1 }],
      }),
    }));
    expect(html).toContain("Tiebreaker: Alpha, Bravo");
    expect(html).toContain("for 1 playoff place.");
  });

  it("separates mixed qualification paths without implying prediction percentages", () => {
    expect(outlookSummary(result({ total: 3, qualified: 1, qualificationTiebreaker: 1, eliminated: 1 })))
      .toBe("qualify in 1 of 3; qualification tiebreaker in 1 of 3; eliminated in 1 of 3.");
  });
});
