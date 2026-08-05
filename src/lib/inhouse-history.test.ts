import { describe, expect, it } from "vitest";
import {
  INHOUSE_HISTORY_PAGE_SIZE,
  inhouseEndedAt,
  inhouseHistoryPage,
  inhousePlayedAt,
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
