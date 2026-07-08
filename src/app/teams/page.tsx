import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { cn } from "@/lib/utils";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  EmptyState,
  PageTitle,
  PlayerLink,
  RankBadge,
  TeamCrest,
} from "@/components/ui";

export const metadata = { title: "Teams" };

export default async function TeamsPage() {
  const season = await getActiveSeason();
  if (!season) {
    return (
      <div>
        <PageTitle title="Teams" />
        <EmptyState title="No active season" />
      </div>
    );
  }

  const [teams, matches] = await Promise.all([
    prisma.team.findMany({
      where: { seasonId: season.id },
      orderBy: { draftOrder: "asc" },
      include: {
        captain: true,
        members: { include: { user: true }, orderBy: { price: "desc" } },
      },
    }),
    prisma.match.findMany({ where: { seasonId: season.id } }),
  ]);

  if (teams.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle title="Teams" subtitle={season.name} />
        <EmptyState
          title="No teams yet"
          description={
            season.status === "SIGNUPS"
              ? "Teams are formed once signups close and the draft runs."
              : "Teams will appear here once the draft begins."
          }
        />
      </div>
    );
  }

  const standings = computeStandings(
    teams.map((t) => t.id),
    matches,
  );
  const rankOf = new Map(standings.map((s, i) => [s.teamId, i + 1]));
  const rowOf = new Map(standings.map((s) => [s.teamId, s]));
  const played = matches.some((m) => m.status === "COMPLETED" && m.phase === "REGULAR");
  const isDraft = season.status === "DRAFT";

  // After matches start, order by standings; before that, keep draft order.
  const ordered = played
    ? [...teams].sort(
        (a, b) => (rankOf.get(a.id) ?? 99) - (rankOf.get(b.id) ?? 99),
      )
    : teams;

  return (
    <div className="space-y-6">
      <PageTitle
        title="Teams"
        subtitle={`${season.name} · ${teams.length} teams`}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {ordered.map((t) => {
          const rank = rankOf.get(t.id) ?? 0;
          const row = rowOf.get(t.id);
          const isChampion = season.championTeamId === t.id;
          return (
            <Card
              key={t.id}
              className={cn(
                "transition-colors hover:border-muted/50",
                isChampion ? "ring-1 ring-accent/40" : undefined,
              )}
            >
              <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <TeamCrest name={t.name} seed={t.id} size={44} />
                  <div className="min-w-0">
                    <Link
                      href={`/teams/${t.id}`}
                      className="flex items-center gap-1.5 font-display text-lg font-semibold hover:text-info"
                    >
                      {played && rank > 0 ? (
                        <span className="text-muted">#{rank}</span>
                      ) : null}
                      <span className="truncate">{t.name}</span>
                      {isChampion ? <span title="Champion">🏆</span> : null}
                    </Link>
                    <p className="mt-0.5 truncate text-sm text-muted">
                      Captain:{" "}
                      <PlayerLink userId={t.captainId} className="text-muted">
                        {t.captain.name}
                      </PlayerLink>
                    </p>
                  </div>
                </div>
                <div className="shrink-0">
                  {isDraft ? (
                    <Badge tone="accent">${t.budget}</Badge>
                  ) : played && row ? (
                    <div className="text-right">
                      <div className="text-lg font-semibold tabular-nums">
                        {row.wins}–{row.losses}
                        {row.draws > 0 ? `–${row.draws}` : ""}
                      </div>
                      <div className="text-xs text-muted">{row.points} pts</div>
                    </div>
                  ) : (
                    <Badge>
                      {t.members.length}/{season.teamSize}
                    </Badge>
                  )}
                </div>
              </div>
              <CardBody className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {t.members.map((m) => (
                    <PlayerLink
                      key={m.id}
                      userId={m.userId}
                      className="flex items-center gap-1.5 rounded-full border border-line bg-surface-2/50 py-0.5 pl-0.5 pr-2.5 text-xs hover:border-muted/60 hover:no-underline"
                    >
                      <Avatar name={m.user.name} src={m.user.avatar} size={20} />
                      <span>{m.user.name}</span>
                      {m.isCaptain ? (
                        <Badge tone="accent" className="px-1.5 py-0">
                          C
                        </Badge>
                      ) : null}
                      <RankBadge rankTier={m.user.rankTier} />
                    </PlayerLink>
                  ))}
                  {Array.from({
                    length: Math.max(0, season.teamSize - t.members.length),
                  }).map((_, i) => (
                    <span
                      key={`empty-${i}`}
                      className="rounded-full border border-dashed border-line/70 px-3 py-1 text-xs text-muted/60"
                    >
                      empty
                    </span>
                  ))}
                </div>
                {played && row ? (
                  <div className="flex items-center gap-4 border-t border-line/60 pt-2 text-xs text-muted">
                    <span>Played {row.played}</span>
                    <span>
                      Games {row.gameWins}–{row.gameLosses}
                    </span>
                    <span>
                      Diff{" "}
                      {row.gameDiff > 0 ? `+${row.gameDiff}` : row.gameDiff}
                    </span>
                  </div>
                ) : null}
              </CardBody>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
