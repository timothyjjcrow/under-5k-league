import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HeroIcon } from "@/components/hero-icon";
import { LocalTime } from "@/components/local-time";
import { UpsetChip } from "@/components/home/week-highlights";
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LinkArrow,
  PageTitle,
  PlayerLink,
  TeamCrest,
  textLink,
} from "@/components/ui";
import { getPublicSeasonHonorReadiness } from "@/lib/cached-queries";
import { MATCH_PHASE, MATCH_STATUS } from "@/lib/constants";
import { heroById } from "@/lib/heroes";
import { weeklyHonors } from "@/lib/honors";
import { HONOR_WEEK_STATE } from "@/lib/honors-readiness";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { weekOracles } from "@/lib/pickem";
import { prisma } from "@/lib/prisma";
import { MATCH_LIST_ORDER } from "@/lib/schedule";
import { shareMetadata } from "@/lib/share-metadata";
import { seriesUpset, upsetContext } from "@/lib/upsets";
import { cn } from "@/lib/utils";
import {
  bestGameOfWeek,
  weekProgress,
  weekWrapPath,
  weekWrapTable,
} from "@/lib/week-wrap";

/** A regular week's number from the URL; null for anything else. */
function parseWeek(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw)) return null;
  const week = Number(raw);
  return week >= 1 ? week : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; week: string }>;
}): Promise<Metadata> {
  const { id, week: raw } = await params;
  const week = parseWeek(raw);
  const season = week
    ? await prisma.season.findUnique({ where: { id }, select: { name: true } })
    : null;
  if (!season || !week) return {};
  return shareMetadata(
    `Week ${week} wrap · ${season.name}`,
    `Results, honors and the table after week ${week} of ${season.name}.`,
    weekWrapPath(id, week),
  );
}

/**
 * The week wrap: one regular week's story from stored results. Its results
 * (upsets tagged by the same rule as Home), the week's honors (or why they
 * are held), the best single game, the pick'em oracle, how the table moved,
 * and who plays next. The honors post links here; it was a link to the
 * leaderboards, which tell no week's story. Tim's call, 2026-10-05.
 */
