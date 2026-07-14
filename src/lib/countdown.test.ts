import { describe, it, expect } from "vitest";
import {
  countdownLabel,
  elapsedSince,
  LIVE_WINDOW_MS,
  secondsUntil,
} from "./countdown";

const T = 1_800_000_000_000; // arbitrary fixed "now"
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("countdownLabel", () => {
  it("counts minutes inside the last hour", () => {
    expect(countdownLabel(T + 30 * MIN, T)).toBe("in 30 min");
    expect(countdownLabel(T + 30_000, T)).toBe("in 1 min");
  });

  it("counts hours and minutes inside a day", () => {
    expect(countdownLabel(T + 5 * HOUR + 20 * MIN, T)).toBe("in 5h 20m");
    expect(countdownLabel(T + 2 * HOUR, T)).toBe("in 2h");
  });

  it("counts days beyond 24h", () => {
    expect(countdownLabel(T + 2 * DAY + 5 * HOUR, T)).toBe("in 2d 5h");
    expect(countdownLabel(T + 3 * DAY, T)).toBe("in 3d");
  });

  it("shows happening-now through the live window, then nothing", () => {
    expect(countdownLabel(T, T)).toBe("happening now");
    expect(countdownLabel(T - LIVE_WINDOW_MS + 1, T)).toBe("happening now");
    expect(countdownLabel(T - LIVE_WINDOW_MS, T)).toBeNull();
  });
});

describe("secondsUntil (live-room countdown)", () => {
  it("rounds up partial seconds so the clock shows the ceiling", () => {
    // 4.2s left → "5s" (ceil), matching the original Math.ceil behavior.
    expect(secondsUntil(T + 4200, 0, T)).toBe(5);
    expect(secondsUntil(T + 5000, 0, T)).toBe(5);
    expect(secondsUntil(T + 5001, 0, T)).toBe(6);
  });

  it("clamps to zero once the deadline passes (never negative)", () => {
    expect(secondsUntil(T, 0, T)).toBe(0);
    expect(secondsUntil(T - 10_000, 0, T)).toBe(0);
  });

  it("returns 0 when there is no active deadline", () => {
    expect(secondsUntil(null, 0, T)).toBe(0);
    expect(secondsUntil(undefined, 500, T)).toBe(0);
  });

  it("corrects for server/client clock skew via offsetMs", () => {
    // Client clock is 3s BEHIND the server (serverNow − clientNow = +3000).
    // A deadline 5s out on the server should still read 5s locally, not 8s.
    const offset = 3000;
    const clientNow = T;
    const serverDeadline = clientNow + offset + 5000;
    expect(secondsUntil(serverDeadline, offset, clientNow)).toBe(5);
  });
});

describe("elapsedSince (inhouse game timer)", () => {
  it("returns null before the game has started", () => {
    expect(elapsedSince(null, 0, T)).toBeNull();
    expect(elapsedSince(undefined, 0, T)).toBeNull();
  });

  it("measures elapsed ms, skew-corrected", () => {
    expect(elapsedSince(T - 90_000, 0, T)).toBe(90_000);
    // Client 2s ahead of server (offset −2000): started 60s ago on the server.
    expect(elapsedSince(T - 60_000, -2000, T)).toBe(58_000);
  });
});
