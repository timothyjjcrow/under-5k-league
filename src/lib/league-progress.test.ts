import { describe, expect, it } from "vitest";
import { leagueProgress } from "./league-progress";
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
