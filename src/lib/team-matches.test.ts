import { describe, expect, it } from "vitest";
import {
  formByTeam,
  headToHead,
  recentForm,
  resultFor,
  type TeamMatchLike,
} from "./team-matches";

const A = "teamA";
const B = "teamB";
const C = "teamC";

function m(partial: Partial<TeamMatchLike>): TeamMatchLike {
  return {
    homeTeamId: A,
    awayTeamId: B,
    status: "COMPLETED",
    winnerTeamId: A,
    homeScore: 2,
    awayScore: 1,
    ...partial,
  };
}

describe("resultFor", () => {
  it("classifies win / loss / draw for a team", () => {
    expect(resultFor(A, m({ winnerTeamId: A }))).toBe("W");
    expect(resultFor(A, m({ winnerTeamId: B }))).toBe("L");
    expect(resultFor(A, m({ winnerTeamId: null }))).toBe("D");
  });
});

describe("recentForm", () => {
  it("returns most-recent-first and respects the limit", () => {
    const matches = [
      m({ winnerTeamId: A }), // W (oldest)
      m({ winnerTeamId: B }), // L
      m({ winnerTeamId: null }), // D
      m({ winnerTeamId: A }), // W
      m({ winnerTeamId: A }), // W (newest)
    ];
    expect(recentForm(A, matches, 3)).toEqual(["W", "W", "D"]);
  });

  it("ignores non-completed matches", () => {
    const matches = [
      m({ winnerTeamId: A }),
      m({ status: "SCHEDULED", winnerTeamId: null }),
    ];
    expect(recentForm(A, matches)).toEqual(["W"]);
  });
});

describe("headToHead", () => {
  it("aggregates series + games per opponent from both sides", () => {
    const matches = [
      m({ homeTeamId: A, awayTeamId: B, winnerTeamId: A, homeScore: 2, awayScore: 0 }),
      m({ homeTeamId: B, awayTeamId: A, winnerTeamId: B, homeScore: 2, awayScore: 1 }),
      m({ homeTeamId: A, awayTeamId: C, winnerTeamId: null, homeScore: 1, awayScore: 1 }),
    ];
    const rows = headToHead(A, matches);
    const vsB = rows.find((r) => r.opponentId === B)!;
    expect(vsB).toEqual({
      opponentId: B,
      wins: 1,
      losses: 1,
      draws: 0,
      gamesFor: 3, // 2 (home) + 1 (away)
      gamesAgainst: 2, // 0 (home) + 2 (away)
    });
    const vsC = rows.find((r) => r.opponentId === C)!;
    expect(vsC).toMatchObject({ opponentId: C, wins: 0, losses: 0, draws: 1 });
  });

  it("skips matches the team wasn't in and non-completed ones", () => {
    const matches = [
      m({ homeTeamId: B, awayTeamId: C, winnerTeamId: B }),
      m({ homeTeamId: A, awayTeamId: B, status: "SCHEDULED", winnerTeamId: null }),
    ];
    expect(headToHead(A, matches)).toEqual([]);
  });
});

describe("formByTeam", () => {
  it("builds per-team form from each team's own matches", () => {
    const matches = [
      m({ homeTeamId: A, awayTeamId: B, winnerTeamId: A }), // A W, B L
      m({ homeTeamId: A, awayTeamId: C, winnerTeamId: C }), // A L, C W
      m({ homeTeamId: B, awayTeamId: C, winnerTeamId: null }), // B D, C D
    ];
    const map = formByTeam([A, B, C], matches);
    expect(map.get(A)).toEqual(["L", "W"]); // newest-first
    expect(map.get(B)).toEqual(["D", "L"]);
    expect(map.get(C)).toEqual(["D", "W"]);
  });
});
