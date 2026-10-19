import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../test/support/source-files";
import {
  MY_MATCH_NIGHT_HOURS,
  matchNightWindowOpen,
  myMatchNight,
} from "./my-match-night";

/** Ten lines: u1 on Radiant for team "home" (shaped by `mine`), nine others;
 *  the first Dire line is a mapped league player shaped by `rival`. */
function box(
  mine: Record<string, unknown> = {},
  rival: Record<string, unknown> = {},
): string {
  return JSON.stringify(
    Array.from({ length: 10 }, (_, i) =>
      i === 0
        ? {
            heroId: 1,
            isRadiant: true,
            userId: "u1",
            teamId: "home",
            kills: 12,
            deaths: 1,
            assists: 9,
            ...mine,
          }
        : i === 5
          ? {
              heroId: 54,
              isRadiant: false,
              userId: "rival",
              teamId: "away",
              kills: 1,
              deaths: 5,
              assists: 1,
              ...rival,
            }
          : { heroId: 49 + i, isRadiant: i < 5, kills: 1, deaths: 5, assists: 1 },
    ),
  );
}

const HOUR = 60 * 60 * 1000;
/** Epoch seconds of a game start; games last 40 minutes. */
const START = 1_800_000_000;

function game(
  id: string,
  matchId: string,
  startOffsetMin: number,
  players = box(),
  radiantWin = true,
) {
  return {
    id,
    matchId,
    players,
    radiantWin,
    startTime: START + startOffsetMin * 60,
    durationSecs: 2400,
    radiantTeamId: "home",
    direTeamId: "away",
  };
}

const endOf = (startOffsetMin: number) => (START + startOffsetMin * 60 + 2400) * 1000;

describe("myMatchNight", () => {
  it("recaps their latest decided series, game by game", () => {
    const games = [
      game("old", "m-old", -7 * 24 * 60),
      game("g1", "m1", 0, box({ heroId: 7 })),
      // The rival had game 2's best line: they are its Match MVP.
      game("g2", "m1", 60, box({ kills: 2, deaths: 9, heroId: 8 }, { kills: 20, deaths: 0 }), false),
    ];
    const recap = myMatchNight({
      userId: "u1",
      games,
      completedMatchIds: new Set(["m-old", "m1"]),
      nowMs: endOf(60) + HOUR,
    });
    expect(recap).toMatchObject({
      matchId: "m1",
      teamId: "home",
      finishedAtMs: endOf(60),
      games: [
        { gameNumber: 1, won: true, heroId: 7, kills: 12, deaths: 1, assists: 9, mvp: true },
        { gameNumber: 2, won: false, heroId: 8, kills: 2, deaths: 9, mvp: false },
      ],
      mvps: 1,
    });
    expect(recap?.games[0].impact).toBeGreaterThan(recap?.games[1].impact ?? 0);
    expect(recap?.totalImpact).toBeCloseTo(
      (recap?.games[0].impact ?? 0) + (recap?.games[1].impact ?? 0),
      5,
    );
  });

  it("waits for the series to be decided, and lapses after the window", () => {
    const games = [game("g1", "m1", 0)];
    const base = { userId: "u1", games };
    // A live series (one game in, not completed) has no recap yet.
    expect(
      myMatchNight({ ...base, completedMatchIds: new Set(), nowMs: endOf(0) + HOUR }),
    ).toBeNull();
    const done = new Set(["m1"]);
    expect(
      myMatchNight({
        ...base,
        completedMatchIds: done,
        nowMs: endOf(0) + MY_MATCH_NIGHT_HOURS * HOUR - 1,
      }),
    ).not.toBeNull();
    expect(
      myMatchNight({
        ...base,
        completedMatchIds: done,
        nowMs: endOf(0) + MY_MATCH_NIGHT_HOURS * HOUR + 1,
      }),
    ).toBeNull();
  });

  it("names a badge only the first time their career earns it", () => {
    // A deathless game now (5+ kills, 0 deaths), never before.
    const first = myMatchNight({
      userId: "u1",
      games: [
        game("before", "m0", -24 * 60, box({ deaths: 3 })),
        game("now", "m1", 0, box({ deaths: 0 })),
      ],
      completedMatchIds: new Set(["m0", "m1"]),
      nowMs: endOf(0) + HOUR,
    });
    expect(first?.newBadges.map((badge) => badge.key)).toContain("deathless");
    // Earned before: not new again.
    const again = myMatchNight({
      userId: "u1",
      games: [
        game("before", "m0", -24 * 60, box({ deaths: 0 })),
        game("now", "m1", 0, box({ deaths: 0 })),
      ],
      completedMatchIds: new Set(["m0", "m1"]),
      nowMs: endOf(0) + HOUR,
    });
    expect(again?.newBadges.map((badge) => badge.key)).not.toContain("deathless");
  });

  it("has nothing for a player who wasn't in a decided game", () => {
    expect(
      myMatchNight({
        userId: "someone-else",
        games: [game("g1", "m1", 0)],
        completedMatchIds: new Set(["m1"]),
        nowMs: endOf(0) + HOUR,
      }),
    ).toBeNull();
  });
});

