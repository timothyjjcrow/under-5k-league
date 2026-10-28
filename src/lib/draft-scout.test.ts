import { describe, expect, it } from "vitest";
import {
  buildDraftScoutInfo,
  clipAbout,
  DRAFT_ABOUT_CLIP,
  DRAFT_ABOUT_COMPACT_CHARS,
  draftCardView,
  draftScoutWanted,
  inspectedAfterChange,
  poolPanelOpenId,
  poolTapHint,
  toggleInspected,
  type DraftScout,
  type DraftScoutRegistration,
} from "./draft-scout";
import {
  inhouseTitle,
  lastSeasonTitle,
  PUB_QUIET_TITLE,
  pubTitle,
  type PoolInhouseRecord,
  type PoolLastSeason,
} from "./player-pool";
import {
  scoutingSentences,
  scoutingTiles,
  summarizePubMatches,
  type PubScout,
} from "./pub-scout";
import { poolPubRecord } from "./pub-stats";

const DAY = 86_400_000;
const NOW_MS = Date.UTC(2026, 9, 24, 18);
const NOW = Math.floor(NOW_MS / 1000);

/** A ranked All Pick game on US East: a support's last hits on Lion, a
 *  core's on Pudge every third game. */
const game = (i: number, over: Record<string, unknown> = {}) => ({
  hero_id: i % 3 === 0 ? 14 : 26,
  player_slot: 1,
  radiant_win: i % 4 !== 0,
  kills: 3,
  deaths: 5,
  assists: 12,
  gold_per_min: 320,
  last_hits: 70,
  duration: 40 * 60,
  game_mode: 22,
  lobby_type: 7,
  party_size: 1,
  average_rank: 63,
  cluster: 122,
  leaver_status: 0,
  start_time: NOW - 86_400 - i * 3_600,
  lane_role: null,
  is_roaming: false,
  ...over,
});
const scout = (n = 40, over: Record<string, unknown> = {}): PubScout =>
  summarizePubMatches(Array.from({ length: n }, (_, i) => game(i, over)));

const blob = (s: PubScout | null, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    recentWins: 22,
    recentLosses: 18,
    totalGames: 4_000,
    lastPlayedAt: NOW - 86_400,
    topHeroes: [{ heroId: 14, games: 220, wins: 121 }],
    scout: s,
    ...over,
  });

const reg = (
  over: Partial<DraftScoutRegistration> & { userId: string },
): DraftScoutRegistration => ({
  favoriteHeroes: "",
  captainNote: "",
  statement: "",
  pubStats: null,
  pubStatsAt: null,
  ...over,
});

const inhouse: PoolInhouseRecord = {
  rating: 1042,
  rank: 3,
  wins: 7,
  losses: 3,
  games: 10,
};
const lastSeason: PoolLastSeason = {
  seasonName: "Season 1",
  teamName: "Dire Straits",
  record: { wins: 4, losses: 3, draws: 0 },
  price: 12,
  captain: false,
  champion: true,
};
const player = { mmr: 3_200, rankTier: 63, roles: "4,5" };

describe("draftScoutWanted", () => {
  it("is true only while the auction runs", () => {
    expect(draftScoutWanted("IN_PROGRESS")).toBe(true);
    expect(draftScoutWanted("PAUSED")).toBe(true);
    for (const status of ["NOT_STARTED", "COMPLETE", null, undefined, ""]) {
      expect(draftScoutWanted(status)).toBe(false);
    }
  });
});

describe("clipAbout", () => {
  it("keeps short text whole, trimmed", () => {
    expect(clipAbout("  Support main, 5 nights a week.  ")).toBe(
      "Support main, 5 nights a week.",
    );
  });

  it("cuts long text at a word boundary within the limit", () => {
    const text = `${"word ".repeat(100)}end`;
    const clipped = clipAbout(text);
    expect(clipped.length).toBeLessThanOrEqual(DRAFT_ABOUT_CLIP);
    expect(clipped.endsWith("word…")).toBe(true);
  });

  it("cuts a text with no spaces at the limit", () => {
    const clipped = clipAbout("x".repeat(500), 20);
    expect(clipped).toBe(`${"x".repeat(19)}…`);
  });
});

