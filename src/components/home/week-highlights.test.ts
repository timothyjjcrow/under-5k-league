import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SeriesUpset } from "@/lib/upsets";
import {
  homePageSource,
  sourceFile,
  stripLineComments,
} from "../../../test/support/source-files";
import {
  UpsetChip,
  WeekHighlights,
  recentResultSpoken,
} from "./week-highlights";

const LONG = "The Couriers of Catastrophe With Very Long Name";
const teamName = new Map([
  ["home", "Roshan's Revenge"],
  ["away", LONG],
]);
// The away side, bottom of the table, beat the home side 2-0.
const pointsUpset: SeriesUpset = {
  matchId: "m1",
  winnerId: "away",
  loserId: "home",
  kind: "points",
  gap: 6,
  winner: 0,
  loser: 6,
};
const awayWin = { id: "m1", homeTeamId: "home", homeScore: 0, awayScore: 2 };

/** The words a reader sees: tags dropped, React's entities decoded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

describe("UpsetChip", () => {
  it("says Upset in amber, with the reason on hover", () => {
    const html = renderToStaticMarkup(
      createElement(UpsetChip, { upset: pointsUpset }),
    );
    expect(text(html)).toBe("Upset");
    expect(html).toContain(
      'title="Upset: from 6 points behind going into the week"',
    );
    expect(html).toMatch(/class="[^"]*\btext-accent\b/);
    expect(html).not.toMatch(/info/);
  });

  it("is hidden from screen readers, which hear it in the row's sentence", () => {
    const html = renderToStaticMarkup(
      createElement(UpsetChip, { upset: pointsUpset }),
    );
    expect(html).toMatch(/^<span aria-hidden="true"/);
  });

  it("renders nothing for a series that was no upset", () => {
    expect(
      renderToStaticMarkup(createElement(UpsetChip, { upset: undefined })),
    ).toBe("");
  });
});

describe("recentResultSpoken", () => {
  it("opens with Upset and keeps the row's ending", () => {
    const spoken = [
      recentResultSpoken("The Couriers", true),
      recentResultSpoken("Dire Straits", false),
      recentResultSpoken(null, false),
    ];
    expect(spoken).toEqual([
      "Upset: The Couriers won the series · Match details",
      "Dire Straits won the series · Match details",
      "Series drawn · Match details",
    ]);
    // e2e-mid/league-clarity.spec.ts pins this ending on Home's rows.
    for (const line of spoken) {
      expect(line).toMatch(/(won the series|Series drawn) · Match details$/);
    }
  });
});

describe("WeekHighlights", () => {
  const render = (props: Partial<Parameters<typeof WeekHighlights>[0]>) =>
    renderToStaticMarkup(
      createElement(WeekHighlights, {
        label: "Week 5",
        match: awayWin,
        upset: pointsUpset,
        teamName,
        ...props,
      }),
    );

  it("names the round, the winner first with its score, and why", () => {
    const html = render({});
    expect(text(html)).toContain("Week 5 upset");
    expect(text(html)).toContain(
      `${LONG} beat Roshan's Revenge 2–0, from 6 points behind going into the week`,
    );
    expect(html).toContain('href="/matches/m1"');
    expect(text(html)).toContain("Match details");
  });

  it("is its own labelled section that wraps a long name", () => {
    const html = render({});
    expect(html).toMatch(/^<section aria-labelledby="home-week-upset"/);
    expect(html).toContain('<h2 id="home-week-upset"');
    expect(html).toMatch(/<p class="min-w-0 \[overflow-wrap:anywhere\]">/);
  });

  it("puts a home winner's score first too, and names playoff seeds", () => {
    const html = render({
      label: "Semifinal",
      match: { id: "m2", homeTeamId: "away", homeScore: 2, awayScore: 1 },
      upset: { ...pointsUpset, kind: "seed", gap: 3, winner: 4, loser: 1 },
    });
    expect(text(html)).toContain("Semifinal upset");
    expect(text(html)).toContain(
      `${LONG} beat Roshan's Revenge 2–1, seed 4 over seed 1`,
    );
  });
});

describe("Home's upset wiring", () => {
  const home = stripLineComments(homePageSource());

  it("judges the matches Home already loaded, adding no query", () => {
    expect(home).toContain("upsetContext(");
    expect(home).toContain("seriesUpset(m, upsets)");
    expect(home).toContain("biggestUpset(matches, upsets)");
    expect(home).toContain("<UpsetChip upset={recentUpsets.get(m.id)} />");
    expect(home).toContain("recentResultSpoken(");
    expect(home).toContain("recentUpsets.has(m.id)");
    const own = sourceFile("src/components/home/week-highlights.tsx").text;
    expect(own).not.toMatch(/prisma|await\s|async\s/);
  });

  it("puts the week's upset beside the honors line, not inside it", () => {
    const at = home.indexOf("<WeekHighlights");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(home.indexOf("<WeeklyHonorsLine"));
    const honors = home.slice(home.indexOf("async function WeeklyHonorsLine"));
    expect(honors.slice(0, honors.indexOf("\n}\n"))).not.toContain(
      "WeekHighlights",
    );
  });
});
