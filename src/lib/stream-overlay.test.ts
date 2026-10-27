import { describe, expect, it } from "vitest";
import { matchNightRoster } from "./availability";
import {
  buildStreamOverlay,
  overlayImageUrl,
  overlayMedal,
  overlaySeats,
  seasonLinesFor,
  STREAM_OVERLAY_VERSION,
  type OverlayRosterRow,
  type OverlaySeasonMatch,
  type OverlayStandinRow,
  type OverlayUser,
  type StreamOverlayInput,
} from "./stream-overlay";

const user = (id: string, extra: Partial<OverlayUser> = {}): OverlayUser => ({
  id,
  name: `Player ${id}`,
  avatar: null,
  rankTier: null,
  pubStats: null,
  ...extra,
});

const member = (
  teamId: string,
  id: string,
  price: number,
  isCaptain = false,
): OverlayRosterRow => ({ teamId, isCaptain, price, user: user(id) });

let matchSeq = 0;
function fixture(over: Partial<OverlaySeasonMatch>): OverlaySeasonMatch {
  matchSeq += 1;
  return {
    id: `m${matchSeq}`,
    week: 1,
    phase: "REGULAR",
    bracketSlot: null,
    bestOf: 3,
    status: "SCHEDULED",
    homeScore: 0,
    awayScore: 0,
    winnerTeamId: null,
    forfeit: false,
    scheduledAt: null,
    homeTeamId: "A",
    awayTeamId: "B",
    ...over,
  };
}

/** A complete 5v5 box score: radiant ids first, then dire. */
function boxScore(
  radiant: string[],
  dire: string[],
  stats: Record<string, { k: number; d: number; a: number; hero?: number }> = {},
): string {
  const lines = [...radiant, ...dire].map((userId, index) => ({
    userId,
    accountId: 1000 + index,
    heroId: stats[userId]?.hero ?? 10 + index,
    isRadiant: index < 5,
    kills: stats[userId]?.k ?? 1,
    deaths: stats[userId]?.d ?? 5,
    assists: stats[userId]?.a ?? 2,
    gpm: 400,
  }));
  return JSON.stringify(lines);
}

describe("overlayImageUrl", () => {
  it("keeps https images and drops anything else", () => {
    expect(overlayImageUrl("https://i.imgur.com/a.png")).toBe("https://i.imgur.com/a.png");
    expect(overlayImageUrl("  https://i.imgur.com/a.png ")).toBe("https://i.imgur.com/a.png");
    expect(overlayImageUrl("http://i.imgur.com/a.png")).toBeNull();
    expect(overlayImageUrl("javascript:alert(1)")).toBeNull();
    expect(overlayImageUrl("not a url")).toBeNull();
    expect(overlayImageUrl("")).toBeNull();
    expect(overlayImageUrl(null)).toBeNull();
  });
});

describe("overlayMedal", () => {
  it("draws the site's medal files, with stars below Immortal", () => {
    expect(overlayMedal(55)).toEqual({
      name: "Legend 5",
      icon: "/ranks/rank_icon_5.png",
      star: "/ranks/rank_star_5.png",
    });
    expect(overlayMedal(80)).toEqual({
      name: "Immortal",
      icon: "/ranks/rank_icon_8.png",
      star: null,
    });
  });

  it("leaves an unknown medal out instead of saying Unranked", () => {
    expect(overlayMedal(null)).toBeNull();
    expect(overlayMedal(0)).toBeNull();
    expect(overlayMedal(5)).toBeNull();
  });
});

