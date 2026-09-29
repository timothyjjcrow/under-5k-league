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
      '<span class="sr-only sm:not-sr-only sm:min-w-0 sm:whitespace-normal sm:text-xs sm:[overflow-wrap:anywhere]">Roshan Pit</span>',
    );
    expect(html).toContain('aria-label="No meeting scheduled"');
  });
});
