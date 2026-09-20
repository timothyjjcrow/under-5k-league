import { describe, expect, it } from "vitest";
import { projectPlayoffField as projectCurrentPlayoffField } from "./playoff-field";
// Historical fixture generation; production continues to recognize these stored formats.
const projectPlayoffField: typeof projectCurrentPlayoffField = (teams, matches) => projectCurrentPlayoffField(teams, matches, "legacy");
import { scenarioReport } from "./scenarios";
import { applyNormalOutlook, standingOutlooks } from "./scenario-outlook";
import { remainingRegular, seasonScenarioReport, type StakesMatchRow } from "./stakes";
import { computeStandings, type MatchLike } from "./standings";
import { tiebreakerSlot } from "./tiebreakers";

type Fixture = StakesMatchRow & MatchLike;
function fixture(id: string, home: string, away: string, homeScore = 0, awayScore = 0, completed = true): Fixture {
  return { id, homeTeamId: home, awayTeamId: away, homeScore, awayScore,
    winnerTeamId: homeScore > awayScore ? home : awayScore > homeScore ? away : null,
    phase: "REGULAR", status: completed ? "COMPLETED" : "SCHEDULED", bestOf: 2, week: 1 };
}
function reportFor(ids: string[], matches: Fixture[], withdrawn: string[] = []) {
  const field = projectPlayoffField(ids.map((id) => ({ id, withdrawn: withdrawn.includes(id) })), matches);
  return seasonScenarioReport(field.eligibleStandings, matches, field.eligibleTeamIds.length, field)!;
}

// Public US season fixtures as at 6 September 2026; aliases avoid coupling
// calculations to database IDs. The W/SOV 2–0 includes an administrative game.
const usIds = ["W", "Bad", "BHD", "SOV", "Vegan"];
function usFixtures(): Fixture[] {
  return [fixture("1", "BHD", "Vegan", 1, 1),
    { ...fixture("2", "W", "SOV", 2, 0), forfeit: true },
    fixture("3", "Bad", "BHD", 1, 1), fixture("4", "Vegan", "W", 0, 2),
    fixture("5", "SOV", "Bad", 1, 1), fixture("6", "W", "BHD", 2, 0),
    fixture("7", "SOV", "Vegan", 1, 1), fixture("8", "Bad", "W", 1, 1),
    { ...fixture("9", "BHD", "SOV", 0, 0, false), week: 5 },
    { ...fixture("10", "Vegan", "Bad", 0, 0, false), week: 5 }];
}