describe("overlaySeats", () => {
  const roster = [
    member("A", "a2", 10),
    member("A", "a1", 0, true),
    member("A", "a3", 20),
    member("B", "b1", 0, true),
  ];

  it("puts the captain first, then the roster by price", () => {
    expect(overlaySeats("A", roster, []).map((s) => s.user.id)).toEqual([
      "a1",
      "a3",
      "a2",
    ]);
  });

  it("seats a standin where the player they cover sat, and an empty-seat standin last", () => {
    const standins: OverlayStandinRow[] = [
      { teamId: "A", standin: user("s2"), replaced: null },
      { teamId: "A", standin: user("s1"), replaced: { id: "a3", name: "Player a3" } },
    ];
    const seats = overlaySeats("A", roster, standins);
    expect(seats.map((s) => s.user.id)).toEqual(["a1", "s1", "a2", "s2"]);
    expect(seats[1]).toMatchObject({ standin: true, standinFor: "Player a3", captain: false });
    expect(seats[3]).toMatchObject({ standin: true, standinFor: null });
  });

  it("seats exactly matchNightRoster's players: a stale booking adds nobody", () => {
    const standins: OverlayStandinRow[] = [
      // Covers someone no longer on the roster.
      { teamId: "A", standin: user("s9"), replaced: { id: "gone", name: "Gone" } },
      { teamId: "A", standin: user("s1"), replaced: { id: "a2", name: "Player a2" } },
    ];
    const seated = overlaySeats("A", roster, standins).map((s) => s.user.id);
    const expected = matchNightRoster(
      ["a1", "a3", "a2"],
      standins.map((s) => ({
        standinUserId: s.standin.id,
        replacingUserId: s.replaced?.id ?? null,
      })),
    );
    expect(new Set(seated)).toEqual(new Set(expected));
    expect(seated).not.toContain("s9");
  });

  it("covers a captain with a standin who is not made captain", () => {
    const seats = overlaySeats("A", roster, [
      { teamId: "A", standin: user("s1"), replaced: { id: "a1", name: "Player a1" } },
    ]);
    expect(seats[0]).toMatchObject({ captain: false, standin: true, standinFor: "Player a1" });
  });
});

describe("seasonLinesFor", () => {
  it("counts complete box scores only, with impact points and Match MVPs", () => {
    const radiant = ["a1", "a2", "a3", "a4", "a5"];
    const dire = ["b1", "b2", "b3", "b4", "b5"];
    const lines = seasonLinesFor(new Set(["a1", "b1"]), [
      {
        players: boxScore(radiant, dire, { a1: { k: 12, d: 1, a: 10 } }),
        radiantWin: true,
      },
      // Nine lines: an incomplete box score counts for nobody.
      { players: JSON.stringify(JSON.parse(boxScore(radiant, dire)).slice(0, 9)), radiantWin: true },
      { players: "not json", radiantWin: false },
    ]);
    expect(lines.get("a1")?.lines).toHaveLength(1);
    expect(lines.get("a1")?.mvps).toBe(1);
    expect(lines.get("b1")?.lines).toHaveLength(1);
    expect(lines.get("b1")?.mvps).toBe(0);
    // Only the asked-for players.
    expect(lines.has("a2")).toBe(false);
    // 12 kills and 10 assists at 2 each, a death, the win and a capped bonus.
    expect(lines.get("a1")!.impact).toBeGreaterThan(50);
  });
});

