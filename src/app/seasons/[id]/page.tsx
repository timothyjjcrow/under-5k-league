import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { ChampionBanner } from "@/components/champion-banner";
import { AuctionHistory } from "@/components/auction-history";
import { SeasonAwards } from "@/components/season-awards";
import {
  HISTORY_PHASE_LABEL as PHASE_LABEL,
  seasonPhaseLabel,
} from "@/lib/season-copy";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { getSeasonDraftStatus, getViewerFantasyEntered } from "@/lib/queries";
import { fantasyListed } from "@/lib/site-nav";
import { SEASON_STATUS } from "@/lib/constants";
import { projectPlayoffField } from "@/lib/playoff-field";
import { buildBracketRounds, seedsFromFirstRound } from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { StandingsTable } from "@/components/standings-table-server";
import { SeasonGrid } from "@/components/season-grid";
import { LocalTime } from "@/components/local-time";
import { formatMatchTime } from "@/lib/match-time";
import { shareMetadata } from "@/lib/share-metadata";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  EmptyState,
  LinkArrow,
  PageTitle,
  PlayerLink,
  RankBadge,
  SectionTitle,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Match } from "@prisma/client";
import { resolveChampionPresentation } from "@/lib/champion-presentation";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const season = await prisma.season.findUnique({
    where: { id },
    select: { name: true, isActive: true, status: true },
  });
  // notFound() in metadata runs before the shell streams → real 404 status.
  if (!season) notFound();
  // The champion post in Discord links here, so a finished season's preview
  // says what the page holds.
  return shareMetadata(
    `${season.name} · Season`,
    isFinishedSeason(season)
      ? `Champion, final standings, bracket, awards and every result from ${season.name}.`
      : `Standings, results and rosters from ${season.name}.`,
    `/seasons/${encodeURIComponent(id)}`,
  );
}

/** An archived season, or the current one once its final is played. */
function isFinishedSeason(season: { isActive: boolean; status: string }) {
  return !season.isActive || season.status === "COMPLETE";
}

