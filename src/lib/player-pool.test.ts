import { describe, expect, it } from "vitest";
import {
  buildPoolInhouseInfo,
  buildPoolLastSeasons,
  EMPTY_POOL_FILTER,
  filterAndSortPlayers,
  filterPoolPage,
  lastSeasonTitle,
  lastSeasonToken,
  inhouseToken,
  mmrInRange,
  mmrRangeLabel,
  NO_MMR_RANGE,
  parseMmrInput,
  parseMmrRange,
  POOL_MMR_BANDS,
  poolFacetCounts,
  poolFilterActive,
  poolHeroMatches,
  poolPanelFilterCount,
  poolParamsQuery,
  poolRowFacts,
  pubHeroTitle,
  pubQuietToken,
  readPoolParams,
  recentHeroTitle,
  pubTitle,
  pubToken,
  sortByInhouseRecord,
  sortPoolPage,
  type PoolFilterGates,
  type PoolLastSeason,
  type PoolPageFilter,
  type PoolPlayer,
  type PoolScout,
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

describe("the /players filters (standins share the table)", () => {
  const NOW = Date.UTC(2026, 10, 12);
  const DAY = 86_400_000;
  const pub = (lastPlayedDaysAgo: number) => ({
    recentWins: 5,
    recentLosses: 5,
    lastPlayedAt: Math.floor((NOW - lastPlayedDaysAgo * DAY) / 1000),
    checkedAt: NOW - DAY,
    topHeroes: [{ heroId: 26, games: 40, wins: 22 }], // Lion
    scout: null,
  });
  const rows = [
    mk({ name: "Drafted", mmr: 4000, drafted: true, roles: "1", favoriteHeroes: "Invoker" }),
    mk({ name: "Free", mmr: 3000, roles: "2", wantsCaptain: true, discordName: "free#1" }),
    mk({ name: "Sub", mmr: 3500, roles: "1,5" }),
    mk({ name: "Spare", mmr: 1000, roles: "4" }),
    mk({ name: "Blank", mmr: 0, roles: "3" }),
  ];
  const standins = new Set(["Sub", "Spare"]);
  const scout: PoolScoutInfo = {
    Drafted: {
      lastSeason: {
        seasonName: "Season 6",
        teamName: "Dire Straits",
        record: null,
        price: 12,
        captain: false,
        champion: false,
      },
      inhouse: { rating: 1040, rank: 3, wins: 6, losses: 2, games: 8 },
    },
    Free: { pub: pub(3) },
    Sub: { pub: pub(120) },
  };
  const facts = new Map(
    rows.map((r) => [r.userId, poolRowFacts(r, scout[r.userId], standins, NOW)]),
  );
  const names = (over: Partial<PoolPageFilter>, heroIds = new Set<number>()) =>
    filterPoolPage(rows, facts, { ...EMPTY_POOL_FILTER, ...over }, heroIds).map(
      (p) => p.name,
    );

  it("keeps everyone, in input order, with no filter", () => {
    expect(names({})).toEqual(["Drafted", "Free", "Sub", "Spare", "Blank"]);
  });
  it("search, positions and status reach standins too", () => {
    expect(names({ query: "SUB" })).toEqual(["Sub"]);
    expect(names({ roles: ["1"] })).toEqual(["Drafted", "Sub"]);
  });
  it("positions are any-of: Pos 4 or 5 finds both supports", () => {
    expect(names({ roles: ["4", "5"] })).toEqual(["Sub", "Spare"]);
  });
  it("the Standins chip narrows to standins and keeps the other filters", () => {
    expect(names({ status: "standin" })).toEqual(["Sub", "Spare"]);
    expect(names({ status: "standin", roles: ["4"] })).toEqual(["Spare"]);
  });
  it("the Players chip hides standins and keeps the other filters", () => {
    expect(names({ status: "player" })).toEqual(["Drafted", "Free", "Blank"]);
    expect(names({ status: "player", roles: ["1"] })).toEqual(["Drafted"]);
  });
  it("never counts a standin as a free agent or as drafted", () => {
    expect(names({ status: "free" })).toEqual(["Free", "Blank"]);
    expect(names({ status: "drafted" })).toEqual(["Drafted"]);
  });
  it("leaves the shared lib standin-blind (the draft room's filter)", () => {
    // Without the page's narrowing a standin reads as an undrafted player.
    expect(
      filterAndSortPlayers(rows, { status: "free", sort: "name" }).map(
        (p) => p.name,
      ),
    ).toEqual(["Blank", "Free", "Spare", "Sub"]);
  });
  it("an MMR range is inclusive, open-ended, and never holds an unknown MMR", () => {
    expect(names({ mmr: { min: 3000, max: 3500 } })).toEqual(["Free", "Sub"]);
    expect(names({ mmr: { min: null, max: 3000 } })).toEqual(["Free", "Spare"]);
    expect(names({ mmr: { min: 3600, max: null } })).toEqual(["Drafted"]);
    // Reversed boxes still mean the span between them.
    expect(names({ mmr: { min: 3500, max: 3000 } })).toEqual(["Free", "Sub"]);
  });
  it("splits returning players from first-timers", () => {
    expect(names({ history: "returning" })).toEqual(["Drafted"]);
    expect(names({ history: "new" })).toEqual(["Free", "Sub", "Spare", "Blank"]);
  });
  it("filters to inhouse players and to reachable ones", () => {
    expect(names({ inhouseOnly: true })).toEqual(["Drafted"]);
    expect(names({ discordOnly: true })).toEqual(["Free"]);
    expect(names({ captainOnly: true })).toEqual(["Free"]);
  });
  it("hides only players KNOWN to have gone quiet; no snapshot stays", () => {
    expect(names({ hideInactive: true })).toEqual([
      "Drafted",
      "Free",
      "Spare",
      "Blank",
    ]);
  });
  it("a hero search finds favorites and pub heroes, beside name matches", () => {
    expect(names({ query: "Lion" }, new Set([26]))).toEqual(["Free", "Sub"]);
    expect(names({ query: "invoker" }, new Set([74]))).toEqual(["Drafted"]);
  });
  it("does not mutate the input", () => {
    const before = rows.map((p) => p.name);
    names({ status: "standin", roles: ["1"] });
    expect(rows.map((p) => p.name)).toEqual(before);
  });

  describe("facet counts leave out their own filter", () => {
    it("counts every option against the other filters", () => {
      const counts = poolFacetCounts(
        rows,
        facts,
        { ...EMPTY_POOL_FILTER, roles: ["1"], status: "standin" },
        new Set(),
      );
      // Positions ignore the position filter but keep "standins only".
      expect(counts.roles).toEqual({ "1": 1, "2": 0, "3": 0, "4": 1, "5": 1 });
      // Status ignores the status filter but keeps Pos 1.
      expect(counts.status).toEqual({ player: 1, standin: 1, drafted: 1, free: 0 });
    });
    it("bands MMR without the range and leaves unknown MMR out", () => {
      const counts = poolFacetCounts(
        rows,
        facts,
        { ...EMPTY_POOL_FILTER, mmr: { min: 3000, max: 3999 } },
        new Set(),
      );
      expect(counts.mmrBands).toEqual([1, 0, 2, 1, 0]);
    });
    it("counts the toggles' rows", () => {
      const counts = poolFacetCounts(rows, facts, EMPTY_POOL_FILTER, new Set());
      expect(counts.history).toEqual({ returning: 1, new: 4 });
      expect(counts.inhouse).toBe(1);
      expect(counts.discord).toBe(1);
      expect(counts.captain).toBe(1);
      expect(counts.inactive).toBe(1);
    });
  });
});

describe("sortPoolPage", () => {
  const rows = [
    mk({ name: "Low", mmr: 1000 }),
    mk({ name: "High", mmr: 5000 }),
    mk({ name: "Mid", mmr: 3000 }),
  ];
  const ctx = {
    scout: {
      Low: { inhouse: { rating: 1100, rank: 1, wins: 5, losses: 1, games: 6 } },
    } satisfies PoolScoutInfo,
    signedUpAt: { Low: 3, High: 1, Mid: 2 },
  };
  const order = (sort: Parameters<typeof sortPoolPage>[1]) =>
    sortPoolPage(rows, sort, ctx).map((p) => p.name);
  it("sorts by MMR, name, inhouse record and newest signup", () => {
    expect(order("mmr")).toEqual(["High", "Mid", "Low"]);
    expect(order("name")).toEqual(["High", "Low", "Mid"]);
    expect(order("inhouse")).toEqual(["Low", "High", "Mid"]);
    expect(order("newest")).toEqual(["Low", "Mid", "High"]);
  });
  it("keeps the MMR order for signups without a time", () => {
    expect(
      sortPoolPage(rows, "newest", { ...ctx, signedUpAt: {} }).map((p) => p.name),
    ).toEqual(["High", "Mid", "Low"]);
  });
});

describe("the /players address bar", () => {
  const open: PoolFilterGates = {
    captainSelectionOpen: true,
    draftStatus: true,
    anyStandin: true,
    anyInhouse: true,
    anyReturning: true,
    anyInactive: true,
    showContact: true,
  };
  const read = (qs: string, gates = open) =>
    readPoolParams(new URLSearchParams(qs), gates);

  it("round-trips every filter and the sort", () => {
    const qs =
      "q=lion&pos=4,5&sort=newest&cap=1&status=standin&mmr=3000-3500&history=returning&inhouse=1&discord=1&active=1";
    const { filter, sort } = read(qs);
    expect(filter).toEqual({
      query: "lion",
      roles: ["4", "5"],
      status: "standin",
      captainOnly: true,
      mmr: { min: 3000, max: 3500 },
      history: "returning",
      inhouseOnly: true,
      discordOnly: true,
      hideInactive: true,
    });
    expect(sort).toBe("newest");
    expect(poolParamsQuery(filter, sort)).toBe(qs);
  });
  it("leaves defaults out, so an unfiltered pool is a bare /players", () => {
    expect(poolParamsQuery(EMPTY_POOL_FILTER, "mmr")).toBe("");
  });
  it("keeps an old single-position link working", () => {
    expect(read("pos=1").filter.roles).toEqual(["1"]);
    expect(read("pos=9,2,2").filter.roles).toEqual(["2"]);
  });
  it("never filters by a control that isn't on the page", () => {
    const closed: PoolFilterGates = {
      captainSelectionOpen: false,
      draftStatus: false,
      anyStandin: false,
      anyInhouse: false,
      anyReturning: false,
      anyInactive: false,
      showContact: false,
    };
    const { filter, sort } = read(
      "cap=1&status=standin&history=new&inhouse=1&discord=1&active=1&sort=inhouse",
      closed,
    );
    expect(filter).toEqual(EMPTY_POOL_FILTER);
    expect(sort).toBe("mmr");
    expect(read("status=free", closed).filter.status).toBe("all");
    expect(read("status=player", closed).filter.status).toBe("all");
  });
  it("ignores junk", () => {
    expect(read("sort=bogus&status=x&mmr=abc&history=maybe").filter).toEqual(
      EMPTY_POOL_FILTER,
    );
    expect(read("sort=bogus").sort).toBe("mmr");
  });
});

describe("MMR ranges", () => {
  it("parses open ends and swaps a reversed range", () => {
    expect(parseMmrRange("3000-")).toEqual({ min: 3000, max: null });
    expect(parseMmrRange("-3300")).toEqual({ min: null, max: 3300 });
    expect(parseMmrRange("4000-3000")).toEqual({ min: 3000, max: 4000 });
    expect(parseMmrRange("-")).toEqual(NO_MMR_RANGE);
    expect(parseMmrRange("3k-4k")).toEqual(NO_MMR_RANGE);
  });
  it("reads a typed box as digits only", () => {
    expect(parseMmrInput(" 3200 ")).toBe(3200);
    expect(parseMmrInput("")).toBeNull();
    expect(parseMmrInput("3,200")).toBeNull();
    expect(parseMmrInput("-1")).toBeNull();
  });
  it("labels a range the way the bands do", () => {
    expect(mmrRangeLabel({ min: 3000, max: 3999 })).toBe("3,000–3,999");
    expect(mmrRangeLabel({ min: 3000, max: null })).toBe("From 3,000");
    expect(mmrRangeLabel({ min: null, max: 3300 })).toBe("Up to 3,300");
    expect(mmrRangeLabel(NO_MMR_RANGE)).toBeNull();
  });
  it("has bands that cover every known MMR exactly once", () => {
    for (const mmr of [1, 1999, 2000, 2999, 3000, 4999, 5000, 12000]) {
      expect(
        POOL_MMR_BANDS.filter((band) => mmrInRange(mmr, band)),
      ).toHaveLength(1);
    }
    expect(POOL_MMR_BANDS.some((band) => mmrInRange(0, band))).toBe(false);
  });
});

describe("filter state", () => {
  it("counts only the Filters panel's own filters on its button", () => {
    expect(poolPanelFilterCount(EMPTY_POOL_FILTER)).toBe(0);
    expect(
      poolPanelFilterCount({
        ...EMPTY_POOL_FILTER,
        query: "x",
        roles: ["1"],
        status: "standin",
        mmr: { min: 3000, max: null },
        hideInactive: true,
      }),
    ).toBe(2);
  });
  it("says when anything narrows the list", () => {
    expect(poolFilterActive(EMPTY_POOL_FILTER)).toBe(false);
    expect(poolFilterActive({ ...EMPTY_POOL_FILTER, query: "  " })).toBe(false);
    expect(
      poolFilterActive({ ...EMPTY_POOL_FILTER, mmr: { min: null, max: 1 } }),
    ).toBe(true);
  });
});

describe("poolHeroMatches", () => {
  const lion = { id: 26, name: "Lion" };
  it("says where a hero-matched row plays the hero", () => {
    expect(
      poolHeroMatches(
        mk({ name: "Zed", favoriteHeroes: "Lion, Pudge" }),
        {
          pub: {
            recentWins: 1,
            recentLosses: 1,
            lastPlayedAt: null,
            checkedAt: null,
            topHeroes: [],
            scout: { heroes: [{ heroId: 26, games: 12 }], games: 100 },
          },
        } as unknown as PoolScout,
        "lion",
        [lion],
      ),
    ).toEqual([{ heroId: 26, text: "Lion: a favorite, 12 of their last 100 pubs" }]);
  });
  it("is empty when the name matched or no hero is named", () => {
    expect(poolHeroMatches(mk({ name: "Lionheart" }), undefined, "lion", [lion])).toEqual([]);
    expect(poolHeroMatches(mk({ name: "Zed" }), undefined, "zed", [])).toEqual([]);
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
    scout: null,
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

  it("pubQuietToken says when they last played", () => {
    expect(pubQuietToken({ label: "4mo ago", quiet: true })).toBe(
      "last played 4mo ago",
    );
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

describe("recentHeroTitle", () => {
  it("names the hero, its share of the window and its record", () => {
    expect(recentHeroTitle({ heroId: 26, games: 12, wins: 8 }, 100)).toBe(
      "Lion — 12 of their last 100 games, 8–4",
    );
  });
});
