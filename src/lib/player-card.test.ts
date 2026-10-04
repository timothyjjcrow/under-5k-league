import { describe, expect, it } from "vitest";
import { sourceFile, stripLineComments } from "../../test/support/source-files";
import { careerReportCard, type BenchmarkLine } from "./benchmarks";
import {
  championTitles,
  playerCardFacts,
  playerCardHasContent,
  playerCardHonors,
  playerCardRoleText,
  profileCardRoleText,
  type PlayerCardFacts,
} from "./player-card";
import type { ProfileSeasonRow } from "./profile-seasons";

const ACTIVE = { id: "s9", name: "Season 9" };

function row(overrides: Partial<ProfileSeasonRow> = {}): ProfileSeasonRow {
  return {
    key: `${overrides.seasonId ?? "s9"}|${overrides.teamId ?? "t1"}`,
    seasonId: "s9",
    seasonName: "Season 9",
    teamId: "t1",
    teamName: "Radiant Raccoons",
    role: { kind: "drafted", price: 12 },
    games: 4,
    series: { wins: 2, losses: 0, draws: 0 },
    stoodIn: 0,
    champion: false,
    ...overrides,
  };
}

/** A line graded on two metrics at the given percentiles. */
const graded = (farm: number, fight: number): BenchmarkLine => ({
  benchmarks: {
    gold_per_min: { pct: farm },
    hero_damage_per_min: { pct: fight },
  },
});

type Input = Parameters<typeof playerCardFacts>[0];
function facts(overrides: Partial<Input> = {}): PlayerCardFacts {
  return playerCardFacts({
    activeSeason: ACTIVE,
    signup: null,
    membership: null,
    seasonRows: [],
    teamLogos: new Map(),
    rankTier: null,
    leagueHeroes: [],
    pubHeroes: [],
    report: careerReportCard([]),
    achievements: [],
    recordsHeld: 0,
    ...overrides,
  });
}

describe("which season the card is about", () => {
  it("is the active season while they are signed up for it", () => {
    const card = facts({ signup: { mmr: 3100, type: "PLAYER" } });
    expect(card.season).toEqual({ id: "s9", name: "Season 9", current: true });
    expect(card.role).toEqual({ kind: "registered" });
    expect(card.team).toBeNull();
  });

  it("is the active season with today's team while they are rostered", () => {
    const card = facts({
      signup: { mmr: 3100, type: "PLAYER" },
      membership: {
        teamId: "t1",
        teamName: "Radiant Raccoons",
        teamLogoUrl: "https://i.imgur.com/raccoon.png",
        isCaptain: false,
      },
      seasonRows: [row()],
    });
    expect(card.season?.current).toBe(true);
    expect(card.team).toEqual({
      id: "t1",
      name: "Radiant Raccoons",
      logoUrl: "https://i.imgur.com/raccoon.png",
    });
    // How they joined comes from their tenure.
    expect(card.role).toEqual({ kind: "drafted", price: 12 });
  });

  it("takes the armband from today's roster, not the tenure", () => {
    const membership = {
      teamId: "t1",
      teamName: "Radiant Raccoons",
      teamLogoUrl: null,
      isCaptain: true,
    };
    expect(facts({ membership, seasonRows: [row()] }).role).toEqual({
      kind: "captain",
    });
    // Handed the armband on: a stale captain tenure doesn't make them one.
    expect(
      facts({
        membership: { ...membership, isCaptain: false },
        seasonRows: [row({ role: { kind: "captain" } })],
      }).role,
    ).toBeNull();
  });

  it("calls a standin signup without a team a standin", () => {
    const card = facts({ signup: { mmr: 2900, type: "STANDIN" } });
    expect(card.role).toEqual({ kind: "standin" });
    expect(card.team).toBeNull();
    expect(card.stoodInFor).toBeNull();
    expect(playerCardRoleText(card)).toBe("Standin");
  });

  it("is their latest season, from its history, when they aren't in this one", () => {
    const card = facts({
      seasonRows: [
        row({ seasonId: "s8", seasonName: "Season 8", teamId: "t8", teamName: "Dire Straits" }),
        row({ seasonId: "s7", seasonName: "Season 7" }),
      ],
      teamLogos: new Map([["t8", null]]),
    });
    expect(card.season).toEqual({ id: "s8", name: "Season 8", current: false });
    expect(card.team).toEqual({ id: "t8", name: "Dire Straits", logoUrl: null });
    expect(card.role).toEqual({ kind: "drafted", price: 12 });
  });

  it("puts a title first within that season", () => {
    const card = facts({
      seasonRows: [
        row({ seasonId: "s8", teamId: "a", teamName: "Roster Team" }),
        row({
          seasonId: "s8",
          teamId: "b",
          teamName: "Champions",
          role: null,
          stoodIn: 1,
          champion: true,
        }),
      ],
    });
    expect(card.season?.id).toBe("s8");
    // Covering for the champion counts as theirs, but as a standin: the
    // card names the team without wearing its colours.
    expect(card.role).toEqual({ kind: "standin" });
    expect(card.team).toBeNull();
    expect(playerCardRoleText(card)).toBe("Stood in for Champions");
  });

  it("labels a season spent only standing in, with no team to tint it", () => {
    const card = facts({
      activeSeason: null,
      seasonRows: [row({ role: null, stoodIn: 3, games: 2 })],
    });
    expect(card.role).toEqual({ kind: "standin" });
    expect(card.team).toBeNull();
    expect(card.stoodInFor).toBe("Radiant Raccoons");
    expect(card.season?.current).toBe(false);
  });

  it("wears the team of a season they joined and also stood in", () => {
    // A roster role wins over cover: they were on the team.
    const card = facts({
      activeSeason: null,
      seasonRows: [row({ role: { kind: "free-agent" }, stoodIn: 2 })],
    });
    expect(card.role).toEqual({ kind: "free-agent" });
    expect(card.team?.id).toBe("t1");
    expect(card.stoodInFor).toBeNull();
  });

  it("has no season with none running and no history", () => {
    expect(facts({ activeSeason: null }).season).toBeNull();
    expect(facts().season).toBeNull();
  });
});

