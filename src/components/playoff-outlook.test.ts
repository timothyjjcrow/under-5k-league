import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PlayoffOutlook,
  PlayoffOutlookFootnote,
  outlookSummary,
  settledPlayoffStatus,
  shortOutlook,
  playoffStatusLine,
  playoffPathLines,
} from "./playoff-outlook";
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
    [1, 0, 0, "Qualify"],
    [0, 1, 0, "Tiebreaker for a spot"],
    [0, 0, 1, "Out"],
    [1, 1, 0, "Qualify or tiebreaker"],
    [0, 1, 1, "Tiebreaker or out"],
    [1, 0, 1, "Qualify or out"],
    [1, 1, 1, "Qualify, tiebreaker or out"],
  ])("keeps every possible outcome in the short label (%s/%s/%s)", (qualified, qualificationTiebreaker, eliminated, label) => {
    expect(shortOutlook(result({ total: qualified + qualificationTiebreaker + eliminated,
      qualified, qualificationTiebreaker, eliminated }))).toBe(label);
  });

  it("keeps detailed math collapsed and compact match links free of controls and repeated rules", () => {
    const scenario = team({ nextMatchId: "match", outlook: result({ total: 3, qualified: 1, qualificationTiebreaker: 2 }),
      paths: { win: result({ qualified: 1 }), draw: result({ qualificationTiebreaker: 1 }), loss: result({ eliminated: 1 }) } });
    const html = render(scenario);
    expect(html).toContain("How this works");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html.indexOf("qualify in 1 of 3")).toBeGreaterThan(html.indexOf("<details"));
    const compact = renderToStaticMarkup(createElement(PlayoffOutlook, { scenario, compact: true }));
    expect(compact).not.toMatch(/<details|<summary|of 3|BO3|administrative/);
    expect(compact).toContain("Win to qualify");
    expect(compact).toContain("Tiebreaker for a spot");
  });

  it("never calls a qualification tie qualified and preserves a secured place during a seed tie", () => {
    expect(playoffStatusLine(team({ status: "CLINCHED", outlook: result({ qualificationTiebreaker: 1 }) })))
      .toBe("Playoff spot decided by tiebreaker");
    expect(playoffStatusLine(team({ outlook: result({ qualified: 1, seedingTiebreaker: 1 }) })))
      .toBe("Qualified · seeding tiebreaker");
  });
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
    expect(html).toContain("BO1 knockouts");
    expect(html).toContain("up to three games per team in one weekend");
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

  describe("results that all lead to the same place", () => {
    const same = (overrides: Partial<ScenarioOutlook>) => ({
      win: result(overrides), draw: result(overrides), loss: result(overrides),
    });

    it("folds identical win, draw and loss lines into one", () => {
      const scenario = team({ nextMatchId: "m", paths: same({ eliminated: 1 }),
        outlook: result({ total: 3, eliminated: 3 }) });
      expect(playoffPathLines(scenario, "m")).toEqual([{
        key: "any", label: "Any result", description: "Out",
        detail: "Eliminated from playoffs.",
      }]);
    });

    it("folds the feasible pair when a loss is impossible", () => {
      const scenario = team({ nextMatchId: "m",
        outlook: result({ total: 2, qualified: 2 }),
        paths: { win: result({ qualified: 1 }), draw: result({ qualified: 1 }), loss: null } });
      expect(playoffPathLines(scenario, "m").map((line) => line.label)).toEqual(["Any result"]);
    });

    it("keeps separate lines when the result matters, and a lone feasible line as is", () => {
      const differs = team({ nextMatchId: "m",
        paths: { win: result({ qualified: 1 }), draw: result({ qualified: 1 }), loss: result({ eliminated: 1 }) } });
      expect(playoffPathLines(differs, "m").map((line) => line.label)).toEqual(["Win", "Draw", "Loss"]);
      const lone = team({ nextMatchId: "m", paths: { win: result({ qualified: 1 }), draw: null, loss: null } });
      expect(playoffPathLines(lone, "m").map((line) => line.label)).toEqual(["Win"]);
    });

    it.each([
      [{ qualified: 1 }, "Qualified for playoffs"],
      [{ eliminated: 1 }, "Eliminated"],
      [{ qualificationTiebreaker: 1 }, "Playoff spot decided by tiebreaker"],
    ])("shows a settled team's status alone (%o)", (verdict, status) => {
      const scenario = team({ nextMatchId: "m", paths: same(verdict),
        outlook: result({ total: 3, ...Object.fromEntries(
          Object.entries(verdict).map(([k]) => [k, 3])) }) });
      for (const compact of [true, false]) {
        const html = renderToStaticMarkup(createElement(PlayoffOutlook, { scenario, matchId: "m", compact }));
        expect(html).toContain(status);
        expect(html).not.toContain("playoff-paths");
        expect(html).not.toMatch(/>(Win|Draw|Loss|Any result)</);
      }
    });

    it("keeps separate lines when results share a short label but not the odds", () => {
      // All three read "Qualify or out", yet a win keeps the team in the
      // bracket in 8 of 9 cases and a loss in only 1 of 9.
      const scenario = team({ nextMatchId: "m",
        outlook: result({ total: 27, qualified: 13, eliminated: 14 }),
        paths: {
          win: result({ total: 9, qualified: 8, eliminated: 1 }),
          draw: result({ total: 9, qualified: 4, eliminated: 5 }),
          loss: result({ total: 9, qualified: 1, eliminated: 8 }),
        } });
      const lines = playoffPathLines(scenario, "m");
      expect(lines.map((line) => line.label)).toEqual(["Win", "Draw", "Loss"]);
      expect(lines.map((line) => line.description)).toEqual(
        ["Qualify or out", "Qualify or out", "Qualify or out"]);
      const html = renderToStaticMarkup(createElement(PlayoffOutlook, { scenario, matchId: "m" }));
      expect(html).not.toContain("Any result");
      expect(html).toContain("qualify in 8 of 9; eliminated in 1 of 9.");
      expect(html).toContain("qualify in 1 of 9; eliminated in 8 of 9.");
    });

    it("folds a settled verdict even when seeding still depends on the result", () => {
      const scenario = team({ nextMatchId: "m",
        outlook: result({ total: 3, qualified: 3, seedingTiebreaker: 1 }),
        paths: {
          win: result({ qualified: 1 }),
          draw: result({ qualified: 1 }),
          loss: result({ qualified: 1, seedingTiebreaker: 1 }),
        } });
      expect(playoffPathLines(scenario, "m").map((line) => line.label)).toEqual(["Any result"]);
    });

    it("keeps one line when the result doesn't matter but other games still do", () => {
      const mixed = result({ total: 2, qualified: 1, eliminated: 1 });
      const scenario = team({ nextMatchId: "m", outlook: result({ total: 6, qualified: 3, eliminated: 3 }),
        paths: { win: mixed, draw: mixed, loss: mixed } });
      const html = renderToStaticMarkup(createElement(PlayoffOutlook, { scenario, matchId: "m" }));
      expect(html).toContain("Playoff spot still open");
      expect(html).toContain(">Any result</dt>");
      expect(html).toContain(">Qualify or out</dd>");
      expect(html).not.toMatch(/>(Win|Draw|Loss)</);
      // The disclosure states the overall counts once, not per result.
      expect(html.match(/qualify in 3 of 6; eliminated in 3 of 6\./g)).toHaveLength(1);
    });
  });

  describe("one shared footnote for a list of teams", () => {
    const names = new Map([["alpha", "Alpha"], ["bravo", "Bravo"], ["charlie", "Charlie"]]);
    const footnote = (scenarios: TeamScenario[]) => renderToStaticMarkup(
      createElement(PlayoffOutlookFootnote, { scenarios, teamNames: names }));

    it("states each team's counts and order once, then the rules once", () => {
      const scenarios = [
        team({ teamId: "alpha", outlook: result({ total: 3, qualified: 3, bestRank: 1, worstRank: 2 }) }),
        team({ teamId: "bravo", nextMatchId: "m",
          outlook: result({ total: 3, qualified: 1, qualificationTiebreaker: 1, eliminated: 1,
            qualificationTies: [{ teamIds: ["bravo", "charlie"], spots: 1 }] }),
          paths: { win: result({ qualified: 1 }), draw: result({ qualificationTiebreaker: 1 }),
            loss: result({ eliminated: 1 }) } }),
        team({ teamId: "charlie", outlook: result({ total: 3, eliminated: 2, qualificationTiebreaker: 1,
          qualificationTies: [{ teamIds: ["charlie", "bravo"], spots: 1 }] }) }),
      ];
      const html = footnote(scenarios);
      expect(html.match(/<details/g)).toHaveLength(1);
      expect(html.match(/How this works/g)).toHaveLength(1);
      expect(html).toContain("Alpha:</strong> Qualified for playoffs. Possible playoff order: #1–#2.");
      expect(html).toContain("qualify in 1 of 3; qualification tiebreaker in 1 of 3; eliminated in 1 of 3.");
      // The same tie seen from both teams is listed once.
      expect(html.match(/Possible tiebreaker: /g)).toHaveLength(1);
      expect(html.match(/BO1 knockouts/g)).toHaveLength(1);
      expect(html.match(/not qualification odds/g)).toHaveLength(1);

      // The tracker cards themselves carry no disclosure of their own.
      for (const scenario of scenarios) {
        const card = renderToStaticMarkup(createElement(PlayoffOutlook, { scenario, compact: true }));
        expect(card).not.toMatch(/<details|How this works/);
      }
    });

    it("renders nothing when there is nothing to explain", () => {
      expect(footnote([team({ teamId: "alpha" })])).toBe("");
    });
  });

  describe("the settled status chip", () => {
    it.each([
      [team({ outlook: result({ total: 3, qualified: 3 }) }), "Qualified for playoffs", "success"],
      [team({ outlook: result({ total: 3, qualified: 3, seedingTiebreaker: 3 }) }),
        "Qualified · seeding tiebreaker", "success"],
      [team({ outlook: result({ total: 3, eliminated: 3 }) }), "Eliminated", "neutral"],
      [team({ outlook: result({ total: 3, qualificationTiebreaker: 3 }) }),
        "Playoff spot decided by tiebreaker", "accent"],
      [team({ status: "CLINCHED" }), "Qualified for playoffs", "success"],
      [team({ status: "ELIMINATED" }), "Eliminated", "neutral"],
    ])("names a settled outcome", (scenario, text, tone) => {
      expect(settledPlayoffStatus(scenario)).toEqual({ text, tone });
    });

    it("stays away while results can still change the outcome", () => {
      expect(settledPlayoffStatus(team({ outlook: result({ total: 3, qualified: 2, eliminated: 1 }) })))
        .toBeNull();
      expect(settledPlayoffStatus(team({ status: null }))).toBeNull();
      // A clinch flag from the bounds never overrides an exact mixed outlook.
      expect(settledPlayoffStatus(team({ status: "CLINCHED",
        outlook: result({ total: 3, qualified: 1, qualificationTiebreaker: 2 }) }))).toBeNull();
    });
  });
});
