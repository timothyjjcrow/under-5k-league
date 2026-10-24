import { describe, expect, it } from "vitest";
import { projectPlayoffField } from "./playoff-field";
import { standingsSections } from "./season-groups";
import {
  bestGameOfWeek,
  weekProgress,
  weekWrapPath,
  weekWrapTable,
  weekWrapTables,
} from "./week-wrap";

type M = Parameters<typeof weekWrapTable>[1][number];

function series(
  week: number,
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
  status = "COMPLETED",
): M {
  return {
    week,
    phase: "REGULAR",
    status,
    homeTeamId: home,
    awayTeamId: away,
    homeScore,
    awayScore,
    winnerTeamId:
      status !== "COMPLETED" || homeScore === awayScore
        ? null
        : homeScore > awayScore
          ? home
          : away,
  };
}

const TEAMS = ["a", "b", "c", "d"];

describe("weekWrapTable", () => {
  it("is the table after the week, with movement against the week before", () => {
    const matches = [
      // Week 1: a beat b; c and d drew. Going into week 2: a, c, d, b.
      series(1, "a", "b", 2, 0),
      series(1, "c", "d", 1, 1),
      // Week 2: d beat a, b beat c. After it: d (4), a and b (3, a won
      // their meeting), c (1).
      series(2, "d", "a", 2, 0),
      series(2, "b", "c", 2, 0),
      // A later week never counts.
      series(3, "c", "a", 2, 0),
    ];
    const rows = weekWrapTable(TEAMS, matches, 2);
    expect(rows.map((r) => [r.teamId, r.rank, r.points, r.movement])).toEqual([
      ["d", 1, 4, 2],
      ["a", 2, 3, -1],
      ["b", 3, 3, 1],
      ["c", 4, 1, -2],
    ]);
    expect(rows.every((r) => r.played === 2)).toBe(true);
  });

  it("has no movement for the first week with results", () => {
    const rows = weekWrapTable(TEAMS, [series(1, "a", "b", 2, 0)], 1);
    expect(rows.every((r) => r.movement === null)).toBe(true);
    expect(rows[0]).toMatchObject({ teamId: "a", wins: 1, points: 3, rank: 1 });
  });
});

