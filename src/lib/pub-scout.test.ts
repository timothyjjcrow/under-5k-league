import { describe, expect, it } from "vitest";
import {
  claimedRoleLean,
  medalMidMmr,
  parsePubScout,
  pubHeroRows,
  pubLobbyRead,
  pubModeRead,
  pubPositionRead,
  pubRegionRead,
  pubRoleRead,
  pubScoutHasReads,
  PUB_SCOUT_VERSION,
  regionForCluster,
  roleClaimDiffers,
  scoutingFacts,
  scoutingRowParts,
  scoutingTiles,
  scoutingTitle,
  summarizePubMatches,
  type PubScout,
  type ScoutContext,
} from "./pub-scout";

const NOW = 1_792_600_000; // epoch seconds

/** A matchmaking game: ranked All Pick, 40 minutes, on US East, a win as a
 *  support (1.5 last hits a minute) on Lion. */
const game = (over: Record<string, unknown> = {}) => ({
  hero_id: 26,
  player_slot: 1,
  radiant_win: true,
  kills: 2,
  deaths: 6,
  assists: 14,
  gold_per_min: 300,
  last_hits: 60,
  duration: 40 * 60,
  game_mode: 22,
  lobby_type: 7,
  party_size: 1,
  average_rank: 63,
  cluster: 122,
  leaver_status: 0,
  start_time: NOW,
  lane_role: null,
  is_roaming: false,
  ...over,
});

const times = (n: number, over: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) =>
    game({ start_time: NOW - i * 3_600, ...over }),
  );

