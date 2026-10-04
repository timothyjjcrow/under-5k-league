import { describe, expect, it } from "vitest";
import { careerReportCard } from "./benchmarks";
import { playerCardFacts, playerCardRoleText } from "./player-card";
import {
  profileSeasonNote,
  profileSeasonRecord,
  profileSeasonRows,
} from "./profile-seasons";

const seasons = new Map([
  ["s1", { name: "Season 1", createdAt: new Date("2026-01-01") }],
  ["s2", { name: "Season 2", createdAt: new Date("2026-05-01") }],
]);
const teamNames = new Map([
  ["a", "Alpha"],
  ["b", "Bravo"],
  ["c", "Charlie"],
]);

const app = (
  over: Partial<{
    teamId: string;
    seasonId: string;
    games: number;
    seriesWins: number;
    seriesLosses: number;
    seriesDraws: number;
  }> = {},
) => ({
  teamId: "a",
  seasonId: "s1",
  games: 3,
  seriesWins: 1,
  seriesLosses: 1,
  seriesDraws: 0,
  ...over,
});

const tenure = (
  over: Partial<{
    seasonId: string;
    teamId: string | null;
    teamName: string;
    joinedAt: Date;
    active: boolean;
    acquisitionKind: string;
    price: number;
    captain: boolean | null;
    endReason: string | null;
  }> = {},
) => ({
  seasonId: "s1",
  teamId: "a" as string | null,
  teamName: "Alpha",
  joinedAt: new Date("2026-01-10"),
  active: true,
  acquisitionKind: "AUCTION",
  price: 12,
  captain: false as boolean | null,
  endReason: null as string | null,
  ...over,
});

const rows = (input: Partial<Parameters<typeof profileSeasonRows>[0]>) =>
  profileSeasonRows({
    seasons,
    appearances: [],
    tenures: [],
    covers: [],
    teamNames,
    champions: new Map(),
    ...input,
  });

