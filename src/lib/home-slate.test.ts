import { describe, expect, it } from "vitest";
import {
  orderSlate,
  playoffRace,
  playoffRaceParts,
  playoffVerdict,
  sharedKickoff,
  standingSummary,
  tablePlace,
} from "./home-slate";
import type { ScenarioOutlook, TeamScenario } from "./scenarios";

const at = (iso: string) => new Date(iso);
const row = (
  id: string,
  home: string,
  away: string,
  overrides: Partial<{ status: string; scheduledAt: Date | null }> = {},
) => ({
  id,
  homeTeamId: home,
  awayTeamId: away,
  status: "SCHEDULED",
  scheduledAt: at("2026-11-15T02:00:00Z"),
  ...overrides,
});

const outlook = (overrides: Partial<ScenarioOutlook>): ScenarioOutlook => ({
  total: 4, qualified: 0, qualificationTiebreaker: 0, eliminated: 0,
  seedingTiebreaker: 0, bestRank: 1, worstRank: 6, qualificationTies: [],
  ...overrides,
});
const scenario = (
  teamId: string,
  overrides: Partial<TeamScenario> = {},
): TeamScenario => ({
  teamId, status: null, winAndIn: false, loseAndOut: false,
  magicNumber: null, eliminationLosses: null, bestRank: 1, worstRank: 6,
  exact: true, madeCount: 0, leafCount: 1, nextMatchId: null, ...overrides,
});
const report = (...teams: TeamScenario[]) => ({
  teams: new Map(teams.map((team) => [team.teamId, team])),
});

describe("orderSlate", () => {
  const slate = [
    row("m1", "a", "b"),
    row("m2", "c", "d", { status: "LIVE" }),
    row("m3", "e", "f"),
    row("m4", "g", "h"),
  ];

  it("leads with the viewer's series, then a live one, then the slate's order", () => {
    expect(orderSlate(slate, "f").map((m) => m.id)).toEqual(["m3", "m2", "m1", "m4"]);
    expect(orderSlate(slate, "g").map((m) => m.id)).toEqual(["m4", "m2", "m1", "m3"]);
  });

  it("keeps the slate's order for a viewer with no series on it", () => {
    expect(orderSlate(slate, null).map((m) => m.id)).toEqual(["m2", "m1", "m3", "m4"]);
    expect(orderSlate(slate, "zz").map((m) => m.id)).toEqual(["m2", "m1", "m3", "m4"]);
  });

  it("leaves the slate it was given untouched", () => {
    const before = slate.map((m) => m.id);
    orderSlate(slate, "h");
    expect(slate.map((m) => m.id)).toEqual(before);
  });
});

describe("sharedKickoff", () => {
  it("is the kickoff every series shares", () => {
    const shared = sharedKickoff([row("m1", "a", "b"), row("m2", "c", "d")]);
    expect(shared?.toISOString()).toBe("2026-11-15T02:00:00.000Z");
  });

  it("is null when one series was moved or has no time", () => {
    expect(
      sharedKickoff([
        row("m1", "a", "b"),
        row("m2", "c", "d", { scheduledAt: at("2026-11-16T02:00:00Z") }),
      ]),
    ).toBeNull();
    expect(
      sharedKickoff([row("m1", "a", "b"), row("m2", "c", "d", { scheduledAt: null })]),
    ).toBeNull();
    expect(
      sharedKickoff([row("m1", "a", "b", { scheduledAt: null }), row("m2", "c", "d")]),
    ).toBeNull();
  });

  it("is null for a slate of one, whose card has its own clock", () => {
    expect(sharedKickoff([row("m1", "a", "b")])).toBeNull();
    expect(sharedKickoff([])).toBeNull();
  });
});

describe("playoffVerdict", () => {
  it("reads the exact outlook when there is one", () => {
    expect(playoffVerdict(scenario("a", { outlook: outlook({ qualified: 4 }) }))).toBe("in");
    expect(playoffVerdict(scenario("a", { outlook: outlook({ eliminated: 4 }) }))).toBe("out");
    expect(
      playoffVerdict(scenario("a", { outlook: outlook({ qualified: 3, eliminated: 1 }) })),
    ).toBe("open");
    // A place that goes to a tiebreaker is not a place yet.
    expect(
      playoffVerdict(scenario("a", { outlook: outlook({ qualificationTiebreaker: 4 }) })),
    ).toBe("open");
  });

  it("trusts the outlook over a clinch status it has refined", () => {
    expect(
      playoffVerdict(
        scenario("a", { status: "CLINCHED", outlook: outlook({ qualified: 2, eliminated: 2 }) }),
      ),
    ).toBe("open");
  });

  it("falls back to the proven clinch status", () => {
    expect(playoffVerdict(scenario("a", { status: "CLINCHED" }))).toBe("in");
    expect(playoffVerdict(scenario("a", { status: "ELIMINATED" }))).toBe("out");
    expect(playoffVerdict(scenario("a"))).toBe("open");
  });
});

