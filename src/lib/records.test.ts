import { describe, expect, it } from "vitest";
import {
  RECORD_WATCH_MIN_GAMES,
  RECORD_WATCH_PER_MATCH,
  RECORD_WATCH_WITHIN_PERCENT,
  brokenPlayerRecord,
  formatGameDuration,
  formatRecordMark,
  analyzeRecordGames,
  leagueRecords,
  recordGameMetricsValid,
  recordWatchBook,
  recordWatchFor,
  recordWatchLines,
  recordWatchText,
  toRecordGames,
  type RecordGame,
  type RecordLine,
  type RecordWatchLine,
  type StoredRecordGame,
} from "./records";

function line(overrides: Partial<RecordLine>): RecordLine {
  return {
    userId: "u1",
    heroId: 1,
    kills: 5,
    deaths: 3,
    assists: 10,
    netWorth: 15000,
    gpm: 400,
    lastHits: 150,
    xpm: null,
    denies: null,
    heroDamage: null,
    towerDamage: null,
    heroHealing: null,
    isRadiant: true,
    ...overrides,
  };
}

function game(overrides: Partial<RecordGame>): RecordGame {
  return {
    matchId: "m1",
    seasonId: "s1",
    radiantWin: true,
    durationSecs: 2400,
    radiantScore: 30,
    direScore: 20,
    lines: [],
    ...overrides,
  };
}

describe("leagueRecords", () => {
  it("returns empty books for no games", () => {
    const book = leagueRecords([]);
    expect(book.players).toEqual([]);
    expect(book.games).toEqual([]);
  });

  it("crowns the best line per player record with hero, match, and result", () => {
    const games: RecordGame[] = [
      game({
        matchId: "m1",
        lines: [
          line({ userId: "a", heroId: 8, kills: 12, isRadiant: true }),
          line({ userId: "b", heroId: 9, kills: 20, isRadiant: false }),
        ],
      }),
    ];
    const kills = leagueRecords(games).players.find((r) => r.key === "kills")!;
    expect(kills.value).toBe(20);
    expect(kills.userId).toBe("b");
    expect(kills.heroId).toBe(9);
    expect(kills.matchId).toBe("m1");
    expect(kills.won).toBe(false); // dire line in a radiant win
  });

  it("keeps the first achiever on ties (records are broken, not shared)", () => {
    const games: RecordGame[] = [
      game({ matchId: "m1", lines: [line({ userId: "a", kills: 15 })] }),
      game({ matchId: "m2", lines: [line({ userId: "b", kills: 15 })] }),
    ];
    const kills = leagueRecords(games).players.find((r) => r.key === "kills")!;
    expect(kills.userId).toBe("a");
    expect(kills.matchId).toBe("m1");
  });

  it("skips unmapped lines and null metrics", () => {
    const games: RecordGame[] = [
      game({
        lines: [
          line({ userId: null, kills: 99, netWorth: 99999 }),
          line({
            userId: "a",
            kills: 3,
            netWorth: null,
            gpm: null,
            lastHits: null,
          }),
        ],
      }),
    ];
    const book = leagueRecords(games);
    expect(book.players.find((r) => r.key === "kills")!.value).toBe(3);
    // Nobody qualified for the null metrics.
    expect(book.players.find((r) => r.key === "netWorth")).toBeUndefined();
    expect(book.players.find((r) => r.key === "gpm")).toBeUndefined();
  });

  it("tracks longest and fastest games, ignoring zero durations", () => {
    const games: RecordGame[] = [
      game({ matchId: "m1", durationSecs: 0 }), // unreported — never a record
      game({ matchId: "m2", durationSecs: 3600 }),
      game({ matchId: "m3", durationSecs: 900 }),
    ];
    const book = leagueRecords(games);
    expect(book.games.find((r) => r.key === "longest")!.matchId).toBe("m2");
    expect(book.games.find((r) => r.key === "shortest")!.matchId).toBe("m3");
  });

  it("computes bloodiest game and biggest stomp from kill scores", () => {
    const games: RecordGame[] = [
      game({ matchId: "m1", radiantScore: 40, direScore: 38 }), // 78 kills, diff 2
      game({ matchId: "m2", radiantScore: 5, direScore: 45 }), // 50 kills, diff 40
    ];
    const book = leagueRecords(games);
    const bloodiest = book.games.find((r) => r.key === "bloodiest")!;
    expect(bloodiest.matchId).toBe("m1");
    expect(bloodiest.value).toBe(78);
    const stomp = book.games.find((r) => r.key === "stomp")!;
    expect(stomp.matchId).toBe("m2");
    expect(stomp.value).toBe(40);
    expect(stomp.score).toBe("5–45");
  });

  it("never crowns kill-score records from unreported 0–0 games", () => {
    const games: RecordGame[] = [
      game({ matchId: "m1", radiantScore: 0, direScore: 0 }),
    ];
    const book = leagueRecords(games);
    expect(book.games.find((r) => r.key === "bloodiest")).toBeUndefined();
    expect(book.games.find((r) => r.key === "stomp")).toBeUndefined();
  });

  it("recognizes support and objective records only when those fields were reported", () => {
    const book = leagueRecords([
      game({
        lines: [
          line({ userId: "support", heroHealing: 12000, heroDamage: 9000, towerDamage: 100 }),
          line({ userId: "pusher", heroHealing: null, heroDamage: 25000, towerDamage: 8000 }),
        ],
      }),
    ]);
    expect(book.players.find((r) => r.key === "heroHealing")).toMatchObject({ userId: "support", value: 12000 });
    expect(book.players.find((r) => r.key === "towerDamage")).toMatchObject({ userId: "pusher", value: 8000 });
    expect(book.players.find((r) => r.key === "heroDamage")).toMatchObject({ userId: "pusher", value: 25000 });
  });

  it("never names a player for their worst game", () => {
    const book = leagueRecords([
      game({ lines: [line({ userId: "a", deaths: 25 }), line({ userId: "b", deaths: 1 })] }),
    ]);
    expect(book.players.map((r) => r.key)).not.toContain("deaths");
    expect(book.players.some((r) => /death/i.test(r.title))).toBe(false);
  });

  it("keeps game-story records grounded in a reported score", () => {
    const book = leagueRecords([
      game({ matchId: "close", radiantWin: true, radiantScore: 21, direScore: 20 }),
      game({ matchId: "loss", radiantWin: false, radiantScore: 35, direScore: 40 }),
      game({ matchId: "empty", radiantScore: 0, direScore: 0 }),
    ]);
    expect(book.games.find((r) => r.key === "closest")).toMatchObject({ matchId: "close", value: 1 });
    expect(book.games.find((r) => r.key === "losingKills")).toMatchObject({ matchId: "loss", value: 35 });
  });
});

