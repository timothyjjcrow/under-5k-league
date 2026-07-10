import { describe, it, expect } from "vitest";
import { ELO, powerRankings, ratingsThroughWeek } from "./power-rankings";

const m = (
  week: number,
  home: string,
  away: string,
  hs: number,
  as: number,
  status = "COMPLETED",
) => ({ week, status, homeTeamId: home, awayTeamId: away, homeScore: hs, awayScore: as });

const teams = ["A", "B", "C", "D"];

describe("ratingsThroughWeek", () => {
  it("moves winner and loser symmetrically from the start rating", () => {
    const r = ratingsThroughWeek([m(1, "A", "B", 1, 0)], teams, 1);
    // Even matchup: expected 0.5 → winner +K/2, loser −K/2.
    expect(r.get("A")).toBeCloseTo(ELO.START + ELO.K / 2);
    expect(r.get("B")).toBeCloseTo(ELO.START - ELO.K / 2);
    expect(r.get("C")).toBe(ELO.START);
  });

  it("rewards a sweep more than a close series", () => {
    const sweep = ratingsThroughWeek([m(1, "A", "B", 2, 0)], teams, 1);
    const close = ratingsThroughWeek([m(1, "A", "B", 2, 1)], teams, 1);
    expect(sweep.get("A")!).toBeGreaterThan(close.get("A")!);
  });

  it("pays more for upsets than for expected wins", () => {
    // Week 1: A beats B twice → A favored. Week 2: B beats A once (upset)
    // vs. C beats D once (even) — B's gain must exceed C's.
    const base = [m(1, "A", "B", 2, 0)];
    const upset = ratingsThroughWeek([...base, m(2, "B", "A", 1, 0)], teams, 2);
    const even = ratingsThroughWeek([...base, m(2, "C", "D", 1, 0)], teams, 2);
    const bGain = upset.get("B")! - ratingsThroughWeek(base, teams, 1).get("B")!;
    const cGain = even.get("C")! - ELO.START;
    expect(bGain).toBeGreaterThan(cGain);
  });

  it("ignores unfinished matches and later weeks", () => {
    const r = ratingsThroughWeek(
      [m(1, "A", "B", 1, 0), m(2, "A", "C", 1, 0, "SCHEDULED"), m(3, "A", "D", 1, 0)],
      teams,
      1,
    );
    expect(r.get("D")).toBe(ELO.START);
    expect(r.get("C")).toBe(ELO.START);
  });
});

describe("powerRankings", () => {
  it("returns empty with no completed matches", () => {
    expect(powerRankings([m(1, "A", "B", 0, 0, "SCHEDULED")], teams)).toEqual([]);
  });

  it("ranks by rating and reports weekly movement", () => {
    const matches = [
      m(1, "A", "B", 2, 0), // A up, B down
      m(1, "C", "D", 2, 1), // C up a bit
      m(2, "B", "A", 2, 0), // B upsets A twice
    ];
    const rows = powerRankings(matches, teams);
    // B's double upset vaults them from last to 2nd; C holds the top spot.
    expect(rows[0].teamId).toBe("C");
    const b = rows.find((r) => r.teamId === "B")!;
    expect(b.rank).toBe(2);
    expect(b.prevRank).toBe(4); // was bottom after week 1
    expect(b.delta).toBeGreaterThan(0);
    const a = rows.find((r) => r.teamId === "A")!;
    expect(a.delta).toBeLessThan(0);
  });
});