describe("normal-series outlook", () => {
  it("accounts for every US BO2 combination and keeps existing guarantees conservative", () => {
    const report = reportFor(usIds, usFixtures());
    expect(report.forecast).toEqual({ basis: "normal_series", total: 9 });
    const counts = (id: string) => {
      const s = report.teams.get(id)!.outlook!;
      return [s.qualified, s.qualificationTiebreaker, s.eliminated, s.seedingTiebreaker];
    };
    expect(counts("W")).toEqual([9, 0, 0, 0]);
    expect(counts("Bad")).toEqual([8, 1, 0, 0]);
    expect(counts("Vegan")).toEqual([5, 3, 1, 2]);
    expect(counts("BHD")).toEqual([4, 3, 2, 2]);
    expect(counts("SOV")).toEqual([4, 3, 2, 2]);
    for (const id of usIds.filter((id) => id !== "W")) {
      const team = report.teams.get(id)!;
      expect(team.winAndIn).toBe(true);
      expect(team.loseAndOut).toBe(false);
      expect(team.paths!.win).toMatchObject({ total: 3, qualified: 3 });
    }
    expect(report.teams.get("Bad")!.paths!.draw).toMatchObject({ total: 3, qualified: 3 });
    expect(report.teams.get("Vegan")!.paths!.loss).toMatchObject({ total: 3, qualified: 0, qualificationTiebreaker: 2, eliminated: 1 });
    expect(report.teams.get("BHD")!.paths!.loss).toMatchObject({ total: 3, qualified: 0, qualificationTiebreaker: 1, eliminated: 2 });
  });

  it.each([
    [2, 2, ["SOV"], [], ["BHD", "Vegan"]],
    [2, 1, ["SOV"], [], []],
    [2, 0, [], ["SOV", "Vegan"], []],
    [1, 2, [], ["Bad", "BHD", "SOV"], []],
    [1, 1, [], ["BHD", "SOV", "Vegan"], []],
    [1, 0, ["Vegan"], [], ["BHD", "SOV"]],
    [0, 2, ["BHD"], [], ["SOV", "Vegan"]],
    [0, 1, ["BHD"], [], []],
    [0, 0, [], ["BHD", "Vegan"], []],
  ] as [number, number, string[], string[], string[]][])(
    "resolves US final scorelines %i and %i with official cutoff and seeding ties",
    (a, b, eliminated, qualificationTie, seedingTie) => {
      const matches = usFixtures().map((m, i) => i < 8 ? m :
        fixture(m.id, m.homeTeamId, m.awayTeamId, i === 8 ? a : b, 2 - (i === 8 ? a : b)));
      const report = reportFor(usIds, matches);
      expect(report.forecast).toEqual({ basis: "final", total: 1 });
      for (const id of usIds) {
        const team = report.teams.get(id)!;
        expect(team.status).toBe(eliminated.includes(id) ? "ELIMINATED" : qualificationTie.includes(id) ? null : "CLINCHED");
        expect(team.outlook!.seedingTiebreaker).toBe(+seedingTie.includes(id));
        expect(team.outlook!.qualificationTiebreaker).toBe(+qualificationTie.includes(id));
        if (qualificationTie.includes(id)) expect(team.outlook!.qualificationTies).toEqual([
          { teamIds: [...qualificationTie].sort(), spots: qualificationTie.length - 1 },
        ]);
      }
    },
  );

  it.each([[1, 0, "BHD", "SOV"], [0, 1, "SOV", "BHD"]] as const)(
    "preserves live BO2 %i–%i wins in guarantees, forecast paths and memo",
    (homeScore, awayScore, leader, trailer) => {
      const before = usFixtures();
      const first = reportFor(usIds, before);
      const matches = before.map((m) => m.id === "9" ? { ...m, status: "LIVE", homeScore, awayScore } : m);
      const live = reportFor(usIds, matches);
      expect(live).not.toBe(first);
      expect(live.forecast!.total).toBe(6);
      expect(live.teams.get(leader)!.paths!.loss).toBeNull();
      expect(live.teams.get(trailer)!.paths!.win).toBeNull();
      expect(live.teams.get(leader)!.loseAndOut).toBe(false);
      expect(live.teams.get(trailer)!.winAndIn).toBe(false);
      expect(live.teams.get(trailer)!.magicNumber).toBeNull();
      expect(live.teams.get(leader)!.paths!.draw!.total).toBe(3);
      expect(reportFor(usIds, matches)).toBe(live);
    },
  );

  it("retains admin partial draws in guarantees while labeling the normal BO3 forecast separately", () => {
    const standings = computeStandings(["T", "A", "B"], []).map((s) => ({ ...s, points: s.teamId === "T" ? 4 : 3 }));
    const report = scenarioReport(standings, [{ id: "bo3", homeTeamId: "A", awayTeamId: "B", bestOf: 3 }], 2);
    expect(report.teams.get("T")!.status).toBeNull();
    expect(report.teams.get("T")!.leafCount).toBe(3);
    const matches = usFixtures().map((m) => m.id === "9" ? { ...m, bestOf: 3 } : m);
    const detailed = reportFor(usIds, matches);
    expect(detailed.forecast!.total).toBe(12);
    expect(detailed.teams.get("BHD")!.paths!.draw).toBeNull();
  });

  it("uses the full table before eligibility filtering, including withdrawn H2H and forfeit scores", () => {
    const ids = [...usIds, "Withdrawn"];
    const matches = [...usFixtures(), ...usIds.map((id, i) => ({
      ...fixture(`withdrawn-${i}`, id, "Withdrawn", i === 0 ? 1 : 2, i === 0 ? 1 : 0), forfeit: true,
    }))];
    const report = reportFor(ids, matches, ["Withdrawn"]);
    expect(report.teams.has("Withdrawn")).toBe(false);
    expect(report.cut).toBe(4);
    // Independently evaluate each leaf through the actual seeder, which keeps
    // all results against the withdrawn side before removing its eligible row.
    const totals = new Map(usIds.map((id) => [id, [0, 0, 0]]));
    for (const a of [0, 1, 2]) for (const b of [0, 1, 2]) {
      const completed = matches.map((m) => m.id === "9" || m.id === "10"
        ? fixture(m.id, m.homeTeamId, m.awayTeamId, m.id === "9" ? a : b, 2 - (m.id === "9" ? a : b)) : m);
      const projection = projectPlayoffField(ids.map((id) => ({ id, withdrawn: id === "Withdrawn" })), completed);
      for (const [id, outlook] of standingOutlooks(projection.eligibleStandings, 4)) {
        const count = totals.get(id)!;
        count[0] += outlook.qualified; count[1] += outlook.qualificationTiebreaker; count[2] += outlook.eliminated;
      }
    }
    for (const id of usIds) {
      const outlook = report.teams.get(id)!.outlook!;
      expect([outlook.qualified, outlook.qualificationTiebreaker, outlook.eliminated]).toEqual(totals.get(id));
    }
  });

  it("stops detailed enumeration at its cap and preserves conservative results", () => {
    const matches = usFixtures();
    const field = projectPlayoffField(usIds.map((id) => ({ id })), matches);
    const remaining = remainingRegular(matches);
    const report = scenarioReport(field.eligibleStandings, remaining, 4);
    const original = JSON.stringify([...report.teams]);
    applyNormalOutlook(report, usIds, matches, remaining, 8);
    expect(report.forecast).toBeUndefined();
    expect(JSON.stringify([...report.teams])).toBe(original);
    applyNormalOutlook(report, usIds, matches, remaining, 9);
    expect(report.forecast!.total).toBe(9);
  });

  it("freezes nested shared outlooks and changes cache keys when official score/forfeit inputs change", () => {
    const matches = usFixtures();
    const first = reportFor(usIds, matches);
    expect(() => { first.teams.get("Vegan")!.paths!.loss!.qualificationTies[0].spots = 99; }).toThrow();
    const changed = matches.map((m) => m.id === "2" ? { ...m, homeScore: 1 } : m);
    expect(reportFor(usIds, changed)).not.toBe(first);
    expect(reportFor(usIds, matches.map((m) => m.id === "2" ? { ...m, forfeit: false } : m))).not.toBe(first);
  });
});

