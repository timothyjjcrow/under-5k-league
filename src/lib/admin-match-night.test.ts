import { describe, expect, it } from "vitest";
import { AUTO_SYNC, MATCH_STATUS, SEASON_STATUS } from "./constants";
import { checkinCountsText } from "./checkin-side";
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
    expect(side).toEqual({
      in: 2,
      out: 1,
      noReply: 2,
      openSeats: 0,
      of: 5,
      standins: 0,
    });
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
    expect(side).toEqual({
      in: 1,
      out: 0,
      noReply: 4,
      openSeats: 0,
      of: 5,
      standins: 1,
    });
  });

  it("never shows a short roster as complete", () => {
    const side = matchNightSide(
      ["a", "b", "c", "d"],
      "home",
      [],
      ["a", "b", "c", "d"].map((userId) => ({ userId, status: "IN" })),
      5,
    );
    expect(nightSideLabel(side)).toBe("4 of 5 in · 1 open seat");
  });
});

describe("nightSideLabel", () => {
  const side = { in: 3, out: 1, noReply: 1, openSeats: 0, of: 5 };

  // The admin Tonight card and the check-in banner (match page, /schedule,
  // Home) describe the same side of the same match; they must say it the
  // same way, so the admin label is the banner's text plus its standins.
  it("is the check-in banner's wording, plus booked standins", () => {
    expect(nightSideLabel({ ...side, standins: 2 })).toBe(
      `${checkinCountsText(side)} · 2 standins`,
    );
    expect(nightSideLabel({ ...side, standins: 2 })).toBe(
      "3 of 5 in · 1 out · 1 no reply · 2 standins",
    );
    expect(
      nightSideLabel({ in: 5, out: 0, noReply: 0, openSeats: 0, of: 5, standins: 1 }),
    ).toBe("5 of 5 in · 1 standin");
    expect(nightSideLabel({ ...side, standins: 0 })).toBe(
      checkinCountsText(side),
    );
  });

  it("words a live series the way the banner does", () => {
    expect(nightSideLabel({ ...side, standins: 0 }, true)).toBe(
      checkinCountsText(side, true),
    );
    expect(nightSideLabel({ ...side, standins: 0 }, true)).toMatch(
      /^3 of 5 ready/,
    );
  });
});
