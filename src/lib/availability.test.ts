import { describe, it, expect } from "vitest";
import {
  CHECKIN_REFUSAL,
  CHECKIN_REFUSAL_MESSAGE,
  checkinClosedReason,
  matchNightRoster,
  outPingThrottleKey,
  parseAvailabilityStatus,
  teamAvailability,
  expectedSideSize,
} from "./availability";
import {
  AUTO_SYNC,
  DRAFT_STATUS,
  MATCH_STATUS,
  SEASON_STATUS,
} from "./constants";

describe("teamAvailability", () => {
  const roster = ["a", "b", "c", "d", "e"];

  it("counts confirmed, out, and unanswered", () => {
    const s = teamAvailability(roster, [
      { userId: "a", status: "IN" },
      { userId: "b", status: "IN" },
      { userId: "c", status: "OUT" },
    ]);
    expect(s.confirmed).toBe(2);
    expect(s.out).toBe(1);
    expect(s.unanswered).toBe(2);
    expect(s.outUserIds).toEqual(["c"]);
  });

  it("treats everyone as unanswered with no rows", () => {
    const s = teamAvailability(roster, []);
    expect(s).toMatchObject({ confirmed: 0, out: 0, unanswered: 5 });
  });

  it("ignores RSVPs from users not on the roster (e.g. the other team)", () => {
    const s = teamAvailability(roster, [
      { userId: "zz", status: "OUT" },
      { userId: "a", status: "IN" },
    ]);
    expect(s.confirmed).toBe(1);
    expect(s.out).toBe(0);
  });

  it("ignores unknown status strings", () => {
    const s = teamAvailability(roster, [{ userId: "a", status: "MAYBE" }]);
    expect(s).toMatchObject({ confirmed: 0, out: 0, unanswered: 5 });
  });
});

describe("parseAvailabilityStatus", () => {
  it("accepts IN and OUT only", () => {
    expect(parseAvailabilityStatus("IN")).toBe("IN");
    expect(parseAvailabilityStatus("OUT")).toBe("OUT");
    expect(parseAvailabilityStatus("MAYBE")).toBeNull();
    expect(parseAvailabilityStatus("")).toBeNull();
  });
});

describe("matchNightRoster", () => {
  it("swaps covered players for their standins", () => {
    expect(
      matchNightRoster(
        ["a", "b", "c"],
        [{ standinUserId: "s1", replacingUserId: "b" }],
      ),
    ).toEqual(["a", "c", "s1"]);
  });

  it("appends a standin with no named replacement without dropping anyone", () => {
    expect(
      matchNightRoster(["a", "b"], [{ standinUserId: "s1", replacingUserId: null }]),
    ).toEqual(["a", "b", "s1"]);
  });

  it("returns the base roster untouched with no assignments", () => {
    const base = ["a", "b"];
    expect(matchNightRoster(base, [])).toBe(base);
  });

  it("keeps the standin's RSVP countable by teamAvailability", () => {
    const roster = matchNightRoster(
      ["a", "b", "x"],
      [{ standinUserId: "s", replacingUserId: "x" }],
    );
    const summary = teamAvailability(roster, [
      { userId: "a", status: "IN" },
      { userId: "b", status: "IN" },
      { userId: "s", status: "IN" },
      { userId: "x", status: "OUT" }, // replaced player's OUT no longer counts
    ]);
    expect(summary).toMatchObject({ confirmed: 3, out: 0, unanswered: 0 });
  });
});

// The swap is "remove the covered player, add the standin", so an assignment
// whose covered player has left the roster used to make the side come out ONE
// TOO LARGE — the filter removed nobody but the standin was still appended,
// reporting six players in a 5v5 to /schedule, the dashboard strip and the
// Discord week reminder.
describe("matchNightRoster — stale cover can't inflate a side", () => {
  const five = ["a", "b", "c", "d", "e"];

  it("drops cover for someone no longer on the roster", () => {
    // P was released and replaced by "f"; S's assignment still names P.
    const base = ["a", "b", "c", "d", "f"];
    const roster = matchNightRoster(base, [
      { standinUserId: "s", replacingUserId: "p" },
    ]);
    expect(roster).toEqual(base);
    expect(roster).toHaveLength(5);
    expect(roster).not.toContain("s");
  });

  it("still applies cover for a player who IS on the roster", () => {
    const roster = matchNightRoster(five, [
      { standinUserId: "s", replacingUserId: "c" },
    ]);
    expect(roster).toHaveLength(5);
    expect(roster).not.toContain("c");
    expect(roster).toContain("s");
  });

  it("keeps a null-replacement standin — that fills an empty seat, not a player", () => {
    const short = ["a", "b", "c", "d"];
    const roster = matchNightRoster(short, [
      { standinUserId: "s", replacingUserId: null },
    ]);
    expect(roster).toHaveLength(5);
    expect(roster).toContain("s");
  });

  it("handles a mix: one live cover, one stale, one empty-seat fill", () => {
    const base = ["a", "b", "c", "d"];
    const roster = matchNightRoster(base, [
      { standinUserId: "s1", replacingUserId: "c" }, // live
      { standinUserId: "s2", replacingUserId: "gone" }, // stale -> dropped
      { standinUserId: "s3", replacingUserId: null }, // empty seat
    ]);
    expect(roster.sort()).toEqual(["a", "b", "d", "s1", "s3"].sort());
  });

  it("returns the plain roster when every assignment is stale", () => {
    expect(
      matchNightRoster(five, [{ standinUserId: "s", replacingUserId: "ghost" }]),
    ).toEqual(five);
  });

  it("is unchanged for the no-assignments case", () => {
    expect(matchNightRoster(five, [])).toEqual(five);
  });
});

