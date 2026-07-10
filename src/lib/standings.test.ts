import { describe, it, expect } from "vitest";
import {
  computeStandings,
  seriesScoreError,
  type MatchLike,
} from "./standings";

function match(
  home: string,
  away: string,
  hs: number,
  as: number,
  opts: { phase?: string; status?: string } = {},
): MatchLike {
  return {
    homeTeamId: home,
    awayTeamId: away,
    homeScore: hs,
    awayScore: as,
    winnerTeamId: hs > as ? home : as > hs ? away : null,
    phase: opts.phase ?? "REGULAR",
    status: opts.status ?? "COMPLETED",
  };
}

describe("computeStandings", () => {
  it("awards 3 points per win and ranks correctly", () => {
    const s = computeStandings(
      ["a", "b", "c"],
      [match("a", "b", 2, 0), match("b", "c", 1, 0), match("a", "c", 2, 1)],
    );
    expect(s[0].teamId).toBe("a");
    expect(s[0].points).toBe(6);
    expect(s[0].wins).toBe(2);
    expect(s.find((x) => x.teamId === "b")?.points).toBe(3);
    expect(s.find((x) => x.teamId === "c")?.points).toBe(0);
  });

  it("ignores playoff and unfinished matches", () => {
    const s = computeStandings(
      ["a", "b"],
      [
        match("a", "b", 2, 0, { phase: "PLAYOFF" }),
        match("a", "b", 2, 0, { status: "SCHEDULED" }),
      ],
    );
    expect(s.every((x) => x.played === 0)).toBe(true);
  });

  it("uses game differential as a tiebreaker", () => {
    // a and b both win once, but a wins by more games
    const s = computeStandings(
      ["a", "b", "c", "d"],
      [match("a", "c", 2, 0), match("b", "d", 2, 1)],
    );
    const a = s.find((x) => x.teamId === "a")!;
    const b = s.find((x) => x.teamId === "b")!;
    expect(a.points).toBe(b.points);
    expect(s.indexOf(a)).toBeLessThan(s.indexOf(b));
  });

  it("gives a point to each team for a drawn (tied) series", () => {
    const s = computeStandings(["a", "b"], [match("a", "b", 1, 1)]);
    const a = s.find((x) => x.teamId === "a")!;
    const b = s.find((x) => x.teamId === "b")!;
    expect(a.points).toBe(1);
    expect(a.draws).toBe(1);
    expect(a.wins).toBe(0);
    expect(b.points).toBe(1);
  });

  it("counts a team with no matches", () => {
    const s = computeStandings(["a"], []);
    expect(s).toHaveLength(1);
    expect(s[0].played).toBe(0);
  });
});

describe("seriesScoreError", () => {
  it("accepts a decided Bo1 / Bo3 / Bo5", () => {
    expect(seriesScoreError(1, 1, 0)).toBeNull();
    expect(seriesScoreError(3, 2, 1)).toBeNull();
    expect(seriesScoreError(5, 3, 0)).toBeNull();
  });

  it("accepts partial results (forfeits) and draws", () => {
    expect(seriesScoreError(3, 1, 0)).toBeNull(); // forfeit / partial
    expect(seriesScoreError(2, 1, 1)).toBeNull(); // Bo2 draw
    expect(seriesScoreError(1, 0, 0)).toBeNull(); // double forfeit
  });

  it("accepts a Bo2 sweep (even series play every game)", () => {
    expect(seriesScoreError(2, 2, 0)).toBeNull();
    expect(seriesScoreError(2, 0, 2)).toBeNull();
  });

  it("rejects a score above an odd series' needed wins", () => {
    expect(seriesScoreError(1, 2, 1)).toMatch(/at most 1 game/);
    expect(seriesScoreError(3, 3, 0)).toMatch(/best-of-3/);
    expect(seriesScoreError(5, 0, 4)).toMatch(/best-of-5/);
  });

  it("rejects more total games than the series holds", () => {
    expect(seriesScoreError(3, 2, 2)).toMatch(/at most 3 games/);
    expect(seriesScoreError(2, 2, 1)).toMatch(/at most 2 games/);
  });
});
