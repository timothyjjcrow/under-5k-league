import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stream-overlay-service", () => ({
  loadStreamOverlay: vi.fn(),
}));

import { loadStreamOverlay } from "@/lib/stream-overlay-service";
import { GET } from "./route";

const load = vi.mocked(loadStreamOverlay);
const SOURCE = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

const get = (id: string, rev: string) =>
  GET(new Request(`http://localhost/api/overlay/${id}/${rev}`), {
    params: Promise.resolve({ id, rev }),
  });

beforeEach(() => {
  load.mockReset();
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
