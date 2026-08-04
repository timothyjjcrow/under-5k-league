import { describe, expect, it } from "vitest";
import type { AutomationProbeRecord } from "@/lib/automation-health";
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
});
