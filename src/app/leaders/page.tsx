import { LEAGUE_CONFIG } from "@/lib/league-config";
import { SectionNav } from "@/components/section-nav";
import Link from "next/link";
import type { Metadata } from "next";
import { heroById } from "@/lib/heroes";
import { notFound } from "next/navigation";
import {
  loadSeasonChoices,
  resolveSeasonScope,
  seasonScopeMetadata,
} from "@/lib/season-scope";
import { NoSeasonYet, SeasonSwitcher } from "@/components/season-scope";
import { finishedSeasonLink } from "@/lib/season-choices";
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
import { impactPointsRule } from "@/lib/fantasy";
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
import { singleSearchParam } from "@/lib/search-params";
import {
  killParticipationByPlayer,
  leaderIdentity,
} from "@/lib/leader-ranking";

/** The fewest games a player needs to rank on kills or assists per game. */
const PER_GAME_MIN_GAMES = 3;

type LeadersSearchParams = { season?: string | string[] };

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<LeadersSearchParams>;
}): Promise<Metadata> {
  return seasonScopeMetadata((await searchParams).season, {
    path: "/leaders",
    title: "Leaders",
    description: `${LEAGUE_CONFIG.name} season leaders, weekly honors, career benchmarks, and player performance boards.`,
    archived: (name) => ({
      title: `${name} leaders`,
      description: `Weekly honors and player performance leaders from ${name}.`,
    }),
  });
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
  // ?season=<id> shows an archived season's boards; with no season running
  // the page opens on the most recent one (resolveSeasonScope).
  const [season, viewer] = await Promise.all([
    resolveSeasonScope(seasonParam),
    getSessionUser(),
  ]);
  if (!season) {
    return (
      <NoSeasonYet title="Leaders">
        <StatsNav active="leaders" />
      </NoSeasonYet>
    );
  }
  // A finished season's page holds its champion and awards: link it from an
  // archived season's boards, and from the current one once its final is in.
  const finishedLink = finishedSeasonLink(season);
  const titleAction = finishedLink ? (
    <Link href={finishedLink.href} className={buttonClasses("secondary", "sm")}>
      {finishedLink.label}
    </Link>
  ) : undefined;

  // Parse each game's players JSON once and reuse the lines for both the
  // boards and the weekly-honors card (the dashboard's League pulse does the
  // same) — honorsByWeek used to re-parse the week's games per week.
  const [gameRows, honorReadiness, seasonOptions] = await Promise.all([
    getSeasonGameLeaders(season.id),
    getSeasonHonorReadiness(season.id),
    loadSeasonChoices("games", season.id),
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
          action={titleAction}
        />
        <StatsNav
          active="leaders"
          seasonId={season.isActive ? undefined : season.id}
        />
        <SeasonSwitcher
          label="leaders"
          basePath="/leaders"
          seasons={seasonOptions}
          selectedId={season.id}
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
  // the other average boards. Cap their floor at the most-played count.
  // Kills and assists per game don't follow it: the league set their minimum
  // at a flat 3 games, so they stay empty until someone has played 3.
  const maxGames = Math.max(1, ...entries.map((e) => e.summary.games));
  const rateFloor = Math.min(PER_GAME_MIN_GAMES, maxGames);

  // Every board ranks what the PLAYER did. Total wins and win rate are gone
  // on purpose (they followed the team's record, so the top of each was the
  // best team's regulars — standings and Team of the Week already show it),
  // and kills/assists are per game so a player whose team played extra series
  // can't outrank a better one on volume. "Most games" stays as the one board
  // that recognises showing up.
  const boards: {
    title: string;
    description: string;
    valueUnit: string;
    category: "teamfights" | "economy";
    key: LeaderboardKey;
    minGames?: number;
    format: (r: LeaderRow) => string;
    rankValue?: (r: LeaderRow) => number;
    hint: (r: LeaderRow) => string;
  }[] = [
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
      title: "Kills per game",
      description: "Enemy heroes taken down, averaged over games played.",
      valueUnit: "kills / game",
      category: "teamfights",
      key: "killsPerGame",
      minGames: PER_GAME_MIN_GAMES,
      format: (r) => r.value.toFixed(1),
      hint: (r) =>
        `${r.summary.kills} kills in ${r.summary.games} game${r.summary.games === 1 ? "" : "s"}`,
    },
    {
      title: "Assists per game",
      description: "Kills set up for teammates, averaged over games played.",
      valueUnit: "assists / game",
      category: "teamfights",
      key: "assistsPerGame",
      minGames: PER_GAME_MIN_GAMES,
      format: (r) => r.value.toFixed(1),
      hint: (r) =>
        `${r.summary.assists} assists in ${r.summary.games} game${r.summary.games === 1 ? "" : "s"}`,
    },
    {
      title: "Most games",
      description: "Players who showed up most often.",
      valueUnit: "games played",
      category: "economy",
      key: "games",
      format: (r) => `${r.value}`,
      hint: (r) =>
        `${r.summary.wins} win${r.summary.wins === 1 ? "" : "s"}, ${r.summary.losses} loss${r.summary.losses === 1 ? "" : "es"}`,
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
  const categories = [
    {
      id: "teamfights",
      index: "01",
      title: "Teamfights",
      description: "Who finishes fights, creates chances, joins kills and sustains teammates.",
    },
    {
      id: "economy",
      index: "02",
      title: "Resources & presence",
      description: "Gold, net worth and the players who put in the most games.",
    },
  ] as const;

  const honorsCard = hasHonors ? (
    <Card id="weekly-honors" className="scroll-mt-24">
      <CardHeader
        headingLevel={2}
        title="Weekly honors"
        subtitle={`Regular season only. Player of the Week earns the most impact points: ${impactPointsRule()}.`}
        action={
          <details className="group max-w-sm text-sm">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60 [&::-webkit-details-marker]:hidden">
              How honors unlock
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                fill="none"
                className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
              >
                <path
                  d="m4 6 4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
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
                    {honors.player.points} impact points
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
  ) : null;

  return (
    <div className="space-y-6">
      {/* The page opens on Weekly honors — the part that changes every week
          and the part the Discord honors post links here for — then the
          boards. There is no banner, no "#1 on each board" highlight cards
          and no tile strip any more: on a phone they pushed the first board
          ~1,500px down and honors to the bottom of a ~9,500px page. */}
      <PageTitle
        title="Leaders"
        subtitle={`${season.name}${season.isActive ? "" : " · archived"} · From complete 5v5 box scores. Each average board names its minimum games; equal values share a rank.`}
        action={titleAction}
      />
      <StatsNav
        active="leaders"
        seasonId={season.isActive ? undefined : season.id}
      />
      <SeasonSwitcher
        label="leaders"
        basePath="/leaders"
        seasons={seasonOptions}
        selectedId={season.id}
      />
      <StatsDataNotice
        invalidLines={invalidLines}
        malformedGames={malformedGames}
        unusableGames={unusableGames}
        unmappedLines={unmappedLines}
      />
      <SectionNav
        label="Leaderboard sections"
        items={[
          ...(hasHonors ? [{ id: "weekly-honors", label: "Weekly honors" }] : []),
          ...categories.map((category) => ({ id: category.id, label: category.title })),
          ...(reportRows.length ? [{ id: "report-card", label: "Report card" }] : []),
        ]}
      />
      {honorsCard}
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
    </div>
  );
}
