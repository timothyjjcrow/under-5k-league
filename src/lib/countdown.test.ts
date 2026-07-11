import { describe, it, expect } from "vitest";
import { countdownLabel, LIVE_WINDOW_MS } from "./countdown";

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
