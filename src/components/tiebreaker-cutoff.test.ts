import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { singleEliminationPlan } from "@/lib/single-elimination";
import { TiebreakerBracket } from "./tiebreaker-bracket";
import type { TiebreakerBracketView } from "./tiebreaker-bracket-view";

const teams = Array.from({ length: 9 }, (_, i) => ({ id: `team-${i}`, name: `Team ${i}` }));
const bracket: TiebreakerBracketView = {
  key: "cutoff", format: "BO1_SINGLE_ELIMINATION", round: 1, bestOf: 1,
  teamIds: teams.map((t) => t.id), status: "needed", byeTeamId: null,
  week: null, openingAt: null, matches: [], placements: [], qualifyingPlaces: 1,
};

describe("oversized tiebreaker draw cutoff", () => {
  it.each([false, true])("discloses the cutoff before the draw for players and admins (admin=%s)", (admin) => {
    const html = renderToStaticMarkup(createElement(TiebreakerBracket, { teams, bracket, admin, postseasonStarted: false }));
    expect(html).toContain("published draw selects 8 teams before play");
    expect(html).toContain("remaining teams are out of playoffs");
    expect(html).not.toContain("Outside the draw cutoff");
  });

  it.each([false, true])("names eliminated teams after the draw (admin=%s)", (admin) => {
    const singlePlan = singleEliminationPlan(bracket.teamIds, 1, bracket.key);
    const html = renderToStaticMarkup(createElement(TiebreakerBracket, {
      teams, bracket: { ...bracket, singlePlan }, admin, postseasonStarted: false,
    }));
    expect(html).toContain("Outside the draw cutoff · Out of playoffs: Team 8.");
    expect(html).toContain("Bracket 1 · One playoff place");
    expect(singlePlan.brackets.flatMap((b) => b.teamIds)).not.toContain("team-8");
  });
});