describe("profileSeasonRows", () => {
  it("merges the roster, games and title into one row per season and team", () => {
    const [row] = rows({
      appearances: [app()],
      tenures: [tenure()],
      champions: new Map([["s1", "a"]]),
    });
    expect(row).toMatchObject({
      seasonName: "Season 1",
      teamId: "a",
      teamName: "Alpha",
      role: { kind: "drafted", price: 12 },
      games: 3,
      series: { wins: 1, losses: 1, draws: 0 },
      stoodIn: 0,
      champion: true,
    });
    expect(profileSeasonNote(row)).toBe("Drafted for $12");
    expect(profileSeasonRecord(row)).toBe("1W 0D 1L series · 3 games");
  });

  it("says Captain for a captain's older record instead of a $0 price", () => {
    // Captured from a surviving roster row: no acquisition facts, $0 price,
    // but the live roster row says captain.
    const [row] = rows({
      tenures: [
        tenure({ acquisitionKind: "LEGACY_CAPTURE", price: 0, captain: true }),
      ],
    });
    expect(row.role).toEqual({ kind: "captain" });
    expect(profileSeasonNote(row)).toBeNull();
  });

  it("uses the live captain flag over how they joined", () => {
    const [promoted] = rows({ tenures: [tenure({ captain: true })] });
    expect(promoted.role).toEqual({ kind: "captain" });
    const [handedOver] = rows({
      tenures: [
        tenure({ acquisitionKind: "CAPTAIN_DESIGNATION", price: 0, captain: false }),
      ],
    });
    expect(handedOver.role).toBeNull();
  });

  it("labels free-agent signings and leaves unknown $0 older records unlabelled", () => {
    const [signed] = rows({
      tenures: [tenure({ acquisitionKind: "FREE_AGENT", price: 0 })],
    });
    expect(profileSeasonNote(signed)).toBe("Signed as a free agent");
    const [older] = rows({
      tenures: [tenure({ acquisitionKind: "LEGACY_CAPTURE", price: 0 })],
    });
    expect(older.role).toBeNull();
    const [olderPaid] = rows({
      tenures: [tenure({ acquisitionKind: "LEGACY_CAPTURE", price: 9 })],
    });
    expect(olderPaid.role).toEqual({ kind: "drafted", price: 9 });
  });

  it("credits a standin's cover on the team they covered, counted per match", () => {
    const [row] = rows({
      appearances: [app({ teamId: "b", games: 2, seriesWins: 1, seriesLosses: 0 })],
      covers: [
        { seasonId: "s1", teamId: "b", matchId: "m1" },
        { seasonId: "s1", teamId: "b", matchId: "m1" },
        { seasonId: "s1", teamId: "b", matchId: "m2" },
      ],
    });
    expect(row).toMatchObject({ teamName: "Bravo", role: null, stoodIn: 2 });
    expect(profileSeasonNote(row)).toBe("Stood in for 2 matches");
    expect(profileSeasonRecord(row)).toBe("1W 0D 0L series · 2 games");
  });

  it("keeps cover served on matches whose games were never imported", () => {
    const [row] = rows({
      covers: [{ seasonId: "s2", teamId: "c", matchId: "m9" }],
      champions: new Map([["s2", "c"]]),
    });
    expect(row).toMatchObject({
      seasonName: "Season 2",
      teamName: "Charlie",
      games: 0,
      series: null,
      stoodIn: 1,
      champion: true,
    });
    expect(profileSeasonNote(row)).toBe("Stood in for 1 match");
    expect(profileSeasonRecord(row)).toBeNull();
  });

  it("drops rosters that never became a season: undone sales, aborted drafts, dissolved teams, swapped-out captains", () => {
    expect(
      rows({
        tenures: [
          tenure({ active: false, endReason: "DRAFT_UNDO" }),
          tenure({ teamId: "b", teamName: "Bravo", active: false, endReason: "DRAFT_ABORT" }),
          tenure({
            teamId: null,
            teamName: "Gone",
            active: false,
            endReason: "PRE_DRAFT_TEAM_REMOVED",
          }),
          // changeCaptain keeps the team, so the tenure keeps its teamId.
          tenure({
            teamId: "c",
            teamName: "Charlie",
            active: false,
            acquisitionKind: "CAPTAIN_DESIGNATION",
            price: 0,
            captain: true,
            endReason: "PRE_DRAFT_CAPTAIN_CHANGED",
          }),
        ],
      }),
    ).toEqual([]);
    // A release is real history: they were on that team.
    const [released] = rows({
      tenures: [tenure({ active: false, endReason: "RELEASE" })],
    });
    expect(released.role).toEqual({ kind: "drafted", price: 12 });
  });

  it("never takes the role from a voided tenure on a row that exists anyway", () => {
    // Swapped out as captain before the draft, then bought back by the same
    // team in the auction: they were drafted, not its captain.
    const [rebought] = rows({
      tenures: [
        tenure({
          joinedAt: new Date("2026-01-01"),
          active: false,
          acquisitionKind: "CAPTAIN_DESIGNATION",
          price: 0,
          captain: true,
          endReason: "PRE_DRAFT_CAPTAIN_CHANGED",
        }),
        tenure({ price: 9 }),
      ],
    });
    expect(rebought.role).toEqual({ kind: "drafted", price: 9 });
  });

  it("only hands the trophy to players who were part of the title team", () => {
    const champions = new Map([["s1", "a"]]);
    // Released before playing a game for the eventual champion.
    const [released] = rows({
      tenures: [tenure({ active: false, endReason: "RELEASE" })],
      champions,
    });
    expect(released.champion).toBe(false);
    // Still on the roster at the end, even without an imported game.
    const [bench] = rows({ tenures: [tenure()], champions });
    expect(bench.champion).toBe(true);
    // Played for a different team that season.
    const [other] = rows({ appearances: [app({ teamId: "b" })], champions });
    expect(other.champion).toBe(false);
  });

  it("orders seasons newest first and the roster team first within a season", () => {
    const list = rows({
      appearances: [
        app({ seasonId: "s1", teamId: "b", games: 5 }),
        app({ seasonId: "s2", teamId: "c", games: 1 }),
      ],
      tenures: [tenure({ seasonId: "s1", teamId: "a", teamName: "Alpha" })],
    });
    expect(list.map((row) => [row.seasonName, row.teamName])).toEqual([
      ["Season 2", "Charlie"],
      ["Season 1", "Alpha"],
      ["Season 1", "Bravo"],
    ]);
  });

  it("prefers the current team name and skips seasons it doesn't know", () => {
    const [renamed] = rows({
      tenures: [tenure({ teamName: "Old Alpha name" })],
    });
    expect(renamed.teamName).toBe("Alpha");
    expect(
      rows({ appearances: [app({ seasonId: "deleted" })] }),
    ).toEqual([]);
  });

  it("writes draws into the series record", () => {
    const [row] = rows({
      appearances: [app({ games: 1, seriesWins: 2, seriesLosses: 1, seriesDraws: 1 })],
    });
    expect(profileSeasonRecord(row)).toBe("2W 1D 1L series · 1 game");
  });
});

