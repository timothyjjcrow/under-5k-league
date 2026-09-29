import { describe, expect, it } from "vitest";
import {
  INHOUSE_HISTORY_PAGE_SIZE,
  inhouseEndedAt,
  inhouseHistoryPage,
  inhouseHistorySides,
  inhousePlayedAt,
  type InhouseHistorySidePlayer,
} from "./inhouse-history";

describe("inhousePlayedAt", () => {
  const createdAt = new Date("2026-01-01T01:00:00Z");
  const startedAt = new Date("2026-01-01T01:10:00Z");
  const matchStartTime = new Date("2026-01-01T01:12:00Z");

  it("prefers Valve's match start over the host click and lobby formation", () => {
    expect(inhousePlayedAt({ matchStartTime, startedAt, createdAt })).toBe(
      matchStartTime,
    );
  });

  it("falls back through the site start and formation time for older rows", () => {
    expect(
      inhousePlayedAt({ matchStartTime: null, startedAt, createdAt }),
    ).toBe(startedAt);
    expect(
      inhousePlayedAt({ matchStartTime: null, startedAt: null, createdAt }),
    ).toBe(createdAt);
  });
});

describe("inhouseEndedAt", () => {
  const createdAt = new Date("2026-01-01T01:00:00Z");
  const startedAt = new Date("2026-01-01T01:10:00Z");
  const matchStartTime = new Date("2026-01-01T01:12:00Z");
  const completedAt = new Date("2026-01-01T02:00:00Z");

  it("uses the played start plus Valve's duration when both are known", () => {
    expect(
      inhouseEndedAt({
        matchStartTime,
        startedAt,
        createdAt,
        completedAt,
        durationSecs: 42 * 60,
      }),
    ).toEqual(new Date("2026-01-01T01:54:00Z"));
  });

  it("falls back to the stable completion claim, never a retry timestamp", () => {
    expect(
      inhouseEndedAt({
        matchStartTime: null,
        startedAt,
        createdAt,
        completedAt,
        durationSecs: null,
      }),
    ).toBe(completedAt);
  });
});

describe("inhouseHistoryPage", () => {
  it("defaults malformed input and consistently uses the first repeated value", () => {
    expect(inhouseHistoryPage(undefined, 250).page).toBe(1);
    expect(inhouseHistoryPage("nope", 250).page).toBe(1);
    expect(inhouseHistoryPage(["2", "3"], 250).page).toBe(2);
    expect(inhouseHistoryPage("99999999999999999999", 250).page).toBe(1);
  });

  it("clamps to the last real page and returns its offset", () => {
    expect(inhouseHistoryPage("9", 201)).toEqual({
      page: 3,
      pages: 3,
      skip: INHOUSE_HISTORY_PAGE_SIZE * 2,
    });
  });

  it("keeps an empty archive on a single page", () => {
    expect(inhouseHistoryPage("2", 0)).toEqual({ page: 1, pages: 1, skip: 0 });
  });
});

describe("inhouseHistorySides", () => {
  const player = (
    userId: string,
    team: number | null,
    isCaptain = false,
  ): InhouseHistorySidePlayer => ({
    userId,
    team,
    isCaptain,
    name: userId.toUpperCase(),
  });
  const lobby = [
    player("ember", 1, true),
    player("storm", 1),
    player("wisp", 2, true),
    player("nova", 2),
  ];

  it("names both sides after their captains", () => {
    expect(inhouseHistorySides(lobby, 2, null)).toEqual({
      winnerCaptain: "WISP",
      loserCaptain: "EMBER",
      viewer: null,
    });
  });

  it("marks the game won or lost for a viewer who played it", () => {
    expect(inhouseHistorySides(lobby, 1, "storm").viewer).toBe("won");
    expect(inhouseHistorySides(lobby, 1, "nova").viewer).toBe("lost");
    expect(inhouseHistorySides(lobby, 1, "wisp").viewer).toBe("lost");
  });

  it("gives no result to a viewer who was not in the game", () => {
    expect(inhouseHistorySides(lobby, 1, "outsider").viewer).toBeNull();
    expect(inhouseHistorySides(lobby, 1, null).viewer).toBeNull();
  });

  it("drops the captain names when a side has no captain or two", () => {
    // The import moved a captain who sat on the other side in Dota.
    const moved = [
      player("ember", 2, true),
      player("wisp", 2, true),
      player("storm", 1),
    ];
    expect(inhouseHistorySides(moved, 1, "storm")).toEqual({
      winnerCaptain: null,
      loserCaptain: null,
      viewer: "won",
    });
    expect(
      inhouseHistorySides([player("storm", 1), player("nova", 2)], 1, null),
    ).toMatchObject({ winnerCaptain: null, loserCaptain: null });
  });

  it("says nothing about a game with no winner or a player with no side", () => {
    expect(inhouseHistorySides(lobby, null, "ember")).toEqual({
      winnerCaptain: null,
      loserCaptain: null,
      viewer: null,
    });
    expect(
      inhouseHistorySides([...lobby, player("pool", null)], 1, "pool").viewer,
    ).toBeNull();
  });
});
