import { describe, expect, it } from "vitest";
import { AUTO_SYNC, MATCH_STATUS, SEASON_STATUS } from "./constants";
import {
  AUTO_CHECK_BACKED_OFF_SCANS,
  autoCheckCopy,
  autoCheckStatus,
  autoSyncClaimCutoff,
  autoSyncClosesAt,
  autoSyncIntervalSeconds,
  autoSyncOpensAt,
  isAutoSyncDue,
  leagueFallbackOpensAt,
  minutesSinceAutoSyncOpen,
  nextRosterScanAt,
  syncPingStep,
} from "./result-sync";

const NOW = Date.UTC(2026, 6, 12, 20, 0, 0); // an arbitrary league night
const HOUR = 3600_000;

const match = (
  offsetMs: number | null,
  status: string = MATCH_STATUS.SCHEDULED,
) => ({
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
    expect(
      isAutoSyncDue(match(-(AUTO_SYNC.WINDOW_HOURS - 1) * HOUR), NOW),
    ).toBe(true);
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
    expect(isAutoSyncDue(match(-3 * HOUR), autoSyncOpensAt(kickoff))).toBe(
      true,
    );
    expect(isAutoSyncDue(match(-3 * HOUR), autoSyncClosesAt(kickoff))).toBe(
      true,
    );
    expect(isAutoSyncDue(match(-3 * HOUR), autoSyncClosesAt(kickoff) + 1)).toBe(
      false,
    );
  });
});