describe("summarizePubMatches", () => {
  it("reads core and support from last hits a minute, leaving the middle out", () => {
    const s = summarizePubMatches([
      ...times(3, { last_hits: 280 }), // 7 a minute
      ...times(2, { last_hits: 140 }), // exactly 3.5: core
      ...times(4, { last_hits: 99 }), // just under 2.5: support
      ...times(5, { last_hits: 120 }), // 3: neither
    ]);
    expect(s).toMatchObject({ core: 5, support: 4, games: 14 });
    expect(s.coreAverages).toMatchObject({ games: 5 });
    expect(s.supportAverages).toMatchObject({
      games: 4,
      lastHitsPerMin: 2.5,
      gpm: 300,
      kills: 2,
      deaths: 6,
      assists: 14,
    });
  });

  it("judges only matchmaking games of ten minutes or more", () => {
    const s = summarizePubMatches([
      game({ duration: 9 * 60 }), // an abandon
      game({ game_mode: 23 }), // Turbo farms faster
      game({ lobby_type: 1 }), // a practice lobby: an inhouse or league game
      game({ game_mode: 18 }), // Ability Draft
      game(),
    ]);
    expect(s.support).toBe(1);
    expect(s.core).toBe(0);
  });

  it("names positions from parsed lanes: a core's lane, a support's partner", () => {
    const s = summarizePubMatches([
      ...times(4, { last_hits: 280, lane_role: 3 }), // core offlane: pos 3
      game({ last_hits: 280, lane_role: 2 }), // mid: pos 2
      game({ lane_role: 1 }), // support safe lane: pos 5
      game({ lane_role: 3 }), // support offlane: pos 4
      game({ is_roaming: true, lane_role: 1 }), // a roamer: pos 4
      game({ last_hits: 280 }), // no lane: no position
      game({ last_hits: 120, lane_role: 1 }), // neither side: no position
    ]);
    expect(s.positions).toEqual([0, 1, 4, 2, 1]);
  });

  it("keeps their newest results: last 20 and a newest-first form of 10", () => {
    const rows = [
      ...times(3, { player_slot: 130 }), // newest: three losses
      ...times(22),
      game({ game_mode: 23, player_slot: 130 }), // Turbo never counts
    ];
    const s = summarizePubMatches(rows);
    expect(s.form).toBe("LLLWWWWWWW");
    expect(s).toMatchObject({ recentWins: 17, recentLosses: 3 });
  });

  it("splits every game in the window by mode", () => {
    const s = summarizePubMatches([
      ...times(5),
      ...times(3, { lobby_type: 0 }),
      ...times(4, { game_mode: 23, lobby_type: 0 }),
      game({ lobby_type: 1 }),
      game({ game_mode: 18, lobby_type: 0 }),
    ]);
    expect(s).toMatchObject({ games: 14, ranked: 5, unranked: 3, turbo: 4 });
    expect(pubModeRead(s)).toEqual([
      { key: "ranked", label: "ranked", games: 5, percent: 36 },
      { key: "turbo", label: "Turbo", games: 4, percent: 29 },
      { key: "unranked", label: "unranked", games: 3, percent: 21 },
      { key: "other", label: "other modes", games: 2, percent: 14 },
    ]);
  });

  it("averages ranked lobbies when there are ten, else every matchmaking game", () => {
    // Ancient 3's band middle is 4235, Legend 3's 3465.
    const ranked = summarizePubMatches([
      ...times(10, { average_rank: 63 }),
      ...times(10, { average_rank: 53, lobby_type: 0 }),
    ]);
    expect(ranked).toMatchObject({
      lobbyMmr: 4235,
      lobbyGames: 10,
      lobbyRanked: true,
    });
    const mixed = summarizePubMatches([
      ...times(4, { average_rank: 63 }),
      ...times(4, { average_rank: 53, lobby_type: 0 }),
      game({ average_rank: 80, game_mode: 23 }), // Turbo's lobby never counts
      game({ average_rank: null }),
    ]);
    expect(mixed).toMatchObject({
      lobbyMmr: 3850,
      lobbyGames: 8,
      lobbyRanked: false,
    });
    expect(medalMidMmr(63)).toBe(4235);
    expect(medalMidMmr(80)).toBe(5720);
    expect(medalMidMmr(null)).toBeNull();
  });

  it("counts party games, early leaves and servers by region", () => {
    const s = summarizePubMatches([
      ...times(6, { cluster: 122, party_size: 2 }),
      ...times(2, { cluster: 129 }), // a new US East cluster
      ...times(3, { cluster: 111, leaver_status: 3 }),
      game({ cluster: 404, party_size: null, leaver_status: 1 }),
      game({ cluster: 133, game_mode: 23 }), // Turbo: matchmaking games only
    ]);
    expect(s).toMatchObject({ partyKnown: 12, party: 6, abandons: 3 });
    expect(s.regionGames).toBe(11);
    expect(s.regions).toEqual([
      { region: 2, games: 8 },
      { region: 1, games: 3 },
    ]);
    expect(regionForCluster(404)).toBeNull();
    expect(regionForCluster(275)).toBe(3);
  });

  it("lists heroes across ranked, unranked and Turbo, most played first", () => {
    const s = summarizePubMatches([
      ...times(3, { hero_id: 1, kills: 10, deaths: 2, assists: 4 }),
      ...times(2, { hero_id: 2, game_mode: 23, player_slot: 130 }),
      game({ hero_id: 3, game_mode: 18 }), // Ability Draft picks no hero
      game({ hero_id: 0 }),
    ]);
    expect(s.heroCount).toBe(2);
    expect(s.heroes.map((h) => [h.heroId, h.games, h.wins])).toEqual([
      [1, 3, 3],
      [2, 2, 0],
    ]);
    expect(pubHeroRows(s)[0]).toEqual({ heroId: 1, games: 3, wins: 3, kda: 7 });
  });

  it("dates the window and survives junk rows", () => {
    const s = summarizePubMatches([
      null,
      "x",
      { game_mode: "22", lobby_type: 7 },
      game({ start_time: NOW }),
      game({ start_time: NOW - 86_400 * 3 }),
    ]);
    expect(s).toMatchObject({
      v: PUB_SCOUT_VERSION,
      games: 5,
      ranked: 2,
      firstAt: NOW - 86_400 * 3,
      lastAt: NOW,
    });
  });

  it("an empty window is all zeros", () => {
    expect(summarizePubMatches([])).toMatchObject({
      games: 0,
      core: 0,
      support: 0,
      lobbyMmr: null,
      heroes: [],
      heroCount: 0,
      positions: [0, 0, 0, 0, 0],
      form: "",
      firstAt: null,
    });
  });
});

