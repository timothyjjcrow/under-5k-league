import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stream-overlay-service", () => ({
  loadStreamOverlay: vi.fn(),
}));

import { PUBLIC_GET_LIMITS } from "@/lib/public-get-limit";
import { __resetRateLimits } from "@/lib/rate-limit";
import { loadStreamOverlay } from "@/lib/stream-overlay-service";
import { GET } from "./route";

const load = vi.mocked(loadStreamOverlay);
const SOURCE = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

const get = (id: string, rev: string, ip = "203.0.113.7") =>
  GET(
    new Request(`http://localhost/api/overlay/${id}/${rev}`, {
      headers: { "x-forwarded-for": ip },
    }),
    { params: Promise.resolve({ id, rev }) },
  );

beforeEach(() => {
  load.mockReset();
  __resetRateLimits();
});

describe("the overlay data route", () => {
  it("returns the fixture's overlay, for the CDN to keep under its version", async () => {
    const payload = { version: 1, match: { id: "m1" } };
    load.mockResolvedValue(payload as never);
    const response = await get("m1", "mgd8xz1a.2qkf3");
    expect(response.status).toBe(200);
    expect(load).toHaveBeenCalledWith("m1");
    expect(await response.json()).toEqual(payload);
    expect(response.headers.get("cache-control")).toBe("public, max-age=600");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, max-age=86400");
  });

  it("answers no such match with a short-lived 404", async () => {
    load.mockResolvedValue(null);
    const response = await get("missing", "0.f");
    expect(response.status).toBe(404);
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, max-age=300");
  });

  it("refuses a malformed id or version before reading anything", async () => {
    for (const [id, rev] of [
      ["a/b", "0.f"],
      ["m1", "latest"],
      ["m1", "0.f.g"],
    ]) {
      expect((await get(id, rev)).status).toBe(404);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses one address past its per-IP limit before reading anything", async () => {
    // A version is whatever the caller types, so nothing else caps a loop.
    load.mockResolvedValue({ version: 1, match: { id: "m1" } } as never);
    const { limit } = PUBLIC_GET_LIMITS.overlay;
    for (let i = 0; i < limit; i += 1) {
      expect((await get("m1", `${i.toString(36)}.f`)).status).toBe(200);
    }
    expect(load).toHaveBeenCalledTimes(limit);
    const refused = await get("m1", "zz.f");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.json()).toEqual({ error: "Too many requests" });
    expect(load).toHaveBeenCalledTimes(limit);
    // Another address (another caster) is unaffected.
    expect((await get("m1", "zz.f", "198.51.100.2")).status).toBe(200);
  });

  it("stays well above what a room of OBS sources asks for", () => {
    // Each source asks once per version (a result, or every ten minutes);
    // five casters with all three layouts open is 15 at a version change.
    expect(PUBLIC_GET_LIMITS.overlay.limit).toBeGreaterThanOrEqual(60);
  });

  it("exports no mutating handler", async () => {
    const route = await import("./route");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(method in route).toBe(false);
    }
  });

  it("can't trigger the worker, an import or a provider call from public traffic", () => {
    for (const name of ["runResultSync", "runAutomation", "importGame", "@/lib/dota", "discord"]) {
      expect(SOURCE).not.toContain(name);
    }
  });
});
