import { describe, expect, it } from "vitest";
import {
  INHOUSE_ELO,
  MONTH_MIN_GAMES,
  PROVISIONAL_GAMES,
  parseEloDeltas,
  rankInhouse,
  summarizeInhouse,
  summarizeInhouseMonth,
  toMonthLobby,
  type FinishedLobby,
  type InhouseRecord,
  type MonthLobby,
} from "./inhouse-stats";

function lobby(
  id: string,
  createdAt: number,
  winnerTeam: number | null,
  players: [string, number | null][], // [userId, team]
): FinishedLobby {
  return {
    id,
    createdAt,
    winnerTeam,
    players: players.map(([userId, team]) => ({
      userId,
      name: userId.toUpperCase(),
      avatar: null,
      team,
    })),
  };
}

describe("summarizeInhouse", () => {
  it("tallies wins/losses and win rate per player", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]),
      lobby("g2", 2, 2, [["a", 1], ["b", 2]]),
      lobby("g3", 3, 1, [["a", 1], ["b", 2]]),
    ]);
    const a = recs.find((r) => r.userId === "a")!;
    const b = recs.find((r) => r.userId === "b")!;
    expect(a).toMatchObject({ games: 3, wins: 2, losses: 1 });
    expect(a.winRate).toBeCloseTo(2 / 3);
    expect(b).toMatchObject({ games: 3, wins: 1, losses: 2 });
  });

  it("ignores lobbies with no reported winner and unassigned players", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, null, [["a", 1], ["b", 2]]), // no winner
      lobby("g2", 2, 1, [["a", 1], ["c", null]]), // c never got a team
    ]);
    expect(recs.find((r) => r.userId === "a")?.games).toBe(1);
    expect(recs.find((r) => r.userId === "b")).toBeUndefined();
    expect(recs.find((r) => r.userId === "c")).toBeUndefined();
  });

  it("tracks streaks chronologically regardless of input order", () => {
    // Fed newest-first; streak must still reflect chronological W,W,L for 'a'.
    const recs = summarizeInhouse([
      lobby("g3", 3, 2, [["a", 1]]), // loss (most recent)
      lobby("g1", 1, 1, [["a", 1]]), // win
      lobby("g2", 2, 1, [["a", 1]]), // win
    ]);
    expect(recs[0].streak).toBe(-1); // last game was a loss
  });

  it("ranks by rating", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]),
      lobby("g2", 2, 1, [["a", 1], ["b", 2]]),
      lobby("g3", 3, 1, [["c", 1], ["b", 2]]),
    ]);
    // a climbed twice, c once (vs an already-sunk b), b only lost.
    expect(recs.map((r) => r.userId)).toEqual(["a", "c", "b"]);
    expect(recs[0].rating).toBeGreaterThan(recs[1].rating);
    expect(recs[2].rating).toBeLessThan(INHOUSE_ELO.START);
  });

  it("moves evenly-rated sides by K/2 per game, same for every member", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [
        ["a", 1],
        ["b", 1],
        ["c", 2],
        ["d", 2],
      ]),
    ]);
    const rating = (id: string) => recs.find((r) => r.userId === id)!.rating;
    expect(rating("a")).toBe(INHOUSE_ELO.START + INHOUSE_ELO.K / 2);
    expect(rating("b")).toBe(INHOUSE_ELO.START + INHOUSE_ELO.K / 2);
    expect(rating("c")).toBe(INHOUSE_ELO.START - INHOUSE_ELO.K / 2);
    expect(rating("d")).toBe(INHOUSE_ELO.START - INHOUSE_ELO.K / 2);
  });

  it("pays an underdog win more than a favorite win", () => {
    // a beats b twice, then b finally wins one.
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]),
      lobby("g2", 2, 1, [["a", 1], ["b", 2]]),
      lobby("g3", 3, 2, [["a", 1], ["b", 2]]),
    ]);
    const b = recs.find((r) => r.userId === "b")!;
    // b's comeback must earn more than the even-match K/2.
    const comebackGain = b.rating - (INHOUSE_ELO.START - INHOUSE_ELO.K); // vs after 2 losses
    expect(comebackGain).toBeGreaterThan(INHOUSE_ELO.K / 2);
  });

  it("records form newest-first, capped at five results", () => {
    // Chronologically for a: W W L W L W L — form keeps the last 5, newest first.
    const outcomes: (1 | 2)[] = [1, 1, 2, 1, 2, 1, 2];
    const recs = summarizeInhouse(
      outcomes.map((winner, i) =>
        lobby(`g${i}`, i + 1, winner, [["a", 1], ["b", 2]]),
      ),
    );
    const a = recs.find((r) => r.userId === "a")!;
    expect(a.form).toEqual(["L", "W", "L", "W", "L"]);
    const b = recs.find((r) => r.userId === "b")!;
    expect(b.form).toEqual(["W", "L", "W", "L", "W"]);
  });

  it("reports the most recent game's rating swing as lastChange", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]),
    ]);
    const a = recs.find((r) => r.userId === "a")!;
    const b = recs.find((r) => r.userId === "b")!;
    // First game between even sides moves both by K/2, in opposite directions.
    expect(a.lastChange).toBe(INHOUSE_ELO.K / 2);
    expect(b.lastChange).toBe(-INHOUSE_ELO.K / 2);

    // After a second game the swing reflects only the latest result.
    const recs2 = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]),
      lobby("g2", 2, 2, [["a", 1], ["b", 2]]),
    ]);
    const a2 = recs2.find((r) => r.userId === "a")!;
    expect(a2.lastChange).toBeGreaterThan(0 - INHOUSE_ELO.K); // sane bound
    expect(a2.lastChange).toBeLessThan(0); // lost the latest game
    expect(a2.lastChange).toBe(-recs2.find((r) => r.userId === "b")!.lastChange);
  });

  it("leaves form empty and lastChange 0 for unrated appearances", () => {
    const recs = summarizeInhouse([lobby("g1", 1, null, [["a", 1], ["b", 2]])]);
    expect(recs.length).toBe(0); // no winner → nobody accrues anything

    const oneSided = summarizeInhouse([lobby("g2", 2, 1, [["c", 1]])]);
    const c = oneSided.find((r) => r.userId === "c")!;
    expect(c.form).toEqual(["W"]); // the win still counts for the record…
    expect(c.lastChange).toBe(0); // …but there was no side to rate against
  });

  it("tracks peak rating and never rates a one-sided lobby", () => {
    const recs = summarizeInhouse([
      lobby("g1", 1, 1, [["a", 1], ["b", 2]]), // a → 1016
      lobby("g2", 2, 2, [["a", 1], ["b", 2]]), // a falls back
      lobby("g3", 3, 1, [["c", 1]]), // no opposing side — unrated
    ]);
    const a = recs.find((r) => r.userId === "a")!;
    expect(a.peak).toBe(INHOUSE_ELO.START + INHOUSE_ELO.K / 2);
    expect(a.rating).toBeLessThan(a.peak);
    const c = recs.find((r) => r.userId === "c")!;
    expect(c.games).toBe(1);
    expect(c.rating).toBe(INHOUSE_ELO.START);
  });
});

