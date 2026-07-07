import { describe, expect, it } from "vitest";
import { filterAndSortPlayers, type PoolPlayer } from "./player-pool";

function mk(p: Partial<PoolPlayer> & { name: string }): PoolPlayer {
  return {
    userId: p.name,
    avatar: null,
    mmr: 0,
    rankTier: null,
    roles: "",
    favoriteHeroes: "",
    captainNote: "",
    wantsCaptain: false,
    drafted: false,
    accountId: null,
    ...p,
  };
}

const players = [
  mk({ name: "Alice", mmr: 3000, rankTier: 50, roles: "1,2", wantsCaptain: true }),
  mk({ name: "Bob", mmr: 4500, rankTier: 70, roles: "3" }),
  mk({ name: "Carol", mmr: 2000, rankTier: null, roles: "4,5", wantsCaptain: true }),
];

describe("filterAndSortPlayers", () => {
  it("sorts by MMR desc by default", () => {
    expect(filterAndSortPlayers(players, {}).map((p) => p.name)).toEqual([
      "Bob",
      "Alice",
      "Carol",
    ]);
  });
  it("sorts by name", () => {
    expect(
      filterAndSortPlayers(players, { sort: "name" }).map((p) => p.name),
    ).toEqual(["Alice", "Bob", "Carol"]);
  });
  it("sorts by rank desc with unknown medals last", () => {
    expect(
      filterAndSortPlayers(players, { sort: "rank" }).map((p) => p.name),
    ).toEqual(["Bob", "Alice", "Carol"]);
  });
  it("searches by name, case-insensitively", () => {
    expect(
      filterAndSortPlayers(players, { query: "CAR" }).map((p) => p.name),
    ).toEqual(["Carol"]);
  });
  it("filters by role/position", () => {
    expect(
      filterAndSortPlayers(players, { role: "1" }).map((p) => p.name),
    ).toEqual(["Alice"]);
    expect(
      filterAndSortPlayers(players, { role: "5" }).map((p) => p.name),
    ).toEqual(["Carol"]);
  });
  it("filters to captain hopefuls only", () => {
    expect(
      filterAndSortPlayers(players, {
        sort: "name",
        captainOnly: true,
      }).map((p) => p.name),
    ).toEqual(["Alice", "Carol"]);
  });
  it("combines filters", () => {
    expect(
      filterAndSortPlayers(players, { role: "2", captainOnly: true }).map(
        (p) => p.name,
      ),
    ).toEqual(["Alice"]);
  });
  it("does not mutate the input array", () => {
    const before = players.map((p) => p.name);
    filterAndSortPlayers(players, { sort: "name" });
    expect(players.map((p) => p.name)).toEqual(before);
  });
});