describe("playoffRace", () => {
  it("is null until a team is in or out", () => {
    expect(playoffRace(report(scenario("a"), scenario("b")), 2)).toBeNull();
    expect(playoffRace(null, 4)).toBeNull();
    expect(playoffRace(report(scenario("a", { status: "CLINCHED" })), 0)).toBeNull();
  });

  it("counts the teams in, out and still chasing the places left", () => {
    const race = playoffRace(
      report(
        scenario("a", { status: "CLINCHED" }),
        scenario("b", { status: "CLINCHED" }),
        scenario("c"),
        scenario("d"),
        scenario("e"),
        scenario("f", { status: "ELIMINATED" }),
      ),
      4,
    );
    expect(race).toEqual({ in: 2, out: 1, open: 3, placesLeft: 2 });
    expect(playoffRaceParts(race!).map((part) => part.text)).toEqual([
      "2 teams in",
      "3 chasing 2 places",
      "1 out",
    ]);
  });

  it("uses singulars, and drops a part with nobody in it", () => {
    const race = playoffRace(
      report(
        scenario("a", { status: "CLINCHED" }),
        scenario("b"),
        scenario("c"),
      ),
      2,
    );
    expect(playoffRaceParts(race!)).toEqual([
      { key: "in", text: "1 team in" },
      { key: "open", text: "2 chasing 1 place" },
    ]);
    const set = playoffRace(
      report(scenario("a", { status: "CLINCHED" }), scenario("b", { status: "ELIMINATED" })),
      1,
    );
    expect(playoffRaceParts(set!).map((part) => part.text)).toEqual(["1 team in", "1 out"]);
  });

  it("never promises a place that is already taken", () => {
    // Every place is secured but the bounds have not ruled the last team out.
    const race = playoffRace(
      report(scenario("a", { status: "CLINCHED" }), scenario("b")),
      1,
    );
    expect(race?.placesLeft).toBe(0);
    expect(playoffRaceParts(race!).map((part) => part.text)).toEqual([
      "1 team in",
      "1 team still to be settled",
    ]);
  });
});

describe("tablePlace and standingSummary", () => {
  const standing = (
    teamId: string,
    wins: number,
    draws: number,
    losses: number,
    idTieGroup?: string,
  ) => ({
    teamId,
    played: wins + draws + losses,
    wins,
    draws,
    losses,
    points: wins * 3 + draws,
    ...(idTieGroup ? { idTieGroup } : {}),
  });
  const table = [
    standing("a", 4, 0, 0),
    standing("b", 2, 1, 1),
    standing("c", 1, 0, 3, "tie-1"),
    standing("d", 1, 0, 3, "tie-1"),
    standing("e", 0, 1, 3),
  ];

  it("places a team by its row", () => {
    expect(tablePlace(table, "b")).toMatchObject({ place: 2, tied: false });
    expect(tablePlace(table, "e")).toMatchObject({ place: 5, tied: false });
    expect(tablePlace(table, "zz")).toBeNull();
  });

  it("shares the best place among rows only the team id could split", () => {
    expect(tablePlace(table, "c")).toMatchObject({ place: 3, tied: true });
    expect(tablePlace(table, "d")).toMatchObject({ place: 3, tied: true });
  });

  it("writes the standing in words", () => {
    const at = (teamId: string, groupKey: string | null) => {
      const found = tablePlace(table, teamId)!;
      return standingSummary({ ...found, groupKey, tableSize: table.length });
    };
    expect(at("a", "A")).toBe("1st in Group A · 4 wins, 0 losses · 12 pts");
    expect(at("b", null)).toBe("2nd of 5 · 2 wins, 1 draw, 1 loss · 7 pts");
    expect(at("d", "B")).toBe("Tied 3rd in Group B · 1 win, 3 losses · 3 pts");
    expect(at("e", null)).toBe("5th of 5 · 0 wins, 1 draw, 3 losses · 1 pt");
  });

  it("says a team has not played instead of ranking a table of zeros", () => {
    const fresh = [standing("a", 0, 0, 0, "tie-0"), standing("b", 0, 0, 0, "tie-0")];
    const found = tablePlace(fresh, "b")!;
    expect(standingSummary({ ...found, groupKey: "A", tableSize: 2 })).toBe(
      "Group A · No series played yet",
    );
    expect(standingSummary({ ...found, groupKey: null, tableSize: 2 })).toBe(
      "No series played yet",
    );
  });

  it("uses the right ordinal suffixes", () => {
    const row = standing("x", 1, 0, 0);
    const line = (place: number) =>
      standingSummary({ place, tied: false, row, groupKey: null, tableSize: 30 });
    expect(line(11)).toMatch(/^11th of 30/);
    expect(line(12)).toMatch(/^12th of 30/);
    expect(line(13)).toMatch(/^13th of 30/);
    expect(line(21)).toMatch(/^21st of 30/);
    expect(line(22)).toMatch(/^22nd of 30/);
    expect(line(23)).toMatch(/^23rd of 30/);
  });
});