describe("leagueFallbackOpensAt", () => {
  it("starts player-account recovery three hours after the scheduled time", () => {
    expect(leagueFallbackOpensAt(NOW)).toBe(
      NOW + AUTO_SYNC.LEAGUE_FALLBACK_MINUTES_AFTER_KICKOFF * 60_000,
    );
    expect(AUTO_SYNC.LEAGUE_FALLBACK_MINUTES_AFTER_KICKOFF).toBe(180);
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

describe("nextRosterScanAt", () => {
  const MIN = 60_000;
  const base = AUTO_SYNC.MATCH_INTERVAL_SECONDS * 1000;

  it("uses the capped young-match interval while the grace lasts", () => {
    const kickoff = NOW - 60 * MIN;
    // Five empty scans would mean 32 x the interval, but the match is young.
    expect(nextRosterScanAt(kickoff, NOW, 5, NOW)).toBe(
      NOW + base * 2 ** AUTO_SYNC.BACKOFF_GRACE_DOUBLINGS + 1,
    );
  });

  it("switches to the full backoff when the young deadline falls past the grace", () => {
    const graceEndsAt = NOW + 5 * MIN;
    const kickoff =
      graceEndsAt -
      (AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF + AUTO_SYNC.BACKOFF_GRACE_MINUTES) *
        MIN;
    expect(nextRosterScanAt(kickoff, NOW, 5, NOW)).toBe(NOW + base * 32 + 1);
  });

  it("is the last scan plus the backoff interval for an older match", () => {
    const kickoff = NOW - 10 * HOUR;
    expect(nextRosterScanAt(kickoff, NOW, 0, NOW)).toBe(NOW + base + 1);
    expect(nextRosterScanAt(kickoff, NOW, 3, NOW)).toBe(NOW + base * 8 + 1);
  });

  it("is the first instant the service's claim cutoff admits the match", () => {
    const kickoff = NOW - 10 * HOUR;
    const at = nextRosterScanAt(kickoff, NOW, 2, NOW);
    const minutes = minutesSinceAutoSyncOpen(kickoff, at);
    expect(autoSyncClaimCutoff(at, 2, minutes).getTime()).toBeGreaterThan(NOW);
    expect(autoSyncClaimCutoff(at - 1, 2, minutes).getTime()).toBe(NOW);
  });
});

describe("autoCheckStatus", () => {
  const MIN = 60_000;
  const regular = { status: SEASON_STATUS.REGULAR_SEASON, dotaLeagueId: null };
  const ticketed = {
    status: SEASON_STATUS.REGULAR_SEASON,
    dotaLeagueId: "18000",
  };
  const fixture = (
    kickoffOffsetMs: number | null,
    over: Partial<{
      status: string;
      autoSyncedAt: Date | null;
      autoSyncAttempts: number;
    }> = {},
  ) => ({
    status: MATCH_STATUS.SCHEDULED,
    scheduledAt:
      kickoffOffsetMs === null ? null : new Date(NOW + kickoffOffsetMs),
    autoSyncedAt: null,
    autoSyncAttempts: 0,
    ...over,
  });

  it("has nothing to say about a finished match", () => {
    expect(
      autoCheckStatus(
        fixture(-HOUR, { status: MATCH_STATUS.COMPLETED }),
        regular,
        NOW,
      ),
    ).toBeNull();
  });

  it("names the phase when the worker does not run for it", () => {
    for (const status of [SEASON_STATUS.SIGNUPS, SEASON_STATUS.DRAFT]) {
      expect(
        autoCheckStatus(fixture(-HOUR), { status, dotaLeagueId: null }, NOW),
      ).toEqual({ kind: "none", reason: "before-season" });
    }
    expect(
      autoCheckStatus(
        fixture(-HOUR),
        { status: SEASON_STATUS.COMPLETE, dotaLeagueId: null },
        NOW,
      ),
    ).toEqual({ kind: "none", reason: "season-over" });
    expect(
      autoCheckStatus(
        fixture(-HOUR),
        { status: SEASON_STATUS.PLAYOFFS, dotaLeagueId: null },
        NOW,
      ),
    ).toEqual({ kind: "due", league: false });
  });

  it("flags a match with no kickoff time", () => {
    expect(autoCheckStatus(fixture(null), regular, NOW)).toEqual({
      kind: "none",
      reason: "no-kickoff",
    });
  });

  it("gives the window's opening before kickoff", () => {
    expect(autoCheckStatus(fixture(10 * MIN), regular, NOW)).toEqual({
      kind: "opens",
      at: autoSyncOpensAt(NOW + 10 * MIN),
    });
  });

  it("says the window closed once it has", () => {
    expect(autoCheckStatus(fixture(-49 * HOUR), regular, NOW)).toEqual({
      kind: "ended",
      at: autoSyncClosesAt(NOW - 49 * HOUR),
    });
  });

  it("is due now for a match never scanned, or scanned long enough ago", () => {
    expect(autoCheckStatus(fixture(-HOUR), regular, NOW)).toEqual({
      kind: "due",
      league: false,
    });
    expect(
      autoCheckStatus(
        fixture(-10 * HOUR, { autoSyncedAt: new Date(NOW - HOUR) }),
        regular,
        NOW,
      ),
    ).toEqual({ kind: "due", league: false });
  });

  it("gives the next scan time with the empty-scan count", () => {
    const syncedAt = new Date(NOW - MIN);
    expect(
      autoCheckStatus(
        fixture(-10 * HOUR, { autoSyncedAt: syncedAt, autoSyncAttempts: 4 }),
        regular,
        NOW,
      ),
    ).toEqual({
      kind: "next",
      at: nextRosterScanAt(NOW - 10 * HOUR, syncedAt.getTime(), 4, NOW),
      emptyScans: 4,
      league: false,
    });
  });

  it("says no scan is left when the backoff runs past the window", () => {
    const kickoff = -(AUTO_SYNC.WINDOW_HOURS * HOUR - 30 * MIN);
    expect(
      autoCheckStatus(
        fixture(kickoff, {
          autoSyncedAt: new Date(NOW - MIN),
          autoSyncAttempts: AUTO_SYNC.BACKOFF_DOUBLINGS,
        }),
        regular,
        NOW,
      ),
    ).toEqual({
      kind: "ending",
      at: autoSyncClosesAt(NOW + kickoff),
      league: false,
    });
  });

  it("reads only the league feed until the fallback on a ticketed season", () => {
    expect(autoCheckStatus(fixture(-HOUR), ticketed, NOW)).toEqual({
      kind: "league-only",
      fallbackAt: leagueFallbackOpensAt(NOW - HOUR),
    });
    // A LIVE series is scanned at once, not after the fallback.
    expect(
      autoCheckStatus(
        fixture(-HOUR, { status: MATCH_STATUS.LIVE }),
        ticketed,
        NOW,
      ),
    ).toEqual({ kind: "due", league: true });
    expect(autoCheckStatus(fixture(-4 * HOUR), ticketed, NOW)).toEqual({
      kind: "due",
      league: true,
    });
    // A blank ticket is no ticket.
    expect(
      autoCheckStatus(
        fixture(-HOUR),
        { status: SEASON_STATUS.REGULAR_SEASON, dotaLeagueId: "  " },
        NOW,
      ),
    ).toEqual({ kind: "due", league: false });
  });
});

describe("autoCheckCopy", () => {
  it("marks only the states no automatic check will fix as problems", () => {
    expect(autoCheckCopy({ kind: "none", reason: "no-kickoff" }).problem).toBe(
      true,
    );
    expect(autoCheckCopy({ kind: "ended", at: NOW }).problem).toBe(true);
    expect(
      autoCheckCopy({ kind: "none", reason: "before-season" }).problem,
    ).toBe(false);
    expect(autoCheckCopy({ kind: "due", league: false }).problem).toBe(false);
    expect(
      autoCheckCopy({ kind: "ending", at: NOW, league: false }).problem,
    ).toBe(false);
  });

  it("carries the one time separately so the page can localise it", () => {
    const next = autoCheckCopy({
      kind: "next",
      at: NOW,
      emptyScans: 0,
      league: false,
    });
    expect(next).toEqual({
      lead: "Next automatic check ",
      at: NOW,
      tail: ".",
      problem: false,
    });
    expect(autoCheckCopy({ kind: "due", league: false })).toEqual({
      lead: "Next automatic check: due now.",
      at: null,
      tail: "",
      problem: false,
    });
  });

  it("says when checks have slowed down after empty scans", () => {
    const quiet = autoCheckCopy({
      kind: "next",
      at: NOW,
      emptyScans: AUTO_CHECK_BACKED_OFF_SCANS - 1,
      league: false,
    });
    expect(quiet.tail).toBe(".");
    const slowed = autoCheckCopy({
      kind: "next",
      at: NOW,
      emptyScans: AUTO_CHECK_BACKED_OFF_SCANS,
      league: false,
    });
    expect(slowed.tail).toBe(
      ` (slowed down after ${AUTO_CHECK_BACKED_OFF_SCANS} checks found nothing).`,
    );
  });

  it("mentions the league feed only on a ticketed season", () => {
    expect(
      autoCheckCopy({ kind: "league-only", fallbackAt: NOW }).lead,
    ).toMatch(/^League feed checks about every 3 minutes; /);
    expect(autoCheckCopy({ kind: "due", league: true }).lead).toMatch(
      /^League feed checks/,
    );
    expect(autoCheckCopy({ kind: "due", league: false }).lead).not.toMatch(
      /League feed/,
    );
  });

  it("points a closed window at the manual tools by their real names", () => {
    const ended = autoCheckCopy({ kind: "ended", at: NOW });
    expect(ended.tail).toContain("Auto-fetch games");
    expect(ended.tail).toContain("Add game");
  });
});

describe("autoSyncIntervalSeconds — young-match grace", () => {
  const base = AUTO_SYNC.MATCH_INTERVAL_SECONDS;
  const graceCap = base * 2 ** AUTO_SYNC.BACKOFF_GRACE_DOUBLINGS;

  it("caps backoff while the match is still young", () => {
    // League nights start late: the empty scans from before tip-off must not
    // buy hours of silence once the games actually land.
    for (const attempts of [3, 4, 6, 20]) {
      expect(autoSyncIntervalSeconds(attempts, 10)).toBe(graceCap);
    }
    expect(graceCap).toBeLessThanOrEqual(16 * 60);
  });

  it("still tightens with attempts inside the grace window", () => {
    expect(autoSyncIntervalSeconds(0, 10)).toBe(base);
    expect(autoSyncIntervalSeconds(1, 10)).toBe(base * 2);
  });

  it("resumes full backoff once the match is no longer young", () => {
    const old = AUTO_SYNC.BACKOFF_GRACE_MINUTES + 1;
    expect(autoSyncIntervalSeconds(6, old)).toBe(
      base * 2 ** AUTO_SYNC.BACKOFF_DOUBLINGS,
    );
    expect(autoSyncIntervalSeconds(6, old)).toBeGreaterThan(graceCap);
  });

  it("defaults to full backoff when no age is supplied", () => {
    expect(autoSyncIntervalSeconds(6)).toBe(
      base * 2 ** AUTO_SYNC.BACKOFF_DOUBLINGS,
    );
  });

  it("a 2h-late start is rescanned within the grace cap, not hours later", () => {
    // The regression: scans at kickoff+25m..+2h drove attempts to 5, so the
    // next claimable instant was ~2h+ away and the result landed overnight.
    const kickoff = NOW;
    const twoHoursIn = kickoff + 2 * HOUR;
    const minutes = minutesSinceAutoSyncOpen(kickoff, twoHoursIn);
    expect(minutes).toBeLessThan(AUTO_SYNC.BACKOFF_GRACE_MINUTES);
    expect(autoSyncIntervalSeconds(5, minutes)).toBe(graceCap);
  });
});

describe("minutesSinceAutoSyncOpen", () => {
  it("is 0 before the window opens and grows after", () => {
    expect(minutesSinceAutoSyncOpen(NOW, NOW)).toBe(0);
    expect(minutesSinceAutoSyncOpen(NOW, NOW + HOUR)).toBeCloseTo(
      60 - AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF,
      5,
    );
  });
});

describe("syncPingStep", () => {
  const WATCH_MS = AUTO_SYNC.WATCH_POLL_SECONDS * 1000;
  const IDLE_MS = AUTO_SYNC.IDLE_POLL_SECONDS * 1000;

  it("does not refresh when the first heartbeat matches the server-render cursor", () => {
    const renderedCursor = "2026-07-30T01:00:00Z";
    const step = syncPingStep({ cursor: renderedCursor }, renderedCursor);
    expect(step.refresh).toBe(false);
    expect(step.cursor).toBe(renderedCursor);
  });

  it("refreshes a losing first heartbeat when another request changed data after render", () => {
    // Interleaving: the page rendered at cursor A, this tab began heartbeat 1,
    // heartbeat 2 won the import claim and stamped B, then heartbeat 1 returned
    // updated:false with B. The first response must compare with the render,
    // not establish a new baseline and strand this tab on its stale RSC payload.
    const step = syncPingStep(
      { updated: false, cursor: "after-concurrent-import" },
      "at-server-render",
    );
    expect(step.refresh).toBe(true);
    expect(step.cursor).toBe("after-concurrent-import");
  });

  it("treats a null server-render cursor as a real baseline", () => {
    // First result ever: there was deliberately no Setting row at render. A
    // concurrent import creating it is still a post-render change.
    const step = syncPingStep({ updated: false, cursor: "first-result" }, null);
    expect(step.refresh).toBe(true);
    expect(step.cursor).toBe("first-result");
  });

  it("refreshes when a later response advances the cursor", () => {
    // The parked-tab trigger: another client's ping did the import, so this
    // one sees updated:false — only the cursor moving says a result landed.
    const step = syncPingStep({ updated: false, cursor: "b" }, "a");
    expect(step.refresh).toBe(true);
    expect(step.cursor).toBe("b");
  });

  it("does not refresh while the cursor holds still", () => {
    const step = syncPingStep({ cursor: "a" }, "a");
    expect(step.refresh).toBe(false);
    expect(step.cursor).toBe("a");
  });

  it("updated:true refreshes even while establishing the first cursor baseline", () => {
    // The client whose own ping performed the import: its baseline is already
    // the new value, so the advance can never fire for it.
    expect(syncPingStep({ updated: true, cursor: "a" }, "a").refresh).toBe(
      true,
    );
    const repaired = syncPingStep(
      { updated: true, cursor: "playoff-repair" },
      null,
    );
    expect(repaired.refresh).toBe(true);
    expect(repaired.cursor).toBe("playoff-repair");
  });

  it("a null or absent cursor preserves the baseline and does not refresh", () => {
    // Resetting to null would make the next real cursor read as a fresh first
    // response — a landed result would slip past every parked tab.
    const nulled = syncPingStep({ cursor: null }, "a");
    expect(nulled.cursor).toBe("a");
    expect(nulled.refresh).toBe(false);
    const absent = syncPingStep({}, "a");
    expect(absent.cursor).toBe("a");
    expect(absent.refresh).toBe(false);
  });

  it("polls fast while the server says watch, near-free otherwise", () => {
    expect(syncPingStep({ watch: true }, null).delayMs).toBe(WATCH_MS);
    expect(syncPingStep({ watch: false }, null).delayMs).toBe(IDLE_MS);
    expect(syncPingStep({}, null).delayMs).toBe(IDLE_MS);
  });
});
