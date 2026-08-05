import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getActiveSeason: vi.fn(),
  findMatches: vi.fn(),
  findTeams: vi.fn(),
}));

vi.mock("@/lib/season", () => ({
  getActiveSeason: mocks.getActiveSeason,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    match: { findMany: mocks.findMatches },
    team: { findMany: mocks.findTeams },
  },
}));
vi.mock("@/lib/site-url", () => ({
  resolveSiteUrl: () => "https://league.example",
}));

import { GET } from "./route";

const season = {
  id: "season-active",
  name: 'Summer Finals "2026"',
};
const teams = [
  { id: "team-radiant", seasonId: season.id, name: "Radiant Raiders" },
  { id: "team-dire", seasonId: season.id, name: "Dire Wolves" },
  { id: "team-other", seasonId: season.id, name: "Other Team" },
];
const matchRows = [
  {
    id: "match-upcoming",
    seasonId: season.id,
    week: 2,
    phase: "REGULAR",
    homeTeamId: "team-radiant",
    awayTeamId: "team-dire",
    scheduledAt: new Date("2026-08-10T02:00:00Z"),
    status: "SCHEDULED",
    bestOf: 2,
    createdAt: new Date("2026-07-01T12:00:00Z"),
  },
  {
    id: "match-completed",
    seasonId: season.id,
    week: 1,
    phase: "REGULAR",
    homeTeamId: "team-dire",
    awayTeamId: "team-radiant",
    scheduledAt: new Date("2026-08-03T02:00:00Z"),
    status: "COMPLETED",
    bestOf: 2,
    createdAt: new Date("2026-07-01T11:00:00Z"),
  },
  {
    id: "match-other-team",
    seasonId: season.id,
    week: 2,
    phase: "REGULAR",
    homeTeamId: "team-other",
    awayTeamId: "team-dire",
    scheduledAt: new Date("2026-08-11T02:00:00Z"),
    status: "SCHEDULED",
    bestOf: 2,
    createdAt: new Date("2026-07-01T13:00:00Z"),
  },
  {
    id: "match-untimed",
    seasonId: season.id,
    week: 3,
    phase: "REGULAR",
    homeTeamId: "team-radiant",
    awayTeamId: "team-dire",
    scheduledAt: null,
    status: "SCHEDULED",
    bestOf: 2,
    createdAt: new Date("2026-07-01T14:00:00Z"),
  },
  {
    id: "match-old-season",
    seasonId: "season-old",
    week: 1,
    phase: "REGULAR",
    homeTeamId: "team-radiant",
    awayTeamId: "team-dire",
    scheduledAt: new Date("2025-08-03T02:00:00Z"),
    status: "COMPLETED",
    bestOf: 2,
    createdAt: new Date("2025-07-01T11:00:00Z"),
  },
];

function request(search = "") {
  return new NextRequest(`https://league.example/api/calendar${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActiveSeason.mockResolvedValue(season);
  mocks.findTeams.mockResolvedValue(teams);
  mocks.findMatches.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) => {
      const teamFilter = where.OR as
        Array<{ homeTeamId?: string; awayTeamId?: string }> | undefined;
      return matchRows.filter((match) => {
        const isRequestedTeam =
          !teamFilter ||
          teamFilter.some(
            (part) =>
              part.homeTeamId === match.homeTeamId ||
              part.awayTeamId === match.awayTeamId,
          );
        return (
          match.seasonId === where.seasonId &&
          match.scheduledAt !== null &&
          isRequestedTeam
        );
      });
    },
  );
});

describe("GET /api/calendar", () => {
  it("returns 404 when no season is active", async () => {
    mocks.getActiveSeason.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(await response.text()).toMatch(/no active season/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.findTeams).not.toHaveBeenCalled();
    expect(mocks.findMatches).not.toHaveBeenCalled();
  });

  it("publishes all timed active-season matches, including completed history", async () => {
    const response = await GET(request());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("UID:match-upcoming@league.example");
    expect(body).toContain("UID:match-completed@league.example");
    expect(body).toContain("UID:match-other-team@league.example");
    expect(body).not.toContain("match-untimed");
    expect(body).not.toContain("match-old-season");
    expect(body).toContain("DTSTAMP:20260701T120000Z");
    expect(mocks.findMatches).toHaveBeenCalledWith({
      where: {
        seasonId: season.id,
        scheduledAt: { not: null },
      },
      orderBy: { scheduledAt: "asc" },
    });
  });

  it("narrows a valid team feed without losing its completed fixtures", async () => {
    const response = await GET(request("?team=team-radiant"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("X-WR-CALNAME:Radiant Raiders — Summer Finals");
    expect(body).toContain("match-upcoming@league.example");
    expect(body).toContain("match-completed@league.example");
    expect(body).not.toContain("match-other-team@league.example");
    expect(mocks.findMatches).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ homeTeamId: "team-radiant" }, { awayTeamId: "team-radiant" }],
        }),
      }),
    );
  });

  it("keeps a valid team with no timed matches as a valid empty feed", async () => {
    mocks.findMatches.mockResolvedValueOnce([]);

    const response = await GET(request("?team=team-other"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("X-WR-CALNAME:Other Team — Summer Finals");
    expect(body).not.toContain("BEGIN:VEVENT");
  });

  it.each(["?team=team-old-season", "?team=", "?team=%20%20"])(
    "returns 404 for an invalid active-season team filter (%s)",
    async (search) => {
      const response = await GET(request(search));

      expect(response.status).toBe(404);
      expect(await response.text()).toMatch(/team not found/i);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.findMatches).not.toHaveBeenCalled();
    },
  );

  it("rejects an oversized team filter before database work", async () => {
    const response = await GET(request(`?team=${"x".repeat(129)}`));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getActiveSeason).not.toHaveBeenCalled();
    expect(mocks.findTeams).not.toHaveBeenCalled();
    expect(mocks.findMatches).not.toHaveBeenCalled();
  });

  it("serves a safe, revalidated iCalendar download", async () => {
    const response = await GET(request());
    const body = await response.text();

    expect(response.headers.get("content-type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="ld2l-summer-finals-2026-schedule.ics"',
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response.headers.get("vercel-cdn-cache-control")).toBe(
      "public, max-age=30, stale-while-revalidate=30",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
    for (const line of body.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
  });
});
