import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PowerRankingsCard, type PowerRankingTeam } from "./power-rankings-card";
import type { PowerRankingRow } from "@/lib/power-rankings";

const teams = new Map<string, PowerRankingTeam>([
  ["a", { name: "Radiant Raiders", logoUrl: null, withdrawn: false }],
  ["b", { name: "Dire Wolves", logoUrl: null, withdrawn: true }],
]);
const rows: PowerRankingRow[] = [
  { teamId: "a", rating: 1043, rank: 1, prevRank: 2, delta: 25 },
  { teamId: "b", rating: 957, rank: 2, prevRank: 1, delta: -25 },
];

function render(frozen: boolean, list = rows) {
  return renderToStaticMarkup(
    createElement(PowerRankingsCard, { rows: list, teams, frozen }),
  );
}

describe("PowerRankingsCard", () => {
  it("starts folded to a one-line summary naming the leader", () => {
    const html = render(false);
    // No `open` attribute: the tag carries only its id and class.
    expect(html).toMatch(/^<details id="power-rankings" class="[^"]*">/);
    expect(html).toContain("Power rankings");
    expect(html).toContain(
      "Elo rating from regular-season games · Radiant Raiders top on 1043",
    );
  });

  it("has one legend for the bars and arrows", () => {
    const html = render(false);
    expect(html).toContain("Bars: Elo change in the latest week");
    expect(html.match(/>lost</g)).toHaveLength(1);
    expect(html.match(/>gained</g)).toHaveLength(1);
    expect(html).toContain("scale −30 to +30");
    expect(html).not.toContain("Weekly Elo change");
    expect(html).toContain('aria-label="Power rank up 1 in the latest week"');
  });

  it("says it is frozen once the regular season is over", () => {
    const html = render(true);
    expect(html).toContain(
      "Frozen at the end of the regular season · Radiant Raiders finished top on 1043",
    );
    expect(html).toContain("Bars: Elo change in the final regular-season week");
    expect(html).toContain(
      'aria-label="Power rank down 1 in the final regular-season week"',
    );
    expect(html).not.toContain("latest week");
  });

  it("explains the missing movement after one week of results", () => {
    const html = render(false, [
      { teamId: "a", rating: 1016, rank: 1, prevRank: 0, delta: 0 },
      { teamId: "b", rating: 984, rank: 2, prevRank: 0, delta: 0 },
    ]);
    expect(html).toContain("Weekly movement shows once a second week has results.");
    expect(html).not.toContain("Bars:");
  });

  it("renders nothing before any result", () => {
    expect(render(false, [])).toBe("");
  });

  it("keeps the withdrawn badge", () => {
    expect(render(false)).toContain(">Withdrawn</span>");
  });
});
