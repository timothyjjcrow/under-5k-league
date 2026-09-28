import { describe, expect, it } from "vitest";
import {
  captainOverdueResults,
  nextRegularKickoff,
  regularResultsDue,
  regularSeasonStatus,
  pendingResultsMessage,
  resultOverdue,
  standingsCaption,
} from "./schedule-status";

function m(week: number, status: string, phase = "REGULAR") {
  return { week, status, phase };
}

describe("regularSeasonStatus", () => {
  it("counts completion per week and overall", () => {
    const s = regularSeasonStatus([
      m(1, "COMPLETED"),
      m(1, "COMPLETED"),
      m(2, "COMPLETED"),
      m(2, "SCHEDULED"),
      m(3, "LIVE"),
    ]);
    expect(s.total).toBe(5);
    expect(s.completed).toBe(3);
    expect(s.pending).toBe(2);
    expect(s.allComplete).toBe(false);
    expect(s.pendingWeeks).toEqual([2, 3]);
    expect(s.weeks.find((w) => w.week === 2)).toMatchObject({
      total: 2,
      completed: 1,
      pending: 1,
    });
  });

  it("is allComplete when every regular match is entered", () => {
    const s = regularSeasonStatus([m(1, "COMPLETED"), m(2, "COMPLETED")]);
    expect(s.allComplete).toBe(true);
    expect(s.pending).toBe(0);
    expect(s.pendingWeeks).toEqual([]);
  });

  it("ignores playoff matches", () => {
    const s = regularSeasonStatus([
      m(1, "COMPLETED"),
      m(2, "SCHEDULED", "PLAYOFF"),
      m(2, "SCHEDULED", "FINAL"),
    ]);
    expect(s.total).toBe(1);
    expect(s.allComplete).toBe(true);
  });

  it("treats an empty schedule as not-yet-complete", () => {
    const s = regularSeasonStatus([]);
    expect(s.total).toBe(0);
    expect(s.allComplete).toBe(false);
    expect(s.pending).toBe(0);
  });
});

describe("pendingResultsMessage", () => {
  it("summarizes what's outstanding, or null when done", () => {
    expect(
      pendingResultsMessage(regularSeasonStatus([m(1, "COMPLETED")])),
    ).toBeNull();
    expect(
      pendingResultsMessage(
        regularSeasonStatus([m(1, "COMPLETED"), m(2, "SCHEDULED")]),
      ),
    ).toMatch(/1 regular-season match still needs results \(week 2\)/);
  });
});

describe("standingsCaption", () => {
  const caption = (
    matches: ReturnType<typeof m>[],
    postseason = false,
  ) =>
    standingsCaption({
      status: regularSeasonStatus(matches),
      postseason,
      bracketSize: 4,
      eligibleTeams: 6,
    });

  it("never calls a table of zeros final", () => {
    expect(caption([m(1, "SCHEDULED"), m(2, "SCHEDULED")])).toBe(
      "No results yet · 4 playoff places",
    );
    // Even when the phase has moved on without a single result.
    expect(caption([m(1, "SCHEDULED")], true)).toBe(
      "No results yet · 4 playoff places",
    );
  });

  it("describes the race while results are still coming in", () => {
    expect(caption([m(1, "COMPLETED"), m(2, "SCHEDULED")])).toBe(
      "4 playoff places · 6 eligible teams",
    );
  });

  it("is final once every regular result is in or the playoffs have begun", () => {
    expect(caption([m(1, "COMPLETED"), m(2, "COMPLETED")])).toBe(
      "Final regular-season table",
    );
    expect(caption([m(1, "COMPLETED"), m(2, "SCHEDULED")], true)).toBe(
      "Final regular-season table",
    );
  });

  it("omits the playoff places when no bracket fits", () => {
    expect(
      standingsCaption({
        status: regularSeasonStatus([m(1, "SCHEDULED")]),
        postseason: false,
        bracketSize: 0,
        eligibleTeams: 1,
      }),
    ).toBe("No results yet");
  });
});

