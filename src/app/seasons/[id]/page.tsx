import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { pickBracketSize } from "@/lib/schedule";
import { buildBracketRounds, seedsFromFirstRound } from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { StandingsTable } from "@/app/page";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  PageTitle,
  PlayerLink,
  RankBadge,
  SectionTitle,
  TeamCrest,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Match } from "@prisma/client";

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
  return { title: `${season.name} · Season archive` };
}

const PHASE_LABEL: Record<string, string> = {
  SIGNUPS: "Signups open",
  DRAFT: "Drafting",
  REGULAR_SEASON: "In season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Complete",
};

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
      <span className="shrink-0 rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs tabular-nums">
        {done ? `${m.homeScore} – ${m.awayScore}` : "not played"}
      </span>
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
  const season = await prisma.season.findUnique({
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
  });
  if (!season) notFound();

  const teamName = new Map(season.teams.map((t) => [t.id, t.name]));
  const standings = computeStandings(
    season.teams.map((t) => t.id),
    season.matches,
  );
  const regular = season.matches.filter((m) => m.phase === "REGULAR");
  const playoff = season.matches.filter((m) => m.phase !== "REGULAR");
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
  const champion = season.championTeamId
    ? season.teams.find((t) => t.id === season.championTeamId)
    : null;

  return (
    <div className="space-y-8">
      <PageTitle
        title={season.name}
        subtitle="Season archive"
        action={
          season.isActive ? (
            <Badge tone="brand">Current season</Badge>
          ) : (
            <Badge tone="neutral">{PHASE_LABEL[season.status] ?? season.status}</Badge>
          )
        }
      />
      <div className="text-sm">
        <Link href="/seasons" className="text-muted hover:text-info">
          ← All seasons
        </Link>
      </div>

      {champion ? (
        <Link
          href={`/teams/${champion.id}`}
          className="flex items-center gap-3 rounded-[var(--radius)] border border-amber-400/40 bg-amber-400/10 px-5 py-4 transition-colors hover:border-amber-400/60"
        >
          <div className="relative shrink-0">
            <TeamCrest
              name={champion.name}
              seed={champion.id}
              size={44}
              className="rounded-xl ring-2 ring-amber-400/50"
            />
            <span
              aria-hidden
              className="absolute -bottom-1.5 -right-1.5 grid h-6 w-6 place-items-center rounded-full border border-amber-400/40 bg-surface text-xs shadow"
            >
              🏆
            </span>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-amber-300/90">
              {season.name} Champion
            </div>
            <div className="text-lg font-bold">{champion.name}</div>
          </div>
        </Link>
      ) : null}

      {season.teams.length > 0 ? (
        <Card>
          <CardHeader title="Final standings" />
          <CardBody className="p-0">
            <StandingsTable standings={standings} teamName={teamName} />
          </CardBody>
        </Card>
      ) : null}

      {playoff.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle>Playoffs</SectionTitle>
          <Card>
            <CardBody className="p-0 pt-4">
              <Bracket
                rounds={bracketRoundsView}
                championTeamId={season.championTeamId}
              />
            </CardBody>
          </Card>
        </section>
      ) : null}

      {weeks.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle>Regular season results</SectionTitle>
          <div className="grid gap-4 lg:grid-cols-2">
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
                      className="flex items-center gap-2 hover:text-info"
                    >
                      <TeamCrest
                        name={t.name}
                        seed={t.id}
                        size={24}
                        className="rounded-md"
                      />
                      {t.name}
                      {t.id === season.championTeamId ? <span>🏆</span> : null}
                    </Link>
                  }
                  subtitle={`Captain: ${t.captain.name}`}
                />
                <CardBody className="space-y-1.5">
                  {t.members.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="flex items-center gap-2">
                        <Avatar name={m.user.name} src={m.user.avatar} size={24} />
                        <PlayerLink userId={m.userId}>{m.user.name}</PlayerLink>
                        {m.isCaptain ? <Badge tone="accent">Captain</Badge> : null}
                        <RankBadge rankTier={m.user.rankTier} />
                      </span>
                      <span className="text-muted">
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
