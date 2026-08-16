import { describe, expect, it } from "vitest";
import {
  AUTOMATION_STALE_AFTER_MS,
  automationProbeView,
  automationHealthView,
  formatAutomationDuration,
  type AutomationHealthRecord,
  type AutomationIdleWindow,
} from "./automation-health";

const NOW = Date.parse("2026-08-04T18:00:00.000Z");
const IDLE_WINDOW: AutomationIdleWindow = {
  nextWakeAtMs: NOW + 60_000,
  hardWakeAtMs: NOW + 180_000,
};

function record(
  overrides: Partial<AutomationHealthRecord> = {},
): AutomationHealthRecord {
  return {
    lastStatus: "SUCCEEDED",
    leaseExpiresAt: null,
    lastAttemptAt: new Date(NOW - 30_000),
    lastStartedAt: new Date(NOW - 30_000),
    lastFinishedAt: new Date(NOW - 20_000),
    lastSuccessAt: new Date(NOW - 20_000),
    lastSource: "CRON",
    lastDurationMs: 10_000,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastSummary: "{}",
    ...overrides,
  };
}

describe("automationHealthView", () => {
  it("distinguishes an unavailable query from a runner that has never run", () => {
    const unavailable = automationHealthView(undefined, NOW);
    const never = automationHealthView(null, NOW);

    expect(unavailable).toMatchObject({
      kind: "UNAVAILABLE",
      canRunNow: false,
      sourceLabel: "Not recorded",
    });
    expect(never).toMatchObject({ kind: "NEVER", canRunNow: true });
  });

  it("disables a manual run while a future database lease is active", () => {
    const view = automationHealthView(
      record({
        lastStatus: "RUNNING",
        leaseExpiresAt: new Date(NOW + 60_000),
        lastFinishedAt: null,
        lastSource: "ADMIN",
      }),
      NOW,
    );

    expect(view).toMatchObject({
      kind: "RUNNING",
      leaseActive: true,
      canRunNow: false,
      sourceLabel: "Admin manual run",
    });
    expect(view.disabledReason).toContain("never overrides");
  });

  it("marks a recent successful cron pass healthy", () => {
    expect(automationHealthView(record(), NOW)).toMatchObject({
      kind: "HEALTHY",
      canRunNow: true,
      sourceLabel: "Scheduled cron",
      durationLabel: "10 s",
      consecutiveFailures: 0,
    });
  });

  it("degrades a successful pass after the scheduler health window", () => {
    const view = automationHealthView(
      record({
        lastFinishedAt: new Date(NOW - AUTOMATION_STALE_AFTER_MS - 1),
        lastSuccessAt: new Date(NOW - AUTOMATION_STALE_AFTER_MS - 1),
      }),
      NOW,
    );

    expect(view.kind).toBe("DEGRADED");
    expect(view.signals).toContain(
      "No completed run has been recorded within the four-minute health window",
    );
  });

  it("keeps a stale clean success healthy during a valid idle window", () => {
    const view = automationHealthView(
      record({
        lastFinishedAt: new Date(NOW - AUTOMATION_STALE_AFTER_MS - 1),
        lastSuccessAt: new Date(NOW - AUTOMATION_STALE_AFTER_MS - 1),
      }),
      NOW,
      IDLE_WINDOW,
    );

    expect(view).toMatchObject({
      kind: "HEALTHY",
      label: "Healthy",
      headline: "The automation worker is caught up",
      description:
        "No maintenance work is due: the worker is caught up and will run again by the next wake.",
      canRunNow: true,
    });
    expect(view.signals).not.toContain(
      "No completed run has been recorded within the four-minute health window",
    );
  });

  it.each([
    ["next wake is current time", { ...IDLE_WINDOW, nextWakeAtMs: NOW }],
    ["hard wake is current time", { ...IDLE_WINDOW, hardWakeAtMs: NOW }],
    [
      "next wake follows the hard wake",
      { nextWakeAtMs: NOW + 2, hardWakeAtMs: NOW + 1 },
    ],
    ["next wake is fractional", { ...IDLE_WINDOW, nextWakeAtMs: NOW + 0.5 }],
    ["hard wake is infinite", { ...IDLE_WINDOW, hardWakeAtMs: Infinity }],
    [
      "next wake is unsafe",
      { ...IDLE_WINDOW, nextWakeAtMs: Number.MAX_SAFE_INTEGER + 1 },
    ],
  ] as const)("rejects an idle window whose %s", (_label, idleWindow) => {
    const view = automationHealthView(
      record({
        lastFinishedAt: new Date(NOW - AUTOMATION_STALE_AFTER_MS - 1),
        lastSuccessAt: new Date(NOW - AUTOMATION_STALE_AFTER_MS - 1),
      }),
      NOW,
      idleWindow,
    );

    expect(view.kind).toBe("DEGRADED");
    expect(view.signals).toContain(
      "No completed run has been recorded within the four-minute health window",
    );
  });

  it("accepts one timestamp as both the next and hard wake", () => {
    const wakeAtMs = NOW + 1;
    const view = automationHealthView(
      record({
        lastFinishedAt: new Date(NOW - AUTOMATION_STALE_AFTER_MS - 1),
        lastSuccessAt: new Date(NOW - AUTOMATION_STALE_AFTER_MS - 1),
      }),
      NOW,
      { nextWakeAtMs: wakeAtMs, hardWakeAtMs: wakeAtMs },
    );

    expect(view.kind).toBe("HEALTHY");
  });

  it.each([
    [
      "active lease",
      record({
        lastStatus: "RUNNING",
        leaseExpiresAt: new Date(NOW + 1),
      }),
      "RUNNING",
    ],
    [
      "expired lease",
      record({
        lastStatus: "RUNNING",
        leaseExpiresAt: new Date(NOW),
      }),
      "DEGRADED",
    ],
    ["failed run", record({ lastStatus: "FAILED" }), "DEGRADED"],
    ["degraded run", record({ lastStatus: "DEGRADED" }), "DEGRADED"],
    ["unknown status", record({ lastStatus: "SURPRISE" }), "DEGRADED"],
    [
      "failure streak",
      record({ consecutiveFailures: 1 }),
      "DEGRADED",
    ],
  ] as const)(
    "does not let an idle window hide an %s",
    (_label, state, expectedKind) => {
      expect(automationHealthView(state, NOW, IDLE_WINDOW).kind).toBe(
        expectedKind,
      );
    },
  );

  it("does not let an idle window hide unavailable or never-run state", () => {
    expect(automationHealthView(undefined, NOW, IDLE_WINDOW).kind).toBe(
      "UNAVAILABLE",
    );
    expect(automationHealthView(null, NOW, IDLE_WINDOW).kind).toBe("NEVER");
    expect(
      automationHealthView(
        record({ lastStatus: "NEVER", lastAttemptAt: null }),
        NOW,
        IDLE_WINDOW,
      ).kind,
    ).toBe("NEVER");
  });

  it("makes an expired RUNNING row recoverable without treating it as owned", () => {
    const view = automationHealthView(
      record({
        lastStatus: "RUNNING",
        leaseExpiresAt: new Date(NOW - 1),
        lastFinishedAt: null,
      }),
      NOW,
    );

    expect(view).toMatchObject({
      kind: "DEGRADED",
      leaseActive: false,
      leaseExpired: true,
      canRunNow: true,
    });
    expect(view.signals[0]).toContain("lease expired");
  });

  it("shows bounded backlog signals while filtering untrusted persisted text", () => {
    const view = automationHealthView(
      record({
        lastStatus: "DEGRADED",
        lastSource: "DATABASE_URL=postgres://secret",
        consecutiveFailures: 2,
        lastErrorCode: "token=super-secret",
        lastSummary: JSON.stringify({
          issueCount: 3,
          issues: [
            "WORKER_DEGRADED",
            "<SCRIPT>",
            "password=hunter2",
            "ABCDEF1234567890",
          ],
          skippedCount: 1,
          skipped: ["WORK_BUDGET_EXHAUSTED", "secret-value"],
          recoveredExpiredLease: true,
          rawError: "postgres://user:password@internal.example/db",
        }),
      }),
      NOW,
    );

    expect(view).toMatchObject({
      kind: "DEGRADED",
      sourceLabel: "Not recorded",
      consecutiveFailures: 2,
    });
    expect(view.signals.join("\n")).toContain("3 issues");
    expect(view.signals.join("\n")).toContain("WORKER_DEGRADED");
    expect(view.signals.join("\n")).toContain("WORK_BUDGET_EXHAUSTED");
    expect(JSON.stringify(view)).not.toMatch(
      /hunter2|postgres:\/\/|super-secret|<SCRIPT>|secret-value|ABCDEF1234567890/,
    );
  });

  it("survives malformed summary JSON and an unknown persisted status", () => {
    const view = automationHealthView(
      record({ lastStatus: "SURPRISE", lastSummary: "not-json" }),
      NOW,
    );

    expect(view.kind).toBe("DEGRADED");
    expect(view.signals).toContain(
      "The persisted runner status is not recognized",
    );
  });
});

