import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StandingsTable } from "./standings-table-server";
import { STANDINGS_RULES, TiedChip } from "./standings-table";
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
  it("uses final partial-bracket outcomes over a stale three-team group", () => {
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
      eligibleTeams: 6, unresolvedPlayoffTeamIds: tiedIds,
      playoffScenarios: report.teams,
    }));
    expect(teamRowHtml(html, "charlie")).toMatch(/Eliminated|Eliminated from playoffs/);
    expect(teamRowHtml(html, "charlie")).not.toContain("Tiebreaker pending");
    for (const id of ["delta", "echo"]) {
      expect(teamRowHtml(html, id)).toMatch(/Qualified|Clinched playoffs/);
      expect(teamRowHtml(html, id)).toMatch(/[Ss]eeding tiebreaker/);
    }
  });
  it("keeps a clinched mark for seed-only ties", () => {
    const seedTieRows = standings.map((standing) => ["bravo", "charlie"].includes(standing.teamId)
      ? { ...standing, idDecided: true, idTieGroup: "seed-only" } : standing);
    const html = renderToStaticMarkup(createElement(StandingsTable, {
      standings: seedTieRows, teamName: names, playoffCut: 4, playoffSeedByTeam: seeds,
      eligibleTeams: 6, unresolvedPlayoffTeamIds: ["bravo", "charlie"],
      clinch: new Map<string, ClinchStatus>([["bravo", "CLINCHED"], ["charlie", "CLINCHED"]]),
    }));
    for (const id of ["bravo", "charlie"]) {
      const markup = teamRowHtml(html, id);
      expect(markup).toMatch(/Qualified|Clinched playoffs/);
      expect(markup).toMatch(/[Ss]eeding tiebreaker/);
      expect(markup).not.toContain("current playoff seed");
    }
  });
  it("keeps unresolved cutoff teams provisional", () => {
    const html = renderToStaticMarkup(createElement(StandingsTable, {
      standings, teamName: names, playoffCut: 4, playoffSeedByTeam: seeds,
      eligibleTeams: 6, unresolvedPlayoffTeamIds: ["delta", "echo"],
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
    expect(teamRowHtml(html, "foxtrot")).toContain("Outside cut");
  });

  it("restores confirmed seeds and the cutoff after the extra result resolves the tie", () => {
    const resolved = standings.map((standing) => standing.idTieGroup
      ? { ...standing, idDecided: false, idTieGroup: undefined, tiebreakerResolved: true }
      : standing);
    const html = renderToStaticMarkup(createElement(StandingsTable, {
      standings: resolved, teamName: names, playoffCut: 4,
      playoffSeedByTeam: seeds, eligibleTeams: 6,
      unresolvedPlayoffTeamIds: [],
    }));
    expect(teamRowHtml(html, "delta")).toContain("Seed 4");
    expect(teamRowHtml(html, "delta")).toContain("Settled by tiebreaker");
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
  const render = (matches: MatchLike[]) => {
    const field = projectPlayoffField(teams, matches);
    return renderToStaticMarkup(createElement(StandingsTable, {
      standings: field.standings, teamName,
      playoffCut: field.bracketSize, playoffSeedByTeam: field.seedByTeam,
      eligibleTeams: field.eligibleTeamIds.length,
      unresolvedPlayoffTeamIds: publicDeadHeatTeamIds(field, matches),
    }));
  };

  it("shows a quiet tied chip and keeps seeds while games remain", () => {
    // d, e and f are level across the cut, but a regular fixture is still live.
    const html = render([
      ...["b", "c", "d", "e", "f"].map((away) => match("a", away, 2, 0)),
      ...["c", "d", "e", "f"].map((away) => match("b", away, 2, 0)),
      ...["d", "e", "f"].map((away) => match("c", away, 2, 0)),
      match("d", "e", 1, 1),
      match("d", "f", 1, 1),
      match("e", "f", 1, 1),
      match("a", "b", 1, 0, "LIVE"),
    ]);
    expect(html).not.toContain("Tiebreaker pending");
    expect(html).not.toMatch(/[Ss]eeding tiebreaker/);
    expect(html).not.toContain("pending a tiebreaker match");
    for (const id of ["d", "e", "f"])
      expect(teamRowHtml(html, id)).toContain(TIED_CHIP);
    expect(teamRowHtml(html, "d")).toContain("current playoff seed 4");
    expect(html).toContain("Playoff cut · 4 places");
  });

  // /teams shows the same chip on its cards. It used its own wording and
  // kept the chip while a tiebreaker was pending, which the table drops.
  it("is the chip /teams shows, under the table's pending-tiebreaker rule", () => {
    const teamsPage = readFileSync("src/app/teams/page.tsx", "utf8");
    expect(teamsPage).toContain('<TiedChip className="font-medium" />');
    expect(teamsPage).toContain("publicDeadHeatTeamIds(field, matches)");
    expect(teamsPage).toContain("!(tiebreakerPending.has(t.id) && !t.withdrawn)");
    expect(teamsPage).not.toContain("game differential");
    expect(renderToStaticMarkup(createElement(TiedChip))).toContain(TIED_CHIP);
  });

  it("shows no tie chips before anyone has played", () => {
    const html = render([match("a", "b", 0, 0, "SCHEDULED")]);
    expect(html).not.toContain("Tiebreaker pending");
    expect(html).not.toContain(TIED_CHIP);
  });
});

describe("one standings table", () => {
  const form = new Map(standings.map((s) => [s.teamId, ["W", "L"] as ("W" | "L")[]]));
  const render = (extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(StandingsTable, {
      standings, teamName: names, playoffCut: 4, playoffSeedByTeam: seeds,
      eligibleTeams: 6, ...extra,
    }));
  const headers = (html: string) =>
    [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
  const bodyCells = (html: string, teamId: string) =>
    teamRowHtml(html, teamId).match(/<t[dh]\b/g)?.length ?? 0;

  it("has no view toggle, no sort buttons and no points bars", () => {
    const html = render({ formByTeam: form, viewerTeamId: "bravo" });
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-sort");
    expect(html).not.toContain("Detailed statistics");
    expect(html).not.toMatch(/style="width:\s*[\d.]+%/);
    expect(html).toContain('aria-label="League standings"');
  });

  it("shows W-D-L, game difference and points, with the one-line rules", () => {
    const html = render();
    expect(headers(html).map((h) => h.replace(/<[^>]+>/g, "|"))).toEqual([
      "|#||Rank|", "Team", "|W-D-L||Series won, drawn and lost|",
      "|Diff||Game difference|", "|Pts||Points|",
    ]);
    const alpha = teamRowHtml(html, "alpha");
    expect(alpha).toContain('aria-label="5 won, 0 drawn, 0 lost"');
    expect(alpha).toContain("+5");
    expect(html).toContain(`<caption class="caption-bottom`);
    expect(html).toContain(STANDINGS_RULES);
    // Diff never hides on a phone: only Last 5 does.
    expect(html.match(/hidden [^"]*sm:table-cell/g) ?? []).toHaveLength(0);
  });

  it("keeps the phone-hidden Last 5 column last so every cell sits on its own <col>", () => {
    const html = render({ formByTeam: form });
    const cols = [...html.matchAll(/<col(?: class="([^"]*)")?\/?>/g)].map((m) => m[1] ?? "");
    expect(cols).toHaveLength(6);
    // Only the last column collapses on phones, and it is the only hidden cell.
    expect(cols.slice(0, -1).every((c) => !c.startsWith("w-0"))).toBe(true);
    expect(cols.at(-1)).toMatch(/^w-0 /);
    const lastHeader = headers(html).at(-1)!;
    expect(lastHeader).toBe("Last 5");
    expect(html).toMatch(/<th scope="col" class="hidden [^"]*sm:table-cell[^"]*">Last 5<\/th>/);
    expect(bodyCells(html, "alpha")).toBe(6);
    const alphaCells = teamRowHtml(html, "alpha").split(/<t[dh]\b/).slice(1);
    expect(alphaCells.at(-1)).toMatch(/^ class="hidden [^"]*sm:table-cell/);
    expect(alphaCells.slice(0, -1).some((cell) => /^ class="hidden/.test(cell))).toBe(false);
  });

  it("tags the viewer's row in a neutral tone, not link blue", () => {
    const html = render({ viewerTeamId: "bravo" });
    const bravo = teamRowHtml(html, "bravo");
    expect(bravo).toContain("bg-info/[0.07]");
    const chip = bravo.match(/<span class="([^"]*)">Your team<\/span>/);
    expect(chip).not.toBeNull();
    expect(chip![1]).not.toMatch(/text-info/);
    expect(teamRowHtml(html, "alpha")).not.toContain("Your team");
  });

  it("states each team's playoff standing under its name", () => {
    const html = render({
      clinch: new Map<string, ClinchStatus>([["alpha", "CLINCHED"], ["foxtrot", "ELIMINATED"]]),
      withdrawnIds: new Set(["echo"]),
    });
    expect(teamRowHtml(html, "alpha")).toContain("Qualified");
    expect(teamRowHtml(html, "bravo")).toContain("Seed 2");
    expect(teamRowHtml(html, "foxtrot")).toContain("Eliminated");
    expect(teamRowHtml(html, "echo")).toContain("Withdrawn");
    expect(teamRowHtml(html, "echo")).toContain("withdrawn and excluded from playoff seeding");
  });
});