export default async function WeekWrapPage({
  params,
}: {
  params: Promise<{ id: string; week: string }>;
}) {
  const { id, week: raw } = await params;
  const week = parseWeek(raw);
  if (!week) notFound();
  const season = await prisma.season.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      teams: {
        select: {
          id: true,
          name: true,
          logoUrl: true,
          members: { select: { userId: true } },
        },
      },
      matches: {
        orderBy: MATCH_LIST_ORDER,
        select: {
          id: true,
          week: true,
          phase: true,
          status: true,
          homeTeamId: true,
          awayTeamId: true,
          homeScore: true,
          awayScore: true,
          winnerTeamId: true,
          forfeit: true,
          scheduledAt: true,
          bracketSlot: true,
          bestOf: true,
        },
      },
    },
  });
  if (!season) notFound();
  const regular = season.matches.filter((m) => m.phase === MATCH_PHASE.REGULAR);
  const slate = regular.filter((m) => m.week === week);
  if (slate.length === 0) notFound();

  const progress = weekProgress(season.matches, week);
  const teamIds = season.teams.map((t) => t.id);
  const team = new Map(season.teams.map((t) => [t.id, t]));
  const teamOf = new Map(
    season.teams.flatMap((t) => t.members.map((m) => [m.userId, t.id] as const)),
  );
  const weeks = [...new Set(regular.map((m) => m.week))].sort((a, b) => a - b);
  const prevWeek = weeks.filter((w) => w < week).pop() ?? null;
  const nextWeek = weeks.find((w) => w > week) ?? null;
  const upsets = upsetContext(teamIds, season.matches);

  const [readinessRows, predictions] = await Promise.all([
    getPublicSeasonHonorReadiness(season.id),
    progress.done
      ? prisma.prediction.findMany({
          where: { matchId: { in: slate.map((m) => m.id) } },
          select: { matchId: true, userId: true, pickedTeamId: true },
        })
      : Promise.resolve([]),
  ]);
  const readiness = readinessRows.find((row) => row.week === week) ?? null;
  const ready = readiness?.state === HONOR_WEEK_STATE.READY;
  const honors = ready && readiness ? weeklyHonors(readiness.games, teamOf) : null;
  const best = ready && readiness ? bestGameOfWeek(readiness.games) : null;
  const oracles = progress.done ? weekOracles(predictions, slate) : [];
  const nameIds = [
    honors?.player?.userId,
    best?.userId,
    ...oracles.map((row) => row.userId),
  ].filter((value): value is string => !!value);
  const names = new Map(
    (nameIds.length
      ? await prisma.user.findMany({
          where: { id: { in: nameIds } },
          select: { id: true, name: true },
        })
      : []
    ).map((user) => [user.id, user.name]),
  );
  const table = weekWrapTable(teamIds, season.matches, week);
  const upNext = nextWeek ? regular.filter((m) => m.week === nextWeek) : [];

  const teamLine = (teamId: string) => {
    const t = team.get(teamId);
    return (
      <span className="flex min-w-0 items-center gap-2">
        <TeamCrest name={t?.name ?? "?"} seed={teamId} logoUrl={t?.logoUrl} size={22} />
        <span className="min-w-0 truncate">{t?.name ?? "?"}</span>
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <PageTitle
        title={`Week ${week} wrap`}
        subtitle={
          progress.done
            ? `${season.name} · every series is final`
            : `${season.name} · ${progress.final} of ${progress.total} series final so far`
        }
      />
      <nav aria-label="Weeks" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {prevWeek ? (
          <Link href={weekWrapPath(season.id, prevWeek)} className={textLink()}>
            ← Week {prevWeek}
          </Link>
        ) : null}
        {nextWeek ? (
          <Link href={weekWrapPath(season.id, nextWeek)} className={textLink()}>
            Week {nextWeek} →
          </Link>
        ) : null}
        <Link href={`/seasons/${encodeURIComponent(season.id)}`} className={textLink()}>
          Season page
        </Link>
        <Link
          href={`/leaders?season=${encodeURIComponent(season.id)}`}
          className={textLink()}
        >
          Leaderboards
        </Link>
      </nav>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <Card className="min-w-0">
          <CardHeader headingLevel={2} title="Results" />
          <CardBody className="p-0">
            <ul className="divide-y divide-line-soft">
              {slate.map((m) => {
                const upset = seriesUpset(m, upsets);
                const final = m.status === MATCH_STATUS.COMPLETED;
                return (
                  <li key={m.id}>
                    <Link
                      href={`/matches/${m.id}`}
                      prefetch={false}
                      className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-3 px-4 py-2.5 text-sm hover:bg-surface-2/50"
                    >
                      <span className={cn("min-w-0 justify-self-end", m.winnerTeamId === m.homeTeamId && "font-semibold")}>
                        {team.get(m.homeTeamId)?.name ?? "?"}
                      </span>
                      <span className="flex flex-col items-center tabular-nums">
                        {final ? `${m.homeScore}–${m.awayScore}` : "vs"}
                        <span className="text-[11px] text-muted">
                          {upset ? <UpsetChip upset={upset} /> : final ? (m.forfeit ? "ruling" : "final") : "to play"}
                        </span>
                      </span>
                      <span className={cn("min-w-0", m.winnerTeamId === m.awayTeamId && "font-semibold")}>
                        {team.get(m.awayTeamId)?.name ?? "?"}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>

        <Card className="min-w-0">
          <CardHeader headingLevel={2} title="Honors" />
          <CardBody className="space-y-3 text-sm">
            {honors && (honors.player || honors.team) ? (
              <>
                {honors.player ? (
                  <p>
                    <span aria-hidden>⭐ </span>
                    <span className="text-muted">Player of the Week: </span>
                    <PlayerLink userId={honors.player.userId} className="font-medium">
                      {names.get(honors.player.userId) ?? "Former player"}
                    </PlayerLink>
                    <span className="text-muted">
                      {" "}
                      · {honors.player.points} impact points
                      {honors.player.heroId != null
                        ? ` (best game on ${heroById(honors.player.heroId)?.name ?? `hero #${honors.player.heroId}`})`
                        : ""}
                    </span>
                  </p>
                ) : null}
                {honors.team ? (
                  <p>
                    <span aria-hidden>🛡️ </span>
                    <span className="text-muted">Team of the Week: </span>
                    <Link href={`/teams/${honors.team.teamId}`} className={textLink("font-medium")}>
                      {team.get(honors.team.teamId)?.name ?? "?"}
                    </Link>
                    <span className="text-muted">
                      {" "}
                      · {honors.team.gameWins} game win{honors.team.gameWins === 1 ? "" : "s"}
                    </span>
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-muted">
                {!progress.done
                  ? "Honors come once every series this week is final."
                  : ready
                    ? "No games were played this week, so no performance honors."
                    : "Honors are waiting for complete, valid 5v5 box scores from every played series."}
              </p>
            )}
            {oracles.length > 0 ? (
              <p>
                <span aria-hidden>🔮 </span>
                <span className="text-muted">
                  Pick&apos;em oracle{oracles.length === 1 ? "" : "s"}:{" "}
                </span>
                {oracles.map((row, index) => (
                  <span key={row.userId}>
                    {index > 0 ? ", " : ""}
                    <PlayerLink userId={row.userId} className="font-medium">
                      {names.get(row.userId) ?? "Former player"}
                    </PlayerLink>
                  </span>
                ))}
                <span className="text-muted">
                  {" "}
                  · {oracles[0].correct} of {oracles[0].graded} right
                </span>
              </p>
            ) : null}
            {best ? (
              <div className="rounded-lg border border-line bg-surface-2/40 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Best single game
                </p>
                <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {best.heroId != null && heroById(best.heroId) ? (
                    <HeroIcon hero={heroById(best.heroId)!} size={26} />
                  ) : null}
                  <PlayerLink userId={best.userId} className="font-medium">
                    {names.get(best.userId) ?? "Former player"}
                  </PlayerLink>
                  <span className="text-muted">
                    {best.heroId != null ? `${heroById(best.heroId)?.name ?? "?"} · ` : ""}
                    {best.kills}/{best.deaths}/{best.assists} · {best.impact} impact
                    {best.won ? " · win" : " · in a loss"}
                  </span>
                </p>
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader
            headingLevel={2}
            title={`The table after week ${week}`}
            subtitle={
              table.some((row) => row.movement !== null)
                ? "Arrows show places moved this week."
                : undefined
            }
          />
          <CardBody className="p-0">
            <ol className="divide-y divide-line-soft">
              {table.map((row) => (
                <li
                  key={row.teamId}
                  className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto_auto] items-center gap-x-3 px-4 py-2 text-sm"
                >
                  <span className="tabular-nums text-muted">{row.rank}</span>
                  <Link href={`/teams/${row.teamId}`} className="min-w-0 hover:text-info">
                    {teamLine(row.teamId)}
                  </Link>
                  <span className="tabular-nums text-muted">
                    {row.wins}-{row.draws}-{row.losses} · {row.points} pts
                  </span>
                  <span
                    className={cn(
                      "w-8 text-right text-xs tabular-nums",
                      row.movement && row.movement > 0
                        ? "text-success"
                        : row.movement && row.movement < 0
                          ? "text-danger-soft"
                          : "text-muted",
                    )}
                  >
                    {row.movement == null ? "" : row.movement > 0 ? (
                      <span role="img" aria-label={`up ${row.movement}`}>▲{row.movement}</span>
                    ) : row.movement < 0 ? (
                      <span role="img" aria-label={`down ${-row.movement}`}>▼{-row.movement}</span>
                    ) : (
                      <span role="img" aria-label="no change">–</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>

        <Card className="min-w-0">
          <CardHeader
            headingLevel={2}
            title={nextWeek ? `Up next: week ${nextWeek}` : "Up next"}
          />
          <CardBody className={upNext.length ? "p-0" : undefined}>
            {upNext.length ? (
              <ul className="divide-y divide-line-soft">
                {upNext.map((m) => (
                  <li key={m.id}>
                    <Link
                      href={`/matches/${m.id}`}
                      prefetch={false}
                      className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 text-sm hover:bg-surface-2/50"
                    >
                      <span className="min-w-0">
                        {team.get(m.homeTeamId)?.name ?? "?"}{" "}
                        <span className="text-muted">vs</span>{" "}
                        {team.get(m.awayTeamId)?.name ?? "?"}
                      </span>
                      <span className="text-xs text-muted">
                        {m.scheduledAt ? (
                          <LocalTime
                            ts={m.scheduledAt.getTime()}
                            variant="short"
                            initial={formatLeagueMatchTime(m.scheduledAt, "short")}
                          />
                        ) : (
                          "time to be set"
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="That was the last regular week"
                description="The table above is the final regular-season table once every series is in."
              />
            )}
          </CardBody>
          {upNext.length ? (
            <CardBody className="border-t border-line-soft pt-3">
              <Link href="/schedule" className={textLink("text-sm")}>
                Full schedule <LinkArrow />
              </Link>
            </CardBody>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