describe("MMR", () => {
  it("shows only an active signup's, in the active season", () => {
    expect(facts({ signup: { mmr: 4700, type: "PLAYER" } }).mmr).toBe(4700);
    expect(facts({ signup: { mmr: 2500, type: "STANDIN" } }).mmr).toBe(2500);
    // A past season's card, or no signup: no MMR.
    expect(facts({ seasonRows: [row({ seasonId: "s8" })] }).mmr).toBeNull();
    expect(
      facts({ activeSeason: null, signup: { mmr: 4700, type: "PLAYER" } }).mmr,
    ).toBeNull();
  });
});

describe("medal", () => {
  it("is the medal when known, and nothing at all otherwise", () => {
    expect(facts({ rankTier: 64 }).rankTier).toBe(64);
    expect(facts({ rankTier: 80 }).rankTier).toBe(80);
    for (const unknown of [null, 0, 5, 95]) {
      expect(facts({ rankTier: unknown }).rankTier, String(unknown)).toBeNull();
    }
    expect(JSON.stringify(facts({ rankTier: null }))).not.toContain("Unranked");
  });
});

describe("heroes", () => {
  it("lists league heroes first, then pub heroes marked as pubs, three at most", () => {
    const card = facts({
      leagueHeroes: [{ heroId: 14 }, { heroId: 2 }],
      pubHeroes: [{ heroId: 2 }, { heroId: 74 }, { heroId: 1 }],
    });
    expect(card.heroes).toEqual([
      { heroId: 14, name: "Pudge", pubs: false },
      { heroId: 2, name: "Axe", pubs: false },
      // Axe is already there from league games; the next pub hero fills in.
      { heroId: 74, name: "Invoker", pubs: true },
    ]);
  });

  it("stops at three league heroes", () => {
    const card = facts({
      leagueHeroes: [{ heroId: 1 }, { heroId: 2 }, { heroId: 3 }, { heroId: 4 }],
      pubHeroes: [{ heroId: 5 }],
    });
    expect(card.heroes.map((h) => h.heroId)).toEqual([1, 2, 3]);
    expect(card.heroes.every((h) => !h.pubs)).toBe(true);
  });

  it("shows none without league games, even with pub heroes", () => {
    expect(facts({ pubHeroes: [{ heroId: 74 }] }).heroes).toEqual([]);
  });

  it("skips a hero id the hero list doesn't know", () => {
    expect(
      facts({ leagueHeroes: [{ heroId: 99999 }, { heroId: 14 }] }).heroes,
    ).toEqual([{ heroId: 14, name: "Pudge", pubs: false }]);
  });

  it("never reads typed favourites", () => {
    // Pub heroes are what they play; favourites are what they claim. The
    // card takes no favourites at all.
    const code = stripLineComments(sourceFile("src/lib/player-card.ts").text);
    expect(code).not.toMatch(/favou?rite/i);
  });
});

describe("grade", () => {
  it("waits for enough graded games", () => {
    const two = careerReportCard([graded(0.8, 0.2), graded(0.8, 0.2)]);
    expect(facts({ report: two, leagueHeroes: [{ heroId: 1 }] }).grade).toBeNull();
  });

  it("gives the overall grade and strength, never what to work on", () => {
    const report = careerReportCard([
      graded(0.95, 0.1),
      graded(0.95, 0.1),
      graded(0.95, 0.1),
    ]);
    // The report has a "Work on" (hero damage) for the player themselves.
    expect(report.focus?.label).toBe("Hero damage");
    const card = facts({ report, leagueHeroes: [{ heroId: 1 }] });
    expect(card.grade).toEqual({ overall: "B", strength: "Farming" });
    expect(JSON.stringify(card)).not.toContain("Hero damage");
  });
});