describe("rankInhouse", () => {
  const rec = (userId: string, games: number, rating: number): InhouseRecord => ({
    userId,
    name: userId,
    avatar: null,
    games,
    wins: games,
    losses: 0,
    winRate: 1,
    streak: games,
    rating,
    peak: rating,
    form: [],
    lastChange: 0,
  });

  it("keeps provisional accounts off the ranked block, preserving order", () => {
    // Ladder order: hot 1-game account first — but it must not outrank the
    // established grinders.
    const rows = [
      rec("newbie", 1, 1016),
      rec("grinder", PROVISIONAL_GAMES + 10, 1010),
      rec("steady", PROVISIONAL_GAMES, 1005),
      rec("fresh", PROVISIONAL_GAMES - 1, 1002),
    ];
    const { ranked, provisional } = rankInhouse(rows);
    expect(ranked.map((r) => r.userId)).toEqual(["grinder", "steady"]);
    expect(provisional.map((r) => r.userId)).toEqual(["newbie", "fresh"]);
  });

  it("handles an all-provisional (fresh league) ladder", () => {
    const { ranked, provisional } = rankInhouse([rec("a", 1, 1016)]);
    expect(ranked).toEqual([]);
    expect(provisional).toHaveLength(1);
  });
});

describe("parseEloDeltas", () => {
  it("keeps finite numbers and drops everything else", () => {
    expect(
      parseEloDeltas('{"a":16,"b":-16,"c":"12","d":null,"e":1e999}'),
    ).toEqual({ a: 16, b: -16 });
  });

  it("reads unreadable or non-object JSON as an empty map", () => {
    for (const bad of ["not json", "[1,2]", "null", "7", undefined, null]) {
      expect(parseEloDeltas(bad)).toEqual({});
    }
  });
});

