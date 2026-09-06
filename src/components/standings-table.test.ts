import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StandingsTable } from "./standings-table-server";
import type { ClinchStatus, TeamStanding } from "@/lib/standings";

const row = (teamId: string, points: number): TeamStanding => ({
  teamId, points, played: 5, wins: points / 3, draws: 0,
  losses: 5 - points / 3, gameWins: points / 3, gameLosses: 0,
  gameDiff: points / 3,
});
const standings = [
  row("alpha", 15), row("bravo", 12), row("charlie", 9),
  { ...row("delta", 3), idDecided: true, idTieGroup: "cutoff" },
  { ...row("echo", 3), idDecided: true, idTieGroup: "cutoff" },
  row("foxtrot", 0),
];
const seeds = new Map(["alpha", "bravo", "charlie", "delta"].map((id, i) => [id, i + 1]));
const names = new Map(standings.map((standing) => [standing.teamId, standing.teamId]));
const teamRowHtml = (html: string, teamId: string) =>
  html.split("<tr").find((part) => part.includes(`href="/teams/${teamId}"`)) ?? "";

describe("standings tiebreaker presentation", () => {
  it.each([true, false])("keeps unresolved cutoff teams provisional (overview=%s)", (overview) => {
    const html = renderToStaticMarkup(createElement(StandingsTable, {
      standings, teamName: names, playoffCut: 4, playoffSeedByTeam: seeds,
      eligibleTeams: 6, overview, unresolvedPlayoffTeamIds: ["delta", "echo"],
      // Stale scenario labels must not overrule the pending tiebreaker.
      clinch: new Map<string, ClinchStatus>([["delta", "CLINCHED"], ["echo", "ELIMINATED"]]),
    }));
    for (const team of ["delta", "echo"]) {
      const markup = teamRowHtml(html, team);
      expect(markup).toContain("Tiebreaker pending");
      expect(markup).not.toContain("current playoff seed");
      expect(markup).not.toContain("Outside cut");
      expect(markup).not.toContain("Qualified");
      expect(markup).not.toContain("Eliminated");
    }
    expect(html).not.toContain("Playoff cut · 4 places");
    expect(teamRowHtml(html, "alpha")).toContain("current playoff seed 1");
    if (overview) expect(teamRowHtml(html, "foxtrot")).toContain("Outside cut");
  });

  it("restores confirmed seeds and the cutoff after the extra result resolves the tie", () => {
    const resolved = standings.map((standing) => standing.idTieGroup
      ? { ...standing, idDecided: false, idTieGroup: undefined, tiebreakerResolved: true }
      : standing);
    const html = renderToStaticMarkup(createElement(StandingsTable, {
      standings: resolved, teamName: names, playoffCut: 4,
      playoffSeedByTeam: seeds, eligibleTeams: 6, overview: true,
      unresolvedPlayoffTeamIds: [],
    }));
    expect(teamRowHtml(html, "delta")).toContain("Seed 4");
    expect(teamRowHtml(html, "delta")).toContain("TB resolved");
    expect(teamRowHtml(html, "echo")).toContain("Outside cut");
    expect(html).toContain("Playoff cut · 4 places");
    expect(html).not.toContain("Tiebreaker pending");
  });
});
