import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ runAutomation: vi.fn() }));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/automation-service", () => ({
  runAutomation: mocks.runAutomation,
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
  });
});
