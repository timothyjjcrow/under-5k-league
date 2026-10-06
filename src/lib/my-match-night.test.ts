import { describe, expect, it } from "vitest";
import { MY_MATCH_NIGHT_HOURS, myMatchNight } from "./my-match-night";

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
