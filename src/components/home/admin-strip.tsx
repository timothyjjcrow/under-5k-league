import Link from "next/link";
import { Badge, LinkArrow } from "@/components/ui";
import { matchAttention } from "@/lib/admin-attention";
import { adminHomeLine } from "@/lib/admin-home-line";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { MATCH_STATUS } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { getSeasonMatches, type SeasonSnapshot } from "@/lib/queries";

/**
 * For admins only, one line under the hero: the admin panel's next step and
 * how many open matches its Needs attention card lists, linking the panel.
 * Home otherwise showed Tim exactly what a visitor sees on match night.
 * Database reads only (request-cached matches plus one query for the open
 * matches' check-ins, covers and reschedules), never a Discord call.
 */
export async function AdminStrip({ snapshot }: { snapshot: SeasonSnapshot }) {
  const { season } = snapshot;
  const [matches, open] = await Promise.all([
    getSeasonMatches(season.id),
    prisma.match.findMany({
      where: { seasonId: season.id, status: { not: MATCH_STATUS.COMPLETED } },
      select: {
        id: true,
        status: true,
        bestOf: true,
        homeTeamId: true,
        awayTeamId: true,
        scheduledAt: true,
        scheduleRevision: true,
        availability: {
          select: { userId: true, status: true, scheduleRevision: true },
        },
        standins: { select: { replacingUserId: true, standinUserId: true } },
        reschedules: { select: { status: true } },
      },
    }),
  ]);
  // A server component renders once per request; the line is a snapshot.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  // Check-ins count for the fixture's current time only, and cover is counted
  // against the current rosters, both as on the panel.
  const attention = matchAttention(
    open.map((match) => ({
      ...match,
      availability: match.availability.filter(
        (rsvp) => rsvp.scheduleRevision === match.scheduleRevision,
      ),
    })),
    snapshot.teams,
    nowMs,
  );
  const { step, attention: attentionLine } = adminHomeLine({
    seasonStatus: season.status,
    draftStatus: snapshot.draftStatus,
    playerCount: snapshot.playerCount,
    minPlayers: snapshot.capacity.minPlayers,
    teams: snapshot.teams,
    matches,
    hasChampion:
      resolveChampionPresentation(season, matches).championTeamId != null,
    attentionCount: attention.length,
    nowMs,
  });
  return (
    <Link
      href="/admin"
      className="group flex items-center justify-between gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm transition-colors hover:border-muted/60"
    >
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone="info">Admin</Badge>
        <span className="text-fg">{step}</span>
        {attentionLine ? (
          <span className="text-muted">
            <span aria-hidden>· </span>
            {attentionLine}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 font-medium text-accent group-hover:underline">
        Open admin <LinkArrow />
      </span>
    </Link>
  );
}
