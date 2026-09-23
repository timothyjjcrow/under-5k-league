import { LEAGUE_CONFIG } from "@/lib/league-config";
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
  Avatar,
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
import {
  killParticipationByPlayer,
  leaderIdentity,
} from "@/lib/leader-ranking";

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
      `${LEAGUE_CONFIG.name} season leaders, weekly honors, career benchmarks, and player performance boards.`,
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
      `${LEAGUE_CONFIG.name} season leaders, weekly honors, career benchmarks, and player performance boards.`,
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

function SeasonSwitcher({
  seasons,
  selectedId,
}: {
  seasons: { id: string; name: string; isActive: boolean }[];
  selectedId: string;
}) {
  if (seasons.length < 2) return null;
  return (
    <nav
      aria-label="Choose a season for leaders"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface/55 px-4 py-3"
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-muted">
        Season
      </span>
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
        {seasons.map((option) => (
          <Link
            key={option.id}
            href={option.isActive ? "/leaders" : `/leaders?season=${option.id}`}
            aria-current={option.id === selectedId ? "page" : undefined}
            className={
              option.id === selectedId
                ? "inline-flex min-h-10 shrink-0 items-center rounded-lg border border-accent/50 bg-accent/10 px-3 text-xs font-semibold text-fg"
                : "inline-flex min-h-10 shrink-0 items-center rounded-lg border border-line px-3 text-xs text-muted transition-colors hover:border-info/50 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
            }
          >
            {option.name}
            {option.isActive ? " · Current" : ""}
          </Link>
        ))}
      </div>
    </nav>
  );
}

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
  const [gameRows, honorReadiness, seasonOptions] = await Promise.all([
    getSeasonGameLeaders(season.id),
    getSeasonHonorReadiness(season.id),
    prisma.season.findMany({
      select: { id: true, name: true, isActive: true },
      orderBy: { createdAt: "desc" },
    }),
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
  const noPerformanceWeeks = honorReadiness.filter(isNoPerformanceHonorWeek);

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
        <SeasonSwitcher seasons={seasonOptions} selectedId={season.id} />
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
    description: string;
    valueUnit: string;
    category: "winning" | "teamfights" | "economy";
    key: LeaderboardKey;
    minGames?: number;
    format: (r: LeaderRow) => string;
    rankValue?: (r: LeaderRow) => number;
    hint: (r: LeaderRow) => string;
  }[] = [
    {
      title: "Most wins",
      description: "Games won across this season.",
      valueUnit: "game wins",
      category: "winning",
      key: "wins",
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.wins}–${r.summary.losses}`,
    },
    {
      title: "Best KDA",
      description: "Kills plus assists for each death.",
      valueUnit: "KDA ratio",
      category: "teamfights",
      key: "kda",
      minGames: rateFloor,
      format: (r) => r.value.toFixed(1),
      hint: (r) =>
        `${r.summary.avgKills}/${r.summary.avgDeaths}/${r.summary.avgAssists}`,
    },
    {
      title: "Highest win rate",
      description: "Share of games won, with a game minimum.",
      valueUnit: "of games won",
      category: "winning",
      key: "winRate",
      minGames: rateFloor,
      format: (r) => `${r.value}%`,
      hint: (r) => `${r.summary.games} game${r.summary.games === 1 ? "" : "s"}`,
    },
    {
      title: "Most kills",
      description: "Total enemy heroes taken down.",
      valueUnit: "kills",
      category: "teamfights",
      key: "kills",
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.avgKills}/game`,
    },
    {
      title: "Most assists",
      description: "Total kills set up for teammates.",
      valueUnit: "assists",
      category: "teamfights",
      key: "assists",
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.avgAssists}/game`,
    },
    {
      title: "Most games",
      description: "Players who showed up most often.",
      valueUnit: "games played",
      category: "economy",
      key: "games",
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.wins}–${r.summary.losses}`,
    },
    {
      title: "Best avg GPM",
      description: "Gold earned per minute, averaged over reported games.",
      valueUnit: "gold / min",
      category: "economy",
      key: "gpm",
      minGames: rateFloor,
      format: (r) => `${r.value}`,
      hint: (r) =>
        `${r.summary.gpmGames} reported game${r.summary.gpmGames === 1 ? "" : "s"}`,
    },
    {
      title: "Richest (avg net worth)",
      description: "Final net worth averaged over reported games.",
      valueUnit: "avg net worth",
      category: "economy",
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

  const participationRows: LeaderBoardRow[] = [
    ...killParticipationByPlayer(games).entries(),
  ]
    .filter(([, stat]) => stat.scoredGames >= rateFloor)
    .sort(
      ([idA, a], [idB, b]) =>
        b.rate - a.rate ||
        b.scoredGames - a.scoredGames ||
        idA.localeCompare(idB),
    )
    .map(([id, stat]) => ({
      id,
      ...leaderIdentity(userMap.get(id)),
      value: stat.rate,
      rankValue: Math.round(stat.rate),
      valueLabel: `${Math.round(stat.rate)}%`,
      hint: `${stat.involved} of ${stat.teamKills} team kills · ${stat.scoredGames} scored game${stat.scoredGames === 1 ? "" : "s"}`,
      isViewer: viewer?.id === id,
      team: teamNameFor(id),
    }));

  // Healing is an optional provider field. Show a sustain board only when
  // enough reported games exist; missing values must never count as zeroes.
  const healingRows: LeaderBoardRow[] = [...rawByUser.entries()]
    .map(([id, lines]) => {
      const reported = lines.flatMap((line) =>
        line.heroHealing == null ? [] : [line.heroHealing],
      );
      const total = reported.reduce((sum, value) => sum + value, 0);
      return {
        id,
        games: reported.length,
        total,
        average: reported.length ? total / reported.length : 0,
      };
    })
    .filter((row) => row.games >= rateFloor && row.total > 0)
    .sort(
      (a, b) =>
        b.average - a.average ||
        b.games - a.games ||
        a.id.localeCompare(b.id),
    )
    .map((row) => ({
      id: row.id,
      ...leaderIdentity(userMap.get(row.id)),
      value: row.average,
      rankValue: Math.round(row.average),
      valueLabel: Math.round(row.average).toLocaleString("en-US"),
      hint: `${Math.round(row.total).toLocaleString("en-US")} total · ${row.games} reported game${row.games === 1 ? "" : "s"}`,
      isViewer: viewer?.id === row.id,
      team: teamNameFor(row.id),
    }));

  const boardRows = new Map(
    boards.map((board) => [
      board.key,
      topBy(entries, board.key, {
        minGames: board.minGames,
        limit: Number.POSITIVE_INFINITY,
      }).map((row): LeaderBoardRow => ({
        id: row.id,
        ...leaderIdentity(userMap.get(row.id)),
        value: row.value,
        rankValue: board.rankValue?.(row),
        valueLabel: board.format(row),
        hint: board.hint(row),
        isViewer: viewer?.id === row.id,
        team: teamNameFor(row.id),
      })),
    ]),
  );
  const hasHonors =
    honorsByWeek.length > 0 ||
    inProgressWeeks.length > 0 ||
    awaitingBoxScoreWeeks.length > 0;
  const spotlights = [
    {
      label: "Winningest player",
      measure: "Game wins",
      row: boardRows.get("wins")?.[0],
      href: "#metric-wins",
    },
    {
      label: "In every fight",
      measure: "Kill involvement",
      row: participationRows[0] ?? boardRows.get("assists")?.[0],
      href: participationRows.length ? "#metric-participation" : "#metric-assists",
    },
    {
      label: "Standout report card",
      measure: "World benchmark",
      row: reportRows[0],
      href: "#metric-report",
    },
  ].filter((item) => item.row != null);

  const categories = [
    {
      id: "winning",
      index: "01",
      title: "Winning",
      description: "Results first: total wins and sustained success across the schedule.",
    },
    {
      id: "teamfights",
      index: "02",
      title: "Teamfights",
      description: "Who finishes fights, creates chances, joins kills and sustains teammates.",
    },
    {
      id: "economy",
      index: "03",
      title: "Resources & presence",
      description: "Gold, net worth and the players who put in the most games.",
    },
  ] as const;

  return (
    <div className="space-y-6">
      <PageTitle
        title="Leaders"
        subtitle={`${season.name}${season.isActive ? "" : " · archived"}`}
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
      <SeasonSwitcher seasons={seasonOptions} selectedId={season.id} />
      <StatsDataNotice
        invalidLines={invalidLines}
        malformedGames={malformedGames}
        unusableGames={unusableGames}
        unmappedLines={unmappedLines}
      />
      <section aria-labelledby="leaders-intro" className="overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-surface-3 via-surface to-bg p-5 sm:p-7">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Season snapshot</p>
            <h2 id="leaders-intro" className="mt-2 font-display text-3xl font-semibold uppercase leading-tight tracking-wide text-fg sm:text-4xl">
              Who is setting the pace?
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
              Explore results, teamfight impact and economy from verified match box scores. Every board keeps a player’s actual season rank when you search.
            </p>
          </div>
          <details className="max-w-md text-sm text-muted">
            <summary className="min-h-11 cursor-pointer py-3 font-medium text-info hover:text-fg">How these boards work</summary>
            <p className="pb-2 text-xs leading-relaxed">
              Only complete 5v5 box scores count. Rate boards need {rateFloor} eligible game{rateFloor === 1 ? "" : "s"}; reported economy stats use that many reported games. Equal displayed values share a rank. Kill involvement is the share of a player’s team kills they scored or assisted, weighted by team kills across games.
            </p>
          </details>
        </div>
        {spotlights.length > 0 ? (
          <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
            {spotlights.map(({ label, measure, row, href }) =>
              row ? (
                <div key={label} className="rounded-xl border border-line/80 bg-bg/55 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{label}</p>
                  <div className="mt-3 flex items-center gap-3">
                    <Avatar name={row.name} src={row.avatar} size={36} />
                    <div className="min-w-0 flex-1">
                      {row.hasProfile === false ? (
                        <p className="truncate text-sm font-semibold text-fg">{row.name}</p>
                      ) : (
                        <PlayerLink userId={row.id} className="block truncate text-sm font-semibold">{row.name}</PlayerLink>
                      )}
                      <p className="truncate text-xs text-muted">{row.team ?? measure}</p>
                    </div>
                    <span className="font-display text-2xl font-semibold tabular-nums text-accent">{row.valueLabel}</span>
                  </div>
                  <a href={href} className="mt-3 inline-flex min-h-11 items-center text-xs font-medium text-info hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60">
                    View {measure.toLowerCase()} board →
                  </a>
                </div>
              ) : null,
            )}
          </div>
        ) : null}
      </section>
      <dl className="flex flex-wrap gap-x-8 gap-y-3 rounded-xl border border-line bg-surface/60 px-5 py-4">
        <div>
          <dt className="text-xs text-muted">Complete 5v5 games</dt>
          <dd className="mt-1 font-display text-xl font-semibold tabular-nums text-cyan-300">
            {games.filter((game) => game.lines.length > 0).length}
            <span className="ml-1 text-sm font-normal text-muted">/ {gameRows.length} imported</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Players with stats</dt>
          <dd className="mt-1 font-display text-xl font-semibold tabular-nums">{entries.length}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Rate minimum</dt>
          <dd className="mt-1 font-display text-xl font-semibold tabular-nums">
            {rateFloor}<span className="ml-1 text-sm font-normal text-muted">game{rateFloor === 1 ? "" : "s"}</span>
          </dd>
        </div>
      </dl>
      <SectionNav
        label="Leaderboard sections"
        items={[
          ...categories.map((category) => ({ id: category.id, label: category.title })),
          ...(reportRows.length ? [{ id: "report-card", label: "Report card" }] : []),
          ...(hasHonors ? [{ id: "weekly-honors", label: "Weekly honors" }] : []),
        ]}
      />
      {categories.map((category) => (
        <section key={category.id} id={category.id} aria-labelledby={`${category.id}-title`} className="scroll-mt-24 space-y-4">
          <div className="flex items-start gap-4 border-b border-line-soft pb-3">
            <span aria-hidden className="font-display text-3xl font-semibold text-accent/65">{category.index}</span>
            <div>
              <h2 id={`${category.id}-title`} className="font-display text-2xl font-semibold uppercase tracking-wide text-fg">{category.title}</h2>
              <p className="mt-1 text-sm text-muted">{category.description}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {boards.filter((board) => board.category === category.id).map((board) => (
              <LeaderBoard
                key={board.key}
                id={`metric-${board.key}`}
                title={board.title}
                subtitle={`${board.description}${board.minGames ? ` Min ${board.minGames} eligible game${board.minGames === 1 ? "" : "s"}.` : ""}`}
                rows={boardRows.get(board.key) ?? []}
                valueUnit={board.valueUnit}
                previewCount={3}
                scaleMax={board.key === "winRate" ? 100 : undefined}
              />
            ))}
            {category.id === "teamfights" && participationRows.length > 0 ? (
              <LeaderBoard
                id="metric-participation"
                title="Kill involvement"
                subtitle={`The share of team kills each player scored or assisted. Min ${rateFloor} scored game${rateFloor === 1 ? "" : "s"}.`}
                rows={participationRows}
                valueUnit="of team kills"
                previewCount={3}
                scaleMax={100}
              />
            ) : null}
            {category.id === "teamfights" && healingRows.length > 0 ? (
              <LeaderBoard
                id="metric-healing"
                title="Team sustain"
                subtitle={`Hero healing per reported game. Min ${rateFloor} reported game${rateFloor === 1 ? "" : "s"}; unavailable box scores are excluded.`}
                rows={healingRows}
                valueUnit="healing / game"
                previewCount={3}
              />
            ) : null}
          </div>
        </section>
      ))}
      {reportRows.length > 0 ? (
        <section id="report-card" aria-labelledby="report-card-title" className="scroll-mt-24 space-y-4">
          <div className="border-b border-line-soft pb-3">
            <h2 id="report-card-title" className="font-display text-2xl font-semibold uppercase tracking-wide">League report card</h2>
            <p className="mt-1 text-sm text-muted">A broader view of each performance, graded against worldwide Dota benchmarks when those measurements are available.</p>
          </div>
          <div className="max-w-3xl">
            <LeaderBoard
              id="metric-report"
              title="Best report card"
              subtitle={`Average benchmark percentile · min ${rateFloor} graded game${rateFloor === 1 ? "" : "s"}.`}
              rows={reportRows}
              valueUnit="percentile"
              previewCount={3}
              scaleMax={1}
            />
          </div>
        </section>
      ) : null}

      {hasHonors ? (
        <Card id="weekly-honors" className="scroll-mt-24">
          <CardHeader
            headingLevel={2}
            title="Weekly honors"
            subtitle="Regular-season awards"
            action={
              <details className="max-w-sm text-sm">
                <summary className="flex min-h-11 cursor-pointer items-center text-muted hover:text-fg">
                  How honors unlock
                </summary>
                <p className="pb-2 text-xs leading-relaxed text-muted">
                  Official after every regular match is final and every played
                  series has a complete attributed 5v5 box score.
                </p>
              </details>
            }
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
    </div>
  );
}