function ResultRow({
  match: m,
  teamName,
  teamLogoUrl,
}: {
  match: Match;
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
}) {
  const done = m.status === "COMPLETED";
  const live = m.status === "LIVE";
  const label = done
    ? m.forfeit
      ? "Forfeit"
      : "Final score"
    : live
      ? "Live"
      : m.scheduledAt
        ? "Scheduled"
        : "Time TBD";
  const matchLabel = `View ${teamName.get(m.homeTeamId) ?? "unknown home team"} vs ${teamName.get(m.awayTeamId) ?? "unknown away team"}: ${done || live ? `${live ? "live, " : ""}${m.homeScore} to ${m.awayScore}${m.forfeit ? " by forfeit" : ""}` : m.scheduledAt ? "scheduled" : "kickoff not set"}`;
  return (
    <div className="min-w-0 px-3 py-3 sm:px-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-[10px] text-muted">
        <span
          role={live ? "img" : undefined}
          aria-label={
            live ? `Live — series at ${m.homeScore}–${m.awayScore}` : undefined
          }
          title={
            done && m.forfeit
              ? "Forfeit — this score was ruled, not played"
              : undefined
          }
          className={cn(
            "inline-flex items-center gap-1.5 font-semibold uppercase tracking-wider",
            done ? "text-success" : live ? "text-danger" : "text-accent",
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
          {label}
        </span>
        {m.scheduledAt ? (
          <LocalTime
            ts={m.scheduledAt.getTime()}
            variant="short"
            initial={formatMatchTime(m.scheduledAt, "short")}
          />
        ) : null}
      </div>
      {[
        { id: m.homeTeamId, score: m.homeScore },
        { id: m.awayTeamId, score: m.awayScore },
      ].map((side) => {
        const winner = done && m.winnerTeamId === side.id;
        const name = teamName.get(side.id) ?? "?";
        return (
          <div
            key={side.id}
            className={cn(
              "flex min-w-0 items-center gap-2.5 rounded-md px-1.5",
              winner && "bg-success/[0.06]",
            )}
          >
            <TeamCrest
              name={name}
              seed={side.id}
              logoUrl={teamLogoUrl.get(side.id)}
              size={24}
              className="rounded-md"
            />
            <Link
              href={`/teams/${side.id}`}
              className={cn(
                "flex min-h-11 min-w-0 flex-1 items-center py-2 text-sm [overflow-wrap:anywhere] hover:text-info",
                done
                  ? winner
                    ? "font-semibold text-fg"
                    : "text-muted"
                  : "font-medium text-fg",
              )}
            >
              {name}
            </Link>
            <span
              className={cn(
                "w-7 shrink-0 text-center font-display text-xl tabular-nums",
                live ? "text-danger" : winner ? "text-fg" : "text-muted",
              )}
            >
              {done || live ? side.score : "—"}
            </span>
          </div>
        );
      })}
      <div className="flex justify-end px-1">
        <Link
          href={`/matches/${m.id}`}
          aria-label={matchLabel}
          className="inline-flex min-h-11 items-center text-xs font-medium text-info hover:underline"
        >
          Match details <LinkArrow />
        </Link>
      </div>
    </div>
  );
}

export default async function SeasonArchivePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [season, gameCount, fantasyEntry] = await Promise.all([
    prisma.season.findUnique({
      where: { id },
      include: {
        teams: {
          orderBy: { draftOrder: "asc" },
          include: {
            captain: true,
            members: { include: { user: true }, orderBy: { price: "desc" } },
          },
        },
        matches: { orderBy: [{ week: "asc" }, { createdAt: "asc" }] },
      },
    }),
    prisma.game.count({ where: { match: { seasonId: id } } }),
    // An archived season links Fantasy when it had managers; otherwise the
    // page would open onto "Entries 0".
    prisma.fantasyRoster.findFirst({
      where: { seasonId: id },
      select: { id: true },
    }),
  ]);
  if (!season) notFound();

  // The current season names its phase as the header and footer chips do,
  // and links Fantasy by the menus' rule. Both reads are request-cached: the
  // root layout already made them.
  const draftStatus =
    season.isActive && season.status === SEASON_STATUS.DRAFT
      ? await getSeasonDraftStatus(season.id)
      : null;
  const fantasyLocked = season.fantasyLockedAt != null || gameCount > 0;
  const viewer = season.isActive && fantasyLocked ? await getSessionUser() : null;
  const showFantasy = season.isActive
    ? fantasyListed({
        phase: season.status,
        draftStatus,
        fantasyLocked,
        fantasyEntered: viewer
          ? await getViewerFantasyEntered(season.id, viewer.id)
          : false,
      })
    : fantasyEntry !== null;

  const teamName = new Map(season.teams.map((t) => [t.id, t.name]));
  const teamLogoUrl = new Map(season.teams.map((t) => [t.id, t.logoUrl]));
  const standings = projectPlayoffField(season.teams, season.matches).standings;
  const regular = season.matches.filter((m) => m.phase === "REGULAR");
  const tiebreakers = season.matches.filter((m) => m.phase === "TIEBREAKER");
  const playoff = season.matches.filter(
    (m) => m.phase === "PLAYOFF" || m.phase === "FINAL",
  );
  const championPresentation = resolveChampionPresentation(
    season,
    season.matches,
  );
  const weeks = [...new Set(regular.map((m) => m.week))].sort((a, b) => a - b);
  // Same interactive bracket the live schedule uses — seeds derive from the
  // archived first-round pairings themselves.
  const bracketRoundsView = buildBracketRounds(
    playoff,
    teamName,
    seedsFromFirstRound(playoff),
    (d) =>
      d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    teamLogoUrl,
  );
  const champion = championPresentation.championTeamId
    ? season.teams.find((t) => t.id === championPresentation.championTeamId)
    : null;

  return (
    <div className="space-y-8">
      <PageTitle
        title={season.name}
        subtitle={
          // The badge already says "Current season"; the subtitle says where
          // the season is, in the header chip's words, so a finished one
          // stops reading as running.
          season.isActive
            ? season.status === SEASON_STATUS.COMPLETE
              ? "Season complete"
              : seasonPhaseLabel(season.status, draftStatus)
            : "Archived season"
        }
        action={
          season.isActive ? (
            <Badge tone="success">Current season</Badge>
          ) : (
            <Badge tone="neutral">
              {PHASE_LABEL[season.status] ?? season.status}
            </Badge>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link
          href="/seasons"
          className={textLink("text-muted hover:text-info")}
        >
          ← All seasons
        </Link>
        <div className="flex flex-wrap gap-2">
          {gameCount > 0 ? (
            <>
              <Link
                href={`/leaders?season=${season.id}`}
                className={buttonClasses("secondary", "sm")}
              >
                Leaders
              </Link>
              <Link
                href={`/meta?season=${season.id}`}
                className={buttonClasses("secondary", "sm")}
              >
                Hero meta
              </Link>
            </>
          ) : null}
          {/* Fantasy and pick'em can have useful season state even when no
              OpenDota Game rows were imported. */}
          {showFantasy ? (
            <Link
              href={`/fantasy?season=${season.id}`}
              className={buttonClasses("secondary", "sm")}
            >
              Fantasy
            </Link>
          ) : null}
          <Link
            href={`/pickem?season=${season.id}`}
            className={buttonClasses("secondary", "sm")}
          >
            Pick&rsquo;em
          </Link>
        </div>
      </div>

      {season.teams.length === 0 && season.matches.length === 0 ? (
        <EmptyState
          title="No competitive history on record"
          description={
            season.isActive
              ? "This season has not created teams or fixtures yet."
              : "This archived season was closed before teams or fixtures were created. Its saved phase and configuration remain available to administrators."
          }
        />
      ) : null}

      {champion ? (
        <ChampionBanner
          teamId={champion.id}
          teamName={champion.name}
          teamLogoUrl={champion.logoUrl}
          seasonName={season.name}
        />
      ) : null}

      {season.status === "COMPLETE" && !champion ? (
        <div className="rounded-xl border border-accent/40 bg-accent/10 px-5 py-3 text-sm">
          <div className="font-medium">Champion state needs review</div>
          <p className="mt-1 text-muted">
            This season was closed without an authoritative champion. Results
            remain historical, but no team is labelled champion until the grand
            final is reconciled.
          </p>
        </div>
      ) : null}

      {season.teams.length > 0 ? (
        <Card>
          <CardHeader
            title={
              season.status === "COMPLETE"
                ? "Final standings"
                : season.isActive
                  ? "Current standings"
                  : "Standings at archive"
            }
          />
          <CardBody className="p-0">
            <StandingsTable
              standings={standings}
              teamName={teamName}
              teamLogoUrl={teamLogoUrl}
              withdrawnIds={
                new Set(
                  season.teams
                    .filter((team) => team.withdrawn)
                    .map((team) => team.id),
                )
              }
            />
          </CardBody>
        </Card>
      ) : null}

      {playoff.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle>Playoffs</SectionTitle>
          {/* overflow-hidden: Bracket scrolls horizontally inside itself, and
              without this the card leaks that width into the page scroll. */}
          <Card className="overflow-hidden">
            <CardBody className="p-0 pt-4">
              <Bracket
                rounds={bracketRoundsView}
                championTeamId={championPresentation.championTeamId}
              />
            </CardBody>
          </Card>
        </section>
      ) : null}

      {tiebreakers.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle>Tiebreaker results</SectionTitle>
          <p className="text-sm text-muted">
            Best-of-three series used to settle playoff qualification and seed order.
          </p>
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            {[...new Set(tiebreakers.map((match) => match.week))]
              .sort((a, b) => a - b)
              .map((week) => (
                <Card key={week} className="min-w-0 overflow-hidden">
                  <CardHeader title={`Tiebreaker week ${week}`} />
                  <CardBody className="divide-y divide-line-soft p-0">
                    {tiebreakers.filter((match) => match.week === week).map((match) => (
                      <ResultRow
                        key={match.id}
                        match={match}
                        teamName={teamName}
                        teamLogoUrl={teamLogoUrl}
                      />
                    ))}
                  </CardBody>
                </Card>
              ))}
          </div>
        </section>
      ) : null}

      {/* The season's numbers and awards live here, not on a separate recap
          page: /recap redirects to this page. Only for a finished season;
          mid-season the Leaders boards are the running version. */}
      {isFinishedSeason(season) && season.matches.length > 0 ? (
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <SeasonAwards
            seasonId={season.id}
            completedSeries={
              season.matches.filter((m) => m.status === "COMPLETED").length
            }
          />
        </Suspense>
      ) : null}

      {weeks.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle>Regular season results</SectionTitle>
          <Card className="min-w-0 overflow-hidden">
            <CardHeader
              title="Head-to-head results"
              subtitle="Each row shows that team's results"
            />
            <CardBody className="p-0">
              <SeasonGrid
                teamIds={standings.map((row) => row.teamId)}
                teamName={teamName}
                teamLogoUrl={teamLogoUrl}
                matches={regular}
              />
            </CardBody>
          </Card>
          <details className="group rounded-xl border border-line-soft bg-surface">
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden sm:px-5">
              <span>
                All series by week{" "}
                <span className="ml-2 font-mono text-xs font-normal tabular-nums text-muted">
                  {regular.length}
                </span>
              </span>
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                fill="none"
                className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180"
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
            <div className="grid grid-cols-1 items-start gap-4 border-t border-line-soft p-3 sm:p-4 lg:grid-cols-2">
              {weeks.map((week) => {
                const matches = regular.filter((m) => m.week === week);
                const completed = matches.filter(
                  (m) => m.status === "COMPLETED",
                ).length;
                return (
                  <Card key={week} className="min-w-0 overflow-hidden">
                    <CardHeader
                      title={`Week ${week}`}
                      action={
                        <span className="text-xs text-muted">
                          <span className="font-mono tabular-nums text-fg">
                            {completed}/{matches.length}
                          </span>{" "}
                          final
                        </span>
                      }
                    />
                    <CardBody className="divide-y divide-line-soft p-0">
                      {matches.map((m) => (
                        <ResultRow
                          key={m.id}
                          match={m}
                          teamName={teamName}
                          teamLogoUrl={teamLogoUrl}
                        />
                      ))}
                    </CardBody>
                  </Card>
                );
              })}
            </div>
          </details>
        </section>
      ) : null}

      {season.teams.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle>Teams &amp; rosters</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {season.teams.map((t) => (
              <Card key={t.id} interactive>
                <CardHeader
                  title={
                    <Link
                      href={`/teams/${t.id}`}
                      className="flex min-h-11 min-w-0 flex-wrap items-center gap-2 hover:text-info"
                    >
                      <TeamCrest
                        name={t.name}
                        seed={t.id}
                        logoUrl={t.logoUrl}
                        size={24}
                        className="rounded-md"
                      />
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {t.name}
                      </span>
                      {t.id === championPresentation.championTeamId ? (
                        <span>🏆</span>
                      ) : null}
                      {t.withdrawn ? <Badge>Withdrawn</Badge> : null}
                    </Link>
                  }
                  subtitle={`Captain: ${t.captain.name}`}
                />
                <CardBody className="space-y-1.5">
                  {t.members.map((m) => (
                    <div
                      key={m.id}
                      className="flex min-w-0 items-center justify-between gap-3 rounded-lg px-1.5 text-sm hover:bg-surface-2/40"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <Avatar
                          name={m.user.name}
                          src={m.user.avatar}
                          size={24}
                        />
                        {/* my-0 keeps the whole 44px target in the row's
                            height; with TAP_SAFE's -my-1 each hit box hung
                            over the next row's. */}
                        <PlayerLink
                          userId={m.userId}
                          className="my-0 inline-flex min-h-11 min-w-0 items-center [overflow-wrap:anywhere]"
                        >
                          {m.user.name}
                        </PlayerLink>
                        {m.isCaptain ? (
                          <Badge tone="accent">Captain</Badge>
                        ) : null}
                        <RankBadge rankTier={m.user.rankTier} />
                      </span>
                      <span className="shrink-0 text-muted">
                        {m.isCaptain ? "—" : `$${m.price}`}
                      </span>
                    </div>
                  ))}
                </CardBody>
              </Card>
            ))}
          </div>
        </section>
      ) : null}
      <AuctionHistory seasonId={season.id} />
    </div>
  );
}
