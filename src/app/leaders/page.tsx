import { SectionNav } from "@/components/section-nav";
import Link from "next/link";
import type { Metadata } from "next";
import { heroById } from "@/lib/heroes";
import { notFound } from "next/navigation";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSeasonGameLeaders } from "@/lib/cached-queries";
import { LeaderBoard, type LeaderBoardRow } from "@/components/leader-board";
import {
  summarizePlayerGames,
  topBy,
  type LeaderboardKey,
  type LeaderEntry,
  type LeaderRow,
  type PlayerGameLine,
  decodeGamePlayers,
  trustedGamePlayers,
} from "@/lib/player-stats";
import type { PlayerStat } from "@/lib/match-import";
import { careerReportCard, percentLabel } from "@/lib/benchmarks";
import { weeklyHonors } from "@/lib/honors";
import {
  HONOR_WEEK_STATE,
  isNoPerformanceHonorWeek,
} from "@/lib/honors-readiness";
import { getSeasonHonorReadiness } from "@/lib/honors-readiness-service";
import { formatNetWorth } from "@/lib/utils";
import {
  buttonClasses,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  PlayerLink,
} from "@/components/ui";
import { StatsDataNotice, StatsNav } from "@/components/stats-nav";
import { shareMetadata } from "@/lib/share-metadata";
import { singleSearchParam } from "@/lib/search-params";
import { leaderIdentity } from "@/lib/leader-ranking";

type LeadersSearchParams = { season?: string | string[] };

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<LeadersSearchParams>;
}): Promise<Metadata> {
  const seasonId = singleSearchParam((await searchParams).season);
  if (seasonId === null) notFound();
  if (!seasonId) {
    return shareMetadata(
      "Leaders",
      "GGD2L season leaders, weekly honors, career benchmarks, and player performance boards.",
      "/leaders",
    );
  }
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { name: true, isActive: true },
  });
  if (!season) notFound();
  if (season.isActive) {
    return shareMetadata(
      "Leaders",
      "GGD2L season leaders, weekly honors, career benchmarks, and player performance boards.",
      "/leaders",
    );
  }
  const path = `/leaders?${new URLSearchParams({ season: seasonId })}`;
  return shareMetadata(
    `${season.name} leaders`,
    `Weekly honors and player performance leaders from ${season.name}.`,
    path,
  );
}

type DisplayUser = {
  name: string;
  avatar: string | null;
  rankTier: number | null;
};

