import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeInhouseNight, type InhouseNight } from "@/lib/inhouse-night";

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

beforeEach(() => mocks.findUnique.mockReset());

describe("GET /api/calendar/inhouse-night", () => {
  it("downloads the planned night as one calendar event", async () => {
    stored({});
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="[a-z0-9-]+-inhouse-night\.ics"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("UID:inhouse-night-night-7@league.example");
    expect(body).toContain("SEQUENCE:2");
    expect(body).toContain("DTSTART:20301010T030000Z");
    expect(body).toContain("DTSTAMP:20301001T120000Z");
    expect(body).toContain("Bring a friend");
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it("is not found with no night, or once the night is over", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect((await GET()).status).toBe(404);
    stored({ startsAtMs: Date.now() - 4 * HOUR });
    expect((await GET()).status).toBe(404);
  });
});
