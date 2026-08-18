import { describe, expect, it, vi } from "vitest";

// The export is a route handler behind an admin session — stub auth exactly
// as admin-claims.itest.ts does. `requireAdmin` resolving = admin; rejecting
// = not. The route only cares whether it throws.
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { GET } from "@/app/api/admin/season-export/route";
import {
  DOTA_MATCH_KIND,
  MATCH_PHASE,
  MATCH_STATUS,
  SCRIM_STATUS,
  SEASON_STATUS,
  TEAM_STAFF_ROLE,
} from "@/lib/constants";
import { SEASON_EXPORT_MAX_RESPONSE_BYTES } from "@/lib/season-export-response";
import { makePlayer, makeSeason, makeTeam, makeUser } from "./factories";

function exportReq(seasonId?: string): NextRequest {
  const url = new URL("http://localhost:3000/api/admin/season-export");
  if (seasonId !== undefined) url.searchParams.set("seasonId", seasonId);
  return new NextRequest(url);
}

/** A small but complete season: two teams, competitive and scrim box scores,
 *  scrim staff/lineups, and the shared Dota ownership claims — the parts the
 *  route's docstring calls out as unrecoverable once OpenDota ages them out. */
async function stageSeason(name: string, isActive = true) {
  const season = await makeSeason({
    name,
    status: SEASON_STATUS.REGULAR_SEASON,
    isActive,
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
  const coach = await makeUser(`${name} Coach`);
  const staff = await prisma.teamStaff.create({
    data: {
      teamId: home.id,
      userId: coach.id,
      role: TEAM_STAFF_ROLE.COACH,
    },
  });
  const scrim = await prisma.scrim.create({
    data: {
      seasonId: season.id,
      hostTeamId: home.id,
      opponentTeamId: away.id,
      createdById: home.captainId,
      scheduledAt: new Date("2026-08-18T03:00:00.000Z"),
      bestOf: 1,
      status: SCRIM_STATUS.COMPLETED,
      hostScore: 1,
      awayScore: 0,
      winnerTeamId: home.id,
    },
  });
  const [rosterParticipant, guestParticipant] = await Promise.all([
    prisma.scrimParticipant.create({
      data: {
        scrimId: scrim.id,
        teamId: home.id,
        userId: player.id,
        dotaAccountId: 301_000_001,
        displayName: player.name,
      },
    }),
    prisma.scrimParticipant.create({
      data: {
        scrimId: scrim.id,
        teamId: away.id,
        dotaAccountId: 301_000_002,
        displayName: `${name} Guest`,
        guest: true,
        addedById: coach.id,
      },
    }),
  ]);
  const scrimPlayers = JSON.stringify([
    {
      accountId: guestParticipant.dotaAccountId,
      userId: null,
      teamId: away.id,
      heroId: 15,
      kills: 4,
      deaths: 6,
      assists: 9,
    },
  ]);
  const scrimGame = await prisma.scrimGame.create({
    data: {
      scrimId: scrim.id,
      dotaMatchId: `${name}-scrim-g1`,
      radiantWin: true,
      radiantTeamId: home.id,
      direTeamId: away.id,
      winnerTeamId: home.id,
      players: scrimPlayers,
    },
  });
  await prisma.dotaMatchClaim.createMany({
    data: [
      {
        dotaMatchId: game.dotaMatchId,
        kind: DOTA_MATCH_KIND.LEAGUE,
        contextId: match.id,
      },
      {
        dotaMatchId: scrimGame.dotaMatchId,
        kind: DOTA_MATCH_KIND.SCRIM,
        contextId: scrim.id,
      },
    ],
  });
  const outsider = await makeUser(`${name} Oracle`);
  await prisma.prediction.create({
    data: {
      matchId: match.id,
      userId: outsider.id,
      pickedTeamId: home.id,
    },
  });
  await prisma.fantasyRoster.create({
    data: {
      seasonId: season.id,
      userId: outsider.id,
      picks: { create: { userId: player.id } },
    },
  });
  await prisma.setting.createMany({
    data: [
      { key: `championAnnounced:${season.id}`, value: "sent" },
      { key: `resultAnnounced:${match.id}`, value: "sent" },
    ],
  });
  await prisma.setting.upsert({
    where: { key: "discordWebhookUrl" },
    create: { key: "discordWebhookUrl", value: "global-secret" },
    update: { value: "global-secret" },
  });
  await prisma.adminAction.create({
    data: {
      actorId: outsider.id,
      actorName: outsider.name,
      action: "recordResult",
      summary: `Recorded ${name}'s result`,
      seasonId: season.id,
    },
  });
  return {
    season,
    home,
    away,
    player,
    coach,
    staff,
    outsider,
    match,
    game,
    players,
    scrim,
    rosterParticipant,
    guestParticipant,
    scrimGame,
    scrimPlayers,
  };
}

describe("GET /api/admin/season-export", () => {
  it("exports the season's rows — box-score players JSON included — scoped to that season", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(undefined as never);
    const a = await stageSeason("Alpha");
    await prisma.user.update({
      where: { id: a.player.id },
      data: {
        dotaAccountIdV2: 388_000_001,
        legacyDotaAccountId: 388_000_002,
      },
    });
    await prisma.user.update({
      where: { id: a.outsider.id },
      data: { legacyDotaAccountId: 388_000_003 },
    });
    // A second season proves the export filters rather than dumping the DB.
    await stageSeason("Beta", false);

    const res = await GET(exportReq(a.season.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    // The filename slugs the season name and appends the id — the browser
    // download is the only artifact this route produces.
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="ld2l-audit-archive-alpha-${a.season.id}.json"`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-ld2l-artifact-purpose")).toBe(
      "audit-only-not-restorable",
    );

    const body = await res.json();
    expect(body.formatVersion).toBe(3);
    expect(body.artifactPurpose).toBe("AUDIT_ARCHIVE_ONLY");
    expect(body.restorable).toBe(false);
    expect(body.recoveryWarning).toMatch(/cannot restore/i);
    expect(body.archiveDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
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

    // Scrim scheduling, lineup identities, separate box scores, and global
    // ownership claims are archived without merging them into league Games.
    expect(body.teamStaff).toHaveLength(1);
    expect(body.teamStaff[0]).toMatchObject({
      id: a.staff.id,
      teamId: a.home.id,
      userId: a.coach.id,
      role: TEAM_STAFF_ROLE.COACH,
    });
    expect(body.scrims).toHaveLength(1);
    expect(body.scrims[0]).toMatchObject({
      id: a.scrim.id,
      seasonId: a.season.id,
      hostTeamId: a.home.id,
      opponentTeamId: a.away.id,
      createdById: a.home.captainId,
      status: SCRIM_STATUS.COMPLETED,
    });
    expect(body.scrimParticipants).toHaveLength(2);
    expect(
      body.scrimParticipants.map((row: { id: string }) => row.id).sort(),
    ).toEqual([a.guestParticipant.id, a.rosterParticipant.id].sort());
    expect(
      body.scrimParticipants.find(
        (row: { id: string }) => row.id === a.guestParticipant.id,
      ),
    ).toMatchObject({
      guest: true,
      userId: null,
      addedById: a.coach.id,
      displayName: "Alpha Guest",
    });
    expect(body.scrimGames).toHaveLength(1);
    expect(body.scrimGames[0]).toMatchObject({
      id: a.scrimGame.id,
      scrimId: a.scrim.id,
      dotaMatchId: "Alpha-scrim-g1",
      players: a.scrimPlayers,
    });
    expect(
      body.dotaMatchClaims.map(
        (claim: { dotaMatchId: string; kind: string; contextId: string }) => ({
          dotaMatchId: claim.dotaMatchId,
          kind: claim.kind,
          contextId: claim.contextId,
        }),
      ),
    ).toEqual([
      {
        dotaMatchId: "Alpha-g1",
        kind: DOTA_MATCH_KIND.LEAGUE,
        contextId: a.match.id,
      },
      {
        dotaMatchId: "Alpha-scrim-g1",
        kind: DOTA_MATCH_KIND.SCRIM,
        contextId: a.scrim.id,
      },
    ]);

    // Identity references that do not have a Registration (predictors,
    // fantasy managers, standins, admins) are still self-contained.
    expect(body.users.map((u: { id: string }) => u.id)).toContain(a.outsider.id);
    expect(body.users).toHaveLength(5); // two captains + player + coach + outsider
    expect(body.users[0]).not.toHaveProperty("discordId");
    expect(body.users[0]).not.toHaveProperty("role");
    const archivedPlayer = body.users.find(
      (u: { id: string }) => u.id === a.player.id,
    );
    const archivedOutsider = body.users.find(
      (u: { id: string }) => u.id === a.outsider.id,
    );
    const archivedCoach = body.users.find(
      (u: { id: string }) => u.id === a.coach.id,
    );
    expect(archivedPlayer).toMatchObject({ dotaAccountId: 388_000_001 });
    expect(archivedOutsider).toMatchObject({ dotaAccountId: 388_000_003 });
    expect(archivedCoach).toMatchObject({
      id: a.coach.id,
      steamId: a.coach.steamId,
      name: "Alpha Coach",
    });
    expect(archivedCoach).not.toHaveProperty("discordId");
    expect(archivedCoach).not.toHaveProperty("role");
    expect(archivedPlayer).not.toHaveProperty("dotaAccountIdV2");
    expect(archivedPlayer).not.toHaveProperty("legacyDotaAccountId");
    expect(body.predictions).toHaveLength(1);
    expect(body.fantasyRosters[0].picks).toHaveLength(1);

    // Relationless season/match state and audit history remain in v3, but
    // global secrets are not.
    expect(body.settings.map((s: { key: string }) => s.key).sort()).toEqual(
      [
        `championAnnounced:${a.season.id}`,
        `resultAnnounced:${a.match.id}`,
      ].sort(),
    );
    expect(body.settings.map((s: { key: string }) => s.key)).not.toContain(
      "discordWebhookUrl",
    );
    expect(body.adminActions).toHaveLength(1);
    expect(body.adminActions[0].summary).toContain("Alpha");

    expect(body.counts).toEqual({
      users: 5,
      registrations: 1,
      teams: 2,
      teamStaff: 1,
      teamMembers: 0,
      matches: 1,
      games: 1,
      scrims: 1,
      scrimParticipants: 2,
      scrimGames: 1,
      dotaMatchClaims: 2,
      predictions: 1,
      fantasyRosters: 1,
      settings: 2,
      adminActions: 1,
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

  it("rejects an oversized season id before querying the archive", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(undefined as never);
    const res = await GET(exportReq("s".repeat(129)));

    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "seasonId is too long" });
  });

  it("404s on a bogus seasonId (admin-confirmed, so this one may say why)", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(undefined as never);
    const res = await GET(exportReq("no-such-season"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown season" });
  });

  it("fails safely before returning an archive above the hosted response ceiling", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(undefined as never);
    const a = await stageSeason("Oversize");
    // Fire is four UTF-8 bytes but only two JavaScript UTF-16 code units. This
    // makes the route test pin byte-based sizing all the way through the real
    // database/archive path rather than accidentally enforcing string.length.
    await prisma.game.update({
      where: { id: a.game.id },
      data: {
        players: "🔥".repeat(
          Math.ceil(SEASON_EXPORT_MAX_RESPONSE_BYTES / 4),
        ),
      },
    });

    const res = await GET(exportReq(a.season.id));
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.json()).toEqual({
      error:
        "This season's audit archive is too large for the hosted download limit. Use the verified full-database backup workflow and arrange an approved out-of-band audit export before deleting this season.",
    });
  });
});
