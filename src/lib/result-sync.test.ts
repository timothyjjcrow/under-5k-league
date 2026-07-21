import { describe, expect, it } from "vitest";
import { AUTO_SYNC, MATCH_STATUS } from "./constants";
import {
  autoSyncClaimCutoff,
  autoSyncClosesAt,
  autoSyncIntervalSeconds,
  autoSyncOpensAt,
  isAutoSyncDue,
  nextAutoSyncAt,
} from "./result-sync";

const NOW = Date.UTC(2026, 6, 12, 20, 0, 0); // an arbitrary league night
const HOUR = 3600_000;

const match = (offsetMs: number | null, status: string = MATCH_STATUS.SCHEDULED) => ({
  scheduledAt: offsetMs === null ? null : new Date(NOW + offsetMs),
  status,
});

describe("isAutoSyncDue", () => {
  it("opens shortly after kickoff, not before", () => {
    // Kickoff just happened — no Dota game can be over yet.
    expect(isAutoSyncDue(match(-5 * 60_000), NOW)).toBe(false);
    // Past the minimum game length: due.
    expect(
      isAutoSyncDue(
        match(-(AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF + 1) * 60_000),
        NOW,
      ),
    ).toBe(true);
    // Future kickoff: never due.
    expect(isAutoSyncDue(match(2 * HOUR), NOW)).toBe(false);
  });

  it("closes after the window so stale fixtures stop burning API budget", () => {
    expect(isAutoSyncDue(match(-(AUTO_SYNC.WINDOW_HOURS - 1) * HOUR), NOW)).toBe(
      true,
    );
    expect(
      isAutoSyncDue(match(-(AUTO_SYNC.WINDOW_HOURS + 1) * HOUR), NOW),
    ).toBe(false);
  });

  it("skips completed and unscheduled matches", () => {
    expect(isAutoSyncDue(match(-2 * HOUR, MATCH_STATUS.COMPLETED), NOW)).toBe(
      false,
    );
    expect(isAutoSyncDue(match(null), NOW)).toBe(false);
    // LIVE (partial series) keeps scanning — games 2/3 of a Bo3 arrive later.
    expect(isAutoSyncDue(match(-2 * HOUR, MATCH_STATUS.LIVE), NOW)).toBe(true);
  });

  it("window edges are inclusive and consistent with the accessors", () => {
    const kickoff = NOW - 3 * HOUR;
    expect(isAutoSyncDue(match(-3 * HOUR), autoSyncOpensAt(kickoff))).toBe(true);
    expect(isAutoSyncDue(match(-3 * HOUR), autoSyncClosesAt(kickoff))).toBe(
      true,
    );
    expect(
      isAutoSyncDue(match(-3 * HOUR), autoSyncClosesAt(kickoff) + 1),
    ).toBe(false);
  });
});

describe("autoSyncIntervalSeconds", () => {
  it("doubles per consecutive empty scan, capped", () => {
    expect(autoSyncIntervalSeconds(0)).toBe(AUTO_SYNC.MATCH_INTERVAL_SECONDS);
    expect(autoSyncIntervalSeconds(1)).toBe(
      AUTO_SYNC.MATCH_INTERVAL_SECONDS * 2,
    );
    expect(autoSyncIntervalSeconds(3)).toBe(
      AUTO_SYNC.MATCH_INTERVAL_SECONDS * 8,
    );
    const cap =
      AUTO_SYNC.MATCH_INTERVAL_SECONDS * 2 ** AUTO_SYNC.BACKOFF_DOUBLINGS;
    expect(autoSyncIntervalSeconds(AUTO_SYNC.BACKOFF_DOUBLINGS)).toBe(cap);
    expect(autoSyncIntervalSeconds(50)).toBe(cap); // never past the cap
    expect(autoSyncIntervalSeconds(-2)).toBe(AUTO_SYNC.MATCH_INTERVAL_SECONDS);
  });

  it("keeps a stuck 48h fixture down to a handful of scans", () => {
    // Simulate the claim loop: how many scans does a never-completing match
    // get across its whole window? Without backoff it'd be ~720.
    let t = 0;
    let attempts = 0;
    let scans = 0;
    const windowSecs = AUTO_SYNC.WINDOW_HOURS * 3600;
    while (t < windowSecs) {
      scans++;
      attempts++;
      t += autoSyncIntervalSeconds(attempts);
    }
    expect(scans).toBeLessThan(25);
  });
});

describe("autoSyncClaimCutoff", () => {
  it("is exactly one rescan interval in the past", () => {
    expect(autoSyncClaimCutoff(NOW).getTime()).toBe(
      NOW - AUTO_SYNC.MATCH_INTERVAL_SECONDS * 1000,
    );
    expect(autoSyncClaimCutoff(NOW, 2).getTime()).toBe(
      NOW - AUTO_SYNC.MATCH_INTERVAL_SECONDS * 4 * 1000,
    );
  });
});

describe("nextAutoSyncAt", () => {
  it("projects the next scan from the last one plus the backoff interval", () => {
    const last = new Date(NOW);
    expect(nextAutoSyncAt(last, 0)?.getTime()).toBe(
      NOW + AUTO_SYNC.MATCH_INTERVAL_SECONDS * 1000,
    );
    expect(nextAutoSyncAt(last, 3)?.getTime()).toBe(
      NOW + AUTO_SYNC.MATCH_INTERVAL_SECONDS * 8 * 1000,
    );
    expect(nextAutoSyncAt(null, 5)).toBeNull(); // never scanned → due now
  });
});
