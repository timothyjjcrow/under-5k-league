import { describe, it, expect } from "vitest";
import { careerCounts, topCounts } from "./hall-of-fame";

describe("careerCounts", () => {
  const memberships = [
    { userId: "u1", teamId: "s1-A" },
    { userId: "u2", teamId: "s1-A" },
    { userId: "u3", teamId: "s1-B" },
    // season 2: u1 changes teams, u3 stays on a B-team
    { userId: "u1", teamId: "s2-C" },
    { userId: "u3", teamId: "s2-B" },
  ];

  it("credits every member of each counted team, across seasons", () => {
    // Champions: s1-A (u1, u2) and s2-C (u1) → u1 has 2 titles.
    const titles = careerCounts(memberships, ["s1-A", "s2-C"]);
    expect(titles.get("u1")).toBe(2);
    expect(titles.get("u2")).toBe(1);
    expect(titles.has("u3")).toBe(false);
  });

  it("counts repeated wins and skips null winners (draws)", () => {
    const wins = careerCounts(memberships, ["s1-B", "s1-B", null, undefined, "s2-B"]);
    expect(wins.get("u3")).toBe(3);
    expect(wins.has("u1")).toBe(false);
  });
});

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