function ladderWithBottomTie(size: number): Fixture[] {
  const ids = ["A", "B", "C", "D", "E"];
  return ids.flatMap((home, i) => ids.slice(i + 1).map((away) =>
    fixture(`${home}-${away}`, home, away, i >= ids.length - size ? 1 : 2, i >= ids.length - size ? 1 : 0)));
}
function addTiebreaker(matches: Fixture[], winner: string): Fixture[] {
  const field = projectPlayoffField(["A", "B", "C", "D", "E"].map((id) => ({ id })), matches);
  const group = field.tiebreakers.groups.find((g) => g.status === "needed")!;
  const pair = group.pairings[0] ?? { home: group.teamIds[0], away: group.teamIds[1] };
  const score = group.bestOf === 1 ? 1 : 2;
  return [...matches, { ...fixture(`tb-${matches.length}`, pair.home, pair.away,
    winner === pair.home ? score : 0, winner === pair.away ? score : 0),
    phase: "TIEBREAKER", bestOf: group.bestOf, bracketSlot: tiebreakerSlot(group, 0), week: 6 }];
}

describe("actual tiebreaker outlook", () => {
  const ids = ["A", "B", "C", "D", "E"];
  it("finalizes a completed BO3 cutoff result without altering regular points", () => {
    const regular = ladderWithBottomTie(2);
    const before = reportFor(ids, regular);
    expect(before.teams.get("E")!.outlook!.qualificationTiebreaker).toBe(1);
    const after = reportFor(ids, addTiebreaker(regular, "E"));
    expect(after).not.toBe(before);
    expect(after.teams.get("E")).toMatchObject({ status: "CLINCHED", bestRank: 4, worstRank: 4 });
    expect(after.teams.get("D")).toMatchObject({ status: "ELIMINATED", bestRank: 5, worstRank: 5 });
    expect(after.teams.get("E")!.paths).toEqual({ win: null, draw: null, loss: null });
  });

  it("fixes BO1 third place after game3, then finalizes all three after the upper winner wins game4", () => {
    let matches = ladderWithBottomTie(3);
    for (const winner of ["C", "E", "D"]) matches = addTiebreaker(matches, winner);
    const partial = reportFor(ids, matches);
    expect(partial.teams.get("C")).toMatchObject({ status: "ELIMINATED", bestRank: 5, worstRank: 5 });
    for (const id of ["D", "E"]) expect(partial.teams.get(id)).toMatchObject({
      status: "CLINCHED", outlook: { qualified: 1, seedingTiebreaker: 1, bestRank: 3, worstRank: 4 },
    });
    const final = reportFor(ids, addTiebreaker(matches, "E"));
    expect(final.teams.get("E")).toMatchObject({ status: "CLINCHED", bestRank: 3, worstRank: 3 });
    expect(final.teams.get("D")).toMatchObject({ status: "CLINCHED", bestRank: 4, worstRank: 4 });
    expect(final.teams.get("C")).toMatchObject({ status: "ELIMINATED", bestRank: 5, worstRank: 5 });
  });

  it("keeps game4 lower-win participants tied until the BO1 reset finishes", () => {
    let matches = ladderWithBottomTie(3);
    for (const winner of ["C", "E", "D", "D"]) matches = addTiebreaker(matches, winner);
    expect(reportFor(ids, matches).teams.get("D")!.outlook!.seedingTiebreaker).toBe(1);
    const final = reportFor(ids, addTiebreaker(matches, "D"));
    expect(final.teams.get("D")!.bestRank).toBe(3);
    expect(final.teams.get("E")!.bestRank).toBe(4);
  });

  it("does not apply stale extra-week results to future normal-series scorelines", () => {
    const old = addTiebreaker(ladderWithBottomTie(2), "E");
    const reopened = old.map((m) => m.id === "D-E" ? { ...m, status: "SCHEDULED", homeScore: 0, awayScore: 0 } : m);
    const field = projectPlayoffField(ids.map((id) => ({ id })), reopened);
    // A stale TB causes an error in the canonical projection: suppress the
    // detailed forecast rather than letting its old winner decide a new tie.
    const report = seasonScenarioReport(field.eligibleStandings, reopened, 5, field)!;
    expect(field.tiebreakers.error).not.toBeNull();
    expect(report.forecast).toBeUndefined();
  });

  it("fails closed for corrupt actual extra-week results", () => {
    const matches = addTiebreaker(ladderWithBottomTie(2), "E");
    matches[matches.length - 1].winnerTeamId = "D";
    const report = reportFor(ids, matches);
    expect(report.forecast).toBeUndefined();
    for (const team of report.teams.values()) {
      expect(team.status).toBeNull();
      expect(team.magicNumber).toBeNull();
      expect(team.exact).toBe(false);
    }
  });

  it("reports seed-only ties when every eligible team makes the bracket", () => {
    const four = ["A", "B", "C", "D"];
    const report = reportFor(four, []);
    expect(report.cut).toBe(4);
    for (const team of report.teams.values()) expect(team).toMatchObject({
      status: "CLINCHED", outlook: { qualified: 1, qualificationTiebreaker: 0, seedingTiebreaker: 1 },
    });
  });
});
