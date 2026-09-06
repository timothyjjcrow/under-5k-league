import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StandingsTable } from "./standings-table-server";
import type { ClinchStatus, TeamStanding } from "@/lib/standings";
import { scenarioReport } from "@/lib/scenarios";

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
  it.each([true, false])("uses final partial-bracket outcomes over a stale three-team group (overview=%s)", (overview) => {
    const tiedIds = ["charlie", "delta", "echo"];
    const tiedRows = standings.map((standing) => tiedIds.includes(standing.teamId)
      ? { ...standing, idDecided: true, idTieGroup: "three-way" } : standing);
    const report = scenarioReport(tiedRows, [], 4);
    for (const id of tiedIds) {
      report.teams.get(id)!.outlook = {
        total: 1, qualified: id === "charlie" ? 0 : 1,
        qualificationTiebreaker: 0, eliminated: id === "charlie" ? 1 : 0,
        seedingTiebreaker: id === "charlie" ? 0 : 1,
        bestRank: id === "charlie" ? 5 : 3,
        worstRank: id === "charlie" ? 5 : 4,
        qualificationTies: [],
      };
    }
    const html = renderToStaticMarkup(createElement(StandingsTable, {
      standings: tiedRows, teamName: names, playoffCut: 4, playoffSeedByTeam: seeds,
      eligibleTeams: 6, overview, unresolvedPlayoffTeamIds: tiedIds,
      playoffScenarios: report.teams,
    }));
    expect(teamRowHtml(html, "charlie")).toMatch(/Eliminated|Eliminated from playoffs/);
    expect(teamRowHtml(html, "charlie")).not.toContain("Tiebreaker pending");
    for (const id of ["delta", "echo"]) {
      expect(teamRowHtml(html, id)).toMatch(/Qualified|Clinched playoffs/);
      expect(teamRowHtml(html, id)).toMatch(/[Ss]eeding tiebreaker/);
    }
  });
  it.each([true, false])("keeps a clinched mark for seed-only ties (overview=%s)", (overview) => {
    const seedTieRows = standings.map((standing) => ["bravo", "charlie"].includes(standing.teamId)
      ? { ...standing, idDecided: true, idTieGroup: "seed-only" } : standing);
    const html = renderToStaticMarkup(createElement(StandingsTable, {
      standings: seedTieRows, teamName: names, playoffCut: 4, playoffSeedByTeam: seeds,
      eligibleTeams: 6, overview, unresolvedPlayoffTeamIds: ["bravo", "charlie"],
      clinch: new Map<string, ClinchStatus>([["bravo", "CLINCHED"], ["charlie", "CLINCHED"]]),
    }));
    for (const id of ["bravo", "charlie"]) {
      const markup = teamRowHtml(html, id);
      expect(markup).toMatch(/Qualified|Clinched playoffs/);
      expect(markup).toMatch(/[Ss]eeding tiebreaker/);
      expect(markup).not.toContain("current playoff seed");
    }
  });
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
