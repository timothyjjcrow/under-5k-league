import { describe, it, expect } from "vitest";
import { careerGameCounts, rankCounts, topPlaces } from "./hall-of-fame";

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