/** A season's worth of a support who signs up honestly. */
const scout = (over: Partial<PubScout> = {}): PubScout => ({
  ...summarizePubMatches(times(100)),
  ...over,
});

const ctx = (over: Partial<ScoutContext> = {}): ScoutContext => ({
  roles: "4,5",
  signupMmr: 4200,
  rankTier: 63,
  league: "us",
  ...over,
});

describe("the reads", () => {
  it("names the side they mostly play, or both", () => {
    expect(pubRoleRead(scout({ core: 10, support: 70 }))).toMatchObject({
      lean: "support",
      percent: 88,
    });
    expect(pubRoleRead(scout({ core: 70, support: 10 }))).toMatchObject({
      lean: "core",
      percent: 88,
    });
    expect(pubRoleRead(scout({ core: 40, support: 40 }))?.lean).toBe("both");
  });

  it("shows nothing below ten games, and positions from five", () => {
    const thin = scout({
      games: 9,
      core: 5,
      support: 4,
      lobbyGames: 9,
      regionGames: 9,
      partyKnown: 9,
      recentWins: 5,
      recentLosses: 4,
      heroes: [],
      positions: [0, 0, 0, 4, 0],
    });
    expect(pubRoleRead(thin)).toBeNull();
    expect(pubLobbyRead(thin)).toBeNull();
    expect(pubModeRead(thin)).toBeNull();
    expect(pubRegionRead(thin)).toBeNull();
    expect(pubPositionRead(thin)).toBeNull();
    expect(pubScoutHasReads(thin)).toBe(false);
    expect(scoutingFacts(thin, ctx())).toEqual([]);
    expect(pubPositionRead(scout({ positions: [0, 0, 0, 3, 2] }))).toEqual([
      { position: 4, games: 3 },
      { position: 5, games: 2 },
    ]);
  });

  it("rounds the lobby to 50 MMR and names its medal", () => {
    expect(pubLobbyRead(scout({ lobbyMmr: 4180, lobbyGames: 90 }))).toEqual({
      mmr: 4200,
      rankTier: 63,
      games: 90,
      ranked: true,
    });
  });

  it("sets a signup's side against what they play", () => {
    expect(claimedRoleLean(["4", "5"])).toBe("support");
    expect(claimedRoleLean(["1", "2"])).toBe("core");
    expect(claimedRoleLean(["3", "4"])).toBe("both");
    expect(claimedRoleLean([])).toBeNull();
    const support = pubRoleRead(scout());
    expect(roleClaimDiffers("core", support)).toBe(true);
    expect(roleClaimDiffers("support", support)).toBe(false);
    expect(roleClaimDiffers("both", support)).toBe(false);
    expect(roleClaimDiffers(null, support)).toBe(false);
  });
});