describe("summarizeInhouseMonth", () => {
  const START = Date.UTC(2026, 8, 1, 7); // Sept 1, 00:00 Pacific
  const END = Date.UTC(2026, 9, 1, 7); // Oct 1, 00:00 Pacific
  const window = { startMs: START, endMs: END };
  const HOUR = 3_600_000;

  // [userId, team] pairs; deltas default to ±16 per side.
  function month(
    id: string,
    completedAt: number | null,
    winnerTeam: number | null,
    players: [string, number | null][],
    eloDeltas?: Record<string, number>,
  ): MonthLobby {
    return {
      id,
      completedAt,
      winnerTeam,
      eloDeltas:
        eloDeltas ??
        Object.fromEntries(
          players
            .filter(([, team]) => team === 1 || team === 2)
            .map(([userId, team]) => [
              userId,
              team === winnerTeam ? 16 : -16,
            ]),
        ),
      players: players.map(([userId, team]) => ({
        userId,
        name: userId.toUpperCase(),
        avatar: null,
        team,
      })),
    };
  }

  it("counts only games that completed inside the half-open window", () => {
    const board = summarizeInhouseMonth(
      [
        month("before", START - 1, 1, [["a", 1], ["b", 2]]),
        month("first", START, 1, [["a", 1], ["b", 2]]),
        month("mid", START + 5 * HOUR, 2, [["a", 1], ["b", 2]]),
        month("end", END, 1, [["a", 1], ["b", 2]]),
        month("legacy", null, 1, [["a", 1], ["b", 2]]),
      ],
      window,
    );
    expect(board.games).toBe(2);
    const rows = [...board.ranked, ...board.unranked];
    expect(rows.find((r) => r.userId === "a")).toMatchObject({
      games: 2,
      wins: 1,
      losses: 1,
      winRate: 0.5,
      eloNet: 0,
    });
  });

  it("ignores lobbies with no winner and players with no side", () => {
    const board = summarizeInhouseMonth(
      [
        month("g1", START + HOUR, null, [["a", 1], ["b", 2]]),
        month("g2", START + 2 * HOUR, 1, [["a", 1], ["c", null]]),
      ],
      window,
    );
    expect(board.games).toBe(1);
    const rows = [...board.ranked, ...board.unranked];
    expect(rows.map((r) => r.userId)).toEqual(["a"]);
  });

  it("ranks by wins, then win rate, then games, then userId", () => {
    const games: MonthLobby[] = [];
    let t = START;
    const play = (winner: string, loser: string, n: number) => {
      for (let i = 0; i < n; i++) {
        t += HOUR;
        games.push(month(`g${games.length}`, t, 1, [[winner, 1], [loser, 2]]));
      }
    };
    // Pads a player's LOSS column with a throwaway opponent.
    const lose = (who: string, n: number) => play(`pad-${who}`, who, n);
    play("fourwins", "x", 4); // 4-0
    play("threewins", "y", 3); // 3-0 (100%)
    play("slower", "y", 3);
    lose("slower", 1); // 3-1 (75%): same wins, lower rate
    play("zeta", "q", 3);
    lose("zeta", 1); // 3-1, identical to "slower": userId decides
    const order = summarizeInhouseMonth(games, window).ranked.map(
      (r) => r.userId,
    );
    const pos = (id: string) => order.indexOf(id);
    expect(pos("fourwins")).toBeLessThan(pos("threewins"));
    expect(pos("threewins")).toBeLessThan(pos("slower"));
    expect(pos("slower")).toBeLessThan(pos("zeta"));
  });

  it("breaks an equal-wins, equal-rate tie on games played", () => {
    // Both 0 wins at 0%: the player who turned up more ranks first.
    const games: MonthLobby[] = [];
    for (let i = 0; i < 4; i++)
      games.push(month(`m${i}`, START + i * HOUR, 1, [["w", 1], ["many", 2]]));
    for (let i = 0; i < 3; i++)
      games.push(month(`f${i}`, START + (10 + i) * HOUR, 1, [["w", 1], ["few", 2]]));
    const order = summarizeInhouseMonth(games, window).ranked.map(
      (r) => r.userId,
    );
    expect(order).toEqual(["w", "many", "few"]);
  });

  it("puts players under the games floor after the ranked block, unranked", () => {
    const games: MonthLobby[] = [];
    for (let i = 0; i < MONTH_MIN_GAMES; i++)
      games.push(month(`r${i}`, START + i * HOUR, 2, [["grinder", 1], ["regular", 2]]));
    // Two wins from two games: a hot start that must not outrank the floor.
    games.push(month("h1", START + 20 * HOUR, 1, [["hot", 1], ["grinder", 2]]));
    games.push(month("h2", START + 21 * HOUR, 1, [["hot", 1], ["regular", 2]]));
    const board = summarizeInhouseMonth(games, window);
    expect(board.ranked.map((r) => r.userId)).toEqual(["regular", "grinder"]);
    expect(board.unranked.map((r) => r.userId)).toEqual(["hot"]);
    expect(board.unranked[0]).toMatchObject({ games: 2, wins: 2 });
    expect(board.ranked.every((r) => r.games >= MONTH_MIN_GAMES)).toBe(true);
  });

  it("sums the stored swings, and reports null when one is missing", () => {
    const board = summarizeInhouseMonth(
      [
        month("g1", START + HOUR, 1, [["a", 1], ["b", 2]], { a: 18, b: -18 }),
        month("g2", START + 2 * HOUR, 2, [["a", 1], ["b", 2]], { a: -11, b: 11 }),
        // Finalization never stamped this one for b.
        month("g3", START + 3 * HOUR, 1, [["a", 1], ["b", 2]], { a: 15 }),
      ],
      window,
    );
    const rows = [...board.ranked, ...board.unranked];
    expect(rows.find((r) => r.userId === "a")?.eloNet).toBe(22);
    expect(rows.find((r) => r.userId === "b")?.eloNet).toBeNull();
  });

  it("returns an empty board for a month with no games", () => {
    expect(
      summarizeInhouseMonth(
        [month("old", START - HOUR, 1, [["a", 1], ["b", 2]])],
        window,
      ),
    ).toEqual({ ranked: [], unranked: [], games: 0 });
  });

  it("maps a prisma row, parsing the stored delta JSON", () => {
    const completedAt = new Date(START + HOUR);
    expect(
      toMonthLobby({
        id: "l1",
        winnerTeam: 2,
        completedAt,
        eloDeltas: '{"u1":-9,"u2":"x"}',
        players: [
          { userId: "u1", team: 1, user: { name: "One", avatar: null } },
          { userId: "u2", team: 2, user: { name: "Two", avatar: "a.png" } },
        ],
      }),
    ).toEqual({
      id: "l1",
      winnerTeam: 2,
      completedAt,
      eloDeltas: { u1: -9 },
      players: [
        { userId: "u1", name: "One", avatar: null, team: 1 },
        { userId: "u2", name: "Two", avatar: "a.png", team: 2 },
      ],
    });
  });
});