describe("brokenPlayerRecord", () => {
  // `count` complete-enough base games, each with one line on `kills`.
  const base = (count: number, kills = 14) =>
    Array.from({ length: count }, (_, i) =>
      game({ matchId: `old-${i}`, lines: [line({ userId: `p${i}`, kills, assists: 5 })] }),
    );

  it("reports the mark a series beat, with the old holder", () => {
    const series = game({
      matchId: "series",
      lines: [line({ userId: "star", heroId: 42, kills: 17, assists: 5 })],
    });
    const broken = brokenPlayerRecord([...base(20), series], "series");
    expect(broken?.record).toMatchObject({ key: "kills", value: 17, userId: "star", heroId: 42 });
    expect(broken?.previous).toMatchObject({ key: "kills", value: 14, userId: "p0" });
  });

  it("stays quiet until 20 complete games stood before the series", () => {
    const series = game({ matchId: "series", lines: [line({ userId: "star", kills: 30 })] });
    expect(brokenPlayerRecord([...base(19), series], "series")).toBeNull();
    expect(brokenPlayerRecord([...base(20), series], "series")).not.toBeNull();
  });

  it("ignores an equalled mark and a series with no games in the book", () => {
    const equal = game({ matchId: "series", lines: [line({ userId: "star", kills: 14, assists: 5 })] });
    expect(brokenPlayerRecord([...base(20), equal], "series")).toBeNull();
    expect(brokenPlayerRecord(base(25), "missing")).toBeNull();
  });

  it("names one record, kills first, when a series breaks several", () => {
    const series = game({
      matchId: "series",
      lines: [line({ userId: "star", kills: 20, assists: 40 })],
    });
    expect(brokenPlayerRecord([...base(20), series], "series")?.record.key).toBe("kills");
  });

  it("counts a later series game as the series, not the old mark", () => {
    const series = [
      game({ matchId: "series", lines: [line({ userId: "a", kills: 16, assists: 5 })] }),
      game({ matchId: "series", lines: [line({ userId: "b", kills: 18, assists: 5 })] }),
    ];
    const broken = brokenPlayerRecord([...base(20), ...series], "series");
    expect(broken?.record).toMatchObject({ userId: "b", value: 18 });
    expect(broken?.previous.value).toBe(14);
  });
});

