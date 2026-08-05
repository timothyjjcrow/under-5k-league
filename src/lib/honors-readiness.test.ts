import { describe, expect, it } from "vitest";
import {
  evaluateHonorWeeks,
  HONOR_WEEK_STATE,
  isNoPerformanceHonorWeek,
  type HonorReadinessMatchInput,
} from "./honors-readiness";

function players(home: string, away: string) {
  return JSON.stringify([
    ...Array.from({ length: 5 }, (_, index) => ({
      accountId: index + 1,
      userId: `home-${index}`,
      teamId: home,
      heroId: index + 1,
      isRadiant: true,
      kills: 10,
      deaths: 2,
      assists: 8,
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      accountId: index + 101,
      userId: `away-${index}`,
      teamId: away,
      heroId: index + 101,
      isRadiant: false,
      kills: 2,
      deaths: 10,
      assists: 4,
    })),
  ]);
}

function match(
  overrides: Partial<HonorReadinessMatchInput> = {},
): HonorReadinessMatchInput {
  const homeTeamId = overrides.homeTeamId ?? "home";
  const awayTeamId = overrides.awayTeamId ?? "away";
  return {
    id: "match-1",
    week: 1,
    phase: "REGULAR",
    status: "COMPLETED",
    homeTeamId,
    awayTeamId,
    homeScore: 1,
    awayScore: 0,
    forfeit: false,
    games: [
      {
        id: "game-1",
        radiantWin: true,
        radiantTeamId: homeTeamId,
        direTeamId: awayTeamId,
        winnerTeamId: homeTeamId,
        players: players(homeTeamId, awayTeamId),
      },
    ],
    ...overrides,
  };
}

describe("evaluateHonorWeeks", () => {
  it("publishes only a complete, attributed 5v5 regular slate", () => {
    const readiness = evaluateHonorWeeks([match()]);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]).toMatchObject({
      week: 1,
      state: HONOR_WEEK_STATE.READY,
      issues: [],
    });
    expect(readiness[0].games).toHaveLength(1);
  });

  it("keeps an unfinished slate distinct from final data repair", () => {
    expect(evaluateHonorWeeks([match({ status: "LIVE" })])[0].state).toBe(
      HONOR_WEEK_STATE.IN_PROGRESS,
    );
    expect(evaluateHonorWeeks([match({ games: [] })])[0]).toMatchObject({
      state: HONOR_WEEK_STATE.AWAITING_BOX_SCORES,
      issues: expect.arrayContaining(["GAME_COUNT_MISMATCH"]),
    });
  });

  it("rejects incomplete, duplicate, unattributed, or wrong-side box scores", () => {
    const base = match();
    const raw = JSON.parse(base.games[0].players) as Record<string, unknown>[];
    const cases = [
      raw.slice(0, 9),
      raw.map((line, index) =>
        index === 9 ? { ...line, userId: "home-0" } : line,
      ),
      raw.map((line, index) =>
        index === 9 ? { ...line, userId: null } : line,
      ),
      raw.map((line, index) =>
        index === 0 ? { ...line, teamId: "away" } : line,
      ),
    ];
    for (const candidate of cases) {
      const readiness = evaluateHonorWeeks([
        match({
          games: [{ ...base.games[0], players: JSON.stringify(candidate) }],
        }),
      ])[0];
      expect(readiness.state).toBe(HONOR_WEEK_STATE.AWAITING_BOX_SCORES);
      expect(readiness.games).toEqual([]);
    }
  });

  it("rejects score/game winner mismatches", () => {
    const readiness = evaluateHonorWeeks([
      match({ homeScore: 0, awayScore: 1 }),
    ])[0];
    expect(readiness).toMatchObject({
      state: HONOR_WEEK_STATE.AWAITING_BOX_SCORES,
      issues: expect.arrayContaining(["RESULT_MISMATCH"]),
    });
  });

  it("rejects a non-forfeit 0–0 final", () => {
    const readiness = evaluateHonorWeeks([
      match({ homeScore: 0, awayScore: 0, games: [] }),
    ])[0];
    expect(readiness).toMatchObject({
      state: HONOR_WEEK_STATE.AWAITING_BOX_SCORES,
      issues: expect.arrayContaining(["GAME_COUNT_MISMATCH"]),
    });
  });

  it("allows a zero-game forfeit and validates any game a forfeit retains", () => {
    const unplayedForfeit = evaluateHonorWeeks([
      match({ forfeit: true, homeScore: 2, games: [] }),
    ])[0];
    expect(unplayedForfeit).toMatchObject({
      state: HONOR_WEEK_STATE.READY,
      games: [],
    });
    expect(isNoPerformanceHonorWeek(unplayedForfeit)).toBe(true);
    expect(isNoPerformanceHonorWeek(undefined)).toBe(false);
    expect(
      evaluateHonorWeeks([
        match({
          forfeit: true,
          games: [{ ...match().games[0], players: "not-json" }],
        }),
      ])[0].state,
    ).toBe(HONOR_WEEK_STATE.AWAITING_BOX_SCORES);

    const twoGames = [match().games[0], { ...match().games[0], id: "game-2" }];
    expect(
      evaluateHonorWeeks([
        match({ forfeit: true, homeScore: 1, awayScore: 0, games: twoGames }),
      ])[0],
    ).toMatchObject({
      state: HONOR_WEEK_STATE.AWAITING_BOX_SCORES,
      issues: expect.arrayContaining(["GAME_COUNT_MISMATCH"]),
    });
  });

  it("ignores postseason fixtures, even when they reuse the week number", () => {
    const readiness = evaluateHonorWeeks([
      match(),
      match({ id: "playoff", phase: "PLAYOFF", status: "SCHEDULED" }),
    ]);
    expect(readiness).toHaveLength(1);
    expect(readiness[0].state).toBe(HONOR_WEEK_STATE.READY);
  });
});
