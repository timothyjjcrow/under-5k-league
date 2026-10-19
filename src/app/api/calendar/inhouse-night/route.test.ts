import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { serializeInhouseNight, type InhouseNight } from "@/lib/inhouse-night";
import { limitPublicGet, PUBLIC_GET_LIMITS } from "@/lib/public-get-limit";
import { __resetRateLimits } from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { setting: { findUnique: mocks.findUnique } },
}));
vi.mock("@/lib/site-url", () => ({
  resolveSiteUrl: () => "https://league.example",
}));

import { GET } from "./route";

const HOUR = 3_600_000;

function stored(night: Partial<InhouseNight>) {
  mocks.findUnique.mockResolvedValue({
    value: serializeInhouseNight({
      id: "night-7",
      startsAtMs: Date.parse("2030-10-10T03:00:00.000Z"),
      note: "Bring a friend",
      createdAtMs: Date.parse("2030-10-01T12:00:00.000Z"),
      revision: 2,
      discordEventId: null,
      ...night,
    }),
  });
}

const get = (ip = "203.0.113.7") =>
  GET(
    new NextRequest("https://league.example/api/calendar/inhouse-night", {
      headers: { "x-forwarded-for": ip },
    }),
  );

beforeEach(() => {
  mocks.findUnique.mockReset();
  __resetRateLimits();
});

describe("GET /api/calendar/inhouse-night", () => {
  it("downloads the planned night as one calendar event", async () => {
    stored({});
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="[a-z0-9-]+-inhouse-night\.ics"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("UID:inhouse-night-night-7@ggd2l.vercel.app");
    expect(body).toContain("SEQUENCE:2");
    expect(body).toContain("DTSTART:20301010T030000Z");
    expect(body).toContain("DTSTAMP:20301001T120000Z");
    expect(body).toContain("Bring a friend");
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it("is not found with no night, or once the night is over", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    stored({ startsAtMs: Date.now() - 4 * HOUR });
    expect((await get()).status).toBe(404);
  });

  it("is never kept: a night an admin just moved downloads as moved", async () => {
    stored({});
    expect(await (await get()).text()).toContain("DTSTART:20301010T030000Z");
    stored({ startsAtMs: Date.parse("2030-10-11T03:00:00.000Z"), revision: 3 });
    const moved = await (await get()).text();
    expect(moved).toContain("DTSTART:20301011T030000Z");
    expect(moved).toContain("SEQUENCE:3");
  });

  it("shares the calendar feed's per-IP limit and refuses before reading anything", async () => {
    stored({});
    for (let i = 0; i < PUBLIC_GET_LIMITS.calendar.limit; i += 1) {
      limitPublicGet(
        new NextRequest("https://league.example/api/calendar", {
          headers: { "x-forwarded-for": "203.0.113.7" },
        }),
        "calendar",
        Date.now(),
      );
    }
    const refused = await get();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect((await get("198.51.100.2")).status).toBe(200);
  });
});
