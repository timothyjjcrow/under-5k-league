import { LEAGUE_CONFIG } from "@/lib/league-config";
import Link from "@/components/app-link";
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
import { weekWrapPath } from "@/lib/week-wrap";
import {
  getPublicSeasonHonorReadiness,
  getSeasonGameLeaders,
} from "@/lib/cached-queries";
import {
  LeadersExplorer,
  type LeadersExplorerPlayer,
} from "@/components/leaders-explorer";
import { decodeGamePlayers, trustedGamePlayers } from "@/lib/player-stats";
import { buildLeaderTable } from "@/lib/leader-table";
import { weeklyHonors } from "@/lib/honors";
import { impactPointsRule } from "@/lib/fantasy";
import {
  HONOR_WEEK_STATE,
  isNoPerformanceHonorWeek,
} from "@/lib/honors-readiness";
import { cn } from "@/lib/utils";
import {
  TAP_SAFE,
  buttonClasses,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LinkArrow,
  PageTitle,
  PlayerLink,
  SectionTitle,
} from "@/components/ui";
import { StatsDataNotice, StatsNav } from "@/components/stats-nav";
import { singleSearchParam } from "@/lib/search-params";
import { leaderIdentity } from "@/lib/leader-ranking";

type LeadersSearchParams = {
  season?: string | string[];
  stat?: string | string[];
};

