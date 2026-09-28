import { describe, expect, it } from "vitest";
import { AUTO_SYNC, MATCH_STATUS, SEASON_STATUS } from "./constants";
import {
  TONIGHT_AHEAD_HOURS,
  TONIGHT_FINISHED_HOURS,
  matchNightSide,
  matchNightSlate,
  nightSideLabel,
} from "./admin-match-night";

const NOW = Date.UTC(2026, 8, 20, 1, 0, 0);
const HOUR = 3600_000;

const fixture = (
  id: string,
  kickoffOffsetHours: number | null,
  status: string = MATCH_STATUS.SCHEDULED,
) => ({
  id,
  status,
  scheduledAt:
    kickoffOffsetHours === null
      ? null
      : new Date(NOW + kickoffOffsetHours * HOUR),
});

describe("matchNightSlate", () => {
  const regular = SEASON_STATUS.REGULAR_SEASON;

  it("keeps tonight's upcoming, playing and waiting fixtures in kickoff order", () => {
    const slate = matchNightSlate(
      regular,
      [
        fixture("later", 2),
        fixture("waiting", -30),
        fixture("soon", 0.5),
        fixture("playing", -1, MATCH_STATUS.LIVE),
      ],
      NOW,
    );
    expect(slate.map((m) => m.id)).toEqual([
      "waiting",
      "playing",
      "soon",
      "later",
    ]);
  });

  it("leaves out next week and results older than the automatic window", () => {
    const slate = matchNightSlate(
      regular,
      [
        fixture("next-week", 7 * 24),
        fixture("edge-ahead", TONIGHT_AHEAD_HOURS),
        fixture("too-old", -(AUTO_SYNC.WINDOW_HOURS + 1)),
        fixture("edge-old", -AUTO_SYNC.WINDOW_HOURS),
      ],
      NOW,
    );
    expect(slate.map((m) => m.id)).toEqual(["edge-old", "edge-ahead"]);
  });

  it("shows a finished match only on the night it was played", () => {
    const slate = matchNightSlate(
      regular,
      [
        fixture("tonight", -2, MATCH_STATUS.COMPLETED),
        fixture("yesterday", -(TONIGHT_FINISHED_HOURS + 1), MATCH_STATUS.COMPLETED),
      ],
      NOW,
    );
    expect(slate.map((m) => m.id)).toEqual(["tonight"]);
  });

  it("keeps a LIVE series even without a kickoff, and drops other untimed rows", () => {
    const slate = matchNightSlate(
      regular,
      [fixture("untimed", null), fixture("live", null, MATCH_STATUS.LIVE)],
      NOW,
    );
    expect(slate.map((m) => m.id)).toEqual(["live"]);
  });

  it("is empty outside the Regular season and Playoffs", () => {
    const matches = [fixture("soon", 1)];
    expect(matchNightSlate(SEASON_STATUS.PLAYOFFS, matches, NOW)).toHaveLength(1);
    for (const status of [
      SEASON_STATUS.SIGNUPS,
      SEASON_STATUS.DRAFT,
      SEASON_STATUS.COMPLETE,
    ]) {
      expect(matchNightSlate(status, matches, NOW)).toEqual([]);
    }
  });
});

describe("matchNightSide", () => {
  const roster = ["a", "b", "c", "d", "e"];

  it("counts check-ins against the side size", () => {
    const side = matchNightSide(
      roster,
      "home",
      [],
      [
        { userId: "a", status: "IN" },
        { userId: "b", status: "IN" },
        { userId: "c", status: "OUT" },
        { userId: "outsider", status: "IN" },
      ],
      5,
    );
    expect(side).toEqual({ confirmed: 2, out: 1, expected: 5, standins: 0 });
  });

  it("drops a covered player's out and counts the standin's own answer", () => {
    const side = matchNightSide(
      roster,
      "home",
      [
        { teamId: "home", standinUserId: "s1", replacingUserId: "c" },
        { teamId: "away", standinUserId: "s2", replacingUserId: "x" },
      ],
      [
        { userId: "c", status: "OUT" },
        { userId: "s1", status: "IN" },
      ],
      5,
    );
    expect(side).toEqual({ confirmed: 1, out: 0, expected: 5, standins: 1 });
  });

  it("never shows a short roster as complete", () => {
    const side = matchNightSide(
      ["a", "b", "c", "d"],
      "home",
      [],
      ["a", "b", "c", "d"].map((userId) => ({ userId, status: "IN" })),
      5,
    );
    expect(nightSideLabel(side)).toBe("4/5 checked in");
  });
});

describe("nightSideLabel", () => {
  it("adds out and standin counts only when there are any", () => {
    expect(
      nightSideLabel({ confirmed: 3, out: 1, expected: 5, standins: 2 }),
    ).toBe("3/5 checked in · 1 out · 2 standins");
    expect(
      nightSideLabel({ confirmed: 5, out: 0, expected: 5, standins: 1 }),
    ).toBe("5/5 checked in · 1 standin");
  });
});