describe("the season a player's card names, from these rows", () => {
  // The card's history branch (playerCardFacts with no current season of
  // theirs) over real rows: the order profileSeasonRows sorts them in is the
  // order the card trusts. These replaced latestLeagueLine's tests when the
  // card took over the header's past-season line.
  const card = (input: Partial<Parameters<typeof profileSeasonRows>[0]>) => {
    const facts = playerCardFacts({
      activeSeason: null,
      signup: null,
      membership: null,
      seasonRows: rows(input),
      teamLogos: new Map(),
      rankTier: null,
      leagueHeroes: [],
      pubHeroes: [],
      report: careerReportCard([]),
      achievements: [],
      recordsHeld: 0,
    });
    return {
      season: facts.season?.name ?? null,
      team: facts.team?.name ?? null,
      role: playerCardRoleText(facts),
      titles: facts.titles.map((t) => t.seasonName),
    };
  };

  it("names the newest season and its team", () => {
    expect(
      card({
        tenures: [
          tenure(),
          tenure({
            seasonId: "s2",
            teamId: "b",
            teamName: "Bravo",
            joinedAt: new Date("2026-05-10"),
          }),
        ],
      }),
    ).toEqual({
      season: "Season 2",
      team: "Bravo",
      role: "Drafted for $12",
      titles: [],
    });
  });

  it("carries the title when that season was won", () => {
    expect(
      card({
        tenures: [tenure({ captain: true })],
        champions: new Map([["s1", "a"]]),
      }),
    ).toEqual({
      season: "Season 1",
      team: "Alpha",
      role: "Captain",
      titles: ["Season 1"],
    });
  });

  it("prefers a title in the newest season over the roster team", () => {
    // Rostered on Alpha, covered for the champion Bravo in the same season.
    expect(
      card({
        tenures: [tenure()],
        covers: [{ seasonId: "s1", teamId: "b", matchId: "m1" }],
        champions: new Map([["s1", "b"]]),
      }),
    ).toEqual({
      season: "Season 1",
      team: null,
      role: "Stood in for Bravo",
      titles: ["Season 1"],
    });
  });

  it("does not reach back past the newest season for an older title", () => {
    expect(
      card({
        tenures: [
          tenure(),
          tenure({
            seasonId: "s2",
            teamId: "b",
            teamName: "Bravo",
            joinedAt: new Date("2026-05-10"),
          }),
        ],
        champions: new Map([["s1", "a"]]),
      }),
    ).toEqual({
      season: "Season 2",
      team: "Bravo",
      role: "Drafted for $12",
      // The older title still counts among their titles.
      titles: ["Season 1"],
    });
  });

  it("says a standin-only season was cover, games played or not", () => {
    const covers = [{ seasonId: "s2", teamId: "c", matchId: "m1" }];
    const standin = {
      season: "Season 2",
      team: null,
      role: "Stood in for Charlie",
      titles: [],
    };
    expect(card({ covers })).toEqual(standin);
    expect(
      card({ covers, appearances: [app({ seasonId: "s2", teamId: "c" })] }),
    ).toEqual(standin);
  });

  it("names no season with no league season", () => {
    expect(card({})).toEqual({
      season: null,
      team: null,
      role: null,
      titles: [],
    });
  });
});
