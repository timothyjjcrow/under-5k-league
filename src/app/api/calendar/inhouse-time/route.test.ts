import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { inhouseTimeParam } from "@/lib/inhouse-times";
import { limitPublicGet, PUBLIC_GET_LIMITS } from "@/lib/public-get-limit";
import { __resetRateLimits } from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({ readInhouseTime: vi.fn() }));

vi.mock("@/lib/inhouse-times-service", () => ({
  readInhouseTime: mocks.readInhouseTime,
}));
vi.mock("@/lib/site-url", () => ({
  resolveSiteUrl: () => "https://league.example",
}));

import { GET } from "./route";

const QUARTER_HOUR = 15 * 60_000;
const startsAtMs =
  Math.ceil((Date.now() + 2 * 60 * 60_000) / QUARTER_HOUR) * QUARTER_HOUR;

const get = (at: string, ip = "203.0.113.7") =>
  GET(
    new NextRequest(
      `https://league.example/api/calendar/inhouse-time?at=${encodeURIComponent(at)}`,
      { headers: { "x-forwarded-for": ip } },
    ),
  );

beforeEach(() => {
  mocks.readInhouseTime.mockReset();
  mocks.readInhouseTime.mockImplementation(async (ms: number) =>
    ms === startsAtMs ? { startsAtMs } : null,
  );
  __resetRateLimits();
});

describe("GET /api/calendar/inhouse-time", () => {
  it("downloads a time on the list as one calendar event", async () => {
    const res = await get(inhouseTimeParam(startsAtMs));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.text()).match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it("is not found for a malformed time or one that isn't on the list", async () => {
    expect((await get("tonight")).status).toBe(404);
    expect((await get(inhouseTimeParam(startsAtMs + QUARTER_HOUR))).status).toBe(404);
  });

  it("shares the calendar feed's per-IP limit and refuses before reading anything", async () => {
    for (let i = 0; i < PUBLIC_GET_LIMITS.calendar.limit; i += 1) {
      limitPublicGet(
        new NextRequest("https://league.example/api/calendar", {
          headers: { "x-forwarded-for": "203.0.113.7" },
        }),
        "calendar",
        Date.now(),
      );
    }
    const refused = await get(inhouseTimeParam(startsAtMs));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(mocks.readInhouseTime).not.toHaveBeenCalled();
    expect((await get(inhouseTimeParam(startsAtMs), "198.51.100.2")).status).toBe(200);
  });
});