describe("captainOverdueResults", () => {
  const freshFrom = Date.parse("2026-09-20T00:00:00Z");
  const fixture = (
    id: string,
    kickoff: string | null,
    extra: Partial<{
      status: string;
      phase: string;
      homeTeamId: string;
      awayTeamId: string;
    }> = {},
  ) => ({
    id,
    phase: "REGULAR",
    status: "SCHEDULED",
    scheduledAt: kickoff ? new Date(kickoff) : null,
    homeTeamId: "mine",
    awayTeamId: "them",
    ...extra,
  });

  it("lists the captain's own unreported fixtures past the sync window, oldest first", () => {
    const due = captainOverdueResults(
      [
        fixture("later", "2026-09-13T01:00:00Z"),
        fixture("earlier", "2026-09-06T01:00:00Z", {
          homeTeamId: "them",
          awayTeamId: "mine",
        }),
      ],
      new Set(["mine"]),
      "REGULAR_SEASON",
      freshFrom,
    );
    expect(due.map((m) => m.id)).toEqual(["earlier", "later"]);
  });

  it("leaves out fresh, untimed, started, finished and other teams' fixtures", () => {
    const due = captainOverdueResults(
      [
        fixture("fresh", "2026-09-21T01:00:00Z"),
        fixture("untimed", null),
        fixture("live", "2026-09-06T01:00:00Z", { status: "LIVE" }),
        fixture("done", "2026-09-06T01:00:00Z", { status: "COMPLETED" }),
        fixture("others", "2026-09-06T01:00:00Z", {
          homeTeamId: "a",
          awayTeamId: "b",
        }),
      ],
      new Set(["mine"]),
      "REGULAR_SEASON",
      freshFrom,
    );
    expect(due).toEqual([]);
  });

  it("only asks while captains can still report in this phase", () => {
    const regular = fixture("regular", "2026-09-06T01:00:00Z");
    const semi = fixture("semi", "2026-09-06T01:00:00Z", { phase: "PLAYOFF" });
    const mine = new Set(["mine"]);
    expect(
      captainOverdueResults([regular, semi], mine, "PLAYOFFS", freshFrom).map(
        (m) => m.id,
      ),
    ).toEqual(["semi"]);
    expect(
      captainOverdueResults([regular, semi], mine, "COMPLETE", freshFrom),
    ).toEqual([]);
    expect(
      captainOverdueResults([regular], new Set(), "REGULAR_SEASON", freshFrom),
    ).toEqual([]);
  });

  it("marks the same fixtures overdue for everyone", () => {
    expect(
      resultOverdue(fixture("x", "2026-09-06T01:00:00Z"), freshFrom),
    ).toBe(true);
    expect(
      resultOverdue(fixture("x", "2026-09-21T01:00:00Z"), freshFrom),
    ).toBe(false);
  });
});

describe("regularResultsDue — only fixtures past kickoff", () => {
  const now = Date.UTC(2026, 9, 14, 18);
  const at = (hoursFromNow: number | null) =>
    hoursFromNow == null ? null : new Date(now + hoursFromNow * 3600_000);
  const fx = (
    week: number,
    status: string,
    hours: number | null,
    phase = "REGULAR",
  ) => ({ week, status, phase, scheduledAt: at(hours) });

  it("counts live and past-kickoff fixtures, never future or untimed ones", () => {
    const due = regularResultsDue(
      [
        fx(1, "SCHEDULED", -2),
        fx(1, "LIVE", 1), // a live series is due even if its kickoff moved
        fx(1, "COMPLETED", -2),
        fx(1, "SCHEDULED", 0), // kickoff is now
        fx(2, "SCHEDULED", 24 * 7),
        fx(3, "SCHEDULED", null),
        fx(1, "SCHEDULED", -2, "TIEBREAKER"),
      ],
      now,
    );
    expect(due.map((m) => [m.week, m.status])).toEqual([
      [1, "SCHEDULED"],
      [1, "LIVE"],
      [1, "SCHEDULED"],
    ]);
  });

  it("is empty on day one, before anything kicks off", () => {
    expect(
      regularResultsDue([fx(1, "SCHEDULED", 48), fx(2, "SCHEDULED", 216)], now),
    ).toEqual([]);
  });

  it("names the next week to kick off and when", () => {
    expect(
      nextRegularKickoff(
        [
          fx(1, "SCHEDULED", -2),
          fx(3, "SCHEDULED", 24 * 14),
          fx(2, "SCHEDULED", 24 * 7),
          fx(2, "LIVE", 24),
          fx(2, "SCHEDULED", null),
          fx(1, "SCHEDULED", 5, "TIEBREAKER"),
        ],
        now,
      ),
    ).toEqual({ week: 2, at: at(24 * 7) });
    expect(nextRegularKickoff([fx(1, "SCHEDULED", -2)], now)).toBeNull();
  });
});
