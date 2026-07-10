import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { draftRecap } from "@/lib/draft-recap";
import { powerRankings } from "@/lib/power-rankings";
import { cn } from "@/lib/utils";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
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

  // Draft-night superlatives (biggest spend, best steal, …) — MMR from signups.
  const memberIds = teams.flatMap((t) => t.members.map((m) => m.userId));
  const regs = memberIds.length
    ? await prisma.registration.findMany({
        where: { seasonId: season.id, userId: { in: memberIds } },
        select: { userId: true, mmr: true },
      })
    : [];
  const mmrByUser = new Map(regs.map((r) => [r.userId, r.mmr]));
  const recap = draftRecap(
    teams.flatMap((t) =>
      t.members.map((m) => ({
        name: m.user.name,
        teamName: t.name,
        price: m.price,
        isCaptain: m.isCaptain,
        mmr: mmrByUser.get(m.userId) ?? null,
      })),
    ),
  );

  // After matches start, order by standings; before that, keep draft order.
  const ordered = played
    ? [...teams].sort(
        (a, b) => (rankOf.get(a.id) ?? 99) - (rankOf.get(b.id) ?? 99),
      )
    : teams;

  // Elo power rankings — only regular-season series feed the rating.
  const power = powerRankings(
    matches.filter((m) => m.phase === "REGULAR"),
    teams.map((t) => t.id),
  );
  const powerName = new Map(teams.map((t) => [t.id, t.name]));

  return (
    <div className="space-y-6">
      <PageTitle
        title="Teams"
        subtitle={`${season.name} · ${teams.length} teams`}
      />

      {power.length > 0 ? (
        <Card>
          <CardHeader
            title="Power rankings"
            subtitle="Elo per game — beating strong teams counts extra · movement vs. last week"
          />
          <CardBody className="divide-y divide-line/60 p-0">
            {power.map((row) => {
              const moved = row.prevRank > 0 ? row.prevRank - row.rank : 0;
              return (
                <div
                  key={row.teamId}
                  className="flex items-center gap-3 px-5 py-2.5 text-sm"
                >
                  <span className="w-6 text-center font-mono text-muted">
                    {row.rank}
                  </span>
                  <span
                    className={cn(
                      "w-9 shrink-0 text-center font-mono text-xs tabular-nums",
                      moved > 0 && "text-success",
                      moved < 0 && "text-danger",
                      moved === 0 && "text-muted",
                    )}
                    title={
                      moved !== 0
                        ? `Was #${row.prevRank} last week`
                        : "No movement"
                    }
                  >
                    {moved > 0 ? `▲${moved}` : moved < 0 ? `▼${-moved}` : "–"}
                  </span>
                  <TeamCrest
                    name={powerName.get(row.teamId) ?? "?"}
                    seed={row.teamId}
                    size={24}
                    className="shrink-0 rounded-md"
                  />
                  <Link
                    href={`/teams/${row.teamId}`}
                    className="min-w-0 flex-1 truncate font-medium hover:text-info"
                  >
                    {powerName.get(row.teamId) ?? "?"}
                  </Link>
                  <span
                    className={cn(
                      "font-mono text-xs tabular-nums",
                      row.delta > 0
                        ? "text-success"
                        : row.delta < 0
                          ? "text-danger"
                          : "text-muted",
                    )}
                  >
                    {row.delta > 0 ? `+${row.delta}` : row.delta}
                  </span>
                  <span className="shrink-0 font-mono text-base font-semibold tabular-nums">
                    {row.rating}
                  </span>
                </div>
              );
            })}
          </CardBody>
        </Card>
      ) : null}

      {recap.totalSpent > 0 ? (
        <Card>
          <CardHeader
            title={isDraft ? "Draft night — so far" : "Draft night"}
            subtitle={`$${recap.totalSpent} changed hands at the auction`}
          />
          <CardBody className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {recap.biggestSpend ? (
              <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-muted">
                  💸 Biggest spend
                </div>
                <div className="mt-1 font-medium">
                  {recap.biggestSpend.name} · ${recap.biggestSpend.price}
                </div>
                <div className="text-xs text-muted">
                  {recap.biggestSpend.teamName}
                </div>
              </div>
            ) : null}
            {recap.bestValue ? (
              <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-muted">
                  🕵️ Best steal
                </div>
                <div className="mt-1 font-medium">
                  {recap.bestValue.name} · ${recap.bestValue.price}
                </div>
                <div className="text-xs text-muted">
                  {recap.bestValue.mmr} MMR for {recap.bestValue.teamName}
                </div>
              </div>
            ) : null}
            {recap.topSpender ? (
              <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-muted">
                  🐳 Top spender
                </div>
                <div className="mt-1 font-medium">{recap.topSpender.teamName}</div>
                <div className="text-xs text-muted">
                  ${recap.topSpender.spent} total
                </div>
              </div>
            ) : null}
            {recap.bargainHunter &&
            recap.bargainHunter.teamName !== recap.topSpender?.teamName ? (
              <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-muted">
                  🧾 Bargain hunter
                </div>
                <div className="mt-1 font-medium">
                  {recap.bargainHunter.teamName}
                </div>
                <div className="text-xs text-muted">
                  ${recap.bargainHunter.spent} total
                </div>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {ordered.map((t) => {
          const rank = rankOf.get(t.id) ?? 0;
          const row = rowOf.get(t.id);
          const isChampion = season.championTeamId === t.id;
          return (
            <Card
              key={t.id}
              interactive
              className={cn(isChampion ? "ring-1 ring-accent/40" : undefined)}
            >
              <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <TeamCrest name={t.name} seed={t.id} size={44} />
                  <div className="min-w-0">
                    <Link
                      href={`/teams/${t.id}`}
                      className="flex min-w-0 items-center gap-1.5 font-display text-lg font-semibold hover:text-info"
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
