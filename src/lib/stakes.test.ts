import { describe, it, expect } from "vitest";
import {
  clinchFromReport,
  remainingRegular,
  seasonScenarioReport,
  type StakesMatchRow,
} from "./stakes";
import { computeStandings } from "./standings";

function row(partial: Partial<StakesMatchRow> & { id: string }): StakesMatchRow {
  return {
    homeTeamId: "A",
    awayTeamId: "B",
    status: "SCHEDULED",
    phase: "REGULAR",
    bestOf: 1,
    week: 1,
    ...partial,
  };
}

describe("remainingRegular", () => {
  it("keeps only unfinished regular-season matches, in week order", () => {
    const rows = [
      row({ id: "w3", week: 3 }),
      row({ id: "done", week: 1, status: "COMPLETED" }),
      row({ id: "w2live", week: 2, status: "LIVE" }),
      row({ id: "playoff", week: 4, phase: "PLAYOFF" }),
    ];
    expect(remainingRegular(rows).map((m) => m.id)).toEqual(["w2live", "w3"]);
  });

  it("orders by actual kickoff when every remaining match has a time", () => {
    // A rescheduled week-2 match now plays AFTER week 3's night — kickoff
    // order decides which match is a team's "next".
    const rows = [
      row({ id: "w2-late", week: 2, scheduledAt: new Date("2026-07-20") }),
      row({ id: "w3", week: 3, scheduledAt: new Date("2026-07-15") }),
    ];
    expect(remainingRegular(rows).map((m) => m.id)).toEqual(["w3", "w2-late"]);
  });

  it("falls back to week order when any remaining match is untimed", () => {
    const rows = [
      row({ id: "w2", week: 2, scheduledAt: new Date("2026-07-20") }),
      row({ id: "w1-untimed", week: 1, scheduledAt: null }),
    ];
    expect(remainingRegular(rows).map((m) => m.id)).toEqual(["w1-untimed", "w2"]);
  });

  it("carries bestOf through for draw-aware enumeration", () => {
    expect(remainingRegular([row({ id: "x", bestOf: 2 })])[0].bestOf).toBe(2);
  });
});

describe("seasonScenarioReport", () => {
  const teamIds = ["A", "B", "C", "D", "E"];
  const played = (
    id: string,
    home: string,
    away: string,
    winner: string | null,
    week = 1,
  ): StakesMatchRow & {
    homeScore: number;
    awayScore: number;
    winnerTeamId: string | null;
  } => ({
    ...row({ id, homeTeamId: home, awayTeamId: away, week, status: "COMPLETED" }),
    homeScore: winner === home ? 1 : 0,
    awayScore: winner === away ? 1 : 0,
    winnerTeamId: winner,
  });

  it("returns null when the bracket takes everyone (no race) or no teams", () => {
    const standings = computeStandings(["A", "B", "C", "D"], []);
    expect(seasonScenarioReport(standings, [], 4)).toBeNull();
    expect(seasonScenarioReport([], [], 0)).toBeNull();
  });

  it("uses the playoff-seeding cut for a field the bracket can't fit", () => {
    // 5 teams -> bracket of 4, so one team misses: a real race.
    const done = [
      played("m1", "A", "B", "A"),
      played("m2", "C", "D", "C"),
    ];
    const standings = computeStandings(teamIds, done);
    const report = seasonScenarioReport(standings, done, teamIds.length);
    expect(report).not.toBeNull();
    expect(report!.cut).toBe(4);
    expect(report!.teams.size).toBe(5);
  });

  it("round-trips into a clinch map the standings table can render", () => {
    // A full round robin with a strict points ladder (A 12 > B 9 > C 6 > D 3 >
    // E 0) and nothing left: with a cut of 4 the engine can call every team —
    // top 4 CLINCHED, last ELIMINATED (ties would rightly stay null).
    const beat: [string, string][] = [
      ["A", "B"], ["A", "C"], ["A", "D"], ["A", "E"],
      ["B", "C"], ["B", "D"], ["B", "E"],
      ["C", "D"], ["C", "E"],
      ["D", "E"],
    ];
    const done = beat.map(([w, l], i) =>
      played(`m${i}`, w, l, w, i + 1),
    );
    const standings = computeStandings(teamIds, done);
    const report = seasonScenarioReport(standings, done, teamIds.length);
    const clinch = clinchFromReport(report)!;
    const order = standings.map((s) => s.teamId);
    for (const teamId of order.slice(0, 4)) {
      expect(clinch.get(teamId)).toBe("CLINCHED");
    }
    expect(clinch.get(order[4])).toBe("ELIMINATED");
  });

  it("clinchFromReport passes a null report through as undefined", () => {
    expect(clinchFromReport(null)).toBeUndefined();
  });
});
