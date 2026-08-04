import Link from "next/link";
import { ChampionBanner } from "@/components/champion-banner";
import { HISTORY_PHASE_LABEL as PHASE_LABEL } from "@/lib/season-copy";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { buildBracketRounds, seedsFromFirstRound } from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { StandingsTable } from "@/components/standings-table-server";
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
  SectionTitle,
  TeamCrest,
  buttonClasses,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Match } from "@prisma/client";
import { resolveChampionPresentation } from "@/lib/champion-presentation";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const season = await prisma.season.findUnique({
    where: { id },
    select: { name: true },
  });
  // notFound() in metadata runs before the shell streams → real 404 status.
  if (!season) notFound();
  return { title: `${season.name} · Season` };
}

function ResultRow({
  match: m,
  teamName,
}: {
  match: Match;
  teamName: Map<string, string>;
}) {
  const done = m.status === "COMPLETED";
  const homeWin = m.winnerTeamId === m.homeTeamId;
  const awayWin = m.winnerTeamId === m.awayTeamId;
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm sm:gap-3 sm:px-5">
      <div className="min-w-0 flex-1 truncate text-right">
        <Link
          href={`/teams/${m.homeTeamId}`}
          className={cn(
            "hover:text-info",
            done && (homeWin ? "font-semibold" : "text-muted"),
          )}
        >
          {teamName.get(m.homeTeamId) ?? "?"}
        </Link>
      </div>
      <Link
        href={`/matches/${m.id}`}
        aria-label={`View ${teamName.get(m.homeTeamId) ?? "unknown home team"} vs ${teamName.get(m.awayTeamId) ?? "unknown away team"}: ${done ? `${m.homeScore} to ${m.awayScore}` : "not played"}`}
        className="shrink-0 rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs tabular-nums transition-colors hover:bg-surface-2/80 hover:text-info"
      >
        {done ? `${m.homeScore} – ${m.awayScore}` : "not played"}
      </Link>
      <div className="min-w-0 flex-1 truncate">
        <Link
          href={`/teams/${m.awayTeamId}`}
          className={cn(
            "hover:text-info",
            done && (awayWin ? "font-semibold" : "text-muted"),
          )}
        >
          {teamName.get(m.awayTeamId) ?? "?"}
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
  const [season, gameCount] = await Promise.all([
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
  ]);
  if (!season) notFound();

  const teamName = new Map(season.teams.map((t) => [t.id, t.name]));
  const standings = computeStandings(
    season.teams.map((t) => t.id),
    season.matches,
  );
  const regular = season.matches.filter((m) => m.phase === "REGULAR");
  const playoff = season.matches.filter((m) => m.phase !== "REGULAR");
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
  );
  const champion = championPresentation.championTeamId
    ? season.teams.find((t) => t.id === championPresentation.championTeamId)
    : null;

  return (
    <div className="space-y-8">
      <PageTitle
        title={season.name}
        subtitle={season.isActive ? "Current season" : "Season archive"}
        action={
          season.isActive ? (
            <Badge tone="brand">Current season</Badge>
          ) : (
            <Badge tone="neutral">
              {PHASE_LABEL[season.status] ?? season.status}
            </Badge>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link href="/seasons" className="text-muted hover:text-info">
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
          {/* Recap, fantasy, and pick'em can all have useful season state even
              when no OpenDota Game rows were imported. */}
          <Link
            href={`/fantasy?season=${season.id}`}
            className={buttonClasses("secondary", "sm")}
          >
            Fantasy
          </Link>
          <Link
            href={`/pickem?season=${season.id}`}
            className={buttonClasses("secondary", "sm")}
          >
            Pick&rsquo;em
          </Link>
          <Link
            href={`/recap?season=${season.id}`}
            className={buttonClasses("secondary", "sm")}
          >
            Season recap →
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

      {weeks.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle>Regular season results</SectionTitle>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {weeks.map((week) => (
              <Card key={week}>
                <CardHeader title={`Week ${week}`} />
                <CardBody className="divide-y divide-line/60 p-0">
                  {regular
                    .filter((m) => m.week === week)
                    .map((m) => (
                      <ResultRow key={m.id} match={m} teamName={teamName} />
                    ))}
                </CardBody>
              </Card>
            ))}
          </div>
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
                      className="flex min-w-0 items-center gap-2 hover:text-info"
                    >
                      <TeamCrest
                        name={t.name}
                        seed={t.id}
                        size={24}
                        className="rounded-md"
                      />
                      <span className="truncate">{t.name}</span>
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
                      className="flex min-w-0 items-center justify-between gap-2 text-sm"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Avatar
                          name={m.user.name}
                          src={m.user.avatar}
                          size={24}
                        />
                        <PlayerLink
                          userId={m.userId}
                          className="min-w-0 truncate"
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
    </div>
  );
}
