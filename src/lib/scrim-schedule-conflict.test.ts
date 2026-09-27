import { describe, expect, it } from "vitest";
import {
  describeScrimConflict,
  describeScrimYield,
  scrimCollisionRange,
  scrimConflictFix,
  SCRIM_COLLISION_WINDOW_MS,
} from "./scrim-schedule-conflict";
import { SCRIM_STATUS } from "./constants";
import { formatLeagueTime } from "./zoned-time";

const AT = new Date(Date.UTC(2026, 9, 4, 3, 0));
const FINAL = new Date(AT.getTime() + 2 * 3_600_000);

describe("scrim conflict wording", () => {
  it("names both teams and the league-clock time", () => {
    expect(
      describeScrimConflict({
        hostTeamName: "Radiant Raccoons",
        opponentTeamName: "Dire Straits",
        scheduledAt: AT,
      }),
    ).toBe(
      `the Radiant Raccoons vs Dire Straits scrim on ${formatLeagueTime(AT)}`,
    );
    expect(
      describeScrimConflict({
        hostTeamName: "Radiant Raccoons",
        opponentTeamName: null,
        scheduledAt: AT,
      }),
    ).toBe(`the Radiant Raccoons scrim on ${formatLeagueTime(AT)}`);
  });

  it("tells the admin whether the scrim was cancelled or kept", () => {
    const clash = {
      hostTeamName: "Radiant Raccoons",
      opponentTeamName: "Dire Straits",
      scheduledAt: AT,
    };
    expect(describeScrimYield({ ...clash, cancelled: true }, "the grand final", FINAL)).toBe(
      `Cancelled the Radiant Raccoons vs Dire Straits scrim on ${formatLeagueTime(AT)}: it clashed with the grand final on ${formatLeagueTime(FINAL)}.`,
    );
    const kept = describeScrimYield({ ...clash, cancelled: false }, "the grand final", FINAL);
    expect(kept).toMatch(/^Kept the Radiant Raccoons vs Dire Straits scrim on /);
    expect(kept).toContain("end it at its current score");
  });

  it("points a booked scrim at Cancel and a live one at End series", () => {
    expect(scrimConflictFix({ status: SCRIM_STATUS.SCHEDULED })).toBe(
      "Cancel that scrim on its page",
    );
    // A live scrim can't be cancelled; its page only offers "End series".
    expect(scrimConflictFix({ status: SCRIM_STATUS.LIVE })).toBe(
      "End that series on its scrim page",
    );
  });

  it("collides within four hours either side", () => {
    const range = scrimCollisionRange(AT);
    expect(AT.getTime() - range.gte.getTime()).toBe(SCRIM_COLLISION_WINDOW_MS);
    expect(range.lte.getTime() - AT.getTime()).toBe(SCRIM_COLLISION_WINDOW_MS);
  });
});