function baseInput(over: Partial<StreamOverlayInput> = {}): StreamOverlayInput {
  matchSeq = 0;
  const done1 = fixture({
    week: 1,
    homeTeamId: "A",
    awayTeamId: "C",
    status: "COMPLETED",
    homeScore: 2,
    awayScore: 0,
    winnerTeamId: "A",
  });
  const done2 = fixture({
    week: 2,
    homeTeamId: "C",
    awayTeamId: "B",
    status: "COMPLETED",
    homeScore: 2,
    awayScore: 0,
    winnerTeamId: "C",
  });
  const drew = fixture({
    week: 3,
    homeTeamId: "B",
    awayTeamId: "A",
    status: "COMPLETED",
    homeScore: 1,
    awayScore: 1,
    bestOf: 2,
  });
  const live = fixture({
    week: 4,
    status: "LIVE",
    homeScore: 1,
    awayScore: 0,
    scheduledAt: new Date("2026-10-11T01:00:00Z"),
  });
  const radiant = ["a1", "a2", "a3", "x1", "x2"];
  const dire = ["b1", "b2", "b3", "x3", "x4"];
  return {
    leagueName: "GGD2L",
    seasonId: "season-1",
    seasonName: "Season 2",
    season: { formatConfig: null },
    match: {
      ...live,
      homeTeam: { name: "Alpha Wolves", logoUrl: "https://i.imgur.com/alpha.png" },
      awayTeam: { name: "Bravo Bears", logoUrl: "http://insecure.example/b.png" },
    },
    kickoffText: "Sat, Oct 10, 6:00 PM Pacific",
    teams: [
      { id: "A", name: "Alpha Wolves", withdrawn: false, groupKey: null, createdAtMs: 1 },
      { id: "B", name: "Bravo Bears", withdrawn: false, groupKey: null, createdAtMs: 2 },
      { id: "C", name: "Charlie Cats", withdrawn: false, groupKey: null, createdAtMs: 3 },
    ],
    seasonMatches: [live, drew, done2, done1],
    roster: [
      member("A", "a1", 0, true),
      member("A", "a2", 15),
      member("A", "a3", 9),
      member("B", "b1", 0, true),
      member("B", "b2", 4),
      member("B", "b3", 3),
    ],
    standins: [],
    roles: new Map([
      ["a1", "1,2"],
      ["b1", "5"],
    ]),
    seasonGames: [
      {
        players: boxScore(radiant, dire, { a1: { k: 14, d: 0, a: 9, hero: 1 } }),
        radiantWin: true,
      },
    ],
    ...over,
  };
}

