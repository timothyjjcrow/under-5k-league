import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StandingsTable } from "./standings-table-server";
import type { ClinchStatus, TeamStanding } from "@/lib/standings";
import { scenarioReport } from "@/lib/scenarios";
import type { MatchLike } from "@/lib/standings";
import {
  projectPlayoffField,
  publicDeadHeatTeamIds,
} from "@/lib/playoff-field";

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

describe("mid-season ties", () => {
  // The chip's accessible name (the table caption also says "Fully tied").
  const TIED_CHIP = 'aria-label="Fully tied with a neighbouring team';
  const match = (
    homeTeamId: string,
    awayTeamId: string,
    homeScore: number,
    awayScore: number,
    status = "COMPLETED",
  ): MatchLike => ({
    homeTeamId, awayTeamId, homeScore, awayScore, status, phase: "REGULAR",
    winnerTeamId: status !== "COMPLETED" || homeScore === awayScore
      ? null : homeScore > awayScore ? homeTeamId : awayTeamId,
  });
  const teams = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
  const teamName = new Map(teams.map((team) => [team.id, team.id]));
  const render = (matches: MatchLike[], overview: boolean) => {
    const field = projectPlayoffField(teams, matches);
    return renderToStaticMarkup(createElement(StandingsTable, {
      standings: field.standings, teamName, overview,
      playoffCut: field.bracketSize, playoffSeedByTeam: field.seedByTeam,
      eligibleTeams: field.eligibleTeamIds.length,
      unresolvedPlayoffTeamIds: publicDeadHeatTeamIds(field, matches),
    }));
  };

  it.each([true, false])("shows a quiet tied chip and keeps seeds while games remain (overview=%s)", (overview) => {
    // d, e and f are level across the cut, but a regular fixture is still live.
    const html = render([
      ...["b", "c", "d", "e", "f"].map((away) => match("a", away, 2, 0)),
      ...["c", "d", "e", "f"].map((away) => match("b", away, 2, 0)),
      ...["d", "e", "f"].map((away) => match("c", away, 2, 0)),
      match("d", "e", 1, 1),
      match("d", "f", 1, 1),
      match("e", "f", 1, 1),
      match("a", "b", 1, 0, "LIVE"),
    ], overview);
    expect(html).not.toContain("Tiebreaker pending");
    expect(html).not.toMatch(/[Ss]eeding tiebreaker/);
    expect(html).not.toContain("pending a tiebreaker match");
    for (const id of ["d", "e", "f"])
      expect(teamRowHtml(html, id)).toContain(TIED_CHIP);
    expect(teamRowHtml(html, "d")).toContain("current playoff seed 4");
    if (overview) expect(html).toContain("Playoff cut · 4 places");
    else expect(html).toContain("Playoff cut");
  });

  it.each([true, false])("shows no tie chips before anyone has played (overview=%s)", (overview) => {
    const html = render([match("a", "b", 0, 0, "SCHEDULED")], overview);
    expect(html).not.toContain("Tiebreaker pending");
    expect(html).not.toContain(TIED_CHIP);
  });
});
