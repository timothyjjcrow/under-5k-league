import { describe, expect, it } from "vitest";
import { nameMatchesQuery } from "./name-search";

describe("nameMatchesQuery", () => {
  it("matches every typed word anywhere in the name, in any case", () => {
    expect(nameMatchesQuery("Player 37", "player")).toBe(true);
    expect(nameMatchesQuery("Player 37", "37")).toBe(true);
    expect(nameMatchesQuery("Captain Kunkka", "kun cap")).toBe(true);
    expect(nameMatchesQuery("Captain Kunkka", "kun tide")).toBe(false);
  });

  it("matches everyone on an empty or blank query", () => {
    expect(nameMatchesQuery("Dendi", "")).toBe(true);
    expect(nameMatchesQuery("Dendi", "   ")).toBe(true);
    expect(nameMatchesQuery(null, "")).toBe(true);
  });

  it("never matches a missing name to a real query", () => {
    expect(nameMatchesQuery(undefined, "d")).toBe(false);
  });
});