describe("formatAutomationDuration", () => {
  it.each([
    [null, "Not recorded"],
    [-1, "Not recorded"],
    [20, "20 ms"],
    [1_250, "1.3 s"],
    [12_500, "13 s"],
    [65_000, "1m 5s"],
  ] as const)("formats %s as %s", (duration, expected) => {
    expect(formatAutomationDuration(duration)).toBe(expected);
  });
});

describe("automationProbeView", () => {
  it("accepts only a fresh clean success, including while the next lease runs", () => {
    expect(automationProbeView(record(), NOW)).toEqual({
      ok: true,
      status: "healthy",
    });
    expect(
      automationProbeView(
        record({
          lastStatus: "RUNNING",
          leaseExpiresAt: new Date(NOW + 1),
        }),
        NOW,
      ),
    ).toEqual({ ok: true, status: "running" });
  });

  it("fails closed for unavailable, never-run, stale, failed, and expired states", () => {
    expect(automationProbeView(undefined, NOW).status).toBe("unavailable");
    expect(automationProbeView(null, NOW).status).toBe("never-run");
    expect(
      automationProbeView(
        record({ lastSuccessAt: new Date(NOW - AUTOMATION_STALE_AFTER_MS - 1) }),
        NOW,
      ).status,
    ).toBe("stale");
    expect(
      automationProbeView(record({ lastStatus: "FAILED" }), NOW).status,
    ).toBe("failed");
    expect(
      automationProbeView(
        record({
          lastStatus: "RUNNING",
          leaseExpiresAt: new Date(NOW),
        }),
        NOW,
      ).status,
    ).toBe("lease-expired");
  });

  it("waives only stale success during a valid idle window", () => {
    const staleSuccess = record({
      lastSuccessAt: new Date(NOW - AUTOMATION_STALE_AFTER_MS - 1),
    });

    expect(automationProbeView(staleSuccess, NOW, IDLE_WINDOW)).toEqual({
      ok: true,
      status: "healthy",
    });

    const guardedCases = [
      [undefined, "unavailable"],
      [null, "never-run"],
      [record({ lastStatus: "NEVER" }), "never-run"],
      [record({ lastStatus: "FAILED" }), "failed"],
      [record({ lastStatus: "DEGRADED" }), "degraded"],
      [record({ lastStatus: "SURPRISE" }), "degraded"],
      [record({ consecutiveFailures: 1 }), "degraded"],
      [
        record({
          lastStatus: "RUNNING",
          leaseExpiresAt: new Date(NOW + 1),
          lastSuccessAt: staleSuccess.lastSuccessAt,
        }),
        "running",
      ],
      [
        record({
          lastStatus: "RUNNING",
          leaseExpiresAt: new Date(NOW),
        }),
        "lease-expired",
      ],
    ] as const;

    for (const [state, status] of guardedCases) {
      expect(automationProbeView(state, NOW, IDLE_WINDOW).status).toBe(status);
    }
  });
});
