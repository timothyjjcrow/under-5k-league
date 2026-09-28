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
    expect(PAGE).toContain("const PER_GAME_MIN_GAMES = 3;");
    for (const key of ["killsPerGame", "assistsPerGame"]) {
      expect(board(key), key).toContain("minGames: PER_GAME_MIN_GAMES,");
    }
  });

  it("labels the Most games hint as wins and losses, not a bare score", () => {
    expect(board("games")).not.toMatch(/`\$\{r\.summary\.wins\}–\$\{r\.summary\.losses\}`/);
    expect(board("games")).toContain("win${r.summary.wins === 1");
  });
});