describe("scoutingFacts", () => {
  const byKey = (s: PubScout, c: ScoutContext) =>
    Object.fromEntries(scoutingFacts(s, c).map((f) => [f.key, f]));

  it("reads an honest support plainly", () => {
    const facts = byKey(scout(), ctx());
    expect(facts.role).toMatchObject({
      lead: "Support in 100 of 100 games",
      detail: "Signed up for Pos 4 and Pos 5: matches",
      tone: "good",
    });
    expect(facts.level).toMatchObject({
      lead: "Ancient 3 games (≈4,250)",
      tone: "good",
    });
    expect(facts.level.detail).toContain("close to their 4,200 signup MMR");
    expect(facts.modes).toMatchObject({
      lead: "Mostly ranked (100%)",
      tone: "info",
    });
    expect(facts.queue).toMatchObject({ lead: "Solo", tone: "info" });
    expect(facts.server).toMatchObject({
      lead: "US East (100%)",
      tone: "info",
    });
    expect(facts.form.lead).toBe("Won 20 of their last 20");
    // 100 games over about 4 days.
    expect(facts.activity.lead).toBe("About 24 games a day");
    expect(facts.leaves).toBeUndefined();
  });

  it("flags a signup on the other side", () => {
    expect(byKey(scout(), ctx({ roles: "1,2" })).role).toMatchObject({
      detail: "Signed up for Pos 1 and Pos 2: the other side",
      tone: "warn",
    });
  });

  it("flags games well above or below the signup MMR, and a stale medal", () => {
    const above = byKey(scout(), ctx({ signupMmr: 3500 })).level;
    expect(above.tone).toBe("warn");
    expect(above.detail).toContain("about 750 above their 3,500 signup MMR");
    const below = byKey(scout(), ctx({ signupMmr: 4900 })).level;
    expect(below.detail).toContain("about 650 below their 4,900 signup MMR");
    const stale = byKey(scout(), ctx({ rankTier: 15 })).level;
    expect(stale.tone).toBe("warn");
    expect(stale.detail).toContain("Well above their Herald 5 medal");
  });

  it("flags Turbo, a server far from the league, and early leaves", () => {
    const facts = byKey(
      scout({ ranked: 40, unranked: 10, turbo: 50, abandons: 3 }),
      ctx({ league: "eu" }),
    );
    expect(facts.modes).toMatchObject({
      lead: "50% Turbo, 40% ranked",
      tone: "warn",
    });
    expect(facts.server).toMatchObject({ tone: "warn" });
    expect(facts.server.detail).toContain("far from the league's servers");
    expect(facts.leaves).toMatchObject({
      lead: "3 of their last 100 games",
      tone: "warn",
    });
  });

  it("names lanes when enough are known", () => {
    const facts = byKey(scout({ positions: [0, 0, 0, 7, 2] }), ctx());
    expect(facts.positions).toMatchObject({
      lead: "Mostly Pos 4: 7 of 9 games with a known lane",
      detail: "Pos 4 ×7 · Pos 5 ×2",
    });
    expect(
      byKey(scout({ positions: [0, 0, 6, 0, 0] }), ctx()).positions.lead,
    ).toBe("Pos 3 in all 6 games with a known lane");
  });
});

describe("the pool row", () => {
  it("reads role, level, queue and server, a position when lanes settle it", () => {
    expect(scoutingRowParts(scout(), ctx())).toEqual([
      { key: "role", text: "plays support (100%)", warn: false },
      { key: "level", text: "in Ancient 3 games", warn: false },
      { key: "queue", text: "solo", warn: false },
      { key: "server", text: "US East", warn: false },
    ]);
    expect(
      scoutingRowParts(scout({ positions: [0, 0, 0, 8, 1] }), ctx())[0].text,
    ).toBe("plays Pos 4");
  });

  it("tints what is worth a second look and adds heavy Turbo", () => {
    const parts = scoutingRowParts(
      scout({ ranked: 40, unranked: 10, turbo: 50, abandons: 2 }),
      ctx({ roles: "1", signupMmr: 3000, league: "eu" }),
    );
    expect(parts.filter((p) => p.warn).map((p) => p.key)).toEqual([
      "role",
      "level",
      "turbo",
      "server",
      "leaves",
    ]);
    expect(parts.at(-1)?.text).toBe("left 2 early");
    expect(parts.find((p) => p.key === "turbo")?.text).toBe("50% Turbo");
  });

  it("the hover gives every fact as a sentence", () => {
    const title = scoutingTitle(scout(), ctx());
    expect(title.split("\n")[0]).toBe("Their last 100 public games");
    expect(title).toContain("Role: Support in 100 of 100 games");
  });
});

