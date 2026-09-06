import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TiebreakerNotice } from "./tiebreaker-notice";
import { projectPlayoffField } from "@/lib/playoff-field";

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
  it("keeps provisional in-season ties quiet until regular results are complete", () => {
    expect(render({ regularComplete: false })).toBe("");
  });

  it("explains a two-team best-of-three series and links to its fixtures", () => {
    const html = render();
    expect(html).toContain("Alpha, Bravo");
    expect(html).toContain("Two tied teams play one best-of-three series");
    expect(html).toContain("remaining tiebreaker matches must be scheduled");
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
    expect(html).toContain("scheduled tiebreaker matches must finish");
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
    expect(html).toContain("settled playoff qualification and seeding");
  });
});
