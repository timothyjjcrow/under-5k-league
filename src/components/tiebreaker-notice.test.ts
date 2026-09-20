import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TiebreakerNotice } from "./tiebreaker-notice";
import { projectPlayoffField as projectCurrentPlayoffField } from "@/lib/playoff-field";
// Historical fixture generation; production continues to recognize these stored formats.
const projectPlayoffField: typeof projectCurrentPlayoffField = (teams, matches) => projectCurrentPlayoffField(teams, matches, "legacy");
import { scenarioReport } from "@/lib/scenarios";

const teams = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Bravo" },
];
const projection = projectPlayoffField(teams, []);
const render = (props: Partial<Parameters<typeof TiebreakerNotice>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(TiebreakerNotice, {
      teams,
      projection,
      regularComplete: true,
      hasTiebreakers: false,
      ...props,
    }),
  );

describe("public tiebreaker notice", () => {
  it("describes only seeding after the third-place team is eliminated", () => {
    const threeTeams = [...teams, { id: "c", name: "Charlie" }];
    const field = projectPlayoffField(threeTeams, []);
    const report = scenarioReport(field.eligibleStandings, [], 2);
    report.forecast = { basis: "final", total: 1 };
    for (const [id, scenario] of report.teams) {
      scenario.outlook = {
        total: 1, qualified: id === "c" ? 0 : 1,
        qualificationTiebreaker: 0, eliminated: id === "c" ? 1 : 0,
        seedingTiebreaker: id === "c" ? 0 : 1,
        bestRank: id === "c" ? 3 : 1, worstRank: id === "c" ? 3 : 2,
        qualificationTies: [],
      };
    }
    const html = render({ teams: threeTeams, projection: field, report, hasTiebreakers: true });
    expect(html).toContain("Alpha, Bravo have qualified; their seeding tiebreaker decides playoff order.");
    expect(html).not.toContain("Charlie");
    expect(html).not.toContain("need a qualification tiebreaker");
  });
  it("keeps provisional in-season ties quiet until regular results are complete", () => {
    expect(render({ regularComplete: false })).toBe("");
  });

  it("explains a two-team best-of-three series and links to its fixtures", () => {
    const html = render();
    expect(html).toContain("Alpha, Bravo");
    expect(html).toContain("Two tied teams play one best-of-three series");
    expect(html).toContain("An administrator must schedule the remaining tiebreakers");
    expect(html).toContain('href="/schedule#tiebreakers"');
    expect(html).toContain("Regular-season points stay the same");
  });

  it("requires unfinished extra series to finish before playoffs", () => {
    const html = render({
      hasTiebreakers: true,
      projection: {
        ...projection,
        tiebreakers: { ...projection.tiebreakers, pending: true },
      },
    });
    expect(html).toContain("Finish the scheduled tiebreakers before playoffs begin");
    expect(html).not.toContain("tiebreakers complete");
  });

  it("explains the bounded three-team BO1 bracket and opening draw", () => {
    const threeTeams = [...teams, { id: "c", name: "Charlie" }];
    const html = render({
      teams: threeTeams,
      projection: projectPlayoffField(threeTeams, []),
    });
    expect(html).toContain("Alpha, Bravo, Charlie");
    expect(html).toContain("best-of-one double-elimination bracket");
    expect(html).toContain("four games, or five if the final needs a reset");
    expect(html).toContain("same tiebreaker week");
    expect(html).toContain("opening matchup and bye are drawn");
    expect(html).not.toContain("play another round");
  });

  it("does not claim qualification is settled when fixture validation fails", () => {
    const html = render({
      hasTiebreakers: true,
      projection: {
        ...projection,
        seedingDeadHeatTeamIds: [],
        tiebreakers: { ...projection.tiebreakers, error: "Stale fixture" },
      },
    });
    expect(html).toContain("review before the playoff bracket can start");
    expect(html).not.toContain("tiebreakers complete");
  });

  it("announces a settled playoff order only after resolution", () => {
    const html = render({
      hasTiebreakers: true,
      projection: {
        ...projection,
        seedingDeadHeatTeamIds: [],
        tiebreakers: {
          groups: [],
          resolved: true,
          pending: false,
          needsMatches: false,
          error: null,
        },
      },
    });
    expect(html).toContain("Playoff tiebreakers complete");
    expect(html).toContain("Qualification and seeds are settled");
  });
});