describe("weekWrapTables", () => {
  // Ten teams in two groups of five, as a group season plays them.
  const grouped = [
    ...["a1", "a2", "a3", "a4", "a5"].map((id) => ({ id, groupKey: "A" })),
    ...["b1", "b2", "b3", "b4", "b5"].map((id) => ({ id, groupKey: "B" })),
  ];
  const tablesAfter = (
    teams: { id: string; groupKey: string | null }[],
    matches: M[],
    week: number,
  ) => weekWrapTables(standingsSections(projectPlayoffField(teams, matches, { formatConfig: null })), matches, week);
  const placesOf = (rows: ReturnType<typeof weekWrapTable>) =>
    rows.map((r) => [r.teamId, r.rank, r.points, r.movement]);

  it("ranks and moves a group season's teams inside their own group", () => {
    const matches = [
      // Week 1. Going into week 2, A: a1, a3, a5, a4, a2; B: b2, b3, b5,
      // b1, b4 (b2/b3 and b1/b4 level, by id).
      series(1, "a1", "a2", 2, 0),
      series(1, "a3", "a4", 2, 1),
      series(1, "b1", "b2", 0, 2),
      series(1, "b3", "b4", 2, 0),
      // Week 2.
      series(2, "a5", "a1", 2, 0),
      series(2, "a2", "a3", 2, 0),
      series(2, "b5", "b2", 2, 1),
      series(2, "b4", "b1", 2, 0),
    ];
    const tables = tablesAfter(grouped, matches, 2);
    expect(tables.map((t) => [t.key, t.title])).toEqual([
      ["A", "Group A"],
      ["B", "Group B"],
    ]);
    // a5 leads A on game difference; a1 and a2 are level and a1 won their
    // meeting.
    expect(placesOf(tables[0].rows)).toEqual([
      ["a5", 1, 3, 2],
      ["a1", 2, 3, -1],
      ["a2", 3, 3, 2],
      ["a3", 4, 3, -2],
      ["a4", 5, 0, -1],
    ]);
    // B's leader is first in Group B, never sixth of one table of ten.
    expect(placesOf(tables[1].rows)).toEqual([
      ["b3", 1, 3, 1],
      ["b5", 2, 3, 1],
      ["b2", 3, 3, -2],
      ["b4", 4, 3, 1],
      ["b1", 5, 0, -1],
    ]);
  });

  it("waits for a group's own first results before it draws arrows", () => {
    // Group B's week 1 was postponed: going into week 2 its table has no
    // results, so arrows against it would be alphabetical noise. Group A's
    // week 1 was played, so A's arrows are real.
    const matches = [
      series(1, "a1", "a2", 2, 0),
      series(1, "a3", "a4", 2, 1),
      series(1, "b1", "b2", 0, 0, "SCHEDULED"),
      series(1, "b3", "b4", 0, 0, "SCHEDULED"),
      series(2, "a5", "a1", 2, 0),
      series(2, "b5", "b2", 2, 1),
    ];
    const [a, b] = tablesAfter(grouped, matches, 2);
    expect(a.rows.every((r) => r.movement !== null)).toBe(true);
    expect(b.rows.every((r) => r.movement === null)).toBe(true);
    expect(b.rows[0]).toMatchObject({ teamId: "b5", rank: 1, points: 3 });
  });

  it("is the one league table, unchanged, in a one-table season", () => {
    const matches = [
      series(1, "a", "b", 2, 0),
      series(1, "c", "d", 1, 1),
      series(2, "d", "a", 2, 0),
      series(2, "b", "c", 2, 0),
    ];
    const tables = tablesAfter(
      TEAMS.map((id) => ({ id, groupKey: null })),
      matches,
      2,
    );
    expect(tables).toEqual([
      { key: null, title: null, rows: weekWrapTable(TEAMS, matches, 2) },
    ]);
    expect(placesOf(tables[0].rows)).toEqual([
      ["d", 1, 4, 2],
      ["a", 2, 3, -1],
      ["b", 3, 3, 1],
      ["c", 4, 1, -2],
    ]);
  });
});

describe("bestGameOfWeek", () => {
  const line = (userId: string | null, isRadiant: boolean, kills: number, deaths: number) => ({
    userId,
    isRadiant,
    heroId: 7,
    kills,
    deaths,
    assists: 5,
  });

  it("finds the highest impact line by a league player", () => {
    const best = bestGameOfWeek([
      { radiantWin: true, players: [line("u1", true, 10, 2), line(null, false, 30, 0)] },
      { radiantWin: false, players: [line("u2", false, 14, 1), line("u3", true, 2, 9)] },
    ]);
    // The unmapped 30-kill line is no league player's.
    expect(best).toMatchObject({ userId: "u2", kills: 14, won: true });
  });

  it("breaks ties the same way every time, and has nothing without games", () => {
    const a = bestGameOfWeek([
      { radiantWin: true, players: [line("u2", true, 10, 2), line("u1", true, 10, 2)] },
    ]);
    expect(a?.userId).toBe("u1");
    expect(bestGameOfWeek([])).toBeNull();
  });
});

describe("weekProgress and weekWrapPath", () => {
  it("counts the week's final series", () => {
    expect(
      weekProgress(
        [series(2, "a", "b", 2, 0), series(2, "c", "d", 0, 0, "SCHEDULED"), series(1, "a", "c", 1, 1)],
        2,
      ),
    ).toEqual({ total: 2, final: 1, done: false });
    expect(weekProgress([series(1, "a", "b", 2, 0)], 1)).toEqual({ total: 1, final: 1, done: true });
    expect(weekProgress([], 4)).toEqual({ total: 0, final: 0, done: false });
  });

  it("puts the wrap under the season's own URL", () => {
    expect(weekWrapPath("season 1", 3)).toBe("/seasons/season%201/weeks/3");
  });
});