describe("honors", () => {
  it("lists each title season once, newest first", () => {
    const card = facts({
      seasonRows: [
        row({ seasonId: "s9", seasonName: "Season 9", champion: true }),
        row({ seasonId: "s9", seasonName: "Season 9", teamId: "t2", champion: true }),
        row({ seasonId: "s8", seasonName: "Season 8", champion: false }),
        row({ seasonId: "s7", seasonName: "Season 7", champion: true }),
      ],
    });
    expect(card.titles).toEqual([
      { seasonId: "s9", seasonName: "Season 9" },
      { seasonId: "s7", seasonName: "Season 7" },
    ]);
  });

  it("counts Match MVPs from the achievement and the records held", () => {
    const card = facts({
      achievements: [
        { key: "deathless", count: 4 },
        { key: "mvp", count: 3 },
      ],
      recordsHeld: 1,
    });
    expect(card.mvps).toBe(3);
    expect(card.records).toBe(1);
    expect(playerCardHonors(card)).toEqual(["3 Match MVPs", "1 league record"]);
    expect(playerCardHonors({ mvps: 1, records: 2 })).toEqual([
      "1 Match MVP",
      "2 league records",
    ]);
    expect(playerCardHonors({ mvps: 0, records: 0 })).toEqual([]);
  });

  it("shows three titles, then folds the rest into +N", () => {
    const titles = [9, 8, 7, 6, 5].map((n) => ({
      seasonId: `s${n}`,
      seasonName: `Season ${n}`,
    }));
    expect(championTitles(titles)).toEqual({
      shown: ["Season 9 champion", "Season 8 champion", "Season 7 champion"],
      more: ["Season 6 champion", "Season 5 champion"],
    });
    expect(championTitles(titles.slice(0, 3)).more).toEqual([]);
    expect(championTitles([])).toEqual({ shown: [], more: [] });
  });
});

describe("what the card may carry", () => {
  it("has exactly these fields, none of them contact details", () => {
    const card = facts({ signup: { mmr: 3100, type: "PLAYER" } });
    expect(Object.keys(card).sort()).toEqual(
      [
        "grade",
        "heroes",
        "mmr",
        "mvps",
        "rankTier",
        "records",
        "role",
        "season",
        "stoodInFor",
        "team",
        "titles",
      ].sort(),
    );
    const code = stripLineComments(sourceFile("src/lib/player-card.ts").text);
    expect(code).not.toMatch(/discord|steam|profileUrl|contact|email/i);
  });

  it("is empty only when there is nothing to show", () => {
    expect(playerCardHasContent(facts({ activeSeason: null }))).toBe(false);
    expect(playerCardHasContent(facts({ rankTier: 41 }))).toBe(true);
    expect(
      playerCardHasContent(facts({ signup: { mmr: 3000, type: "PLAYER" } })),
    ).toBe(true);
  });
});

describe("role text", () => {
  it("says how they took part in a few words", () => {
    const text = (role: PlayerCardFacts["role"], stoodInFor: string | null = null) =>
      playerCardRoleText({ role, stoodInFor });
    expect(text({ kind: "captain" })).toBe("Captain");
    expect(text({ kind: "drafted", price: 47 })).toBe("Drafted for $47");
    expect(text({ kind: "free-agent" })).toBe("Signed as a free agent");
    expect(text({ kind: "standin" })).toBe("Standin");
    expect(text({ kind: "standin" }, "Dire Straits")).toBe(
      "Stood in for Dire Straits",
    );
    expect(text({ kind: "registered" })).toBe("Registered");
    expect(text(null)).toBeNull();
  });

  it("leaves a live Captain or Standin to the name row's badge on the profile", () => {
    const captain = { role: { kind: "captain" as const }, stoodInFor: null };
    expect(profileCardRoleText(captain, { captain: true, standin: false })).toBeNull();
    // A past season's captaincy has no badge beside the name: the card says it.
    expect(profileCardRoleText(captain, { captain: false, standin: false })).toBe(
      "Captain",
    );
    const standin = { role: { kind: "standin" as const }, stoodInFor: null };
    expect(profileCardRoleText(standin, { captain: false, standin: true })).toBeNull();
    expect(
      profileCardRoleText(
        { role: { kind: "drafted", price: 3 }, stoodInFor: null },
        { captain: false, standin: true },
      ),
    ).toBe("Drafted for $3");
  });
});