describe("formatRecordMark", () => {
  it("adds the unit to each kind of mark", () => {
    expect(formatRecordMark("kills", 17)).toBe("17 kills");
    expect(formatRecordMark("netWorth", 32100)).toBe("32.1k net worth");
    expect(formatRecordMark("gpm", 812)).toBe("812 GPM");
    expect(formatRecordMark("heroDamage", 45210)).toBe("45,210 hero damage");
  });
});

describe("record watch", () => {
  // The record holder's big night comes first, so a later equal mark is
  // "level", never a share of the record.
  const holder = game({
    matchId: "holder-night",
    lines: [
      line({
        userId: "holder",
        kills: 20,
        assists: 30,
        netWorth: 30000,
        gpm: 800,
        lastHits: 300,
      }),
    ],
  });
  // Quiet games: 5 kills, 10 assists, 15,000 net worth, 400 GPM, 150 last
  // hits, far outside 15% of every record above.
  const quiet = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      game({ matchId: `quiet-${i}`, lines: [line({ userId: `p${i}` })] }),
    );
  /** A book of `total` complete games: the holder's, one per chaser line,
   *  then quiet games. */
  const bookWith = (chaser: Partial<RecordLine>[], total = 20) =>
    recordWatchBook([
      holder,
      ...chaser.map((overrides, i) =>
        game({
          matchId: `chase-${i}`,
          lines: [line({ userId: "chaser", ...overrides })],
        }),
      ),
      ...quiet(total - 1 - chaser.length),
    ]);

  it("waits for 20 games and a best within 15%, at most 3 lines a match", () => {
    expect(RECORD_WATCH_MIN_GAMES).toBe(20);
    expect(RECORD_WATCH_WITHIN_PERCENT).toBe(15);
    expect(RECORD_WATCH_PER_MATCH).toBe(3);
  });

  it("measures the gap from the player's career best to the record", () => {
    const book = bookWith([{ kills: 12 }, { kills: 18 }, { kills: 15 }]);
    expect(recordWatchFor(book, "chaser")).toEqual({
      userId: "chaser",
      key: "kills",
      title: "Most kills",
      emoji: "🔪",
      best: 18,
      record: 20,
      gap: 2,
    });
  });

  it("stays quiet until the book has 20 complete games", () => {
    expect(recordWatchFor(bookWith([{ kills: 18 }], 19), "chaser")).toBeNull();
    expect(recordWatchFor(bookWith([{ kills: 18 }], 20), "chaser")).toMatchObject(
      { key: "kills", gap: 2 },
    );
  });

  it("counts a best exactly 15% short, and nothing further", () => {
    // 17 of 20 is 3 short, exactly 15%; 16 is 4 short, 20%.
    expect(recordWatchFor(bookWith([{ kills: 17 }]), "chaser")).toMatchObject({
      gap: 3,
    });
    expect(recordWatchFor(bookWith([{ kills: 16 }]), "chaser")).toBeNull();
  });

  it("never lists a record the player holds, but watches the rest", () => {
    // In a plain book the holder holds every record: nothing to chase.
    expect(recordWatchFor(bookWith([]), "holder")).toBeNull();
    // A rival's 820 GPM takes that record, and the holder's 800 trails it.
    const book = bookWith([{ gpm: 820 }]);
    expect(recordWatchFor(book, "holder")).toMatchObject({
      key: "gpm",
      best: 800,
      record: 820,
      gap: 20,
    });
    expect(recordWatchFor(book, "chaser")).toBeNull();
  });

  it("calls an equalled mark level with the record", () => {
    const watch = recordWatchFor(bookWith([{ kills: 20 }]), "chaser");
    expect(watch).toMatchObject({ best: 20, record: 20, gap: 0 });
    expect(recordWatchText(watch!)).toBe(
      "Career best 20 kills · level with the record",
    );
  });

  it("picks the record closest by share, then book order", () => {
    // 790 of 800 GPM is 1.25% short; 18 of 20 kills is 10% short, though
    // fewer units away.
    expect(
      recordWatchFor(bookWith([{ kills: 18, gpm: 790 }]), "chaser"),
    ).toMatchObject({ key: "gpm", gap: 10 });
    // 18 of 20 kills and 27 of 30 assists are both 10% short: kills first.
    expect(
      recordWatchFor(bookWith([{ kills: 18, assists: 27 }]), "chaser"),
    ).toMatchObject({ key: "kills" });
  });

  it("has nothing for a player outside the book or a record of zero", () => {
    expect(recordWatchFor(bookWith([{ kills: 18 }]), "nobody")).toBeNull();
    // Twenty games without a kill: a record of 0 is no target, and "level
    // with the record" at 0 kills would be a joke at the player's expense.
    const blank = Array.from({ length: 20 }, (_, i) =>
      game({
        matchId: `blank-${i}`,
        lines: [
          line({
            userId: `p${i}`,
            kills: 0,
            assists: 0,
            netWorth: null,
            gpm: null,
            lastHits: null,
          }),
        ],
      }),
    );
    expect(recordWatchFor(recordWatchBook(blank), "p1")).toBeNull();
  });

  describe("recordWatchLines", () => {
    const book = recordWatchBook([
      holder,
      game({ matchId: "a", lines: [line({ userId: "amy", gpm: 790 })] }), // 1.25%
      game({ matchId: "b", lines: [line({ userId: "bob", kills: 18 })] }), // 10%
      game({ matchId: "z", lines: [line({ userId: "zed", kills: 19 })] }), // 5%
      game({ matchId: "c", lines: [line({ userId: "ace", assists: 27 })] }), // 10%
      game({ matchId: "d", lines: [line({ userId: "abe", kills: 18 })] }), // 10%
      ...quiet(14),
    ]);
    const ids = (userIds: string[], limit?: number) =>
      recordWatchLines(book, userIds, limit).map((watch) => watch.userId);

    it("lists the closest first, one line a player", () => {
      expect(ids(["bob", "zed", "amy"])).toEqual(["amy", "zed", "bob"]);
    });

    it("breaks an equal share on book order, then user id", () => {
      // All three are 10% short; kills comes before assists in the book,
      // though "ace" sorts before "bob".
      expect(ids(["ace", "bob", "abe"])).toEqual(["abe", "bob", "ace"]);
    });

    it("stops at three lines unless told otherwise", () => {
      expect(ids(["ace", "bob", "abe", "zed", "amy"])).toEqual([
        "amy",
        "zed",
        "abe",
      ]);
      expect(ids(["bob", "amy"], 1)).toEqual(["amy"]);
    });

    it("skips repeats and players with nothing to chase", () => {
      expect(ids(["amy", "amy", "p1", "nobody", "holder"])).toEqual(["amy"]);
    });
  });

  it("writes the stored marks and the gap, exact and with their unit", () => {
    const watch = (overrides: Partial<RecordWatchLine>): RecordWatchLine => ({
      userId: "u",
      key: "kills",
      title: "Most kills",
      emoji: "🔪",
      best: 18,
      record: 21,
      gap: 3,
      ...overrides,
    });
    expect(recordWatchText(watch({}))).toBe(
      "Career best 18 kills · record 21, 3 short",
    );
    expect(
      recordWatchText(
        watch({ key: "netWorth", best: 30200, record: 32149, gap: 1949 }),
      ),
    ).toBe("Career best 30,200 net worth · record 32,149, 1,949 short");
    expect(
      recordWatchText(watch({ key: "gpm", best: 790, record: 800, gap: 10 })),
    ).toBe("Career best 790 GPM · record 800, 10 short");
  });
});

