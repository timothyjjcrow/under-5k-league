import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { seasonSettingScopeWhere } from "@/lib/settings";

export const dynamic = "force-dynamic";

async function readSeasonArchive(
  tx: Prisma.TransactionClient,
  seasonId: string,
) {
  const season = await tx.season.findUnique({ where: { id: seasonId } });
  if (!season) return null;

  const [
    registrations,
    teams,
    teamMembers,
    matches,
    games,
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
    tx.teamMember.findMany({
      where: { seasonId },
      include: { user: { select: { id: true, steamId: true, name: true } } },
    }),
    tx.match.findMany({ where: { seasonId } }),
    // The box scores are the biggest and least reproducible part of a season.
    tx.game.findMany({ where: { match: { seasonId } } }),
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
  const settings = await tx.setting.findMany({
    where: seasonSettingScopeWhere(seasonId, matchIds),
    orderBy: { key: "asc" },
  });

  const userIds = new Set<string>();
  for (const row of registrations) userIds.add(row.userId);
  for (const row of teams) userIds.add(row.captainId);
  for (const row of teamMembers) userIds.add(row.userId);
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
      dotaAccountId: true,
      rankTier: true,
      discordName: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    season,
    users,
    registrations,
    teams,
    teamMembers,
    draft,
    bids,
    matches,
    games,
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
 * Read-only, admin-only, and streams whatever the season has — no pagination,
 * because a season is a few thousand rows and the point is completeness.
 */
export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    // Same shape as the rest of the app: never confirm what exists to a
    // non-admin.
    return new NextResponse("Not found", { status: 404 });
  }

  const seasonId = req.nextUrl.searchParams.get("seasonId");
  if (!seasonId) {
    return NextResponse.json({ error: "seasonId required" }, { status: 400 });
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
        { status: 409, headers: { "retry-after": "1" } },
      );
    }
    throw error;
  }
  if (!archive) {
    return NextResponse.json({ error: "Unknown season" }, { status: 404 });
  }

  const core = {
    formatVersion: 2,
    artifactPurpose: "AUDIT_ARCHIVE_ONLY",
    restorable: false,
    recoveryWarning:
      "This JSON cannot restore the database and is not a substitute for a verified full-database backup.",
    ...archive,
    counts: {
      users: archive.users.length,
      registrations: archive.registrations.length,
      teams: archive.teams.length,
      teamMembers: archive.teamMembers.length,
      matches: archive.matches.length,
      games: archive.games.length,
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
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="ld2l-audit-archive-${safeName}-${seasonId}.json"`,
      "cache-control": "no-store",
      "x-ld2l-artifact-purpose": "audit-only-not-restorable",
    },
  });
}