export default async function LeadersPage({
  searchParams,
}: {
  searchParams: Promise<LeadersSearchParams>;
}) {
  const seasonParam = singleSearchParam((await searchParams).season);
  if (seasonParam === null) notFound();
  // ?season=<id> shows an archived season's boards (recap's pattern) —
  // otherwise leaderboards vanish forever the moment a season is archived.
  const [season, viewer] = await Promise.all([
    seasonParam
      ? prisma.season.findUnique({ where: { id: seasonParam } })
      : getActiveSeason(),
    getSessionUser(),
  ]);
  if (seasonParam && !season) notFound();
  if (!season) {
    const archived = await prisma.season.findMany({
      where: { isActive: false },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    });
    return (
      <div>
        <PageTitle title="Leaders" />
        <StatsNav active="leaders" />
        <EmptyState
          title="No active season"
          description={
            archived.length > 0
              ? "Browse a past season's boards instead."
              : undefined
          }
          action={
            archived.length > 0 ? (
              <div className="flex flex-wrap justify-center gap-2">
                {archived.map((s) => (
                  <Link
                    key={s.id}
                    href={`/leaders?season=${s.id}`}
                    className={buttonClasses("secondary", "sm")}
                  >
                    {s.name} →
                  </Link>
                ))}
              </div>
            ) : undefined
          }
        />
      </div>
    );
  }
  // Keep archived-season navigation on that season across the stat pages.
  const seasonQS =
    seasonParam && !season.isActive ? `?season=${season.id}` : "";

  // Parse each game's players JSON once and reuse the lines for both the
  // boards and the weekly-honors card (the dashboard's League pulse does the
  // same) — honorsByWeek used to re-parse the week's games per week.
  const [gameRows, honorReadiness] = await Promise.all([
    getSeasonGameLeaders(season.id),
    getSeasonHonorReadiness(season.id),
  ]);
  const decodedRows = gameRows.map((game) => ({
    game,
    decoded: decodeGamePlayers(game.players),
  }));
  const invalidLines = decodedRows.reduce(
    (total, row) => total + row.decoded.invalidLines,
    0,
  );
  const malformedGames = decodedRows.filter(
    (row) => row.decoded.malformed,
  ).length;
  const unusableGames = decodedRows.filter(
    (row) => !row.decoded.malformed && !row.decoded.completeRoster,
  ).length;
  const unmappedLines = decodedRows.reduce(
    (total, row) =>
      total + row.decoded.players.filter((player) => !player.userId).length,
    0,
  );
  const games = decodedRows.map(({ game, decoded }) => ({
    ...game,
    lines: trustedGamePlayers(decoded),
  }));
  const inProgressWeeks = honorReadiness.filter(
    (row) => row.state === HONOR_WEEK_STATE.IN_PROGRESS,
  );
  const awaitingBoxScoreWeeks = honorReadiness.filter(
    (row) => row.state === HONOR_WEEK_STATE.AWAITING_BOX_SCORES,
  );
  const noPerformanceWeeks = honorReadiness.filter(
    isNoPerformanceHonorWeek,
  );

  // Accumulate each mapped player's per-game lines across the whole season —
  // and the raw stored lines too, which carry the benchmark percentiles the
  // report-card board grades on.
  const linesByUser = new Map<string, PlayerGameLine[]>();
  const rawByUser = new Map<string, PlayerStat[]>();
  for (const g of games) {
    for (const p of g.lines) {
      if (!p.userId) continue;
      const arr = linesByUser.get(p.userId) ?? [];
      arr.push({
        isRadiant: p.isRadiant,
        radiantWin: g.radiantWin,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        heroId: p.heroId,
        netWorth: p.netWorth,
        gpm: p.gpm,
      });
      linesByUser.set(p.userId, arr);
      const raw = rawByUser.get(p.userId) ?? [];
      raw.push(p);
      rawByUser.set(p.userId, raw);
    }
  }

  const entries: LeaderEntry[] = [...linesByUser.entries()].map(
    ([id, lines]) => ({ id, summary: summarizePlayerGames(lines) }),
  );

  if (entries.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle
          title="Leaders"
          subtitle={season.isActive ? season.name : `${season.name} · archived`}
          action={
            !season.isActive ? (
              <Link
                href={`/seasons/${season.id}`}
                className={buttonClasses("secondary", "sm")}
              >
                Season archive →
              </Link>
            ) : undefined
          }
        />
        <StatsNav
          active="leaders"
          seasonId={season.isActive ? undefined : season.id}
        />
        <StatsDataNotice
          invalidLines={invalidLines}
          malformedGames={malformedGames}
          unusableGames={unusableGames}
          unmappedLines={unmappedLines}
        />
        <EmptyState
          title={
            games.length > 0 ? "No attributed player stats" : "No stats yet"
          }
          description={
            awaitingBoxScoreWeeks.length > 0
              ? `Week ${awaitingBoxScoreWeeks[0].week} is final, but weekly honors and public stats are waiting for complete, valid 5v5 box scores.`
              : noPerformanceWeeks.length > 0
                ? `Week ${noPerformanceWeeks[0].week} is final with no played games, so there are no performance honors or player statistics for that week.`
              : games.length > 0
                ? "Games are imported, but no complete player box score is mapped to league accounts. An administrator should inspect the match, remove the bad import, verify Steam links, and import it again."
                : "Leaderboards fill in once match games are imported."
          }
        />
      </div>
    );
  }

  const users = await prisma.user.findMany({
    where: { id: { in: entries.map((e) => e.id) } },
    select: { id: true, name: true, avatar: true, rankTier: true },
  });
  const userMap = new Map<string, DisplayUser>(
    users.map((u) => [
      u.id,
      { name: u.name, avatar: u.avatar, rankTier: u.rankTier },
    ]),
  );

  // Season rosters + team names: shared by the Weekly honors card and the
  // team suffix on every board row below.
  const [members, teams] = await Promise.all([
    prisma.teamMember.findMany({
      where: { seasonId: season.id },
      select: { userId: true, teamId: true },
    }),
    prisma.team.findMany({
      where: { seasonId: season.id },
      select: { id: true, name: true },
    }),
  ]);
  const teamOf = new Map(members.map((m) => [m.userId, m.teamId]));
  const teamNameOf = new Map(teams.map((t) => [t.id, t.name]));
  // null for unrostered players (free agents/standins) — the row suffix
  // simply doesn't render.
  const teamNameFor = (userId: string) =>
    teamNameOf.get(teamOf.get(userId) ?? "") ?? null;
  const honorsByWeek = honorReadiness
    .filter((row) => row.state === HONOR_WEEK_STATE.READY)
    .map((row) => ({
      week: row.week,
      honors: weeklyHonors(row.games, teamOf),
    }));

  // Early in a season everyone has few games; don't let the rate floor empty
  // the board. Cap the floor at the most-played count.
  const maxGames = Math.max(1, ...entries.map((e) => e.summary.games));
  const rateFloor = Math.min(3, maxGames);

  const boards: {
    title: string;
    subtitle?: string;
    key: LeaderboardKey;
    minGames?: number;
    format: (r: LeaderRow) => string;
    rankValue?: (r: LeaderRow) => number;
    hint: (r: LeaderRow) => string;
  }[] = [
    {
      title: "Most wins",
      key: "wins",
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.wins}–${r.summary.losses}`,
    },
    {
      title: "Best KDA",
      subtitle: `min ${rateFloor} game${rateFloor > 1 ? "s" : ""}`,
      key: "kda",
      minGames: rateFloor,
      format: (r) => r.value.toFixed(1),
      hint: (r) =>
        `${r.summary.avgKills}/${r.summary.avgDeaths}/${r.summary.avgAssists}`,
    },
    {
      title: "Highest win rate",
      subtitle: `min ${rateFloor} game${rateFloor > 1 ? "s" : ""}`,
      key: "winRate",
      minGames: rateFloor,
      format: (r) => `${r.value}%`,
      hint: (r) => `${r.summary.games} game${r.summary.games === 1 ? "" : "s"}`,
    },
    {
      title: "Most kills",
      key: "kills",
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.avgKills}/game`,
    },
    {
      title: "Most assists",
      key: "assists",
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.avgAssists}/game`,
    },
    {
      title: "Most games",
      key: "games",
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.wins}–${r.summary.losses}`,
    },
    {
      title: "Best avg GPM",
      subtitle: `min ${rateFloor} game${rateFloor > 1 ? "s" : ""}`,
      key: "gpm",
      minGames: rateFloor,
      format: (r) => `${r.value}`,
      hint: (r) =>
        `${r.summary.gpmGames} reported game${r.summary.gpmGames === 1 ? "" : "s"}`,
    },
    {
      title: "Richest (avg net worth)",
      subtitle: `min ${rateFloor} game${rateFloor > 1 ? "s" : ""}`,
      key: "netWorth",
      minGames: rateFloor,
      format: (r) => formatNetWorth(r.value),
      rankValue: (r) => Math.round(r.value / 100),
      hint: (r) =>
        `${r.summary.netWorthGames} reported game${r.summary.netWorthGames === 1 ? "" : "s"}`,
    },
  ];

  // "Best report card": ranked by average benchmark percentile — the learn
  // league's own honor roll. Only graded lines count; the shared rate floor
  // keeps one lucky game off the top.
  const reportRows: LeaderBoardRow[] = [...rawByUser.entries()]
    .map(([id, lines]) => ({ id, report: careerReportCard(lines) }))
    .filter((r) => r.report.avgPct != null && r.report.graded >= rateFloor)
    .sort(
      (a, b) =>
        b.report.avgPct! - a.report.avgPct! ||
        b.report.graded - a.report.graded ||
        a.id.localeCompare(b.id),
    )
    .map(({ id, report }) => {
      const u = userMap.get(id);
      const identity = leaderIdentity(u);
      return {
        id,
        ...identity,
        value: report.avgPct!,
        rankValue: Math.round(report.avgPct! * 100),
        valueLabel: percentLabel(report.avgPct!).replace(" percentile", ""),
        hint: `${report.graded} graded game${report.graded === 1 ? "" : "s"}${report.best ? ` · best: ${report.best.label.toLowerCase()}` : ""}`,
        isViewer: viewer?.id === id,
        team: teamNameFor(id),
      };
    });

  return (
    <div className="space-y-6">
      <PageTitle
        title="Leaders"
        subtitle={`${season.name}${season.isActive ? "" : " · archived"} · from ${games.length} imported game${games.length === 1 ? "" : "s"}`}
        action={
          <div className="flex flex-wrap gap-2">
            {!season.isActive ? (
              <Link
                href={`/seasons/${season.id}`}
                className={buttonClasses("secondary", "sm")}
              >
                Season archive →
              </Link>
            ) : null}
            <Link
              href={`/recap${seasonQS}`}
              className={buttonClasses("secondary", "sm")}
            >
              Season recap →
            </Link>
          </div>
        }
      />
      <StatsNav
        active="leaders"
        seasonId={season.isActive ? undefined : season.id}
      />
      <StatsDataNotice
        invalidLines={invalidLines}
        malformedGames={malformedGames}
        unusableGames={unusableGames}
        unmappedLines={unmappedLines}
      />
      <p className="text-sm text-muted">{games.filter((game) => game.lines.length > 0).length} of {gameRows.length} imported games have trusted 5v5 scores. Individual boards use linked players and their displayed minimum sample.</p>
      <SectionNav label="Leaderboard metrics" items={[
        ...(reportRows.length ? [{ id: "metric-report", label: "Report card" }] : []),
        ...boards.map((board) => ({ id: `metric-${board.key}`, label: board.title })),
      ]} />
      {honorsByWeek.length > 0 ||
      inProgressWeeks.length > 0 ||
      awaitingBoxScoreWeeks.length > 0 ? (
        <Card>
          <CardHeader
            headingLevel={2}
            title="Weekly honors"
            subtitle="Official after every regular match is final and every played series has a complete attributed 5v5 box score"
          />
          <CardBody className="divide-y divide-line/60 p-0">
            {inProgressWeeks.length > 0 ? (
              <p className="px-5 py-3 text-sm text-muted">
                Week {inProgressWeeks[0].week} is still in progress. Its honors
                will appear after the full slate is final.
              </p>
            ) : null}
            {awaitingBoxScoreWeeks.length > 0 ? (
              <p className="px-5 py-3 text-sm text-muted">
                Week {awaitingBoxScoreWeeks[0].week} is final, but honors are
                waiting for complete, valid 5v5 box scores from every played
                series.
              </p>
            ) : null}
            {honorsByWeek.map(({ week, honors }) =>
              !honors.player && !honors.team ? (
                <p key={week} className="px-5 py-3 text-sm text-muted">
                  Week {week} is final with no played games, so no performance
                  honors were awarded.
                </p>
              ) : (
                <div
                  key={week}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm"
                >
                <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-muted">
                  Week {week}
                </span>
                {honors.player ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span aria-hidden>⭐</span>
                    {userMap.has(honors.player.userId) ? (
                      <PlayerLink
                        userId={honors.player.userId}
                        className="font-medium"
                      >
                        {userMap.get(honors.player.userId)!.name}
                      </PlayerLink>
                    ) : (
                      <span className="font-medium text-muted">
                        Former player
                      </span>
                    )}
                    <span className="text-xs text-muted">
                      {honors.player.points} pts
                      {honors.player.heroId != null
                        ? ` · ${heroById(honors.player.heroId)?.name ?? `Hero #${honors.player.heroId}`}`
                        : ""}
                    </span>
                  </span>
                ) : null}
                {honors.team ? (
                  <span className="mt-1.5 flex min-w-0 items-center gap-1.5">
                    <span aria-hidden>🛡️</span>
                    <Link
                      href={`/teams/${honors.team.teamId}`}
                      className="py-1 -my-1 font-medium hover:text-info"
                    >
                      {teamNameOf.get(honors.team.teamId) ?? "?"}
                    </Link>
                    <span className="text-xs text-muted">
                      {honors.team.gameWins} game win
                      {honors.team.gameWins === 1 ? "" : "s"}
                    </span>
                  </span>
                ) : null}
                </div>
              ),
            )}
          </CardBody>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {reportRows.length > 0 ? (
          <LeaderBoard
            id="metric-report"
            title="Best report card"
            subtitle={`avg percentile vs the world · min ${rateFloor} graded game${rateFloor > 1 ? "s" : ""}`}
            rows={reportRows}
            headingLevel={2}
          />
        ) : null}
        {boards.map((b) => {
          // Full ranked list per board — the client card shows top 5 and
          // expands on demand; labels are precomputed here (fns don't
          // serialize across the boundary).
          const rows: LeaderBoardRow[] = topBy(entries, b.key, {
            minGames: b.minGames,
            limit: Number.POSITIVE_INFINITY,
          }).map((r) => {
            const u = userMap.get(r.id);
            const identity = leaderIdentity(u);
            return {
              id: r.id,
              ...identity,
              value: r.value,
              rankValue: b.rankValue?.(r),
              valueLabel: b.format(r),
              hint: b.hint(r),
              isViewer: viewer?.id === r.id,
              team: teamNameFor(r.id),
            };
          });
          return (
            <LeaderBoard
              key={b.title}
              id={`metric-${b.key}`}
              title={b.title}
              subtitle={b.subtitle}
              rows={rows}
              headingLevel={2}
            />
          );
        })}
      </div>
    </div>
  );
}