describe("parsePubScout", () => {
  it("round-trips the stored counts", () => {
    const s = summarizePubMatches([
      ...times(30, { lane_role: 1, party_size: 3 }),
      ...times(5, { game_mode: 23 }),
    ]);
    expect(parsePubScout(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("reads an older shape or junk as unknown", () => {
    expect(parsePubScout(null)).toBeNull();
    expect(parsePubScout("x")).toBeNull();
    // The first shape had no version.
    expect(
      parsePubScout({ games: 100, ranked: 90, core: 10, support: 70 }),
    ).toBeNull();
    expect(
      parsePubScout({
        ...scout(),
        lobbyMmr: -5,
        form: "WXL<script>",
        regions: [{ region: 2, games: 3 }, { region: "x" }, null],
        heroes: [
          { heroId: 5, games: 2, wins: 9 },
          { heroId: 0, games: 1 },
        ],
      }),
    ).toMatchObject({
      lobbyMmr: null,
      lobbyGames: 0,
      form: "WL",
      regions: [{ region: 2, games: 3 }],
      heroes: [{ heroId: 5, games: 2, wins: 2 }],
    });
  });
});

describe("scoutingTiles", () => {
  const tiles = (s: PubScout, c: ScoutContext) =>
    Object.fromEntries(scoutingTiles(s, c).map((t) => [t.key, t]));

  it("says each finding in a few words, with the full sentence as its hover", () => {
    const t = tiles(scout(), ctx());
    expect(Object.keys(t)).toEqual([
      "role",
      "level",
      "modes",
      "server",
      "form",
    ]);
    expect(t.role).toMatchObject({
      lead: "Support 100%",
      note: "Matches signup (Pos 4, 5)",
      tone: "good",
    });
    expect(t.role.title).toContain("Support in 100 of 100 games");
    expect(t.level).toMatchObject({
      label: "Ranked games at",
      lead: "≈4,250",
      note: "Near signup 4,200",
      rankTier: 63,
      tone: "good",
    });
    expect(t.modes).toMatchObject({ lead: "100% ranked", note: "Solo" });
    expect(t.server).toMatchObject({ lead: "US East 100%", note: null });
    expect(t.form).toMatchObject({
      label: "Last 20 games",
      lead: "20–0",
      note: "~24 games a day",
    });
  });

  it("leads with a position when lanes settle one, and tints what to look at", () => {
    const t = tiles(
      scout({
        positions: [0, 0, 0, 8, 1],
        ranked: 40,
        unranked: 10,
        turbo: 50,
        abandons: 3,
      }),
      ctx({ roles: "1,2", signupMmr: 3500, league: "eu" }),
    );
    expect(t.role).toMatchObject({
      lead: "Pos 4",
      note: "Signed up Pos 1, 2",
      tone: "warn",
    });
    expect(t.level).toMatchObject({
      note: "750 over signup 3,500",
      tone: "warn",
    });
    expect(t.modes).toMatchObject({
      lead: "50% Turbo",
      note: "Solo · 40% ranked",
      tone: "warn",
    });
    expect(t.server).toMatchObject({
      note: "Far from league servers",
      tone: "warn",
    });
    expect(t.leaves).toMatchObject({
      lead: "3 games",
      note: "of their last 100",
      tone: "warn",
    });
  });

  it("names a stale medal, and leaves out what has too few games", () => {
    expect(tiles(scout(), ctx({ rankTier: 15 })).level.note).toBe(
      "Above their Herald 5 medal",
    );
    expect(
      scoutingTiles(
        scout({
          games: 9,
          core: 5,
          support: 4,
          lobbyGames: 9,
          regionGames: 9,
          partyKnown: 9,
          recentWins: 5,
          recentLosses: 4,
        }),
        ctx(),
      ),
    ).toEqual([]);
  });
});
