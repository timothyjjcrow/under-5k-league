import { describe, expect, it } from "vitest";
import { leagueProgress, progressSummary } from "./league-progress";
import { AUTO_SYNC } from "./constants";
import type { SlateMatch } from "./schedule";

const now = Date.parse("2026-09-04T20:00:00Z");
const match = (
  id: string,
  status: string,
  week: number,
  scheduledAt: Date | null,
): SlateMatch => ({ id, status, week, scheduledAt, phase: "REGULAR" });

describe("league progress presentation", () => {
  it("tracks the tiebreaker week separately from the completed regular season", () => {
    expect(leagueProgress([
      match("regular", "COMPLETED", 5, new Date(now)),
      { ...match("tb-done", "COMPLETED", 6, new Date(now)), phase: "TIEBREAKER" },
      { ...match("tb-open", "SCHEDULED", 6, new Date(now + 3600_000)), phase: "TIEBREAKER" },
    ], now)).toMatchObject({
      total: 1,
      completed: 1,
      totalWeeks: 5,
      focusWeek: null,
      tiebreakerTotal: 2,
      tiebreakerCompleted: 1,
      tiebreakerPending: 1,
      tiebreakerFocusWeek: 6,
    });
  });

  it("distinguishes future fixtures, live series, missing times, and overdue results", () => {
    const old = new Date(now - (AUTO_SYNC.WINDOW_HOURS + 1) * 3600_000);
    const result = leagueProgress(
      [
        match("done", "COMPLETED", 1, old),
        match("old", "SCHEDULED", 2, old),
        match("live", "LIVE", 3, old),
        match("future", "SCHEDULED", 3, new Date(now + 3600_000)),
        match("untimed", "SCHEDULED", 4, null),
        { ...match("playoff", "COMPLETED", 6, old), phase: "FINAL" },
      ],
      now,
    );
    expect(result).toMatchObject({
      total: 5,
      completed: 1,
      live: 1,
      scheduled: 1,
      untimed: 1,
      focusWeek: 3,
      totalWeeks: 4,
    });
    expect(result.awaiting.map((row) => row.id)).toEqual(["old"]);
    expect(
      result.completed +
        result.live +
        result.scheduled +
        result.untimed +
        result.awaiting.length,
    ).toBe(result.total);
  });

  it("does not call a fixture overdue at the existing sync-window boundary", () => {
    const result = leagueProgress(
      [
        match(
          "boundary",
          "SCHEDULED",
          1,
          new Date(now - AUTO_SYNC.WINDOW_HOURS * 3600_000),
        ),
      ],
      now,
    );
    expect(result.awaiting).toEqual([]);
    expect(result.scheduled).toBe(1);
  });

  it("counts each week's final results for the week bars", () => {
    const old = new Date(now - 7 * 86_400_000);
    const result = leagueProgress(
      [
        match("w1a", "COMPLETED", 1, old),
        match("w1b", "COMPLETED", 1, old),
        match("w3a", "COMPLETED", 3, new Date(now)),
        match("w3b", "LIVE", 3, new Date(now)),
        { ...match("tb", "COMPLETED", 4, old), phase: "TIEBREAKER" },
        { ...match("po", "COMPLETED", 5, old), phase: "PLAYOFF" },
      ],
      now,
    );
    // Week 2 had no fixtures at all; later non-regular weeks are not bars.
    expect(result.weeks).toEqual([
      { week: 1, total: 2, completed: 2 },
      { week: 2, total: 0, completed: 0 },
      { week: 3, total: 2, completed: 1 },
    ]);
    expect(leagueProgress([], now).weeks).toEqual([]);
  });

  it("does not invent a current week for an empty, final, or stale-only schedule", () => {
    expect(leagueProgress([], now)).toMatchObject({
      total: 0,
      totalWeeks: 0,
      focusWeek: null,
    });
    const old = new Date(0);
    expect(
      leagueProgress([match("final", "COMPLETED", 5, old)], now),
    ).toMatchObject({ total: 1, completed: 1, focusWeek: null });
    expect(
      leagueProgress([match("old", "SCHEDULED", 2, old)], now),
    ).toMatchObject({ completed: 0, focusWeek: null });
  });
});

describe("progress summary line", () => {
  it("names the current week and the series played", () => {
    expect(
      progressSummary(
        leagueProgress(
          [
            match("a", "COMPLETED", 1, new Date(now - 7 * 86_400_000)),
            match("b", "COMPLETED", 1, new Date(now - 7 * 86_400_000)),
            match("c", "SCHEDULED", 2, new Date(now + 3600_000)),
            match("d", "SCHEDULED", 3, new Date(now + 7 * 86_400_000)),
          ],
          now,
        ),
      ),
    ).toBe("Week 2 of 3 · 2 of 4 series played");
  });

  it("drops the week once no fixture is current", () => {
    const old = new Date(now - (AUTO_SYNC.WINDOW_HOURS + 1) * 3600_000);
    expect(
      progressSummary(
        leagueProgress(
          [match("a", "COMPLETED", 1, old), match("b", "SCHEDULED", 2, old)],
          now,
        ),
      ),
    ).toBe("1 of 2 series played");
    expect(
      progressSummary(
        leagueProgress([match("a", "COMPLETED", 1, old)], now),
      ),
    ).toBe("1 of 1 series played");
  });

  it("says nothing before fixtures exist", () => {
    expect(progressSummary(leagueProgress([], now))).toBeNull();
  });
});
