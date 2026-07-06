import { describe, it, expect } from "vitest";
import {
  teamNeed,
  maxBid,
  canBid,
  isDraftComplete,
  nextNominatorIndex,
  type DraftTeam,
} from "./draft";

const team = (rosterCount: number, budget = 100): DraftTeam => ({
  id: "t",
  budget,
  rosterCount,
});

describe("teamNeed", () => {
  it("counts remaining slots and never goes negative", () => {
    expect(teamNeed(5, 1)).toBe(4);
    expect(teamNeed(5, 5)).toBe(0);
    expect(teamNeed(5, 6)).toBe(0);
  });
});

describe("maxBid", () => {
  it("reserves the min bid for every other empty slot", () => {
    // roster 1 of 5 -> needs 4 -> reserve 3 -> 100-3 = 97
    expect(maxBid(team(1), 5)).toBe(97);
    // roster 4 of 5 -> needs 1 -> reserve 0 -> full budget
    expect(maxBid(team(4, 50), 5)).toBe(50);
  });
  it("is 0 for a full team", () => {
    expect(maxBid(team(5), 5)).toBe(0);
  });
  it("never returns negative", () => {
    expect(maxBid(team(1, 2), 5)).toBe(0);
  });
});

describe("canBid", () => {
  it("accepts a legal raise", () => {
    expect(canBid(team(1), 5, 10, 5)).toBe(true);
  });
  it("rejects a bid at or below the current high bid", () => {
    expect(canBid(team(1), 5, 5, 5)).toBe(false);
    expect(canBid(team(1), 5, 4, 5)).toBe(false);
  });
  it("rejects below the minimum bid", () => {
    expect(canBid(team(1), 5, 0, -1)).toBe(false);
  });
  it("rejects above the max affordable bid", () => {
    expect(canBid(team(1), 5, 98, 5)).toBe(false); // max is 97
    expect(canBid(team(1), 5, 97, 5)).toBe(true);
  });
  it("rejects when the team is already full", () => {
    expect(canBid(team(5), 5, 10, 5)).toBe(false);
  });
  it("rejects non-integer amounts", () => {
    expect(canBid(team(1), 5, 10.5, 5)).toBe(false);
  });
});

describe("isDraftComplete", () => {
  it("is complete when every team is full", () => {
    expect(isDraftComplete([team(5), team(5)], 5, 10)).toBe(true);
  });
  it("is complete when no players remain", () => {
    expect(isDraftComplete([team(1)], 5, 0)).toBe(true);
  });
  it("is not complete while a team needs players and some remain", () => {
    expect(isDraftComplete([team(1), team(5)], 5, 3)).toBe(false);
  });
});

describe("nextNominatorIndex", () => {
  const teams = [team(1), team(5), team(1)]; // middle team is full

  it("skips full teams", () => {
    expect(nextNominatorIndex(teams, 5, 0)).toBe(2);
  });
  it("wraps around the order", () => {
    expect(nextNominatorIndex(teams, 5, 2)).toBe(0);
  });
  it("returns -1 when all teams are full", () => {
    expect(nextNominatorIndex([team(5)], 5, 0)).toBe(-1);
  });
});
