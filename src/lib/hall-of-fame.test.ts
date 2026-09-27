import { describe, it, expect } from "vitest";
import { careerGameCounts, topCounts } from "./hall-of-fame";

describe("topCounts", () => {
  it("ranks, floors, and limits", () => {
    const rows = topCounts(
      new Map([
        ["a", 3],
        ["b", 1],
        ["c", 5],
        ["d", 0],
      ]),
      2,
    );
    expect(rows).toEqual([
      { userId: "c", value: 5 },
      { userId: "a", value: 3 },
    ]);
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
