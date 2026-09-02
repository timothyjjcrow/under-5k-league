import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { DOTA_MATCH_KIND } from "@/lib/constants";
import { seasonSettingScopeWhere } from "@/lib/settings";
import { storedDotaAccountId } from "@/lib/dota-account";
import { serializeSeasonExport } from "@/lib/season-export-response";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "no-store" };

async function readSeasonArchive(
  tx: Prisma.TransactionClient,
  seasonId: string,
) {
  const season = await tx.season.findUnique({ where: { id: seasonId } });
  if (!season) return null;

  const [
    registrations,
    teams,
    teamStaff,
    teamMembers,
    matches,
    games,
    scrims,
    scrimParticipants,
    scrimGames,
    draft,
    bids,
    availability,
    standins,
    predictions,
    fantasyRosters,
    reschedules,
    adminActions,
  ] = await Promise.all([
    tx.registration.findMany({
      where: { seasonId },
      include: { user: { select: { id: true, steamId: true, name: true } } },
    }),
    tx.team.findMany({ where: { seasonId } }),
    tx.teamStaff.findMany({
      where: { team: { seasonId } },
      orderBy: { id: "asc" },
    }),
    tx.teamMember.findMany({
      where: { seasonId },
      include: { user: { select: { id: true, steamId: true, name: true } } },
    }),
    tx.match.findMany({ where: { seasonId } }),
    // The box scores are the biggest and least reproducible part of a season.
    tx.game.findMany({ where: { match: { seasonId } } }),
    tx.scrim.findMany({
      where: { seasonId },
      orderBy: { id: "asc" },
    }),
    tx.scrimParticipant.findMany({
      where: { scrim: { seasonId } },
      orderBy: { id: "asc" },
    }),
    // Scrim box scores are intentionally separate from competitive Game rows,
    // but they are just as unrecoverable and belong in the same audit snapshot.
    tx.scrimGame.findMany({
      where: { scrim: { seasonId } },
      orderBy: { id: "asc" },
    }),
    tx.draft.findUnique({ where: { seasonId } }),
    tx.bid.findMany({ where: { seasonId } }),
    tx.matchAvailability.findMany({ where: { match: { seasonId } } }),
    tx.standinAssignment.findMany({ where: { match: { seasonId } } }),
    tx.prediction.findMany({ where: { match: { seasonId } } }),
    tx.fantasyRoster.findMany({
      where: { seasonId },
      include: { picks: true },
    }),
    tx.rescheduleRequest.findMany({ where: { match: { seasonId } } }),
    // Relationless by design: audit history survives a season deletion.
    tx.adminAction.findMany({
      where: { seasonId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);

  const matchIds = matches.map((match) => match.id);
  const scrimIds = scrims.map((scrim) => scrim.id);
  const exportedDotaMatchIds = [
    ...games.map((game) => game.dotaMatchId),
    ...scrimGames.map((game) => game.dotaMatchId),
  ];
  const [settings, dotaMatchClaims] = await Promise.all([
    tx.setting.findMany({
      where: seasonSettingScopeWhere(seasonId, matchIds),
      orderBy: { key: "asc" },
    }),
    tx.dotaMatchClaim.findMany({
      where: {
        OR: [
          {
            kind: DOTA_MATCH_KIND.LEAGUE,
            contextId: { in: matchIds },
          },
          {
            kind: DOTA_MATCH_KIND.SCRIM,
            contextId: { in: scrimIds },
          },
          { dotaMatchId: { in: exportedDotaMatchIds } },
        ],
      },
      orderBy: { dotaMatchId: "asc" },
    }),
  ]);

  const userIds = new Set<string>();
  for (const row of registrations) userIds.add(row.userId);
  for (const row of teams) userIds.add(row.captainId);
  for (const row of teamStaff) userIds.add(row.userId);
  for (const row of teamMembers) userIds.add(row.userId);
  for (const row of scrims) userIds.add(row.createdById);
  for (const row of scrimParticipants) {
    if (row.userId) userIds.add(row.userId);
    if (row.addedById) userIds.add(row.addedById);
  }
  for (const row of bids) userIds.add(row.userId);
  for (const row of availability) userIds.add(row.userId);
  for (const row of standins) {
    userIds.add(row.standinUserId);
    if (row.replacingUserId) userIds.add(row.replacingUserId);
  }
  for (const row of predictions) userIds.add(row.userId);
  for (const row of fantasyRosters) {
    userIds.add(row.userId);
    for (const pick of row.picks) userIds.add(pick.userId);
  }
  for (const row of reschedules) userIds.add(row.proposedById);
  for (const row of adminActions) userIds.add(row.actorId);

  // A single identity table covers every foreign id, including fantasy
  // managers, predictors, standins, and admins who may not have registered.
  // OAuth ownership ids, roles, private scouting snapshots, and inhouse state
  // are intentionally outside a season archive.
  const users = await tx.user.findMany({
    where: { id: { in: [...userIds] } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      steamId: true,
      name: true,
      avatar: true,
      profileUrl: true,
      dotaAccountIdV2: true,
      legacyDotaAccountId: true,
      rankTier: true,
      discordName: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  // Keep the established archive contract stable. The rollback bridge is an
  // internal storage detail; an archive carries one authoritative stored
  // override under the pre-release field name.
  const archivedUsers = users.map((user) => ({
    id: user.id,
    steamId: user.steamId,
    name: user.name,
    avatar: user.avatar,
    profileUrl: user.profileUrl,
    dotaAccountId: storedDotaAccountId(user),
    rankTier: user.rankTier,
    discordName: user.discordName,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }));

  return {
    season,
    users: archivedUsers,
    registrations,
    teams,
    teamStaff,
    teamMembers,
    draft,
    bids,
    matches,
    games,
    scrims,
    scrimParticipants,
    scrimGames,
    dotaMatchClaims,
    availability,
    standins,
    predictions,
    fantasyRosters,
    reschedules,
    settings,
    adminActions,
  };
}

/**
 * Download one season as a JSON audit archive.
 *
 * `deleteSeason` is the only truly unrecoverable action in the app: a hard
 * cascade that takes every match, game, box score, registration, roster, draft
 * price, fantasy roster and pick'em pick with it, and silently rewrites the
 * cross-season boards (/records, /hall-of-fame, /meta, career stats) because
 * they scan all Game rows. This file is deliberately an AUDIT ARCHIVE, not a
 * backup or restore artifact. Re-importing would have to rebuild cuid graphs
 * and foreign keys across a dozen tables, and no such importer exists. It is
 * useful for investigation and a future deliberate import tool, but it does
 * not satisfy the production hard-delete backup gate.
 *
 * Read-only and admin-only. The archive is returned whole because its purpose
 * is completeness, but it is rejected before delivery if the serialized UTF-8
 * body would exceed the conservative hosted-response ceiling.
 */
export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    // Same shape as the rest of the app: never confirm what exists to a
    // non-admin.
    return new NextResponse("Not found", { status: 404, headers: NO_STORE });
  }

  const seasonId = req.nextUrl.searchParams.get("seasonId");
  if (!seasonId) {
    return NextResponse.json(
      { error: "seasonId required" },
      { status: 400, headers: NO_STORE },
    );
  }
  if (seasonId.length > 128) {
    return NextResponse.json(
      { error: "seasonId is too long" },
      { status: 400, headers: NO_STORE },
    );
  }

  let archive: Awaited<ReturnType<typeof readSeasonArchive>>;
  try {
    archive = await prisma.$transaction(
      (tx) => readSeasonArchive(tx, seasonId),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if ((error as { code?: string }).code === "P2034") {
      return NextResponse.json(
        {
          error:
            "The season changed while its archive was being captured. Retry the download for one consistent snapshot.",
        },
        {
          status: 409,
          headers: { ...NO_STORE, "retry-after": "1" },
        },
      );
    }
    throw error;
  }
  if (!archive) {
    return NextResponse.json(
      { error: "Unknown season" },
      { status: 404, headers: NO_STORE },
    );
  }

  const core = {
    formatVersion: 3,
    artifactPurpose: "AUDIT_ARCHIVE_ONLY",
    restorable: false,
    recoveryWarning:
      "This JSON cannot restore the database and is not a substitute for a verified full-database backup.",
    ...archive,
    counts: {
      users: archive.users.length,
      registrations: archive.registrations.length,
      teams: archive.teams.length,
      teamStaff: archive.teamStaff.length,
      teamMembers: archive.teamMembers.length,
      matches: archive.matches.length,
      games: archive.games.length,
      scrims: archive.scrims.length,
      scrimParticipants: archive.scrimParticipants.length,
      scrimGames: archive.scrimGames.length,
      dotaMatchClaims: archive.dotaMatchClaims.length,
      predictions: archive.predictions.length,
      fantasyRosters: archive.fantasyRosters.length,
      settings: archive.settings.length,
      adminActions: archive.adminActions.length,
    },
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(core))
    .digest("hex");
  const payload = {
    exportedAt: new Date().toISOString(),
    archiveDigest: `sha256:${digest}`,
    ...core,
  };

  const safeName =
    archive.season.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() ||
    "season";
  const serialized = serializeSeasonExport(payload);
  if (!serialized.ok) {
    return NextResponse.json(
      {
        error:
          "This season's audit archive is too large for the hosted download limit. Use the verified full-database backup workflow and arrange an approved out-of-band audit export before deleting this season.",
      },
      { status: 413, headers: NO_STORE },
    );
  }

  return new NextResponse(serialized.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="ld2l-audit-archive-${safeName}-${seasonId}.json"`,
      "cache-control": "no-store",
      "x-ld2l-artifact-purpose": "audit-only-not-restorable",
    },
  });
}
