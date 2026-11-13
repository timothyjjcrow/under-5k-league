import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(path.join(__dirname, "../..", file), "utf8");
const PAGE = read("app/leaders/page.tsx");
const TABLE = read("lib/leader-table.ts");
const EXPLORER = read("components/leaders-explorer.tsx");

/** The source of one stat's cell in buildLeaderTable. */
function cell(key: string): string {
  const start = TABLE.indexOf(`put("${key}", {`);
  expect(start, key).toBeGreaterThan(-1);
  return TABLE.slice(start, TABLE.indexOf("\n    });", start));
}

describe("/leaders per-game rankings", () => {
  // The league's rule: kills and assists per game need 3 games. They once
  // used the adaptive floor, so one-game players ranked early in a season.
  it("rank kills and assists per game only after 3 games, however early in the season", () => {
    // Defined once, and shared with the season recap's Kill Leader and
    // Playmaker awards (awards.ts).
    expect(read("lib/player-stats.ts")).toContain(
      "export const PER_GAME_MIN_GAMES = 3;",
    );
    for (const key of ["killsPerGame", "assistsPerGame"]) {
      expect(cell(key), key).toContain(
        "ranked: summary.games >= PER_GAME_MIN_GAMES,",
      );
    }
    // The following floor is for the other averages only.
    expect(cell("kda")).toContain("ranked: summary.games >= rateFloor,");
  });

  it("labels the Most games hint as wins and losses, not a bare score", () => {
    expect(cell("games")).not.toMatch(/`\$\{summary\.wins\}–\$\{summary\.losses\}`/);
    expect(cell("games")).toContain('plural(summary.wins, "win")');
  });

  // Tim's decision (2026-09-27): every ranking is what the PLAYER did. Wins
  // and win rate ranked a team's record.
  it("has no wins or win-rate ranking", () => {
    const keys = /export const LEADER_STAT_KEYS = \[([\s\S]*?)\] as const;/.exec(
      TABLE,
    )?.[1];
    expect(keys).toBeDefined();
    expect(keys).toContain('"games"');
    expect(keys).not.toMatch(/"wins"|"winRate"/);
  });
});

describe("/leaders layout", () => {
  it("opens on Weekly honors, then one ranking of every player", () => {
    const honors = PAGE.lastIndexOf("{honorsCard}");
    const rankings = PAGE.lastIndexOf("<LeadersExplorer");
    expect(honors).toBeGreaterThan(-1);
    expect(rankings).toBeGreaterThan(honors);
    // One explorer, not a board per stat.
    expect(PAGE.split("<LeadersExplorer").length - 1).toBe(1);
    expect(PAGE).not.toContain("<LeaderBoard");
    // The page hands the explorer what leader-table.ts worked out.
    expect(PAGE).toContain("const table = buildLeaderTable(games);");
    expect(PAGE).toContain("stats={table.stats}");
  });

  it("keeps both weekly honors on one baseline when they share a line", () => {
    const row = PAGE.slice(PAGE.indexOf("<span aria-hidden>🛡️</span>") - 200, PAGE.indexOf("<span aria-hidden>🛡️</span>"));
    expect(row).not.toMatch(/className="mt-[\d.]+ /);
  });

  it("folds the older honor weeks so the rankings stay within reach", () => {
    expect(PAGE).toContain("const HONOR_WEEKS_SHOWN = 3;");
    expect(PAGE).toContain("honorsByWeek.slice(0, HONOR_WEEKS_SHOWN)");
    expect(PAGE).toContain("{earlierHonors.map(honorWeek)}");
  });

  it("ranks the list and every player's card through one function", () => {
    // The order on screen and "#3 of 60" in a card can't disagree.
    expect(EXPLORER).toContain(
      "rankByCell(players, (player) => player.cells[index])",
    );
    expect(EXPLORER.split("rankByCell(").length - 1).toBe(1);
  });

  it("gives a row every stat column only from xl, and one stat below it", () => {
    const grid = EXPLORER.match(/const ROW_GRID =\s*"([^"]*)"/)?.[1] ?? "";
    // Below xl: rank, avatar, name, the ranked stat, the card toggle. The
    // name track is minmax(0, 1fr), so a long name can't widen the page.
    expect(grid).toContain(
      "grid-cols-[1.5rem_1.75rem_minmax(0,1fr)_auto_2.75rem]",
    );
    expect(grid).toContain("repeat(var(--stat-cols),minmax(0,4.75rem))");
    expect(EXPLORER).toContain('active ? "pl-1 xl:pl-0" : "hidden xl:block"');
    expect(EXPLORER).toContain('"--stat-cols": stats.length');
  });
});