describe("buildDraftScoutInfo", () => {
  const info = buildDraftScoutInfo({
    registrations: [
      reg({
        userId: "rich",
        favoriteHeroes: "Lion, Pudge",
        captainNote: "Pos 4 or 5, any night.",
        statement: "Want to win.",
        pubStats: blob(scout()),
        pubStatsAt: new Date(NOW_MS - 3 * DAY),
      }),
      reg({ userId: "bare" }),
      reg({ userId: "garbage", pubStats: "{not json" }),
      reg({ userId: "same", captainNote: "Hi.", statement: "Hi." }),
    ],
    inhouse: { rich: inhouse, stranger: inhouse },
    lastSeasons: { rich: lastSeason },
  });

  it("has one entry per registration, empty when there is nothing", () => {
    expect(Object.keys(info).sort()).toEqual(["bare", "garbage", "rich", "same"]);
    expect(info.bare).toEqual({});
    expect(info.garbage).toEqual({});
  });

  it("attaches each source by id and joins the about text", () => {
    expect(info.rich.inhouse).toEqual(inhouse);
    expect(info.rich.lastSeason).toEqual(lastSeason);
    expect(info.rich.favoriteHeroes).toBe("Lion, Pudge");
    expect(info.rich.about).toBe("Pos 4 or 5, any night. · Want to win.");
    expect(info.same.about).toBe("Hi.");
    expect(info.rich.pub).toEqual(
      poolPubRecord(blob(scout()), new Date(NOW_MS - 3 * DAY)),
    );
  });

  it("clips a long about text", () => {
    const long = buildDraftScoutInfo({
      registrations: [reg({ userId: "a", captainNote: "word ".repeat(400) })],
      inhouse: {},
      lastSeasons: {},
    });
    expect(long.a.about!.length).toBeLessThanOrEqual(DRAFT_ABOUT_CLIP);
  });

  it("never carries a lifetime total or contact", () => {
    const json = JSON.stringify(info);
    for (const banned of ["totalGames", "computed", "discord", "steam"]) {
      expect(json.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("stays small enough to ship the whole pool in the page", () => {
    // 60 full snapshots, a clipped about text, inhouse and last season each:
    // the /draft render sends this once per tab per phase move.
    const registrations = Array.from({ length: 60 }, (_, i) =>
      reg({
        userId: `user-${i}`,
        favoriteHeroes: "Lion, Pudge, Rubick, Earthshaker",
        captainNote: "a".repeat(2_000),
        pubStats: blob(
          summarizePubMatches(
            Array.from({ length: 100 }, (_, g) =>
              game(g, { hero_id: 1 + ((g * 7 + i) % 40), lane_role: 1 + (g % 3) }),
            ),
          ),
        ),
        pubStatsAt: new Date(NOW_MS),
      }),
    );
    const ids = registrations.map((r) => r.userId);
    const big = buildDraftScoutInfo({
      registrations,
      inhouse: Object.fromEntries(ids.map((id) => [id, inhouse])),
      lastSeasons: Object.fromEntries(ids.map((id) => [id, lastSeason])),
    });
    expect(JSON.stringify(big).length).toBeLessThan(60 * 2_400);
  });
});

describe("draftCardView", () => {
  const pub = poolPubRecord(blob(scout()), new Date(NOW_MS - 3 * DAY))!;
  const full: DraftScout = {
    pub,
    inhouse,
    lastSeason,
    favoriteHeroes: "Lion",
    about: "From the map.",
  };
  const view = (over: Partial<Parameters<typeof draftCardView>[0]> = {}) =>
    draftCardView({
      player,
      scout: full,
      league: "us",
      nowMs: NOW_MS,
      ...over,
    });

  it("leads with the league record, then inhouse, then pubs", () => {
    const v = view();
    expect(v.record.map((t) => t.key)).toEqual(["lastSeason", "inhouse", "pubs"]);
    expect(v.record[0]).toMatchObject({
      text: "Season 1: Dire Straits · 4W 0D 3L series · $12 · 🏆 champion",
      title: lastSeasonTitle(lastSeason),
    });
    expect(v.record[1]).toMatchObject({
      text: "Inhouse 1042 · 7–3",
      title: inhouseTitle(inhouse),
    });
    expect(v.record[2]).toMatchObject({
      text: "Pubs 55% in last 40 · checked 3d ago",
      title: pubTitle(pub, NOW_MS),
      warn: false,
    });
  });

  it("names a quiet account, tinted", () => {
    const quietPub = poolPubRecord(
      blob(scout(), { lastPlayedAt: NOW - 90 * 86_400 }),
      new Date(NOW_MS - DAY),
    )!;
    const v = view({ scout: { pub: quietPub } });
    // Measured when the snapshot was taken (a day ago): 89 days.
    expect(v.record.at(-1)).toEqual({
      key: "quiet",
      text: "last played 2mo ago",
      title: PUB_QUIET_TITLE,
      warn: true,
    });
  });

  it("says the snapshot's age once: in the Pubs token, else the caption", () => {
    expect(view().caption).toBe("Their last 40 public games");
    // A Turbo-only window: no W/L token, so the caption carries the age.
    const turbo = poolPubRecord(
      blob(scout(40, { game_mode: 23 }), { recentWins: 0, recentLosses: 0 }),
      new Date(NOW_MS - 3 * DAY),
    )!;
    const v = view({ scout: { pub: turbo } });
    expect(v.record.map((t) => t.key)).not.toContain("pubs");
    expect(v.caption).toBe("Their last 40 public games · checked 3d ago");
  });

  it("builds the tiles from the live signup, so an MMR fix moves them", () => {
    const counts = pub.scout!;
    const ctx = { roles: "4,5", signupMmr: 3_200, rankTier: 63, league: "us" as const };
    expect(view().tiles).toEqual(scoutingTiles(counts, ctx));
    expect(view().findings).toEqual(scoutingSentences(counts, ctx));
    const level = (mmr: number) =>
      view({ player: { ...player, mmr } }).tiles.find((t) => t.key === "level")
        ?.note;
    expect(level(3_200)).not.toBe(level(5_000));
  });

  it("has no tiles or findings without enough games, but names the window of its heroes", () => {
    const thin = poolPubRecord(blob(scout(3)), new Date(NOW_MS))!;
    const v = view({ scout: { pub: thin } });
    expect(v.tiles).toEqual([]);
    expect(v.findings).toEqual([]);
    expect(v.moreScout).toBeNull();
    expect(v.heroes?.kind).toBe("recent");
    expect(v.caption).toBe("Their last 3 public games");
    // No heroes and no tiles: nothing to caption.
    const bare = poolPubRecord(
      blob({ ...scout(3), heroes: [] }),
      new Date(NOW_MS),
    )!;
    expect(view({ scout: { pub: bare } }).caption).toBeNull();
  });

  it("dates a few Turbo games' heroes when no Pubs token can", () => {
    const turbo = poolPubRecord(
      blob(scout(7, { game_mode: 23 }), { recentWins: 0, recentLosses: 0 }),
      new Date(NOW_MS - 3 * DAY),
    )!;
    const v = view({ scout: { pub: turbo } });
    expect(v.record.map((t) => t.key)).not.toContain("pubs");
    expect(v.tiles).toEqual([]);
    expect(v.heroes?.kind).toBe("recent");
    expect(v.caption).toBe("Their last 7 public games · checked 3d ago");
  });

  it("shows recent pub heroes, else the all-time ones, else none", () => {
    expect(view().heroes).toEqual({ kind: "recent", scout: pub.scout });
    const old = poolPubRecord(blob(null), new Date(NOW_MS))!;
    expect(view({ scout: { pub: old } }).heroes).toEqual({
      kind: "mostPlayed",
      heroes: old.topHeroes,
    });
    expect(view({ scout: {} }).heroes).toBeNull();
  });

  it("takes the nominee's favorites and about text from the tick, blank included", () => {
    expect(view().favoriteHeroes).toBe("Lion");
    expect(view().about).toBe("From the map.");
    const live = view({ live: { favoriteHeroes: "", about: "Fresh." } });
    expect(live.favoriteHeroes).toBe("");
    expect(live.about).toBe("Fresh.");
  });

  it("gives the compact card one strip: the record, then the reads to draft on", () => {
    const counts = pub.scout!;
    const ctx = { roles: "4,5", signupMmr: 3_200, rankTier: 63, league: "us" as const };
    const tiles = scoutingTiles(counts, ctx);
    const v = view();
    const reads = tiles.filter(
      (t) => t.key === "role" || t.key === "level" || t.tone === "warn",
    );
    expect(v.segments.map((s) => s.key)).toEqual([
      "lastSeason",
      "inhouse",
      "pubs",
      ...reads.map((t) => t.key),
    ]);
    expect(v.segments.slice(0, 3)).toEqual([
      {
        key: "lastSeason",
        label: "Season 1",
        value: "Dire Straits · 4W 0D 3L · $12 🏆",
        title: lastSeasonTitle(lastSeason),
        tone: "info",
      },
      {
        key: "inhouse",
        label: "Inhouse",
        value: "1042 · 7–3",
        title: inhouseTitle(inhouse),
        tone: "info",
      },
      {
        key: "pubs",
        label: "Pubs · 3d ago",
        value: "55% of 40",
        title: pubTitle(pub, NOW_MS),
        tone: "info",
      },
    ]);
    // A pub read keeps its tile's words, tone, hover and medal.
    const level = tiles.find((t) => t.key === "level")!;
    expect(v.segments.find((s) => s.key === "level")).toEqual({
      key: "level",
      label: level.label,
      value: level.lead,
      title: level.title,
      tone: level.tone,
      ...(level.rankTier ? { rankTier: level.rankTier } : {}),
    });
    // The quiet tiles stay in the full card.
    const shown = new Set(v.segments.map((s) => s.key));
    for (const t of tiles) {
      if (!reads.includes(t)) expect(shown.has(t.key)).toBe(false);
    }
    // Any other read joins once it is worth a second look: a US signup
    // whose pubs are on a European server.
    const abroad = poolPubRecord(
      blob(scout(40, { cluster: 133 })),
      new Date(NOW_MS - 3 * DAY),
    )!;
    const server = view({ scout: { pub: abroad } }).segments.find(
      (s) => s.key === "server",
    );
    expect(server?.tone).toBe("warn");
  });

  it("marks a provisional inhouse record and a quiet account in the strip", () => {
    const provisional = { ...inhouse, rank: null, wins: 2, losses: 1, games: 3 };
    expect(
      view({ scout: { inhouse: provisional } }).segments,
    ).toEqual([
      {
        key: "inhouse",
        label: "Inhouse",
        value: "2–1, new",
        title: inhouseTitle(provisional),
        tone: "info",
      },
    ]);
    const quietPub = poolPubRecord(
      blob(scout(), { lastPlayedAt: NOW - 90 * 86_400 }),
      new Date(NOW_MS - DAY),
    )!;
    expect(
      view({ scout: { pub: quietPub } }).segments.find((s) => s.key === "quiet"),
    ).toEqual({
      key: "quiet",
      label: "Last played",
      value: "2mo ago",
      title: PUB_QUIET_TITLE,
      tone: "warn",
    });
    // Too few games for a tile: the record alone.
    const thin = poolPubRecord(blob(scout(3)), new Date(NOW_MS))!;
    expect(
      view({ scout: { pub: thin } }).segments.map((s) => s.key),
    ).toEqual(["pubs"]);
  });

  it("offers the full card only when it shows more than the compact one", () => {
    // Tiles and findings.
    expect(view().hasMore).toBe(true);
    // Nothing but a short about text: the compact card is the whole card.
    const short = { about: "Pos 4 main." };
    expect(view({ scout: short }).hasMore).toBe(false);
    expect(view({ scout: {} }).hasMore).toBe(false);
    // An about text too long for the compact card's one line.
    const long = { about: "x".repeat(DRAFT_ABOUT_COMPACT_CHARS + 1) };
    expect(view({ scout: long }).hasMore).toBe(true);
    expect(
      view({ scout: { about: "x".repeat(DRAFT_ABOUT_COMPACT_CHARS) } }).hasMore,
    ).toBe(false);
    // The live about text is the one measured.
    expect(
      view({ scout: long, live: { favoriteHeroes: "", about: "Short." } })
        .hasMore,
    ).toBe(false);
    // A few Turbo games' heroes are captioned in the full card.
    const turbo = poolPubRecord(
      blob(scout(7, { game_mode: 23 }), { recentWins: 0, recentLosses: 0 }),
      new Date(NOW_MS - 3 * DAY),
    )!;
    expect(view({ scout: { pub: turbo } }).hasMore).toBe(true);
  });

  it("tells an empty entry from a missing one", () => {
    const empty = view({ scout: {} });
    expect(empty.known).toBe(true);
    expect(empty.nothingOnFile).toBe(true);
    const missing = view({ scout: undefined });
    expect(missing.known).toBe(false);
    expect(missing.nothingOnFile).toBe(false);
    expect(missing.record).toEqual([]);
    expect(view().nothingOnFile).toBe(false);
  });
});

describe("the pool's one open card", () => {
  it("follows the lined-up pick for a picker, the opened row for anyone else", () => {
    expect(poolPanelOpenId({ canPick: true, selected: "a", inspected: "b" })).toBe("a");
    expect(poolPanelOpenId({ canPick: true, selected: null, inspected: "b" })).toBeNull();
    expect(poolPanelOpenId({ canPick: false, selected: "a", inspected: "b" })).toBe("b");
  });

  it("a tap opens a row and a second tap closes it", () => {
    expect(toggleInspected(null, "a")).toBe("a");
    expect(toggleInspected("a", "b")).toBe("b");
    expect(toggleInspected("a", "a")).toBeNull();
  });

  it("closes only the card of the player who went on the block", () => {
    const watching = (onBlockId: string | null) => ({ onBlockId, canPick: false });
    expect(inspectedAfterChange("a", watching(null), watching("a"))).toBeNull();
    expect(inspectedAfterChange("a", watching(null), watching("b"))).toBe("a");
    expect(inspectedAfterChange("a", watching("b"), watching(null))).toBe("a");
    expect(inspectedAfterChange("a", watching("b"), watching("b"))).toBe("a");
    expect(inspectedAfterChange(null, watching(null), watching("a"))).toBeNull();
  });

  it("starts with no card open when the viewer starts or stops lining up picks", () => {
    // An admin opens X during a lot, their nomination phase comes round (a
    // picker: the card hides), then a nomination ends it. X must not reopen.
    const lot = { onBlockId: "z", canPick: false };
    const turn = { onBlockId: null, canPick: true };
    const next = { onBlockId: "y", canPick: false };
    const afterTurn = inspectedAfterChange("x", lot, turn);
    expect(afterTurn).toBeNull();
    expect(inspectedAfterChange(afterTurn, turn, next)).toBeNull();
    // Even when nothing else moved in the same poll.
    expect(
      inspectedAfterChange("x", { onBlockId: "z", canPick: false }, { onBlockId: "z", canPick: true }),
    ).toBeNull();
  });

  it("the hint says what a tap does", () => {
    expect(poolTapHint(true)).toBe(
      "Tap a player to line them up and see their scouting.",
    );
    expect(poolTapHint(false)).toBe("Tap a player to see their scouting.");
  });
});
