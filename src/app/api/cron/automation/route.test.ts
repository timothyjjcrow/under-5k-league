import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  runAutomation: vi.fn(),
  getAutomationGateDecision: vi.fn(),
  invalidateAutomationGateBestEffort: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/automation-service", () => ({
  runAutomation: mocks.runAutomation,
}));
vi.mock("@/lib/automation-gate", () => ({
  getAutomationGateDecision: mocks.getAutomationGateDecision,
}));
vi.mock("@/lib/automation-gate-invalidation", () => ({
  invalidateAutomationGateBestEffort:
    mocks.invalidateAutomationGateBestEffort,
}));

import { GET, maxDuration } from "./route";
import { revalidatePath, revalidateTag } from "next/cache";

const SECRET = "C8kP2vR7xM4qT9wL6nH3dF5sJ0yB1zUa";

function request(authorization?: string) {
  return new NextRequest("https://league.example/api/cron/automation", {
    headers: authorization ? { authorization } : undefined,
  });
}

describe("GET /api/cron/automation", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", SECRET);
    mocks.runAutomation.mockReset();
    mocks.getAutomationGateDecision.mockReset().mockResolvedValue({
      run: true,
    });
    mocks.invalidateAutomationGateBestEffort.mockReset();
    vi.mocked(revalidatePath).mockReset();
    vi.mocked(revalidateTag).mockReset();
    mocks.runAutomation.mockResolvedValue({
      kind: "completed",
      status: "SUCCEEDED",
      durationMs: 25,
      recoveredExpiredLease: false,
      errorCode: null,
      summary: "{}",
      imported: 0,
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses the sixty-second platform cap", () => {
    expect(maxDuration).toBe(60);
  });

  it.each([undefined, `Bearer ${SECRET}x`, `Basic ${SECRET}`])(
    "rejects a missing or wrong machine credential (%s)",
    async (authorization) => {
      const response = await GET(request(authorization));

      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        ok: false,
        error: "Unauthorized",
      });
      expect(mocks.runAutomation).not.toHaveBeenCalled();
      expect(mocks.getAutomationGateDecision).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the server secret is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");

    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(401);
    expect(mocks.runAutomation).not.toHaveBeenCalled();
  });

  it("runs the authenticated cron source and returns persisted success", async () => {
    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.runAutomation).toHaveBeenCalledWith({
      source: "CRON",
      signal: expect.any(AbortSignal),
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      status: "SUCCEEDED",
      durationMs: 25,
    });
    expect(mocks.invalidateAutomationGateBestEffort).toHaveBeenCalledOnce();
  });

  it("skips Neon entirely while the cached idle window is still current", async () => {
    const nextWakeAtMs = Date.now() + 120_000;
    mocks.getAutomationGateDecision.mockResolvedValue({
      run: false,
      snapshot: {
        version: 6,
        computedAtMs: Date.now(),
        nextWakeAtMs,
        hardWakeAtMs: nextWakeAtMs + 60_000,
        reason: "LEAGUE",
        runnerHealthy: true,
      },
    });

    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      status: "SUCCEEDED",
      skipped: "NOT_DUE",
      nextWakeAt: new Date(nextWakeAtMs).toISOString(),
    });
    expect(mocks.runAutomation).not.toHaveBeenCalled();
    expect(mocks.invalidateAutomationGateBestEffort).not.toHaveBeenCalled();
  });

  it("fails open to the normal leased pass when gate evaluation is unavailable", async () => {
    mocks.getAutomationGateDecision.mockRejectedValue(new Error("cache down"));

    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(mocks.runAutomation).toHaveBeenCalledOnce();
    expect(mocks.invalidateAutomationGateBestEffort).toHaveBeenCalledOnce();
  });

  it("recomputes the gate after active work so exact backoffs can sleep", async () => {
    mocks.runAutomation.mockResolvedValue({
      kind: "completed",
      status: "SUCCEEDED",
      durationMs: 25,
      recoveredExpiredLease: false,
      errorCode: null,
      summary: "{}",
      imported: 0,
    });

    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(mocks.runAutomation).toHaveBeenCalledOnce();
    expect(mocks.invalidateAutomationGateBestEffort).toHaveBeenCalledOnce();
  });

  it("recomputes after a board pass so health sees the new runner state", async () => {
    const now = Date.now();
    mocks.getAutomationGateDecision.mockResolvedValue({
      run: true,
      snapshot: {
        version: 6,
        computedAtMs: now - 60_000,
        nextWakeAtMs: now - 60_000,
        hardWakeAtMs: now + 60_000,
        reason: "BOARD",
        runnerHealthy: true,
      },
    });

    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(mocks.runAutomation).toHaveBeenCalledOnce();
    expect(mocks.invalidateAutomationGateBestEffort).toHaveBeenCalledOnce();
  });

  it("also refreshes a board snapshot at its hard reconciliation", async () => {
    const now = Date.now();
    mocks.getAutomationGateDecision.mockResolvedValue({
      run: true,
      snapshot: {
        version: 6,
        computedAtMs: now - 120_000,
        nextWakeAtMs: now - 120_000,
        hardWakeAtMs: now - 1,
        reason: "BOARD",
        runnerHealthy: true,
      },
    });

    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(mocks.invalidateAutomationGateBestEffort).toHaveBeenCalledOnce();
  });

  it("expires game and layout caches when the owned pass imports a game", async () => {
    mocks.runAutomation.mockResolvedValue({
      kind: "completed",
      status: "SUCCEEDED",
      durationMs: 25,
      recoveredExpiredLease: false,
      errorCode: null,
      summary: "{}",
      imported: 2,
    });

    await GET(request(`Bearer ${SECRET}`));

    expect(revalidateTag).toHaveBeenCalledWith("games", { expire: 0 });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("treats a duplicate active lease as an accepted skip", async () => {
    mocks.runAutomation.mockResolvedValue({
      kind: "lease-held",
      status: "RUNNING",
      leaseExpiresAt: new Date(),
      retryAfterSeconds: 42,
    });

    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(202);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(await response.json()).toMatchObject({
      ok: true,
      skipped: "LEASE_HELD",
    });
    expect(mocks.invalidateAutomationGateBestEffort).not.toHaveBeenCalled();
  });

  it("returns a server error for a persisted failed run without exception text", async () => {
    mocks.runAutomation.mockResolvedValue({
      kind: "completed",
      status: "FAILED",
      durationMs: 5,
      recoveredExpiredLease: false,
      errorCode: "AUTOMATION_FAILED",
      summary: "{}",
      imported: 0,
    });

    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      status: "FAILED",
      durationMs: 5,
      recoveredExpiredLease: false,
      errorCode: "AUTOMATION_FAILED",
    });
  });

  it("returns non-2xx for degraded persisted health", async () => {
    mocks.runAutomation.mockResolvedValue({
      kind: "completed",
      status: "DEGRADED",
      durationMs: 40,
      recoveredExpiredLease: false,
      errorCode: "WORKER_DEGRADED",
      summary: "{}",
      imported: 0,
    });

    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      status: "DEGRADED",
      errorCode: "WORKER_DEGRADED",
    });
  });

  it("returns a generic unavailable response when ownership cannot be persisted", async () => {
    mocks.runAutomation.mockRejectedValue(new Error("database password leaked"));

    const response = await GET(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      status: "UNAVAILABLE",
    });
    expect(mocks.invalidateAutomationGateBestEffort).toHaveBeenCalledOnce();
  });
});
