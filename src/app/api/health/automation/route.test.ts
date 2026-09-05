import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationProbeRecord } from "@/lib/automation-health";

const gate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/automation-gate", () => ({
  getAutomationGateDecision: gate,
}));

import { automationHealthResponse } from "./route";

const NOW = Date.parse("2026-08-04T18:00:00.000Z");

function record(
  overrides: Partial<AutomationProbeRecord> = {},
): AutomationProbeRecord {
  return {
    lastStatus: "SUCCEEDED",
    leaseExpiresAt: null,
    lastSuccessAt: new Date(NOW - 30_000),
    consecutiveFailures: 0,
    ...overrides,
  };
}

async function bodyFor(state: AutomationProbeRecord | null) {
  const response = await automationHealthResponse(
    async () => state,
    () => NOW,
  );
  return { response, body: await response.json() };
}

describe("GET /api/health/automation", () => {
  beforeEach(() => {
    gate.mockReset().mockResolvedValue({ run: true });
  });

  it("reports a recent successful pass without exposing persisted details", async () => {
    const { response, body } = await bodyFor(record());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ ok: true, status: "healthy" });
  });

  it("stays healthy during an owned pass when the previous success is fresh", async () => {
    const { response, body } = await bodyFor(
      record({
        lastStatus: "RUNNING",
        leaseExpiresAt: new Date(NOW + 60_000),
      }),
    );

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, status: "running" });
  });

  it.each([
    [null, "never-run"],
    [record({ lastSuccessAt: new Date(NOW - 240_001) }), "stale"],
    [record({ lastStatus: "FAILED" }), "failed"],
    [record({ lastStatus: "DEGRADED" }), "degraded"],
    [
      record({
        lastStatus: "RUNNING",
        leaseExpiresAt: new Date(NOW - 1),
      }),
      "lease-expired",
    ],
    [
      record({
        lastStatus: "RUNNING",
        leaseExpiresAt: new Date(NOW + 60_000),
        lastSuccessAt: null,
      }),
      "running",
    ],
  ] as const)("returns 503 for %s state", async (state, status) => {
    const { response, body } = await bodyFor(state);

    expect(response.status).toBe(503);
    expect(body).toEqual({ ok: false, status });
  });

  it("returns a generic unavailable response when the database cannot be read", async () => {
    const response = await automationHealthResponse(async () => {
      throw new Error("postgresql://user:password@database.internal/league");
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      status: "unavailable",
    });
  });

  it("uses a valid idle snapshot without waking the database", async () => {
    const loadState = vi.fn();
    gate.mockResolvedValue({
      run: false,
      snapshot: {
        version: 6,
        computedAtMs: NOW - 1_000,
        nextWakeAtMs: NOW + 60_000,
        hardWakeAtMs: NOW + 120_000,
        reason: "LEAGUE",
        runnerHealthy: true,
      },
    });

    const response = await automationHealthResponse(loadState, () => NOW);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "healthy" });
    expect(loadState).not.toHaveBeenCalled();
  });

  it("reports a sleeping blocked league delivery as degraded without waking the database", async () => {
    const loadState = vi.fn();
    gate.mockResolvedValue({
      run: false,
      snapshot: {
        version: 6,
        computedAtMs: NOW - 1_000,
        nextWakeAtMs: Number.MAX_SAFE_INTEGER,
        hardWakeAtMs: NOW + 120_000,
        reason: null,
        runnerHealthy: false,
      },
    });

    const response = await automationHealthResponse(loadState, () => NOW);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, status: "degraded" });
    expect(loadState).not.toHaveBeenCalled();
  });

  it("does not treat a cached RUNNING lease as proof of a healthy prior pass", async () => {
    const loadState = vi.fn().mockResolvedValue(
      record({
        lastStatus: "RUNNING",
        leaseExpiresAt: new Date(NOW + 60_000),
        lastSuccessAt: null,
      }),
    );
    gate.mockResolvedValue({
      run: false,
      snapshot: {
        version: 6,
        computedAtMs: NOW - 1_000,
        nextWakeAtMs: NOW + 60_001,
        hardWakeAtMs: NOW + 120_000,
        reason: "RUNNER",
        runnerHealthy: false,
      },
    });

    const response = await automationHealthResponse(loadState, () => NOW);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, status: "running" });
    expect(loadState).toHaveBeenCalledOnce();
  });
});
