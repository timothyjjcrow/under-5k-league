import { describe, it, expect } from "vitest";
import {
  CLOCK_OFFSET_STEP_MS,
  countdownLabel,
  elapsedSince,
  hasPassed,
  kickoffClock,
  kickoffClockSpoken,
  LIVE_WINDOW_MS,
  nextClockOffset,
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

describe("hasPassed", () => {
  it("flips exactly where the label goes quiet", () => {
    expect(hasPassed(T + DAY, T)).toBe(false);
    expect(hasPassed(T, T)).toBe(false);
    expect(hasPassed(T - LIVE_WINDOW_MS + 1, T)).toBe(false);
    expect(hasPassed(T - LIVE_WINDOW_MS, T)).toBe(true);
    expect(hasPassed(T - DAY, T)).toBe(true);
  });

  // The two are the same boundary, and a caller renders "this date has been and
  // gone" off one while the countdown vanishes off the other. If they ever
  // disagree, a passed draft night renders as an upcoming plan again — the
  // exact bug this pair exists to close.
  it("agrees with countdownLabel at every offset", () => {
    for (let m = -600; m <= 600; m += 3) {
      const target = T + m * MIN;
      expect(hasPassed(target, T)).toBe(countdownLabel(target, T) === null);
    }
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

// The other half of each room's apply(): how the offset above is maintained
// across polls. It lived inline in both rooms, byte-identical, untested.
describe("nextClockOffset", () => {
  it("IGNORES sub-second jitter, returning the previous value identically", () => {
    // `serverNow - clientNow` moves a few ms on every poll, and this feeds
    // React state read by every clock in the room. Adopting each measurement
    // would re-render the room + player pool ~40 times a minute, undoing the
    // leaf-clock optimisation. Identity is what triggers React's bail-out, so
    // a recomputed equal number would not be good enough.
    const prev = 3000;
    expect(nextClockOffset(prev, T + 3040, T)).toBe(prev);
    expect(nextClockOffset(prev, T + 2999, T)).toBe(prev);
  });

  it("adopts a skew that has moved a WHOLE second, outright", () => {
    // No smoothing: the clocks re-base in one step. A whole second is the
    // smallest change any of these countdowns can actually render.
    expect(nextClockOffset(3000, T + 4000, T)).toBe(4000);
    expect(nextClockOffset(0, T - 1000, T)).toBe(-1000);
  });

  it("treats the threshold as inclusive at exactly one second", () => {
    expect(nextClockOffset(0, T + CLOCK_OFFSET_STEP_MS, T)).toBe(
      CLOCK_OFFSET_STEP_MS,
    );
    expect(nextClockOffset(0, T + CLOCK_OFFSET_STEP_MS - 1, T)).toBe(0);
  });

  it("is symmetric — a client that runs FAST re-bases the same way", () => {
    // The comparison is on the absolute move, so a device whose clock drifts
    // ahead is corrected as readily as one that drifts behind.
    expect(nextClockOffset(0, T - 5000, T)).toBe(-5000);
    expect(nextClockOffset(-5000, T, T)).toBe(0);
  });

  it("lets slow drift accumulate until it crosses, then takes it whole", () => {
    // Each measurement is compared against the last ADOPTED value, not the
    // last seen one — so 40 polls of +25ms drift are ignored until the total
    // reaches a second, at which point the full correction lands at once.
    let offset = 0;
    for (let i = 1; i <= 39; i++) offset = nextClockOffset(offset, T + i * 25, T);
    expect(offset).toBe(0);
    offset = nextClockOffset(offset, T + 40 * 25, T);
    expect(offset).toBe(1000);
  });
});

describe("kickoffClock", () => {
  it("splits the time left into days, hours, minutes and seconds", () => {
    expect(
      kickoffClock(T + 2 * DAY + 5 * HOUR + 12 * MIN + 33_000, T),
    ).toEqual({ state: "upcoming", days: 2, hours: 5, minutes: 12, seconds: 33 });
  });

  it("rounds a part second up, so it never reads zero before kickoff", () => {
    expect(kickoffClock(T + 400, T)).toEqual({
      state: "upcoming",
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 1,
    });
  });

  it("agrees with the chip on when kickoff is now and when it is over", () => {
    for (const offset of [0, -1, -LIVE_WINDOW_MS + 1, -LIVE_WINDOW_MS, -DAY]) {
      const clock = kickoffClock(T + offset, T);
      const label = countdownLabel(T + offset, T);
      expect(clock.state === "now").toBe(label === "happening now");
      expect(clock.state === "over").toBe(label === null);
      expect(clock.state === "over").toBe(hasPassed(T + offset, T));
    }
  });
});

describe("kickoffClockSpoken", () => {
  const upcoming = (ms: number) => {
    const clock = kickoffClock(T + ms, T);
    if (clock.state !== "upcoming") throw new Error("expected upcoming");
    return kickoffClockSpoken(clock);
  };

  it("says days, hours and minutes, and never the seconds", () => {
    expect(upcoming(2 * DAY + 5 * HOUR + 12 * MIN + 33_000)).toBe(
      "2 days, 5 hours and 12 minutes",
    );
    expect(upcoming(DAY + MIN)).toBe("1 day, 0 hours and 1 minute");
  });

  it("drops empty leading units", () => {
    expect(upcoming(3 * HOUR + 4 * MIN)).toBe("3 hours and 4 minutes");
  });

  it("rounds the last hour up to whole minutes", () => {
    expect(upcoming(12 * MIN + 30_000)).toBe("13 minutes");
    expect(upcoming(20_000)).toBe("1 minute");
  });
});
