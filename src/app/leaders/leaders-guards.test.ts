import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PAGE = readFileSync(path.join(__dirname, "page.tsx"), "utf8");

/** The source of one board's entry in the page's `boards` list. */
function board(key: string): string {
  const start = PAGE.indexOf(`key: "${key}",`);
  expect(start, key).toBeGreaterThan(-1);
  // Each entry closes with a line of its own: "    },".
  return PAGE.slice(start, PAGE.indexOf("\n    },", start));
}

describe("/leaders per-game boards", () => {
  // The league's rule: kills and assists per game need 3 games. They once
  // used the adaptive floor, so one-game players ranked early in a season.
  it("rank kills and assists per game only after 3 games, however early in the season", () => {
    // Defined once beside topBy, and shared with the season recap's Kill
    // Leader and Playmaker awards (awards.ts).
    expect(readFileSync(path.join(__dirname, "../../lib/player-stats.ts"), "utf8")).toContain(
      "export const PER_GAME_MIN_GAMES = 3;",
    );
    expect(PAGE).toMatch(/\bPER_GAME_MIN_GAMES,\n\} from "@\/lib\/player-stats";/);
    for (const key of ["killsPerGame", "assistsPerGame"]) {
      expect(board(key), key).toContain("minGames: PER_GAME_MIN_GAMES,");
    }
  });

  it("labels the Most games hint as wins and losses, not a bare score", () => {
    expect(board("games")).not.toMatch(/`\$\{r\.summary\.wins\}–\$\{r\.summary\.losses\}`/);
    expect(board("games")).toContain("win${r.summary.wins === 1");
  });
});

describe("/leaders section layout", () => {
  const sections = PAGE.split("<section ").slice(1);

  it("gives every board section the same numbered heading and grid", () => {
    // Two categories plus the report card; the report card used to have no
    // index and a narrower max-w-3xl column, so the page ended misaligned.
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      expect(section).toContain("<CategoryHeading category=");
      expect(section).toContain("className={BOARD_GRID}");
      expect(section).not.toContain("max-w-3xl");
    }
    expect(PAGE).toMatch(/id: "report-card",\s*index: "03",/);
  });

  it("lets a lone last board take the whole row", () => {
    const grid = PAGE.match(/const BOARD_GRID =\s*"([^"]*)"/)?.[1] ?? "";
    expect(grid).toContain("lg:grid-cols-2 lg:[&>:last-child:nth-child(odd)]:col-span-2");
    // Three to a row from xl: six tracks, two per board, and the last row
    // (one board or two) stretches to fill it.
    expect(grid).toContain("xl:grid-cols-6 xl:[&>*]:col-span-2");
    expect(grid).toContain("xl:[&>:nth-child(3n+1):last-child]:col-span-6");
    expect(grid).toContain("xl:[&>:nth-child(3n+1):nth-last-child(2)]:col-span-3");
    expect(grid).toContain("xl:[&>:nth-child(3n+2):last-child]:col-span-3");
  });

  it("keeps both weekly honors on one baseline when they share a line", () => {
    const row = PAGE.slice(PAGE.indexOf("<span aria-hidden>🛡️</span>") - 200, PAGE.indexOf("<span aria-hidden>🛡️</span>"));
    expect(row).not.toMatch(/className="mt-[\d.]+ /);
  });
});