/** Weeks of honors shown before the older ones fold away. */
const HONOR_WEEKS_SHOWN = 3;

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
  const query = await searchParams;
  const seasonParam = singleSearchParam(query.season);
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
      {finishedLink.label} <LinkArrow />
    </Link>
  ) : undefined;

  // Parse each game's players JSON once and reuse the lines for both the
  // boards and the weekly-honors card (the dashboard's League pulse does the
  // same) — honorsByWeek used to re-parse the week's games per week.
  const [gameRows, honorReadiness, seasonOptions] = await Promise.all([
    getSeasonGameLeaders(season.id),
    getPublicSeasonHonorReadiness(season.id),
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

  // Every player's season line under every stat, with each stat's minimum
  // (leader-table.ts). The explorer below only sorts and filters it.
  const table = buildLeaderTable(games);
  const entries = table.rows;

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

  const heroOf = (heroId: number) => heroById(heroId);
  const players: LeadersExplorerPlayer[] = entries.map((entry) => ({
    id: entry.id,
    ...leaderIdentity(userMap.get(entry.id)),
    // null for unrostered players (free agents, standins).
    team: teamNameFor(entry.id),
    isViewer: viewer?.id === entry.id,
    cells: table.stats.map((stat) => entry.cells[stat.key] ?? null),
    heroes: entry.heroes.flatMap(({ heroId, games: played, wins }) => {
      const hero = heroOf(heroId);
      return hero ? [{ hero, games: played, wins }] : [];
    }),
  }));
  // ?stat=<key> opens on that ranking, so one can be linked; anything else
  // opens on the first.
  const statParam = singleSearchParam(query.stat);
  const initialStat = Math.max(
    0,
    table.stats.findIndex((stat) => stat.key === statParam),
  );
  const hasHonors =
    honorsByWeek.length > 0 ||
    inProgressWeeks.length > 0 ||
    awaitingBoxScoreWeeks.length > 0;
  const honorWeek = ({ week, honors }: (typeof honorsByWeek)[number]) =>
    !honors.player && !honors.team ? (
      <p key={week} className="px-4 py-2.5 text-sm text-muted">
        Week {week} is final with no played games, so no performance honors
        were awarded.
      </p>
    ) : (
      <div
        key={week}
        // gap-y-2.5, not a margin on the team entry: a margin shifted Team of
        // the Week ~3px below Player of the Week whenever the two sat on one
        // line. Wrapped, the rows keep the 10px the stacked links need.
        className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-2.5 text-sm"
      >
        {/* The week label opens that week's wrap. */}
        <Link
          href={weekWrapPath(season.id, week)}
          className={cn(TAP_SAFE, "w-16 shrink-0 text-xs uppercase tracking-wide text-muted hover:text-info")}
        >
          Week {week}
        </Link>
        {/* flex-wrap: on a phone the points-and-hero line drops under the
            name. As two shrinking siblings, the NAME broke across lines
            instead ("Pudge / Player4"). */}
        {honors.player ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden>⭐</span>
              {userMap.has(honors.player.userId) ? (
                <PlayerLink userId={honors.player.userId} className="font-medium">
                  {userMap.get(honors.player.userId)!.name}
                </PlayerLink>
              ) : (
                <span className="font-medium text-muted">Former player</span>
              )}
            </span>
            <span className="text-xs text-muted">
              {honors.player.points} impact points
              {honors.player.heroId != null
                ? ` · ${heroById(honors.player.heroId)?.name ?? `Hero #${honors.player.heroId}`}`
                : ""}
            </span>
          </span>
        ) : null}
        {honors.team ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden>🛡️</span>
              <Link
                href={`/teams/${honors.team.teamId}`}
                className="py-1 -my-1 font-medium hover:text-info"
              >
                {teamNameOf.get(honors.team.teamId) ?? "?"}
              </Link>
            </span>
            <span className="text-xs text-muted">
              {honors.team.gameWins} game win
              {honors.team.gameWins === 1 ? "" : "s"}
            </span>
          </span>
        ) : null}
      </div>
    );
  // Newest first. The latest weeks stay open; a long season's older ones
  // fold, so the rankings stay within reach on a phone.
  const recentHonors = honorsByWeek.slice(0, HONOR_WEEKS_SHOWN);
  const earlierHonors = honorsByWeek.slice(HONOR_WEEKS_SHOWN);

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
          <p className="px-4 py-2.5 text-sm text-muted">
            Week {inProgressWeeks[0].week} is still in progress. Its honors
            will appear after the full slate is final.
          </p>
        ) : null}
        {/* Every held week, not just one: naming only the newest hid the
            others (two of Season 1's held weeks were never mentioned). */}
        {awaitingBoxScoreWeeks.length > 0 ? (
          <p className="px-4 py-2.5 text-sm text-muted">
            {heldWeeksPhrase(awaitingBoxScoreWeeks.map((row) => row.week))}{" "}
            final, but honors are waiting for complete, valid 5v5 box scores
            from every played series.
          </p>
        ) : null}
        {recentHonors.map(honorWeek)}
        {earlierHonors.length > 0 ? (
          <details className="group/earlier">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-4 text-sm text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-info/60 [&::-webkit-details-marker]:hidden">
              {`Earlier weeks (${earlierHonors.length})`}
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                fill="none"
                className="h-4 w-4 shrink-0 transition-transform group-open/earlier:rotate-180 motion-reduce:transition-none"
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
            <div className="divide-y divide-line/60 border-t border-line/60">
              {earlierHonors.map(honorWeek)}
            </div>
          </details>
        ) : null}
      </CardBody>
    </Card>
  ) : null;

  return (
    <div className="space-y-6">
      {/* The page opens on Weekly honors, the part that changes every week
          and the part the Discord honors post links here for, then one
          ranking of every player that any stat can sort. The nine separate
          boards it replaces showed three rows each and repeated the same
          players; on a phone they ran about 6,000px. */}
      <PageTitle
        title="Leaders"
        subtitle={`${season.name}${season.isActive ? "" : " · archived"} · Weekly honors, and every player ranked by the stat you pick.`}
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
      {honorsCard}
      <section
        id="rankings"
        aria-labelledby="rankings-title"
        className="scroll-mt-24 space-y-3"
      >
        <SectionTitle>
          <span id="rankings-title">Player rankings</span>
        </SectionTitle>
        <LeadersExplorer
          stats={table.stats}
          players={players}
          initialStat={initialStat}
          compareWith={viewer && userMap.has(viewer.id) ? viewer.id : null}
        />
      </section>
    </div>
  );
}

/** "Week 3 is" / "Weeks 1 and 3 are" / "Weeks 1, 3 and 5 are". */
function heldWeeksPhrase(weeks: number[]): string {
  const sorted = [...weeks].sort((a, b) => a - b);
  if (sorted.length === 1) return `Week ${sorted[0]} is`;
  const list = `${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}`;
  return `Weeks ${list} are`;
}
