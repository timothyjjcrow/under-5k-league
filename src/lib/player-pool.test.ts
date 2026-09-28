import { describe, expect, it } from "vitest";
import {
  buildPoolInhouseInfo,
  buildPoolLastSeasons,
  filterAndSortPlayers,
  filterPoolRows,
  lastSeasonTitle,
  lastSeasonToken,
  inhouseToken,
  pubHeroTitle,
  pubTitle,
  pubToken,
  sortByInhouseRecord,
  type PoolLastSeason,
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

describe("filterPoolRows (standins share the /players table)", () => {
  const rows = [
    mk({ name: "Drafted", mmr: 4000, drafted: true, roles: "1" }),
    mk({ name: "Free", mmr: 3000, roles: "2" }),
    mk({ name: "Sub", mmr: 3500, roles: "1,5" }),
    mk({ name: "Spare", mmr: 1000, roles: "4" }),
  ];
  const standins = new Set(["Sub", "Spare"]);
  const names = (filter: Parameters<typeof filterPoolRows>[1]) =>
    filterPoolRows(rows, filter, standins).map((p) => p.name);

  it("lists everyone by default, standins interleaved by the chosen sort", () => {
    expect(names({})).toEqual(["Drafted", "Sub", "Free", "Spare"]);
  });
  it("search, role and sort reach standins too", () => {
    expect(names({ query: "sub" })).toEqual(["Sub"]);
    expect(names({ role: "1" })).toEqual(["Drafted", "Sub"]);
    expect(names({ sort: "name" })).toEqual(["Drafted", "Free", "Spare", "Sub"]);
  });
  it("the Standins chip narrows to standins and keeps the other filters", () => {
    expect(names({ status: "standin" })).toEqual(["Sub", "Spare"]);
    expect(names({ status: "standin", role: "4" })).toEqual(["Spare"]);
  });
  it("never counts a standin as a free agent or as drafted", () => {
    expect(names({ status: "free" })).toEqual(["Free"]);
    expect(names({ status: "drafted" })).toEqual(["Drafted"]);
  });
  it("leaves the shared lib standin-blind (the draft room's filter)", () => {
    // Without the type narrowing a standin reads as an undrafted player.
    expect(
      filterAndSortPlayers(rows, { status: "free" }).map((p) => p.name),
    ).toEqual(["Sub", "Free", "Spare"]);
  });
  it("does not mutate the input", () => {
    const before = rows.map((p) => p.name);
    names({ status: "standin", sort: "name" });
    expect(rows.map((p) => p.name)).toEqual(before);
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

describe("scouting token copy", () => {
  const now = Date.UTC(2026, 8, 3);
  const pub = {
    recentWins: 54,
    recentLosses: 46,
    lastPlayedAt: null,
    checkedAt: null,
    topHeroes: [{ heroId: 14, games: 220, wins: 121 }],
  };

  it("pubToken names the recent window — a win rate must never read as lifetime", () => {
    expect(pubToken(pub, now)).toBe("Pubs 54% in last 100");
    // A 37-game account states its real window, not "last 100".
    expect(
      pubToken({ ...pub, recentWins: 20, recentLosses: 17 }, now),
    ).toBe("Pubs 54% in last 37");
  });

  it("pubToken says when the snapshot was taken", () => {
    expect(pubToken({ ...pub, checkedAt: now - 3 * 86_400_000 }, now)).toBe(
      "Pubs 54% in last 100 · checked 3d ago",
    );
    expect(pubToken({ ...pub, checkedAt: now - 130 * 86_400_000 }, now)).toBe(
      "Pubs 54% in last 100 · checked 4mo ago",
    );
  });

  it("pubTitle gives last played only while the snapshot is fresh", () => {
    const day = 86_400_000;
    const fresh = {
      ...pub,
      checkedAt: now - 2 * day,
      lastPlayedAt: Math.floor((now - 9 * day) / 1000),
    };
    expect(pubTitle(fresh, now)).toBe(
      "Last 100 pub games: 54W–46L · last played 7d ago · checked 2d ago",
    );
    expect(pubTitle({ ...fresh, checkedAt: now - 90 * day }, now)).toBe(
      "Last 100 pub games: 54W–46L · checked 3mo ago",
    );
    expect(pubTitle(pub, now)).toBe(
      "Last 100 pub games: 54W–46L · checked at an unknown time",
    );
  });

  it("pubToken and pubTitle carry no lifetime games figure", () => {
    expect(pubToken(pub, now)).not.toMatch(/games/i);
    expect(pubTitle(pub, Date.UTC(2026, 7, 1))).not.toMatch(/lifetime/i);
  });

  it("inhouseToken shows the rating only for RANKED players", () => {
    expect(
      inhouseToken({ rating: 1042, rank: 3, wins: 7, losses: 3, games: 10 }),
    ).toBe("Inhouse 1042 · 7–3");
    // Provisional: no rating — a 2-game Elo is noise (the rankInhouse rule).
    expect(
      inhouseToken({ rating: 1042, rank: null, wins: 2, losses: 0, games: 2 }),
    ).toBe("Inhouse 2–0");
  });

  it("pubHeroTitle names the hero with its record, falling back on unknown ids", () => {
    expect(pubHeroTitle({ heroId: 14, games: 220, wins: 121 })).toBe(
      "Pudge — 220 pub games, 55% won",
    );
    expect(pubHeroTitle({ heroId: 99999, games: 1, wins: 1 })).toBe(
      "Hero #99999 — 1 pub game, 100% won",
    );
  });
});

describe("buildPoolLastSeasons (returning players' last league season)", () => {
  const seasons = [
    { id: "s3", name: "Season 3" },
    { id: "s2", name: "Season 2" },
  ];
  const teamNames = new Map([
    ["t-dire", "Dire Straits"],
    ["t-rad", "Radiant Rascals"],
    ["t-old", "Old Guard"],
  ]);
  const app = (
    userId: string,
    teamId: string,
    seasonId: string,
    games: number,
    w = 0,
    l = 0,
    d = 0,
  ) => ({
    userId,
    teamId,
    seasonId,
    games,
    seriesWins: w,
    seriesLosses: l,
    seriesDraws: d,
  });
  const member = (
    userId: string,
    teamId: string,
    seasonId: string,
    price: number,
    isCaptain = false,
  ) => ({ userId, teamId, seasonId, price, isCaptain });
  const build = (
    over: Partial<Parameters<typeof buildPoolLastSeasons>[0]> = {},
  ) =>
    buildPoolLastSeasons({
      userIds: ["u1", "u2", "u3", "u4", "new"],
      seasons,
      appearances: [],
      memberships: [],
      teamNames,
      champions: new Map(),
      ...over,
    });

  it("renders nothing for first-timers or a league with no earlier season", () => {
    expect(build()).toEqual({});
    expect(
      build({
        seasons: [],
        appearances: [app("u1", "t-dire", "s3", 5, 3, 1)],
        memberships: [member("u1", "t-dire", "s3", 12)],
      }),
    ).toEqual({});
  });

  it("takes the most recent earlier season with the roster team's record and price", () => {
    const out = build({
      appearances: [
        app("u1", "t-old", "s2", 8, 5, 1),
        app("u1", "t-dire", "s3", 7, 4, 3),
      ],
      memberships: [
        member("u1", "t-old", "s2", 20),
        member("u1", "t-dire", "s3", 12),
      ],
      champions: new Map([["s3", "t-dire"]]),
    });
    expect(out.u1).toEqual({
      seasonName: "Season 3",
      teamName: "Dire Straits",
      record: { wins: 4, losses: 3, draws: 0 },
      price: 12,
      captain: false,
      champion: true,
    });
    expect(lastSeasonToken(out.u1)).toBe(
      "Season 3: Dire Straits · 4W 0D 3L series · $12 · 🏆 champion",
    );
  });

  it("marks captains without a price, even after a price carried over", () => {
    const out = build({
      appearances: [app("u2", "t-rad", "s3", 6, 2, 2, 1)],
      memberships: [member("u2", "t-rad", "s3", 9, true)],
    });
    expect(out.u2).toMatchObject({ captain: true, price: null });
    expect(lastSeasonToken(out.u2)).toBe(
      "Season 3: Radiant Rascals (captain) · 2W 1D 2L series",
    );
  });

  it("uses the team they played most for when they had no roster row (a standin)", () => {
    const out = build({
      appearances: [
        app("u3", "t-rad", "s3", 1, 1, 0),
        app("u3", "t-dire", "s3", 3, 1, 2),
      ],
    });
    expect(out.u3).toMatchObject({
      teamName: "Dire Straits",
      record: { wins: 1, losses: 2, draws: 0 },
      price: null,
      captain: false,
    });
  });

  it("keeps a roster-only season (no imported games) without a record", () => {
    const out = build({
      memberships: [member("u4", "t-old", "s2", 0)],
    });
    expect(out.u4).toEqual({
      seasonName: "Season 2",
      teamName: "Old Guard",
      record: null,
      price: null,
      captain: false,
      champion: false,
    });
    expect(lastSeasonToken(out.u4)).toBe("Season 2: Old Guard");
  });

  it("ignores users outside the pool and seasons that aren't earlier ones", () => {
    const out = build({
      appearances: [
        app("someone-else", "t-dire", "s3", 4, 2, 0),
        app("u1", "t-dire", "current", 4, 2, 0),
      ],
      memberships: [member("u1", "t-dire", "current", 5)],
    });
    expect(out).toEqual({});
  });

  it("spells the token out in its title", () => {
    const ls: PoolLastSeason = {
      seasonName: "Season 3",
      teamName: "Dire Straits",
      record: { wins: 4, losses: 3, draws: 1 },
      price: 12,
      captain: false,
      champion: true,
    };
    expect(lastSeasonTitle(ls)).toBe(
      "Season 3: played for Dire Straits · series they played in: 4 won, 3 lost, 1 drawn · drafted for $12 · won the title",
    );
  });
});