describe("unansweredUserIds — who the week reminder pings", () => {
  const roster = ["a", "b", "c", "d", "e"];

  it("names exactly the people with no answer", () => {
    const s = teamAvailability(roster, [
      { userId: "a", status: "IN" },
      { userId: "b", status: "OUT" },
    ]);
    expect(s.unansweredUserIds).toEqual(["c", "d", "e"]);
  });

  it("always agrees with the count the rest of the app shows", () => {
    for (const rows of [
      [],
      [{ userId: "a", status: "IN" }],
      [{ userId: "a", status: "MAYBE" }],
      [
        { userId: "a", status: "IN" },
        { userId: "b", status: "OUT" },
        { userId: "c", status: "nonsense" },
      ],
    ]) {
      const s = teamAvailability(roster, rows);
      expect(s.unansweredUserIds).toHaveLength(s.unanswered);
    }
  });

  it("treats an unrecognised status as no answer, not as an answer", () => {
    const s = teamAvailability(roster, [{ userId: "a", status: "MAYBE" }]);
    expect(s.unansweredUserIds).toContain("a");
  });

  it("ignores rows for people who aren't on this roster", () => {
    const s = teamAvailability(["a"], [{ userId: "stranger", status: "IN" }]);
    expect(s.unansweredUserIds).toEqual(["a"]);
  });
});

describe("expectedSideSize", () => {
  // A check-in count rendered `confirmed / roster.length`, so a team that lost
  // a player mid-season read "4/4" — complete, in success green, on the
  // dashboard strip AND in the Discord week reminder — while the side was a
  // player short. Being short is the thing a check-in exists to surface.
  it("reports the season's side size, not the roster we happen to have", () => {
    expect(expectedSideSize(5, 4)).toBe(5);
    expect(expectedSideSize(5, 5)).toBe(5);
  });

  it("never hides an oversized side", () => {
    // A standin filling an EMPTY seat adds a player without replacing one, so
    // a roster can legitimately reach or exceed teamSize from below.
    expect(expectedSideSize(5, 6)).toBe(6);
  });

  it("handles an empty roster without inventing a denominator of 0", () => {
    expect(expectedSideSize(5, 0)).toBe(5);
  });
});

describe("checkinClosedReason — the fixture half of the check-in gate", () => {
  const NOW = Date.UTC(2026, 9, 1, 12);
  const soon = new Date(NOW + 24 * 3600_000);
  const regular = SEASON_STATUS.REGULAR_SEASON;
  const scheduled = (scheduledAt: Date | null) => ({
    status: MATCH_STATUS.SCHEDULED,
    scheduledAt,
  });

  it("is null exactly when matchCheckinOpen lets the fixture be answered", () => {
    expect(checkinClosedReason(regular, null, scheduled(soon), NOW)).toBeNull();
    expect(
      checkinClosedReason(regular, null, { status: MATCH_STATUS.LIVE, scheduledAt: soon }, NOW),
    ).toBeNull();
    // Still inside the result window after kickoff: check-in stays open.
    expect(
      checkinClosedReason(regular, null, scheduled(new Date(NOW - 3600_000)), NOW),
    ).toBeNull();
  });

  it("names the most specific reason when it isn't", () => {
    expect(
      checkinClosedReason(regular, null, { status: MATCH_STATUS.COMPLETED, scheduledAt: soon }, NOW),
    ).toBe(CHECKIN_REFUSAL.FINISHED);
    expect(
      checkinClosedReason(SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS, scheduled(soon), NOW),
    ).toBe(CHECKIN_REFUSAL.PHASE);
    expect(
      checkinClosedReason(SEASON_STATUS.COMPLETE, null, scheduled(soon), NOW),
    ).toBe(CHECKIN_REFUSAL.PHASE);
    expect(
      checkinClosedReason(
        regular,
        null,
        scheduled(new Date(NOW - (AUTO_SYNC.WINDOW_HOURS + 1) * 3600_000)),
        NOW,
      ),
    ).toBe(CHECKIN_REFUSAL.KICKOFF_PASSED);
    expect(checkinClosedReason(regular, null, scheduled(null), NOW)).toBe(
      CHECKIN_REFUSAL.NO_KICKOFF,
    );
  });

  it("keeps setAvailability's refusal copy word for word", () => {
    expect(CHECKIN_REFUSAL_MESSAGE.FINISHED).toBe("That match is already finished");
    expect(CHECKIN_REFUSAL_MESSAGE.NOT_PLAYING).toBe("You're not playing in this match");
    expect(CHECKIN_REFUSAL_MESSAGE.WITHDRAWN).toBe(
      "A withdrawn team cannot check in for this match.",
    );
    for (const reason of Object.values(CHECKIN_REFUSAL)) {
      expect(CHECKIN_REFUSAL_MESSAGE[reason], reason).toBeTruthy();
    }
  });
});

describe("outPingThrottleKey", () => {
  it("is the one key both the single OUT and an away range claim", () => {
    // Changing it strands every live throttle row and lets one OUT ping twice.
    expect(outPingThrottleKey("m1", "u1")).toBe("outPing:m1:u1");
  });
});