describe("matchNightWindowOpen", () => {
  const WINDOW = MY_MATCH_NIGHT_HOURS * HOUR;

  it("opens while a decided game ended inside the window, by start plus duration", () => {
    const ended = [game("g1", "m1", 0)];
    expect(matchNightWindowOpen(ended, endOf(0))).toBe(true);
    expect(matchNightWindowOpen(ended, endOf(0) + WINDOW)).toBe(true);
    expect(matchNightWindowOpen(ended, endOf(0) + WINDOW + 1)).toBe(false);
    // A game ending in the future (a skewed clock) shows nothing yet.
    expect(matchNightWindowOpen(ended, endOf(0) - 1)).toBe(false);
    // It started before the window but ended inside it: still open.
    const long = [{ ...game("g2", "m2", 0), durationSecs: 3 * 3600 }];
    expect(matchNightWindowOpen(long, (START + 3 * 3600) * 1000 + WINDOW - 60_000)).toBe(true);
    expect(matchNightWindowOpen([], endOf(0))).toBe(false);
  });

  it("is never closed when the card would show a recap", () => {
    // Seeded scenarios: series spread over three weeks, some decided, the
    // viewer in some games, and every hour of a week as "now".
    let state = 11;
    const rand = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    let shown = 0;
    for (let scenario = 0; scenario < 60; scenario++) {
      const games = Array.from({ length: 12 }, (_, i) => {
        const startMin = Math.floor(rand() * 21 * 24 * 60) - 14 * 24 * 60;
        const mine = rand() < 0.5 ? box() : box({ userId: "someone-else" });
        return { ...game(`g${i}`, `m${i % 6}`, startMin, mine), durationSecs: 600 + Math.floor(rand() * 7200) };
      });
      const completed = new Set([...new Set(games.map((g) => g.matchId))].filter(() => rand() < 0.7));
      const decided = games.filter((g) => completed.has(g.matchId));
      for (let hour = 0; hour < 7 * 24; hour++) {
        const nowMs = START * 1000 + hour * HOUR;
        const recap = myMatchNight({ userId: "u1", games, completedMatchIds: completed, nowMs });
        if (!recap) continue;
        shown++;
        expect(matchNightWindowOpen(decided, nowMs)).toBe(true);
      }
    }
    expect(shown).toBeGreaterThan(100);
  });
});

describe("Home's match-night card", () => {
  it("checks the window from game times before it reads the viewer's career", () => {
    // Home's sections, wherever the card lives among them: each one that
    // reads the viewer's games (a scan of every stored game) gates it first.
    const readers = sourceFiles(["src/app/page.tsx", "src/components/home/*.tsx"], 10)
      .filter((file) => file.text.includes("getPlayerGameFacts("));
    expect(readers.map((file) => file.path)).toEqual(["src/components/home/my-match-night.tsx"]);
    for (const { text } of readers) {
      const gate = text.indexOf("if (!matchNightWindowOpen(ended, nowMs)) return null;");
      expect(gate).toBeGreaterThan(-1);
      expect(text.indexOf("await getPlayerGameFacts(userId)")).toBeGreaterThan(gate);
      expect(text.match(/getPlayerGameFacts\(/g)).toHaveLength(1);
      // The gate reads two integers by the indexed match id, never a box score.
      expect(text).toMatch(
        /const ended = await prisma\.game\.findMany\(\{\s*where: \{ matchId: \{ in: \[\.\.\.completed\.keys\(\)\] \} \},\s*select: \{ startTime: true, durationSecs: true \},\s*\}\);/,
      );
    }
  });
});
