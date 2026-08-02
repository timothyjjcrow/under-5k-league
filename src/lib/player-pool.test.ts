import { describe, expect, it } from "vitest";
import {
  buildPoolInhouseInfo,
  filterAndSortPlayers,
  sortByInhouseRecord,
  type PoolPlayer,
  type PoolScoutInfo,
} from "./player-pool";

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
    discordName: "",
    discordVerified: false,
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

describe("draft-status filter", () => {
  const base = { mmr: 0, rankTier: null, roles: "" };
  const players = [
    { ...base, name: "Taken", drafted: true },
    { ...base, name: "Free", drafted: false },
    { ...base, name: "NoField" }, // e.g. draft-room rows without the field
  ];

  it("filters to drafted / free while passing rows without the field", async () => {
    const { filterAndSortPlayers } = await import("./player-pool");
    const names = (status: "all" | "drafted" | "free") =>
      filterAndSortPlayers(players, { status, sort: "name" }).map((p) => p.name);
    expect(names("all")).toEqual(["Free", "NoField", "Taken"]);
    expect(names("drafted")).toEqual(["NoField", "Taken"]);
    expect(names("free")).toEqual(["Free", "NoField"]);
  });
});

describe("buildPoolInhouseInfo", () => {
  const rec = (userId: string, rating: number, games = 10) => ({
    userId,
    rating,
    wins: Math.floor(games / 2),
    losses: Math.ceil(games / 2),
    games,
    // Fields the trim must NOT let cross the wire:
    name: `${userId}-name`,
    avatar: null as string | null,
    form: ["W" as const],
    streak: 3,
    peak: rating + 40,
    lastChange: 12,
    winRate: 0.5,
  });
  const ladder = {
    ranked: [rec("a", 1100), rec("b", 1050)],
    provisional: [rec("c", 1200, 2)],
  };

  it("numbers ranked entries by ladder position and nulls provisionals", () => {
    const info = buildPoolInhouseInfo(ladder, ["a", "b", "c"]);
    expect(info.a.rank).toBe(1);
    expect(info.b.rank).toBe(2);
    expect(info.c.rank).toBeNull();
  });

  it("keeps ladder positions for listed users even when others are filtered out", () => {
    // b is not in the pool — a keeps #1, and b simply isn't present.
    const info = buildPoolInhouseInfo(ladder, ["a", "c"]);
    expect(Object.keys(info).sort()).toEqual(["a", "c"]);
    expect(info.a.rank).toBe(1);
  });

  it("trims to exactly the five scalars — no name/avatar/form leak", () => {
    const info = buildPoolInhouseInfo(ladder, ["a"]);
    expect(info.a).toEqual({
      rating: 1100,
      rank: 1,
      wins: 5,
      losses: 5,
      games: 10,
    });
  });
});

describe("sortByInhouseRecord", () => {
  const rows = [
    { userId: "noGames1", name: "A" },
    { userId: "prov", name: "B" },
    { userId: "rankedLow", name: "C" },
    { userId: "noGames2", name: "D" },
    { userId: "rankedHigh", name: "E" },
  ];
  const scout: PoolScoutInfo = {
    prov: {
      inhouse: { rating: 1300, rank: null, wins: 2, losses: 0, games: 2 },
    },
    rankedLow: {
      inhouse: { rating: 990, rank: 2, wins: 4, losses: 6, games: 10 },
    },
    rankedHigh: {
      inhouse: { rating: 1080, rank: 1, wins: 7, losses: 3, games: 10 },
    },
  };

  it("bands ranked > provisional > no games, rating desc within a band", () => {
    // A hot 2-game provisional (1300) must NOT outrank an established player.
    expect(sortByInhouseRecord(rows, scout).map((r) => r.userId)).toEqual([
      "rankedHigh",
      "rankedLow",
      "prov",
      "noGames1",
      "noGames2",
    ]);
  });

  it("orders the ranked band by ladder rank, so a rating tie can't invert #4/#5", () => {
    const tied: PoolScoutInfo = {
      a: { inhouse: { rating: 1026, rank: 5, wins: 5, losses: 3, games: 8 } },
      b: { inhouse: { rating: 1026, rank: 4, wins: 5, losses: 3, games: 8 } },
    };
    // Input arrives with #5 first (MMR order) — the ladder order must win.
    expect(
      sortByInhouseRecord([{ userId: "a" }, { userId: "b" }], tied).map(
        (r) => r.userId,
      ),
    ).toEqual(["b", "a"]);
  });

  it("keeps input order inside the no-games band (input arrives MMR-sorted)", () => {
    const shuffled = [rows[3], rows[0]]; // noGames2 before noGames1
    expect(sortByInhouseRecord(shuffled, scout).map((r) => r.userId)).toEqual([
      "noGames2",
      "noGames1",
    ]);
  });

  it("never mutates the input", () => {
    const before = rows.map((r) => r.userId);
    sortByInhouseRecord(rows, scout);
    expect(rows.map((r) => r.userId)).toEqual(before);
  });

  it("treats an empty scout map as all no-games (stable no-op)", () => {
    expect(sortByInhouseRecord(rows, {}).map((r) => r.userId)).toEqual(
      rows.map((r) => r.userId),
    );
  });
});
