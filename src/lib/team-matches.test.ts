import { describe, expect, it } from "vitest";
import {
  WIN_STREAK_MIN,
  compareSeriesOrder,
  formByTeam,
  headToHead,
  recentForm,
  rematches,
  resultFor,
  seriesRecordSpoken,
  seriesRecordText,
  seriesWinStreak,
  standingsForm,
  standingsStreaksShown,
  teamFixtureOrder,
  type SeriesOrderMatch,
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

describe("rematches", () => {
  it("keeps only opponents met in more than one completed series", () => {
    const matches = [
      m({ homeTeamId: A, awayTeamId: B, winnerTeamId: A }),
      m({ homeTeamId: A, awayTeamId: C, winnerTeamId: C }),
      // The playoff rematch with B, drawn this time.
      m({ homeTeamId: B, awayTeamId: A, winnerTeamId: null, homeScore: 1, awayScore: 1 }),
      // Still to play: not a meeting yet.
      m({ homeTeamId: C, awayTeamId: A, status: "SCHEDULED", winnerTeamId: null }),
    ];
    expect(rematches(headToHead(A, matches))).toEqual([
      {
        opponentId: B,
        wins: 1,
        losses: 0,
        draws: 1,
        gamesFor: 3,
        gamesAgainst: 2,
      },
    ]);
  });

  it("is empty for a single round robin", () => {
    const matches = [
      m({ homeTeamId: A, awayTeamId: B }),
      m({ homeTeamId: A, awayTeamId: C }),
    ];
    expect(rematches(headToHead(A, matches))).toEqual([]);
  });
});

describe("seriesRecordText", () => {
  it("writes wins, draws, losses in the standings' order, lettered", () => {
    // 3 won, 1 drawn, 3 lost: never "3–3–1", which reads as three draws.
    const record = { wins: 3, draws: 1, losses: 3 };
    expect(seriesRecordText(record)).toBe("3W 1D 3L");
    expect(seriesRecordSpoken(record)).toBe("3 won, 1 drawn, 3 lost");
  });

  it("keeps a zero column so every record has the same shape", () => {
    expect(seriesRecordText({ wins: 4, draws: 0, losses: 0 })).toBe("4W 0D 0L");
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

describe("teamFixtureOrder", () => {
  const day = (d: number) => new Date(Date.UTC(2026, 8, d, 19));
  const fixture = (
    id: string,
    status: string,
    week: number,
    scheduledAt: Date | null,
  ) => ({ id, status, week, scheduledAt });

  it("puts a live series first, then upcoming by kickoff, then results newest first", () => {
    const ordered = teamFixtureOrder([
      fixture("w1", "COMPLETED", 1, day(1)),
      fixture("w2", "COMPLETED", 2, day(8)),
      fixture("w4-untimed", "SCHEDULED", 4, null),
      fixture("w3", "SCHEDULED", 3, day(22)),
      fixture("semi-live", "LIVE", 9, day(15)),
      fixture("w5", "SCHEDULED", 5, day(29)),
    ]);
    expect(ordered.map((m) => m.id)).toEqual([
      "semi-live",
      "w3",
      "w5",
      "w4-untimed",
      "w2",
      "w1",
    ]);
  });

  it("orders results by kickoff, so a moved match sits where it was played", () => {
    const ordered = teamFixtureOrder([
      fixture("w3", "COMPLETED", 3, day(15)),
      // Week 2 was pushed back past week 3's night.
      fixture("w2-moved", "COMPLETED", 2, day(17)),
      fixture("w1-untimed", "COMPLETED", 1, null),
    ]);
    expect(ordered.map((m) => m.id)).toEqual(["w2-moved", "w3", "w1-untimed"]);
  });

  it("falls back to week order when no result has a time", () => {
    const ordered = teamFixtureOrder([
      fixture("a", "COMPLETED", 1, null),
      fixture("b", "COMPLETED", 3, null),
      fixture("c", "COMPLETED", 2, null),
    ]);
    expect(ordered.map((m) => m.id)).toEqual(["b", "c", "a"]);
  });
});

describe("win streaks", () => {
  const night = (week: number, hour = 19) =>
    new Date(Date.UTC(2026, 8, week * 7, hour));
  /** A series in week `week`; `winner` null for a draw. */
  const played = (
    id: string,
    week: number,
    home: string,
    away: string,
    winner: string | null,
    extra: Partial<SeriesOrderMatch> = {},
  ): SeriesOrderMatch => ({
    id,
    week,
    scheduledAt: night(week),
    homeTeamId: home,
    awayTeamId: away,
    status: "COMPLETED",
    winnerTeamId: winner,
    homeScore: winner === home ? 2 : 1,
    awayScore: winner === away ? 2 : 1,
    ...extra,
  });

  it("shows from two series in a row", () => {
    expect(WIN_STREAK_MIN).toBe(2);
  });

  it("counts consecutive series wins back from the latest result", () => {
    const matches = [
      played("1", 1, A, B, B),
      played("2", 2, A, C, A),
      played("3", 3, B, A, A),
      played("4", 4, A, C, A),
    ];
    expect(seriesWinStreak(A, matches)).toBe(3);
    expect(seriesWinStreak(B, matches)).toBe(0);
    expect(seriesWinStreak(C, matches)).toBe(0);
  });

  it("ends at a draw as surely as at a loss", () => {
    const matches = [
      played("1", 1, A, B, A),
      played("2", 2, A, C, A),
      played("3", 3, A, B, null),
      played("4", 4, C, A, A),
    ];
    expect(seriesWinStreak(A, matches)).toBe(1);
  });

  it("skips series still being played, counting every phase", () => {
    const matches = [
      played("1", 1, A, B, A),
      played("2", 6, A, C, A, { status: "LIVE", winnerTeamId: null }),
      played("3", 5, A, B, A),
    ].sort(compareSeriesOrder);
    expect(seriesWinStreak(A, matches)).toBe(2);
  });

  it("orders one week's two series by kickoff, then id, never query order", () => {
    // A tiebreaker knockout: A loses the 18:00 game, wins the 21:00 one.
    const early = played("tb-b", 3, A, B, B, { scheduledAt: night(3, 18) });
    const late = played("tb-a", 3, A, C, A, { scheduledAt: night(3, 21) });
    const before = played("w2", 2, A, C, A);
    for (const query of [
      [before, early, late],
      [late, early, before],
    ]) {
      const { form, streaks } = standingsForm([A], query, { streaks: true });
      expect(form.get(A)).toEqual(["W", "L", "W"]);
      expect(streaks?.get(A)).toBe(1);
    }
    // Same kickoff (or none): the id decides, so both pages agree.
    const untimed = [
      played("x2", 3, A, B, A, { scheduledAt: null }),
      played("x1", 3, A, C, null, { scheduledAt: null }),
    ];
    expect(
      standingsForm([A], untimed, { streaks: true }).form.get(A),
    ).toEqual(["W", "D"]);
    // An untimed series sorts after a timed one in its week.
    expect(
      compareSeriesOrder(
        played("p", 3, A, B, A, { scheduledAt: null }),
        played("q", 3, A, C, A),
      ),
    ).toBeGreaterThan(0);
  });

  it("agrees with the Last 5 strip it sits beside", () => {
    const matches = [
      played("1", 1, A, B, A),
      played("2", 2, C, A, A),
      played("3", 3, A, B, B),
      played("4", 4, A, C, A),
      played("5", 5, B, A, A),
      played("6", 6, A, C, A),
    ];
    const { form, streaks } = standingsForm([A, B, C], matches, {
      streaks: true,
    });
    for (const id of [A, B, C]) {
      const strip = form.get(id)!;
      const leadingWins = strip.findIndex((r) => r !== "W");
      expect(streaks?.get(id)).toBe(
        leadingWins === -1 ? strip.length : leadingWins,
      );
    }
    expect(streaks?.get(A)).toBe(3);
  });

  it("leaves streaks out unless the table is live", () => {
    const matches = [played("1", 1, A, B, A), played("2", 2, A, C, A)];
    expect(standingsForm([A], matches, { streaks: false }).streaks).toBe(
      undefined,
    );
    expect(standingsStreaksShown({ isActive: true, status: "REGULAR_SEASON" })).toBe(true);
    expect(standingsStreaksShown({ isActive: true, status: "PLAYOFFS" })).toBe(true);
    expect(standingsStreaksShown({ isActive: true, status: "COMPLETE" })).toBe(false);
    expect(standingsStreaksShown({ isActive: false, status: "REGULAR_SEASON" })).toBe(false);
    expect(standingsStreaksShown({ isActive: true, status: "DRAFT" })).toBe(false);
  });
});