describe("formatGameDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatGameDuration(2597)).toBe("43m 17s");
    expect(formatGameDuration(60)).toBe("1m 0s");
  });
});

describe("toRecordGames", () => {
  const storedRoster = (
    first: Record<string, unknown> = {},
  ): Record<string, unknown>[] =>
    Array.from({ length: 10 }, (_, index) => ({
      accountId: 1000 + index,
      userId: `u${index + 1}`,
      heroId: index + 20,
      kills: index === 0 ? 9 : 1,
      deaths: 2,
      assists: index === 0 ? 14 : 3,
      netWorth: index === 0 ? 21000 : 10000,
      gpm: index === 0 ? 512 : 350,
      lastHits: index === 0 ? 230 : 100,
      isRadiant: index < 5,
      ...(index === 0 ? first : {}),
    }));

  const row = (
    overrides: Partial<StoredRecordGame> = {},
  ): StoredRecordGame => ({
    matchId: "m1",
    radiantWin: true,
    durationSecs: 2400,
    radiantScore: 30,
    direScore: 20,
    players: JSON.stringify(storedRoster({ heroId: 7 })),
    match: { seasonId: "s1" },
    ...overrides,
  });

  it("maps stored rows into the record book's shape", () => {
    const [g] = toRecordGames([row()]);
    expect(g).toMatchObject({
      matchId: "m1",
      seasonId: "s1",
      radiantWin: true,
      durationSecs: 2400,
      radiantScore: 30,
      direScore: 20,
    });
    expect(g.lines).toHaveLength(10);
    expect(g.lines[0]).toEqual({
      userId: "u1",
      heroId: 7,
      kills: 9,
      deaths: 2,
      assists: 14,
      netWorth: 21000,
      gpm: 512,
      lastHits: 230,
      xpm: null,
      denies: null,
      heroDamage: null,
      towerDamage: null,
      heroHealing: null,
      isRadiant: true,
    });
  });

  it("normalizes missing economy fields and userId to null, never 0", () => {
    const [g] = toRecordGames([
      row({
        players: JSON.stringify(
          storedRoster({
            userId: null,
            heroId: 3,
            kills: 1,
            deaths: 1,
            assists: 1,
            netWorth: undefined,
            gpm: undefined,
            lastHits: undefined,
          }),
        ),
      }),
    ]);
    expect(g.lines[0]).toMatchObject({
      userId: null,
      netWorth: null,
      gpm: null,
      lastHits: null,
    });
    // …and leagueRecords therefore never crowns an economy record from it.
    const noEconomyRoster = storedRoster({
      heroId: 3,
      kills: 1,
      deaths: 1,
      assists: 1,
    }).map((player) => ({
      ...player,
      netWorth: undefined,
      gpm: undefined,
      lastHits: undefined,
    }));
    const book = leagueRecords(
      toRecordGames([
        row({
          players: JSON.stringify(noEconomyRoster),
        }),
      ]),
    );
    expect(book.players.find((r) => r.key === "netWorth")).toBeUndefined();
    expect(book.players.find((r) => r.key === "gpm")).toBeUndefined();
  });

  it("carries optional imported damage, healing, and lane stats into records", () => {
    const [mapped] = toRecordGames([
      row({
        players: JSON.stringify(storedRoster({
          xpm: 610,
          denies: 12,
          heroDamage: 24000,
          towerDamage: 5100,
          heroHealing: 3200,
        })),
      }),
    ]);
    expect(mapped.lines[0]).toMatchObject({
      xpm: 610,
      denies: 12,
      heroDamage: 24000,
      towerDamage: 5100,
      heroHealing: 3200,
    });
  });

  it("omits a malformed box score from player and game records", () => {
    expect(toRecordGames([row({ players: "not json" })])).toEqual([]);
    expect(
      analyzeRecordGames([row({ players: "not json" })]).diagnostics,
    ).toMatchObject({ malformedGames: 1, unusableGames: 0 });
  });

  it("omits a partial box score from player and game records", () => {
    expect(
      toRecordGames([
        row({ players: JSON.stringify(storedRoster().slice(0, 9)) }),
      ]),
    ).toEqual([]);
    expect(
      analyzeRecordGames([
        row({ players: JSON.stringify(storedRoster().slice(0, 9)) }),
      ]).diagnostics,
    ).toMatchObject({ malformedGames: 0, unusableGames: 1 });
  });

  it("neutralizes unsafe game-level metrics without discarding valid player lines", () => {
    const [g] = toRecordGames([
      row({ durationSecs: -1, radiantScore: 2_000_000, direScore: 10 }),
    ]);
    expect(g.lines).toHaveLength(10);
    expect(g).toMatchObject({
      durationSecs: 0,
      radiantScore: 0,
      direScore: 0,
    });
    expect(recordGameMetricsValid(row())).toBe(true);
    expect(recordGameMetricsValid(row({ durationSecs: -1 }))).toBe(false);
    const book = leagueRecords([g]);
    expect(book.players.length).toBeGreaterThan(0);
    expect(book.games).toEqual([]);
  });

  it("keeps the caller's row order (records are first-achiever-keeps-tie)", () => {
    const games = toRecordGames([
      row({ matchId: "m1" }),
      row({ matchId: "m2" }),
    ]);
    const book = leagueRecords(games);
    expect(book.players.find((r) => r.key === "kills")?.matchId).toBe("m1");
  });
});
