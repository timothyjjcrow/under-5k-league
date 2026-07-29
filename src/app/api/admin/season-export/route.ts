import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Download one season as JSON — the safety net behind "Delete permanently".
 *
 * `deleteSeason` is the only truly unrecoverable action in the app: a hard
 * cascade that takes every match, game, box score, registration, roster, draft
 * price, fantasy roster and pick'em pick with it, and silently rewrites the
 * cross-season boards (/records, /hall-of-fame, /meta, career stats) because
 * they scan all Game rows. The only backup was `npm run db:backup`, a CLI
 * script the panel never mentions and which cannot run against production from
 * a serverless host — so in practice a live league had no backup at all.
 *
 * This is deliberately an EXPORT, not a restore. Re-importing would have to
 * rebuild cuid graphs and foreign keys across a dozen tables, and a
 * half-working restore button is worse than an honest file: what an admin
 * actually needs at 1am is proof the data still exists somewhere. The file is
 * complete enough to rebuild from by hand or by script.
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

  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) {
    return NextResponse.json({ error: "Unknown season" }, { status: 404 });
  }

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
  ] = await Promise.all([
    prisma.registration.findMany({
      where: { seasonId },
      include: { user: { select: { id: true, steamId: true, name: true } } },
    }),
    prisma.team.findMany({ where: { seasonId } }),
    prisma.teamMember.findMany({
      where: { seasonId },
      include: { user: { select: { id: true, steamId: true, name: true } } },
    }),
    prisma.match.findMany({ where: { seasonId } }),
    // The box scores — by far the biggest and least reproducible part of a
    // season, since they can only be re-fetched while OpenDota still has them.
    prisma.game.findMany({ where: { match: { seasonId } } }),
    prisma.draft.findUnique({ where: { seasonId } }),
    prisma.bid.findMany({ where: { seasonId } }),
    prisma.matchAvailability.findMany({ where: { match: { seasonId } } }),
    prisma.standinAssignment.findMany({ where: { match: { seasonId } } }),
    prisma.prediction.findMany({ where: { match: { seasonId } } }),
    prisma.fantasyRoster.findMany({
      where: { seasonId },
      include: { picks: true },
    }),
    prisma.rescheduleRequest.findMany({ where: { match: { seasonId } } }),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    // Bump when the shape changes, so a future importer can tell.
    formatVersion: 1,
    season,
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
    counts: {
      registrations: registrations.length,
      teams: teams.length,
      matches: matches.length,
      games: games.length,
    },
  };

  const safeName = season.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="ld2l-${safeName}-${seasonId}.json"`,
      "cache-control": "no-store",
    },
  });
}