describe("buildStreamOverlay", () => {
  it("carries the fixture: round, format, score and kickoff", () => {
    const payload = buildStreamOverlay(baseInput());
    expect(payload.version).toBe(STREAM_OVERLAY_VERSION);
    expect(payload.league).toBe("GGD2L");
    expect(payload.seasonName).toBe("Season 2");
    expect(payload.match).toEqual({
      id: "m4",
      round: "Week 4",
      bestOf: 3,
      status: "LIVE",
      homeScore: 1,
      awayScore: 0,
      winner: null,
      forfeit: false,
      kickoffMs: Date.parse("2026-10-11T01:00:00Z"),
      kickoffText: "Sat, Oct 10, 6:00 PM Pacific",
    });
  });

  it("gives each team its record, table place, last results and crest", () => {
    const { home, away } = buildStreamOverlay(baseInput());
    // A: beat C, drew B. B: lost to C, drew A. C: one win, one loss.
    expect(home).toMatchObject({
      id: "A",
      name: "Alpha Wolves",
      initials: "AW",
      logoUrl: "https://i.imgur.com/alpha.png",
      record: "1W 1D 0L",
      standing: "1st of 3",
      form: ["D", "W"],
    });
    expect(away).toMatchObject({
      record: "0W 1D 1L",
      standing: "3rd of 3",
      form: ["D", "L"],
      // An http logo is dropped: the crest is drawn instead.
      logoUrl: null,
    });
    expect(home.hue).not.toBe(away.hue);
    expect(home.ink).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("names no record or place before any series is final", () => {
    const input = baseInput();
    const { home } = buildStreamOverlay({
      ...input,
      seasonMatches: input.seasonMatches.map((m) => ({
        ...m,
        status: "SCHEDULED",
        homeScore: 0,
        awayScore: 0,
        winnerTeamId: null,
      })),
    });
    expect(home.record).toBeNull();
    expect(home.standing).toBeNull();
    expect(home.form).toEqual([]);
  });

  it("names the winner of a decided series", () => {
    const input = baseInput();
    const payload = buildStreamOverlay({
      ...input,
      match: { ...input.match, status: "COMPLETED", homeScore: 2, winnerTeamId: "A" },
    });
    expect(payload.match.winner).toBe("home");
  });

  it("tells the meetings before this one, newest first", () => {
    const { notes } = buildStreamOverlay(baseInput());
    expect(notes).toEqual(["Week 3: Bravo Bears and Alpha Wolves drew 1–1"]);
  });

  it("says a first meeting, and a run of series wins going in", () => {
    matchSeq = 100;
    const wins = [1, 2, 3].map((week) =>
      fixture({
        week,
        homeTeamId: "A",
        awayTeamId: "C",
        status: "COMPLETED",
        homeScore: 2,
        awayScore: 0,
        winnerTeamId: "A",
      }),
    );
    const input = baseInput();
    const live = { ...input.match, week: 4 };
    const payload = buildStreamOverlay({
      ...input,
      match: live,
      seasonMatches: [...wins, live],
    });
    expect(payload.notes).toEqual([
      "Alpha Wolves have won 3 series in a row",
      "First meeting this season",
    ]);
    // Decided, the streak is no longer news going in.
    const done = { ...live, status: "COMPLETED", homeScore: 2, winnerTeamId: "A" };
    expect(
      buildStreamOverlay({ ...input, match: done, seasonMatches: [...wins, done] }).notes,
    ).toEqual(["First meeting this season"]);
  });

  it("names a knockout's seeds instead of the table place", () => {
    matchSeq = 200;
    const semi1 = fixture({ phase: "PLAYOFF", bracketSlot: "R0M0", homeTeamId: "A", awayTeamId: "D", week: 9 });
    const semi2 = fixture({ phase: "PLAYOFF", bracketSlot: "R0M1", homeTeamId: "B", awayTeamId: "C", week: 9 });
    const input = baseInput();
    const payload = buildStreamOverlay({
      ...input,
      match: { ...input.match, ...semi1, awayTeamId: "D", homeTeamId: "A" },
      teams: [
        ...input.teams,
        { id: "D", name: "Delta Dogs", withdrawn: false, groupKey: null, createdAtMs: 4 },
      ],
      seasonMatches: [...input.seasonMatches, semi1, semi2],
    });
    expect(payload.match.round).toBe("Semifinal");
    expect(payload.home.standing).toBe("Seed 1");
    expect(payload.away.standing).toBe("Seed 4");
  });

  describe("in a group season", () => {
    // Two groups of two. The league's rows are group A's table then group
    // B's, so D, top of Group B, is the third row of four: never "3rd of 4".
    const teams = [
      { id: "A", name: "Alpha Wolves", withdrawn: false, groupKey: "A", createdAtMs: 1 },
      { id: "B", name: "Bravo Bears", withdrawn: false, groupKey: "B", createdAtMs: 2 },
      { id: "C", name: "Charlie Cats", withdrawn: false, groupKey: "A", createdAtMs: 3 },
      { id: "D", name: "Delta Dogs", withdrawn: false, groupKey: "B", createdAtMs: 4 },
    ];
    const names = new Map(teams.map((team) => [team.id, team.name]));
    const won = (home: string, away: string) =>
      fixture({
        homeTeamId: home,
        awayTeamId: away,
        status: "COMPLETED",
        homeScore: 2,
        winnerTeamId: home,
      });
    const sides = (m: OverlaySeasonMatch) => ({
      ...m,
      homeTeam: { name: names.get(m.homeTeamId)!, logoUrl: null },
      awayTeam: { name: names.get(m.awayTeamId)!, logoUrl: null },
    });

    it("places each team within its own group", () => {
      matchSeq = 300;
      const results = [won("A", "C"), won("D", "B")];
      const live = fixture({ week: 2, homeTeamId: "D", awayTeamId: "B", status: "LIVE" });
      const { home, away } = buildStreamOverlay({
        ...baseInput(),
        teams,
        match: sides(live),
        seasonMatches: [...results, live],
      });
      expect(home).toMatchObject({ record: "1W 0D 0L", standing: "1st of 2 in Group B" });
      expect(away).toMatchObject({ record: "0W 0D 1L", standing: "2nd of 2 in Group B" });
    });

    it("names a knockout's seeds as the bracket does", () => {
      matchSeq = 400;
      const results = [won("A", "C"), won("D", "B")];
      // Seeds alternate the groups place by place: A1 1, B1 2, A2 3, B2 4.
      const semi1 = fixture({ phase: "PLAYOFF", bracketSlot: "R0M0", homeTeamId: "A", awayTeamId: "B", week: 4 });
      const semi2 = fixture({ phase: "PLAYOFF", bracketSlot: "R0M1", homeTeamId: "D", awayTeamId: "C", week: 4 });
      const { home, away } = buildStreamOverlay({
        ...baseInput(),
        teams,
        match: sides(semi1),
        seasonMatches: [...results, semi1, semi2],
      });
      expect(home.standing).toBe("Seed A1");
      expect(away.standing).toBe("Seed B2");
    });
  });

  it("lists tonight's players home side first, captain first", () => {
    const { players } = buildStreamOverlay(baseInput());
    expect(players.map((p) => p.id)).toEqual(["a1", "a2", "a3", "b1", "b2", "b3"]);
    expect(players.map((p) => p.side)).toEqual(["home", "home", "home", "away", "away", "away"]);
    expect(players[0]).toMatchObject({ captain: true, roles: ["Carry", "Mid"] });
    expect(players[3]).toMatchObject({ captain: true, roles: ["Hard Support"] });
  });

  it("gives a player their season line from the box scores", () => {
    const { players } = buildStreamOverlay(baseInput());
    const captain = players[0];
    expect(captain.season).toMatchObject({
      games: 1,
      wins: 1,
      losses: 0,
      kills: 14,
      deaths: 0,
      assists: 9,
      mvps: 1,
    });
    expect(captain.season!.impact).toBeGreaterThan(40);
    expect(captain.heroes).toEqual([
      expect.objectContaining({ name: "Anti-Mage", games: 1, wins: 1 }),
    ]);
    expect(captain.heroes[0].portrait).toMatch(/^https:\/\/.+antimage\.png$/);
    expect(captain.heroesFrom).toBe("league");
  });

  it("shows a player's pub heroes before their first league game, and says so", () => {
    const input = baseInput();
    const pubs = JSON.stringify({
      recentWins: 10,
      recentLosses: 8,
      totalGames: 500,
      lastPlayedAt: null,
      topHeroes: [
        { heroId: 26, games: 90, wins: 50 },
        { heroId: 5, games: 60, wins: 30 },
      ],
    });
    const payload = buildStreamOverlay({
      ...input,
      standins: [
        {
          teamId: "B",
          standin: user("s1", { name: "Sub", rankTier: 43, pubStats: pubs }),
          replaced: { id: "b3", name: "Player b3" },
        },
      ],
    });
    const sub = payload.players.find((p) => p.id === "s1")!;
    expect(sub).toMatchObject({
      side: "away",
      standin: true,
      standinFor: "Player b3",
      season: null,
      heroesFrom: "pubs",
      medal: { name: "Archon 3" },
    });
    expect(sub.heroes.map((h) => [h.name, h.games])).toEqual([
      ["Lion", 90],
      ["Crystal Maiden", 60],
    ]);
    expect(payload.players.some((p) => p.id === "b3")).toBe(false);
  });

  it("carries display facts only: no MMR, contact or account detail", () => {
    const payload = buildStreamOverlay(baseInput());
    for (const player of payload.players) {
      expect(Object.keys(player).sort()).toEqual(
        [
          "avatar",
          "captain",
          "heroes",
          "heroesFrom",
          "id",
          "medal",
          "name",
          "roles",
          "season",
          "side",
          "standin",
          "standinFor",
        ].sort(),
      );
    }
    const text = JSON.stringify(payload).toLowerCase();
    for (const word of ["mmr", "discord", "steamid", "pubstats", "accountid"]) {
      expect(text).not.toContain(word);
    }
  });
});
