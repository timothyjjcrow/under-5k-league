import { describe, expect, it } from "vitest";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";
import {
  DRAFT_PRESENCE,
  captainInRoom,
  captainPresence,
  captainPresenceLine,
  draftPresenceTracked,
  missingCaptainsConfirmLine,
} from "./draft-presence";

const NOW = Date.parse("2026-09-27T18:00:00.000Z");
const secondsAgo = (s: number) => new Date(NOW - s * 1000).toISOString();

describe("DRAFT_PRESENCE windows", () => {
  it("counts a captain away only after several missed writes", () => {
    // A captain writes at most once per WRITE_SECONDS; the away window has to
    // cover at least a couple of those plus a clamped background timer.
    expect(DRAFT_PRESENCE.AWAY_SECONDS).toBeGreaterThanOrEqual(
      DRAFT_PRESENCE.WRITE_SECONDS * 3,
    );
    expect(DRAFT_PRESENCE.AWAY_SECONDS).toBeGreaterThan(60);
  });
});

describe("captainInRoom", () => {
  it("is true up to and including the away window", () => {
    expect(captainInRoom(secondsAgo(0), NOW)).toBe(true);
    expect(captainInRoom(secondsAgo(DRAFT_PRESENCE.AWAY_SECONDS), NOW)).toBe(
      true,
    );
  });

  it("is false once the window has passed", () => {
    expect(
      captainInRoom(secondsAgo(DRAFT_PRESENCE.AWAY_SECONDS + 1), NOW),
    ).toBe(false);
  });

  it("treats a missing or unreadable time as away", () => {
    expect(captainInRoom(null, NOW)).toBe(false);
    expect(captainInRoom(undefined, NOW)).toBe(false);
    expect(captainInRoom("", NOW)).toBe(false);
    expect(captainInRoom("not a date", NOW)).toBe(false);
  });
});

describe("draftPresenceTracked", () => {
  it("tracks the waiting room before Start", () => {
    expect(draftPresenceTracked(SEASON_STATUS.SIGNUPS, null)).toBe(true);
    expect(
      draftPresenceTracked(SEASON_STATUS.DRAFT, DRAFT_STATUS.NOT_STARTED),
    ).toBe(true);
  });

  it("tracks a live or paused auction", () => {
    expect(
      draftPresenceTracked(SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS),
    ).toBe(true);
    expect(draftPresenceTracked(SEASON_STATUS.DRAFT, DRAFT_STATUS.PAUSED)).toBe(
      true,
    );
  });

  it("stops once the draft is over or the season has moved on", () => {
    expect(
      draftPresenceTracked(SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE),
    ).toBe(false);
    expect(
      draftPresenceTracked(
        SEASON_STATUS.REGULAR_SEASON,
        DRAFT_STATUS.COMPLETE,
      ),
    ).toBe(false);
    expect(draftPresenceTracked(SEASON_STATUS.REGULAR_SEASON, null)).toBe(
      false,
    );
  });
});

function team(
  id: string,
  captainName: string,
  captainInRoom: boolean | null,
): {
  name: string;
  captainId: string;
  captainInRoom: boolean | null;
  members: { userId: string; name: string }[];
} {
  return {
    name: `Team ${id}`,
    captainId: `cap-${id}`,
    captainInRoom,
    members: [
      { userId: `cap-${id}`, name: captainName },
      { userId: `p-${id}`, name: `Player ${id}` },
    ],
  };
}

describe("captainPresence", () => {
  it("counts who is here and names who isn't", () => {
    const teams = [
      team("a", "Alice", true),
      team("b", "Bob", false),
      team("c", "Cara", false),
    ];
    expect(captainPresence(teams, null)).toEqual({
      here: 1,
      total: 3,
      away: ["Bob", "Cara"],
    });
  });

  it("always counts the viewer as here", () => {
    const teams = [team("a", "Alice", true), team("b", "Bob", false)];
    expect(captainPresence(teams, "cap-b")).toEqual({
      here: 2,
      total: 2,
      away: [],
    });
  });

  it("falls back to the team name when the captain row is missing", () => {
    const lonely = { ...team("z", "Zed", false), members: [] };
    expect(captainPresence([lonely], null)?.away).toEqual(["Team z"]);
  });

  it("is null when presence isn't tracked or there are no captains", () => {
    expect(captainPresence([], null)).toBeNull();
    expect(
      captainPresence([team("a", "Alice", true), team("b", "Bob", null)], null),
    ).toBeNull();
  });
});

describe("captainPresenceLine", () => {
  it("says everyone is here", () => {
    expect(captainPresenceLine({ here: 4, total: 4, away: [] })).toBe(
      "All 4 captains are in the draft room.",
    );
    expect(captainPresenceLine({ here: 1, total: 1, away: [] })).toBe(
      "The captain is in the draft room.",
    );
  });

  it("names who is missing", () => {
    expect(
      captainPresenceLine({ here: 2, total: 4, away: ["Bob", "Cara"] }),
    ).toBe("2 of 4 captains are in the draft room. Not here: Bob, Cara.");
  });
});

describe("missingCaptainsConfirmLine", () => {
  it("adds nothing when every captain is here", () => {
    expect(missingCaptainsConfirmLine([], "now")).toBe("");
    expect(missingCaptainsConfirmLine([], "pageLoad")).toBe("");
  });

  it("names the missing captains, as a sentence to append", () => {
    const line = missingCaptainsConfirmLine(["Bob", "Cara"], "now");
    expect(line.startsWith(" Not in the draft room right now: Bob, Cara.")).toBe(
      true,
    );
    expect(line).toContain("can't bid");
    expect(line).toContain("nominates for them");
  });

  it("says when /admin's list is only as fresh as the page", () => {
    expect(missingCaptainsConfirmLine(["Bob"], "pageLoad")).toMatch(
      /^ Not in the draft room when this page loaded: Bob\./,
    );
  });
});
