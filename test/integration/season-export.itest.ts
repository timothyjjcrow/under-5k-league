import { describe, expect, it, vi } from "vitest";

// The export is a route handler behind an admin session — stub auth exactly
// as admin-claims.itest.ts does. `requireAdmin` resolving = admin; rejecting
// = not. The route only cares whether it throws.
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { GET } from "@/app/api/admin/season-export/route";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { makePlayer, makeSeason, makeTeam } from "./factories";

function exportReq(seasonId?: string): NextRequest {
  const url = new URL("http://localhost:3000/api/admin/season-export");
  if (seasonId !== undefined) url.searchParams.set("seasonId", seasonId);
  return new NextRequest(url);
}

/** A small but complete season: two teams, a registration, a completed match
 *  and one imported Game carrying a players JSON box score — the part the
 *  route's docstring calls out as unrecoverable once OpenDota ages it out. */
async function stageSeason(name: string) {
  const season = await makeSeason({
    name,
    status: SEASON_STATUS.REGULAR_SEASON,
  });
  const home = await makeTeam(season.id, `${name} Home`, 0);
  const away = await makeTeam(season.id, `${name} Away`, 1);
  const player = await makePlayer(season.id, `${name} Player`, 3200);
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: home.id,
      awayTeamId: away.id,
      status: MATCH_STATUS.COMPLETED,
      homeScore: 2,
      awayScore: 0,
      winnerTeamId: home.id,
    },
  });
  const players = JSON.stringify([
    { userId: player.id, heroId: 14, kills: 7, deaths: 2, assists: 11 },
  ]);
  const game = await prisma.game.create({
    data: {
      matchId: match.id,
      dotaMatchId: `${name}-g1`,
      radiantWin: true,
      winnerTeamId: home.id,
      players,
    },
  });
  return { season, home, away, player, match, game, players };
}

describe("GET /api/admin/season-export", () => {
  it("exports the season's rows — box-score players JSON included — scoped to that season", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(undefined as never);
    const a = await stageSeason("Alpha");
    // A second season proves the export filters rather than dumping the DB.
    await stageSeason("Beta");

    const res = await GET(exportReq(a.season.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    // The filename slugs the season name and appends the id — the browser
    // download is the only artifact this route produces.
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="ld2l-alpha-${a.season.id}.json"`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.json();
    expect(body.formatVersion).toBe(1);
    expect(body.season.id).toBe(a.season.id);
    expect(body.season.name).toBe("Alpha");

    // Scoped: only Alpha's rows, none of Beta's.
    expect(body.teams).toHaveLength(2);
    expect(body.teams.map((t: { name: string }) => t.name).sort()).toEqual([
      "Alpha Away",
      "Alpha Home",
    ]);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].id).toBe(a.match.id);

    // Registrations carry the identifying user fields (id/steamId/name) so a
    // rebuild can re-link accounts.
    expect(body.registrations).toHaveLength(1);
    expect(body.registrations[0].user.id).toBe(a.player.id);
    expect(body.registrations[0].user.steamId).toBeTruthy();

    // The box score — the least reproducible part of a season — round-trips
    // byte-for-byte as the stored players JSON.
    expect(body.games).toHaveLength(1);
    expect(body.games[0].dotaMatchId).toBe("Alpha-g1");
    expect(body.games[0].players).toBe(a.players);
    expect(JSON.parse(body.games[0].players)[0].kills).toBe(7);

    expect(body.counts).toEqual({
      registrations: 1,
      teams: 2,
      matches: 1,
      games: 1,
    });
  });

  it("refuses a non-admin with a bare 404 — never confirming what exists", async () => {
    const a = await stageSeason("Gamma");
    vi.mocked(requireAdmin).mockRejectedValue(new Error("FORBIDDEN"));

    // Even with a REAL seasonId the refusal is indistinguishable from a
    // missing route: 404 plain text, not a JSON error naming the season.
    const res = await GET(exportReq(a.season.id));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("400s when seasonId is missing", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(undefined as never);
    const res = await GET(exportReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "seasonId required" });
  });

  it("404s on a bogus seasonId (admin-confirmed, so this one may say why)", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(undefined as never);
    const res = await GET(exportReq("no-such-season"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown season" });
  });
});
