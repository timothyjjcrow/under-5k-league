import { describe, expect, it } from "vitest";
import { sourceFile, stripLineComments } from "../../test/support/source-files";
import { profileGameFolds, profileGameRows } from "./profile-games";

/** Ten lines: u1 on Radiant (hero 1 unless `mine` says), nine others on
 *  heroes 50 to 58, the first Dire one shaped by `rival`. */
function box(
  mine: Record<string, unknown>,
  rival: Record<string, unknown> = {},
): string {
  return JSON.stringify(
    Array.from({ length: 10 }, (_, i) =>
      i === 0
        ? { heroId: 1, isRadiant: true, userId: "u1", kills: 12, deaths: 1, assists: 9, ...mine }
        : {
            heroId: 49 + i,
            isRadiant: i < 5,
            kills: 1,
            deaths: 5,
            assists: 1,
            ...(i === 5 ? rival : {}),
          },
    ),
  );
}

function game(id: string, players: string, radiantWin = true) {
  return { id, players, radiantWin, durationSecs: 2400, startTime: 1_700_000_000 };
}

describe("profileGameRows", () => {
  it("takes their line from each trusted game, in order, keeping the game", () => {
    const games = [
      game("g2", box({ heroId: 2 }), false),
      game("g1", box({}), true),
    ];
    const rows = profileGameRows("u1", games);
    expect(rows.map((r) => r.game)).toEqual(games);
    expect(rows.map((r) => r.stat.heroId)).toEqual([2, 1]);
    expect(rows.map((r) => r.won)).toEqual([false, true]);
    expect(rows[0].parsed).toHaveLength(10);
  });

  it("names them Match MVP only of the games they were best in", () => {
    const [mvp] = profileGameRows("u1", [game("g1", box({}))]);
    expect(mvp.mvp).toBe(true);
    // Someone else on the winning side had the better game.
    const [beaten] = profileGameRows("u1", [
      game(
        "g2",
        JSON.stringify(
          Array.from({ length: 10 }, (_, i) => ({
            heroId: i + 1,
            isRadiant: i < 5,
            kills: i === 1 ? 30 : 1,
            deaths: 1,
            assists: 1,
            userId: i < 2 ? `u${i + 1}` : null,
          })),
        ),
      ),
    ]);
    expect(beaten.mvp).toBe(false);
  });

  it("leaves out a game they aren't in and a box score that isn't trusted", () => {
    const notIn = game("g1", box({ userId: "u9" }));
    const nine = game("g2", JSON.stringify(JSON.parse(box({})).slice(0, 9)));
    expect(profileGameRows("u1", [notIn, nine])).toEqual([]);
  });
});

describe("profileGameFolds", () => {
  it("folds the trophy case, report card and hero pool from the same rows", () => {
    const graded = { benchmarks: { gold_per_min: { pct: 0.9 } } };
    const rows = profileGameRows("u1", [
      game("g1", box({ heroId: 2, ...graded })),
      game("g2", box({ heroId: 2, ...graded })),
      // Lost, and a Dire player had the game of their life.
      game(
        "g3",
        box({ heroId: 14 }, { userId: "u2", kills: 25, deaths: 0, assists: 10 }),
        false,
      ),
    ]);
    const { badges, reportCard, leagueHeroes } = profileGameFolds("u1", rows);
    expect(badges.find((b) => b.key === "mvp")?.count).toBe(2);
    expect(reportCard.graded).toBe(2);
    expect(leagueHeroes.map((h) => [h.heroId, h.games, h.wins])).toEqual([
      [2, 2, 2],
      [14, 1, 0],
    ]);
  });

  it("is empty for a player with no games", () => {
    const { badges, reportCard, leagueHeroes } = profileGameFolds("u1", []);
    expect(badges).toEqual([]);
    expect(reportCard.graded).toBe(0);
    expect(leagueHeroes).toEqual([]);
  });
});

describe("the profile and its picture", () => {
  it("fold a player's games through these two functions", () => {
    // The season card on the page and the card in its link picture are the
    // same only while both read their games the same way.
    for (const file of [
      "src/app/players/[id]/page.tsx",
      "src/lib/link-preview-metadata.ts",
    ]) {
      const text = stripLineComments(sourceFile(file).text);
      expect(text, file).toMatch(/profileGameRows\(\s*id,/);
      expect(text, file).toMatch(/profileGameFolds\(\s*id,/);
      expect(text, file).not.toMatch(/\b(achievementsFor|careerReportCard|playerHeroPool)\(/);
    }
  });
});
