import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: mocks.queryRaw },
}));

import { GET, readinessResponse } from "./route";

describe("GET /api/health/ready", () => {
  beforeEach(() => mocks.queryRaw.mockReset());

  it("reports readiness after a successful database probe", async () => {
    mocks.queryRaw.mockResolvedValue([{ one: 1 }]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, status: "ready" });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns a generic 503 when the database is unavailable", async () => {
    const response = await readinessResponse(async () => {
      throw new Error("postgresql://user:password@database.internal/league");
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      status: "unavailable",
    });
  });
});
