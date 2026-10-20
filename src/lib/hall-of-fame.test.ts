import { describe, it, expect } from "vitest";
import {
  careerGameCounts,
  hallOfFameGameBoards,
  hallOfFameGameFacts,
  rankCounts,
  topPlaces,
} from "./hall-of-fame";

describe("rankCounts", () => {
  it("drops values under the floor and sorts best first", () => {
    expect(
      rankCounts(
        new Map([
          ["a", 3],
          ["b", 1],
          ["c", 5],
          ["d", 0],
        ]),
      ),
    ).toEqual([
      { userId: "c", value: 5 },
      { userId: "a", value: 3 },
      { userId: "b", value: 1 },
    ]);
  });
});

describe("topPlaces", () => {
  const rows = (values: number[]) =>
    values.map((value, i) => ({ userId: `u${i}`, value }));

  it("gives equal values a shared place", () => {
    expect(topPlaces(rows([9, 9, 7, 5, 4, 2])).rows.map((r) => r.place)).toEqual(
      [1, 1, 3, 4, 5],
    );
  });

  it("keeps everyone tied at the cutoff instead of dropping them by id", () => {
    // Two five-player rosters on 4 series wins: all ten share first place.
    const board = topPlaces(rows([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3]));
    expect(board.rows).toHaveLength(10);
    expect(board.rows.every((r) => r.place === 1)).toBe(true);
    expect(board.moreTied).toBe(0);
    const fifthTied = topPlaces(rows([9, 8, 7, 6, 5, 5, 5, 4]));
    expect(fifthTied.rows.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 5, 5]);
  });

  it("caps a huge tie and counts the rest", () => {
    const board = topPlaces(rows(Array(14).fill(1)));
    expect(board.rows).toHaveLength(10);
    expect(board.moreTied).toBe(4);
  });

  it("ties values that read the same at the board's precision", () => {
    const board = topPlaces(rows([66.9, 66.7, 60]), {
      placeKey: (value) => Math.round(value),
    });
    expect(board.rows.map((r) => r.place)).toEqual([1, 1, 3]);
  });

  it("places by rankValue when the shown value isn't the whole record", () => {
    // Pick'em shows correct picks but places the record: 3/4 and 3/5 read
    // "3" yet do not share a place; two 3/4s do.
    const board = topPlaces([
      { userId: "a", value: 3, rankValue: -1 },
      { userId: "b", value: 3, rankValue: -1 },
      { userId: "c", value: 3, rankValue: -3 },
      { userId: "d", value: 1, rankValue: -4 },
    ]);
    expect(board.rows.map((r) => [r.userId, r.value, r.place])).toEqual([
      ["a", 3, 1],
      ["b", 3, 1],
      ["c", 3, 3],
      ["d", 1, 4],
    ]);
  });

  it("handles short and empty boards", () => {
    expect(topPlaces([])).toEqual({ rows: [], moreTied: 0 });
    expect(topPlaces(rows([3, 1])).rows).toHaveLength(2);
  });
});

describe("careerGameCounts", () => {
  it("counts mapped appearances and wins using the player's actual side", () => {
    const counts = careerGameCounts([
      { radiantWin: true, players: [
        { userId: "a", isRadiant: true },
        { userId: "b", isRadiant: false },
        { userId: null, isRadiant: true },
      ] },
      { radiantWin: false, players: [
        { userId: "a", isRadiant: false },
        { userId: "b", isRadiant: true },
      ] },
    ]);
    expect(counts.get("a")).toEqual({ games: 2, wins: 2 });
    expect(counts.get("b")).toEqual({ games: 2, wins: 0 });
    expect(counts.size).toBe(2);
  });
});

describe("hallOfFameGameFacts", () => {
  const box = (prefix: string, kills = 4) => JSON.stringify(Array.from({ length: 10 }, (_, i) => ({
    userId: `${prefix}${i}`, accountId: i + 1, heroId: i + 1, isRadiant: i < 5,
    kills, deaths: 2, assists: 6, gpm: 450, lastHits: 120,
  })));

  it("counts trusted complete games only, and seasons only where the match is known", () => {
    const facts = JSON.parse(JSON.stringify(hallOfFameGameFacts([
      { matchId: "m1", radiantWin: true, players: box("u") },
      { matchId: "m2", radiantWin: false, players: box("u", 9) },
      // A partial box score never enters a board, nor makes its season count.
      { matchId: "m3", radiantWin: true, players: JSON.stringify(JSON.parse(box("x")).slice(0, 9)) },
      // A deleted fixture's game still counts, without a season.
      { matchId: "gone", radiantWin: true, players: box("u") },
    ], new Map([["m1", "s1"], ["m2", "s2"], ["m3", "s3"]]))));
    const boards = hallOfFameGameBoards(facts);
    expect(boards.seasonsWithGames).toBe(2);
    expect(boards.gameCounts.get("u0")).toEqual({ games: 3, wins: 2 });
    expect(boards.gameCounts.get("u7")).toEqual({ games: 3, wins: 1 });
    expect(boards.gameCounts.has("x0")).toBe(false);
    // Impact points over the same games (history-cache-size.test.ts checks the
    // values against pointsByPlayer on a full history).
    expect([...boards.impact.keys()].sort()).toEqual([...boards.gameCounts.keys()].sort());
  });
});
