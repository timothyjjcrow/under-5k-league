import { describe, it, expect } from "vitest";
import {
  clinchFromReport,
  playoffOutlookShown,
  remainingRegular,
  seasonScenarioReport,
  stakesCardTitle,
  type StakesMatchRow,
} from "./stakes";
import { projectPlayoffField } from "./playoff-field";
import { computeStandings, type MatchLike } from "./standings";

/** The one-table field a page passes, from the same rows. */
function fieldOf(teamIds: string[], matches: MatchLike[]) {
  return projectPlayoffField(
    teamIds.map((id) => ({ id, withdrawn: false, groupKey: null })),
    matches,
  );
}

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

  it("returns null with no teams or no bracket", () => {
    expect(seasonScenarioReport([], [], 0, fieldOf([], []))).toBeNull();
    const alone = computeStandings(["A"], []);
    expect(seasonScenarioReport(alone, [], 1, fieldOf(["A"], []))).toBeNull();
  });

  it("uses the playoff-seeding cut for a field the bracket can't fit", () => {
    // 5 teams -> bracket of 4, so one team misses: a real race.
    const done = [
      played("m1", "A", "B", "A"),
      played("m2", "C", "D", "C"),
    ];
    const standings = computeStandings(teamIds, done);
    const report = seasonScenarioReport(standings, done, teamIds.length, fieldOf(teamIds, done));
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
    const report = seasonScenarioReport(standings, done, teamIds.length, fieldOf(teamIds, done));
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

describe("seasonScenarioReport memo", () => {
  // The engine enumerates up to 177k leaves at O(teams²) on four hot pages;
  // the memo is content-addressed, so a landed result changes the KEY in the
  // same render that reads it — invalidation by construction, no TTL.
  const ids = ["A", "B", "C", "D", "E"];
  // Carries the score fields too: computeStandings takes MatchLike, and an
  // open match contributes nothing, so the zeros are inert.
  const open = (id: string, home: string, away: string, week: number) => ({
    ...row({ id, homeTeamId: home, awayTeamId: away, week }),
    homeScore: 0,
    awayScore: 0,
    winnerTeamId: null as string | null,
  });

  it("identical inputs return the same report object", () => {
    const matches = [
      open("m1", "A", "B", 1),
      open("m2", "C", "D", 1),
      open("m3", "A", "C", 2),
    ];
    const standings = computeStandings(ids, matches);
    const a = seasonScenarioReport(standings, matches, ids.length, fieldOf(ids, matches));
    const b = seasonScenarioReport(standings, matches, ids.length, fieldOf(ids, matches));
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it("a landed result busts the memo", () => {
    // The load-bearing case: the match leaves `remaining` AND the points move,
    // so the key changes twice over. A key of just [cut, teamCount] would
    // serve the stale report next to a standings table built from live rows.
    const before = [
      open("m1", "A", "B", 1),
      open("m2", "C", "D", 1),
      open("m3", "A", "C", 2),
    ];
    const r1 = seasonScenarioReport(
      computeStandings(ids, before),
      before,
      ids.length,
      fieldOf(ids, before),
    );
    const after = before.map((m) =>
      m.id === "m1"
        ? {
            ...m,
            status: "COMPLETED",
            homeScore: 1,
            awayScore: 0,
            winnerTeamId: "A",
          }
        : m,
    );
    const r2 = seasonScenarioReport(
      computeStandings(ids, after),
      after,
      ids.length,
      fieldOf(ids, after),
    );
    expect(r2).not.toBe(r1);
    // …and it genuinely recomputed: the played match is nobody's next one now.
    const nexts = [...r2!.teams.values()].map((t) => t.nextMatchId);
    expect(nexts).not.toContain("m1");
  });

  it("a reschedule that reorders the run-in busts the memo", () => {
    // Same standings, same match ids — only the kickoff order differs, which
    // changes each team's "next match". This is the case a "games" cache tag
    // and the resultChangedAt cursor would BOTH miss.
    const base = [
      open("early", "A", "B", 1),
      open("late", "A", "C", 2),
      open("other", "D", "E", 1),
    ];
    const standings = computeStandings(ids, base);
    const inWeekOrder = seasonScenarioReport(standings, base, ids.length, fieldOf(ids, base));
    const retimed = [
      { ...base[0], scheduledAt: new Date("2026-08-20") },
      { ...base[1], scheduledAt: new Date("2026-08-10") },
      { ...base[2], scheduledAt: new Date("2026-08-11") },
    ];
    const byKickoff = seasonScenarioReport(standings, retimed, ids.length, fieldOf(ids, retimed));
    expect(byKickoff).not.toBe(inWeekOrder);
    expect(byKickoff!.teams.get("A")!.nextMatchId).toBe("late");
    expect(inWeekOrder!.teams.get("A")!.nextMatchId).toBe("early");
  });

  it("a cached report cannot be mutated by one viewer's page", () => {
    const matches = [open("f1", "A", "B", 1), open("f2", "C", "D", 1)];
    const standings = computeStandings(ids, matches);
    const r = seasonScenarioReport(standings, matches, ids.length, fieldOf(ids, matches))!;
    expect(() => {
      (r.teams.get("A") as unknown as { status: unknown }).status = "CLINCHED";
    }).toThrow();
  });

  // LAST in the file on purpose: it deliberately churns the memo past its cap.
  it("the memo is bounded", () => {
    const matches = [open("b1", "A", "B", 1), open("b2", "C", "D", 1)];
    const field = fieldOf(ids, matches);
    const first = seasonScenarioReport(
      computeStandings(ids, matches),
      matches,
      ids.length,
      field,
    );
    for (let i = 0; i < 9; i++) {
      const churn = computeStandings(ids, matches).map((s, idx) =>
        idx === 0 ? { ...s, points: s.points + i + 1 } : s,
      );
      seasonScenarioReport(churn, matches, ids.length, field);
    }
    const again = seasonScenarioReport(
      computeStandings(ids, matches),
      matches,
      ids.length,
      field,
    );
    expect(again).not.toBe(first); // evicted, recomputed
  });
});

describe("playoffOutlookShown", () => {
  it("waits for the first final regular-season series", () => {
    expect(playoffOutlookShown([])).toBe(false);
    expect(
      playoffOutlookShown([
        row({ id: "live", status: "LIVE" }),
        row({ id: "tb", phase: "TIEBREAKER", status: "COMPLETED" }),
      ]),
    ).toBe(false);
    expect(
      playoffOutlookShown([
        row({ id: "w1", status: "COMPLETED" }),
        row({ id: "w2", week: 2 }),
      ]),
    ).toBe(true);
  });
});

describe("stakesCardTitle", () => {
  const LA = "America/Los_Angeles";
  const BERLIN = "Europe/Berlin";
  // Sun 4 Oct 2026, 6:00 PM in Los Angeles (PDT): Mon 01:00 UTC.
  const usKickoff = new Date(Date.UTC(2026, 9, 5, 1, 0));
  // Wed 7 Oct 2026, 20:00 in Berlin (CEST): 18:00 UTC.
  const euKickoff = new Date(Date.UTC(2026, 9, 7, 18, 0));

  it("says tonight only on match day, on the league's clock", () => {
    // 9 AM Sunday in Los Angeles is still Sunday there, though UTC is a day
    // behind the kickoff's UTC date.
    expect(stakesCardTitle(usKickoff, Date.UTC(2026, 9, 4, 16, 0), LA)).toBe(
      "Tonight's stakes",
    );
    expect(stakesCardTitle(euKickoff, Date.UTC(2026, 9, 7, 8, 0), BERLIN)).toBe(
      "Tonight's stakes",
    );
  });

  it("says what's at stake on the days before, and after midnight", () => {
    expect(stakesCardTitle(usKickoff, Date.UTC(2026, 9, 2, 19, 0), LA)).toBe(
      "What's at stake",
    );
    // 00:30 Thursday in Berlin, still Wednesday in UTC.
    expect(
      stakesCardTitle(euKickoff, Date.UTC(2026, 9, 7, 22, 30), BERLIN),
    ).toBe("What's at stake");
  });

  it("has no tonight for an untimed fixture", () => {
    expect(stakesCardTitle(null, Date.UTC(2026, 9, 7, 8, 0), BERLIN)).toBe(
      "What's at stake",
    );
  });
});
