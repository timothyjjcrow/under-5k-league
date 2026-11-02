import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SeasonGrid } from "./season-grid";
import type { CrossMatch } from "@/lib/cross-table";

const teamName = new Map([
  ["a", "Radiant Raiders"],
  ["b", "Dire Wolves"],
  ["c", "Roshan Pit"],
]);
const teamLogoUrl = new Map<string, string | null>();
const match = (over: Partial<CrossMatch>): CrossMatch => ({
  id: "m",
  week: 1,
  phase: "REGULAR",
  status: "COMPLETED",
  homeTeamId: "a",
  awayTeamId: "b",
  homeScore: 2,
  awayScore: 0,
  winnerTeamId: "a",
  ...over,
});

function render(matches: CrossMatch[]) {
  return renderToStaticMarkup(
    createElement(SeasonGrid, {
      teamIds: ["a", "b", "c"],
      teamName,
      teamLogoUrl,
      matches,
    }),
  );
}

describe("SeasonGrid", () => {
  it("names the table and scrolls it inside a clipped box", () => {
    const html = render([match({})]);
    expect(html).toContain("<caption class=\"sr-only\">Head-to-head results.");
    expect(html).toMatch(/^<div class="min-w-0 overflow-hidden[^"]*"><div class="overflow-x-auto">/);
  });

  it("shows a live series' running score from each row's side", () => {
    const html = render([
      match({ id: "live", status: "LIVE", homeScore: 1, awayScore: 0, winnerTeamId: null }),
    ]);
    expect(html).toContain(
      'aria-label="Radiant Raiders 1–0 in week 1, series in progress"',
    );
    expect(html).toContain(
      'aria-label="Dire Wolves 0–1 in week 1, series in progress"',
    );
    expect(html).toMatch(/>Live<\/span><span>1–0<\/span>/);
  });

  it("marks a ruled result as a forfeit", () => {
    const html = render([
      match({ id: "ff", forfeit: true, homeScore: 0, awayScore: 2, winnerTeamId: "b" }),
    ]);
    expect(html).toContain("L · F");
    expect(html).toContain('aria-label="Dire Wolves won 2–0 by forfeit in week 1"');
  });

  it("keeps row names for screen readers but shows only rank and crest on phones", () => {
    const html = render([match({})]);
    expect(html).toContain(
      '<span class="sr-only sm:not-sr-only sm:block sm:max-w-[8.5rem] sm:truncate sm:text-xs">Roshan Pit</span>',
    );
    expect(html).toContain('aria-label="No meeting scheduled"');
  });

  it("names each column's team for screen readers and on hover, showing crest and rank", () => {
    const html = render([match({})]);
    expect(html).toMatch(
      /<a title="Dire Wolves"[^>]*href="\/teams\/b">.*?<span class="sr-only">Dire Wolves<\/span><span aria-hidden="true"[^>]*>#2<\/span><\/a><\/th>/,
    );
  });

  it("marks a series still to play by its week, never a W that reads as a win", () => {
    const html = render([
      match({ id: "next", week: 5, status: "SCHEDULED", homeScore: 0, awayScore: 0, winnerTeamId: null }),
    ]);
    expect(html).toContain('aria-label="Week 5, not played yet"');
    expect(html).toContain("<span>wk 5</span>");
    expect(html).not.toMatch(/>W5</);
  });

  it("drops the W/L letter on phones but keeps a forfeit's F", () => {
    const html = render([
      match({ id: "ff", forfeit: true, homeScore: 0, awayScore: 2, winnerTeamId: "b" }),
    ]);
    expect(html).toContain('<span class="hidden font-semibold uppercase sm:inline">L · F</span>');
    expect(html).toContain('<span class="font-semibold sm:hidden">F</span><span>0–2</span>');
  });
});
