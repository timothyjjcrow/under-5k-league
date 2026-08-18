import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/result-sync-status", () => ({
  getResultSyncSnapshot: vi.fn(),
}));

import { getResultSyncSnapshot } from "@/lib/result-sync-status";
import { GET } from "./route";

const snapshot = vi.mocked(getResultSyncSnapshot);

beforeEach(() => {
  snapshot.mockReset();
});

describe("public result status route", () => {
  it("returns the read-only watch snapshot with browser-safe edge microcaching", async () => {
    snapshot.mockResolvedValue({
      watch: true,
      cursor: "2026-08-03T12:00:00.000Z",
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledWith();
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response.headers.get("vercel-cdn-cache-control")).toBe(
      "public, max-age=5, stale-while-revalidate=10",
    );
    expect(await response.json()).toEqual({
      updated: false,
      watch: true,
      cursor: "2026-08-03T12:00:00.000Z",
    });
  });

  it("stays quiet when no workflow needs the fast client cadence", async () => {
    snapshot.mockResolvedValue({ watch: false, cursor: null });

    expect(await (await GET()).json()).toEqual({
      updated: false,
      watch: false,
      cursor: null,
    });
  });

  it("exports no mutating POST handler", async () => {
    const route = await import("./route");
    expect("POST" in route).toBe(false);
  });

  it("cannot regress into importing or invoking the worker from public traffic", () => {
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(source).not.toContain("runResultSync");
    expect(source).not.toContain("runAutomation");
    expect(source).not.toContain("loadResultSyncSnapshot");
    expect(source).not.toContain("@/lib/prisma");
    expect(source).not.toContain("revalidateTag");
    expect(source).not.toMatch(/export\s+async\s+function\s+POST/);
  });
});
