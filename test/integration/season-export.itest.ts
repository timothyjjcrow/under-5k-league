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
  await prisma.importSuppression.create({
    data: { seasonId: season.id, dotaMatchId: `${name}-excluded`, reason: "ADMIN_REMOVAL" },
  });
  await prisma.importCandidate.create({
    data: { seasonId: season.id, dotaMatchId: `${name}-pending`, payload: "PRIVATE_TRANSIENT_EVIDENCE",
      expiresAt: new Date(Date.now() + 60_000) },
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
    expect(body.formatVersion).toBe(5);
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
    expect(body.importSuppressions).toHaveLength(1);
    expect(body.importSuppressions[0]).toMatchObject({
      seasonId: a.season.id, dotaMatchId: "Alpha-excluded", reason: "ADMIN_REMOVAL",
    });
    expect(body).not.toHaveProperty("importCandidates");
    expect(JSON.stringify(body)).not.toContain("PRIVATE_TRANSIENT_EVIDENCE");

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
      importSuppressions: 1,
      rosterTenures: 0,
      draftRuns: 0,
      draftLots: 0,
      gameParticipants: 0,
      matchLineups: 0,
      matchLineupSeats: 0,
    });
  });

  it("exports all six history tables and their independent actors, then cascades them only with the deleted season", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(undefined as never);
    const a = await stageSeason("History", false);
    const other = await stageSeason("Other history");
    const [starter, closer, reverser, creator, confirmer, participantUser, seatUser] = await Promise.all(
      ["Starter", "Closer", "Reverser", "Lineup creator", "Lineup confirmer", "Actual participant", "Planned player"]
        .map((name) => makeUser(name)),
    );
    const at = new Date("2026-08-01T20:00:00.000Z");
    const later = new Date("2026-08-02T20:00:00.000Z");
    const run = await prisma.draftRun.create({ data: {
      seasonId: a.season.id, runNumber: 1, provenance: "COMMAND", status: "COMPLETE",
      startedAt: at, endedAt: later, startedById: starter.id,
      rulesSnapshot: JSON.stringify({ version: 1, budgetMmrWeight: 30 }),
      openingTeamsSnapshot: JSON.stringify({ version: 1, teams: [] }),
      poolSnapshot: JSON.stringify({ version: 1, players: [] }),
    } });
    const bidsSnapshot = JSON.stringify({ version: 1, provenance: "COMMAND", bids: [
      { bidId: "preserved-bid", teamId: a.home.id, teamName: a.home.name, amount: 17, at: at.toISOString() },
    ] });
    const lot = await prisma.draftLot.create({ data: {
      runId: run.id, sequence: 1, provenance: "COMMAND", openedAt: at, openingKind: "MANUAL",
      nominatedUserId: a.player.id, nominatorTeamId: a.home.id, openedById: starter.id,
      nomineeSnapshot: JSON.stringify({ version: 1, userId: a.player.id, name: a.player.name, mmr: 3200 }),
      nominatorSnapshot: JSON.stringify({ version: 1, teamId: a.home.id, name: a.home.name }),
      acceptedBidsSnapshot: bidsSnapshot, status: "UNDONE", soldTeamId: a.home.id,
      soldTeamNameSnapshot: a.home.name, soldPrice: 17, soldAt: at, closedAt: at,
      closedById: closer.id, reversedAt: later, reversedById: reverser.id, reversalReason: "ADMIN_UNDO",
      sourceMembershipId: "removed-historical-seat",
    } });
    const tenure = await prisma.rosterTenure.create({ data: {
      seasonId: a.season.id, teamId: a.home.id, userId: a.player.id,
      sourceMembershipId: "removed-historical-seat", joinedAt: at, endedAt: later, closedAt: later,
      startProvenance: "COMMAND", endProvenance: "COMMAND", endReason: "DRAFT_UNDO",
      createdById: starter.id, endedById: reverser.id, acquisitionKind: "AUCTION", acquisitionPrice: 17,
      acquisitionMmr: 3200, rolesSnapshot: "4,5", isCaptainAtJoin: false,
      playerNameSnapshot: a.player.name, teamNameSnapshot: a.home.name, draftLotId: lot.id,
    } });
    // Draft pointers introduce SetNull back-references; they must not form a
    // cascade cycle that prevents deleting the archived season.
    await prisma.draft.create({ data: {
      seasonId: a.season.id, status: "COMPLETE", activeRunId: run.id, currentLotId: lot.id,
    } });
    const participant = await prisma.gameParticipant.create({ data: {
      gameId: a.game.id, sourceLineIndex: 0, userId: participantUser.id, teamId: a.home.id,
      accountId: 3_500_000_000, heroId: 14, isRadiant: true, kills: 7, deaths: 2, assists: 11,
    } });
    const lineup = await prisma.matchLineup.create({ data: {
      matchId: a.match.id, teamId: a.home.id, revision: 1, scheduleRevision: 0, logisticsRevision: 0,
      scheduledAtSnapshot: at, status: "SUPERSEDED", createdAt: at,
      createdById: creator.id, confirmedAt: at, confirmedById: confirmer.id,
      confirmedByName: confirmer.name, supersededAt: later, reason: "ROSTER_RELEASED",
      compositionFingerprint: "historic-lineup",
    } });
    const seat = await prisma.matchLineupSeat.create({ data: {
      lineupId: lineup.id, seatKey: "position-4", userId: seatUser.id,
      userNameSnapshot: seatUser.name, accountId: 3_500_000_001, replacingUserId: a.player.id,
      entryKind: "STANDIN", acceptanceStatusSnapshot: "LEGACY_UNCONFIRMED", position: 4,
      mmr: 3100, mmrSource: "REGISTRATION", ratingAt: at, sourceTenureId: tenure.id,
      availabilityAt: at,
    } });
    const body = await (await GET(exportReq(a.season.id))).json();
    for (const [key, id] of Object.entries({ rosterTenures: tenure.id, draftRuns: run.id,
      draftLots: lot.id, gameParticipants: participant.id, matchLineups: lineup.id, matchLineupSeats: seat.id })) {
      expect(body[key].map((row: { id: string }) => row.id)).toEqual([id]);
      expect(body.counts[key]).toBe(1);
    }
    expect(body.draftLots[0]).toMatchObject({ status: "UNDONE", soldPrice: 17, reversedById: reverser.id,
      acceptedBidsSnapshot: bidsSnapshot });
    expect(body.rosterTenures[0]).toMatchObject({ sourceMembershipId: "removed-historical-seat", endReason: "DRAFT_UNDO" });
    expect(body.gameParticipants[0].accountId).toBe(3_500_000_000);
    expect(body.matchLineups[0]).toMatchObject({ status: "SUPERSEDED", confirmedByName: confirmer.name });
    expect(body.matchLineupSeats[0]).toMatchObject({ acceptanceStatusSnapshot: "LEGACY_UNCONFIRMED", sourceTenureId: tenure.id });
    for (const user of [starter, closer, reverser, creator, confirmer, participantUser, seatUser]) {
      expect(body.users.find((row: { id: string }) => row.id === user.id)).toMatchObject({ name: user.name, steamId: user.steamId });
    }
    expect(body.users.some((row: { name: string }) => row.name.startsWith("Other history"))).toBe(false);
    expect(body.users.every((row: Record<string, unknown>) => !("discordId" in row) && !("role" in row))).toBe(true);

    // The production command already validates archived state/backup receipts;
    // this checks the additive schema's actual FK behavior beneath that guard.
    await prisma.$transaction(async (tx) => {
      await tx.match.deleteMany({ where: { seasonId: a.season.id } });
      await tx.season.delete({ where: { id: a.season.id } });
    });
    expect(await prisma.rosterTenure.count()).toBe(0);
    expect(await prisma.draftRun.count()).toBe(0);
    expect(await prisma.draftLot.count()).toBe(0);
    expect(await prisma.gameParticipant.count()).toBe(0);
    expect(await prisma.matchLineup.count()).toBe(0);
    expect(await prisma.matchLineupSeat.count()).toBe(0);
    expect(await prisma.season.findUnique({ where: { id: other.season.id } })).not.toBeNull();
    expect(await prisma.game.findUnique({ where: { id: other.game.id } })).not.toBeNull();
    expect(await prisma.adminAction.count({ where: { seasonId: a.season.id } })).toBe(1);
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
