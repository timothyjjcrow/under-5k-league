import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getActiveSeason: vi.fn(),
  findMatches: vi.fn(),
  findTeams: vi.fn(),
  findTeam: vi.fn(),
}));

vi.mock("@/lib/season", () => ({
  getActiveSeason: mocks.getActiveSeason,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    match: { findMany: mocks.findMatches },
    team: { findMany: mocks.findTeams, findUnique: mocks.findTeam },
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
const oldSeason = { id: "season-old", name: "Spring Cup" };
const teams = [
  { id: "team-radiant", seasonId: season.id, name: "Radiant Raiders" },
  { id: "team-dire", seasonId: season.id, name: "Dire Wolves" },
  { id: "team-other", seasonId: season.id, name: "Other Team" },
];
const oldTeams = [
  { id: "team-old-season", seasonId: oldSeason.id, name: "Ancient Order" },
  { id: "team-old-rival", seasonId: oldSeason.id, name: "Roshan Pit" },
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
    homeTeamId: "team-old-season",
    awayTeamId: "team-old-rival",
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
  mocks.findTeams.mockImplementation(
    async ({ where }: { where: { seasonId: string } }) =>
      [...teams, ...oldTeams].filter((team) => team.seasonId === where.seasonId),
  );
  mocks.findTeam.mockImplementation(
    async ({ where }: { where: { id: string } }) => {
      const team = [...teams, ...oldTeams].find((row) => row.id === where.id);
      if (!team) return null;
      return {
        id: team.id,
        name: team.name,
        season: team.seasonId === season.id ? season : oldSeason,
      };
    },
  );
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
  it.each([1, 3])("exports tiebreaker fixtures with their own week label and best-of-%i format", async (bestOf) => {
    mocks.findMatches.mockResolvedValueOnce([{
      ...matchRows[0],
      id: "match-tiebreaker",
      phase: "TIEBREAKER",
      week: 6,
      bestOf,
    }]);
    const response = await GET(request());
    const body = await response.text();
    expect(body).toContain("UID:match-tiebreaker@league.example");
    expect(body).toContain("SUMMARY:Tiebreaker: Radiant Raiders vs Dire Wolves");
    expect(body).toContain(`best of ${bestOf}`);
    expect(body).not.toContain("Playoffs");
  });

  it("names playoff events by their round, reading the depth from the whole bracket", async () => {
    // A team feed holds only that team's semifinal; the bracket's first round
    // (four quarterfinals) is what says this is a semifinal, not "Playoffs".
    const semi = {
      ...matchRows[0],
      id: "match-semi",
      phase: "PLAYOFF",
      week: 9,
      bracketSlot: "R1M0",
      bestOf: 3,
    };
    const final = {
      ...matchRows[0],
      id: "match-final",
      phase: "FINAL",
      week: 10,
      bracketSlot: "R2M0",
      bestOf: 3,
    };
    mocks.findMatches.mockImplementation(
      async ({ select }: { select?: unknown }) =>
        select
          ? [0, 1, 2, 3].map((i) => ({ phase: "PLAYOFF", bracketSlot: `R0M${i}` }))
          : [semi, final],
    );
    const body = await (await GET(request("?team=team-radiant"))).text();
    expect(body).toContain("SUMMARY:Semifinal: Radiant Raiders vs Dire Wolves");
    expect(body).toContain("SUMMARY:Grand final: Radiant Raiders vs Dire Wolves");
    expect(body).not.toContain("Playoffs");
    // Subscribers key events on the UID: its format must never change.
    expect(body).toContain("UID:match-semi@league.example");
    expect(mocks.findMatches).toHaveBeenCalledWith({
      where: { seasonId: season.id, phase: { in: ["PLAYOFF", "FINAL"] } },
      select: { phase: true, bracketSlot: true },
    });
  });

  it("serves a valid empty league calendar when no season is active", async () => {
    // A subscription taken last season must keep syncing through the break,
    // then fill with the next season's fixtures by itself.
    mocks.getActiveSeason.mockResolvedValue(null);

    const response = await GET(request());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(body).toContain("X-WR-CALNAME:GGD2L schedule");
    expect(body).not.toContain("BEGIN:VEVENT");
    expect(mocks.findTeams).not.toHaveBeenCalled();
    expect(mocks.findMatches).not.toHaveBeenCalled();
  });

  it("keeps a past season's team feed serving that team's own fixtures", async () => {
    // Teams are re-drafted each season: an old team link must keep syncing its
    // finished matches instead of failing once a new season is active.
    const response = await GET(request("?team=team-old-season"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("X-WR-CALNAME:Ancient Order — Spring Cup");
    expect(body).toContain("UID:match-old-season@league.example");
    expect(body).toContain("SUMMARY:Week 1: Ancient Order vs Roshan Pit");
    expect(body).not.toContain("match-upcoming@league.example");
    expect(mocks.getActiveSeason).not.toHaveBeenCalled();
    expect(mocks.findMatches).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ seasonId: oldSeason.id }),
      }),
    );
  });

  it("keeps a team feed working in the offseason", async () => {
    mocks.getActiveSeason.mockResolvedValue(null);
    const response = await GET(request("?team=team-radiant"));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "UID:match-upcoming@league.example",
    );
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

  it.each(["?team=team-deleted", "?team=", "?team=%20%20"])(
    "returns 404 for a team filter that names no team (%s)",
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
      'attachment; filename="ggd2l-summer-finals-2026-schedule.ics"',
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
