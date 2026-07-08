import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { groupPlayoffRounds, roundName } from "@/lib/schedule";
import { formByTeam } from "@/lib/team-matches";
import {
  regularSeasonStatus,
  pendingResultsMessage,
} from "@/lib/schedule-status";
import { StandingsTable } from "@/app/page";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  SectionTitle,
  TeamCrest,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Match, StandinAssignment, User } from "@prisma/client";

export const metadata = { title: "Schedule · Under 5k League" };

type MatchStandin = StandinAssignment & { standin: User; replaced: User | null };

function fmtWhen(d: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function SchedulePage() {
  const season = await getActiveSeason();
  if (!season) {
    return (
      <div>
        <PageTitle title="Schedule" />
        <EmptyState title="No active season" />
      </div>
    );
  }

  const [teams, matches, assignments] = await Promise.all([
    prisma.team.findMany({ where: { seasonId: season.id } }),
    prisma.match.findMany({
      where: { seasonId: season.id },
      orderBy: [{ week: "asc" }, { createdAt: "asc" }],
    }),
    prisma.standinAssignment.findMany({
      where: { match: { seasonId: season.id } },
      include: { standin: true, replaced: true },
    }),
  ]);

  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const standinsByMatch = new Map<string, MatchStandin[]>();
  for (const a of assignments) {
    const arr = standinsByMatch.get(a.matchId) ?? [];
    arr.push(a);
    standinsByMatch.set(a.matchId, arr);
  }
  const standings = computeStandings(
    teams.map((t) => t.id),
    matches,
  );
  const teamForm = formByTeam(
    teams.map((t) => t.id),
    matches,
  );

  const regular = matches.filter((m) => m.phase === "REGULAR");
  const playoff = matches.filter((m) => m.phase !== "REGULAR");
  const weeks = [...new Set(regular.map((m) => m.week))].sort((a, b) => a - b);
  const status = regularSeasonStatus(matches);
  const weekStatus = new Map(status.weeks.map((w) => [w.week, w]));
  const pendingMsg = pendingResultsMessage(status);

  const champion =
    season.championTeamId && teamName.get(season.championTeamId)
      ? teamName.get(season.championTeamId)
      : null;

  // Group playoff matches into rounds for a simple bracket view.
  const { totalRounds, rounds: playoffRounds } = groupPlayoffRounds(playoff);

  return (
    <div className="space-y-8">
      <PageTitle title="Schedule & Standings" subtitle={season.name} />

      {pendingMsg && season.status === "REGULAR_SEASON" ? (
        <div className="flex items-start gap-3 rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-5 py-3 text-sm">
          <span className="text-lg leading-none">⏳</span>
          <div>
            <div className="font-medium">Results outstanding</div>
            <div className="text-muted">
              {pendingMsg} Standings &amp; playoff seeding update once they&apos;re
              entered.
            </div>
          </div>
        </div>
      ) : null}

      {champion ? (
        <div className="flex items-center gap-3 rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-5 py-4">
          <span className="text-3xl">🏆</span>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted">
              Champion
            </div>
            <div className="text-lg font-bold">{champion}</div>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader title="Standings" />
        <CardBody className="p-0">
          <StandingsTable
            standings={standings}
            teamName={teamName}
            formByTeam={teamForm}
          />
        </CardBody>
      </Card>

      {playoff.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle>Playoff bracket</SectionTitle>
          <div className="flex gap-4 overflow-x-auto pb-2">
            {playoffRounds.map(({ round, matches: roundMatches }) => (
              <div key={round} className="min-w-[16rem] flex-1 space-y-3">
                <h3 className="text-sm font-medium uppercase tracking-wide text-muted">
                  {roundName(round, totalRounds)}
                </h3>
                {roundMatches.map((m) => (
                  <Card key={m.id}>
                    <CardBody className="p-0">
                      <MatchRow
                        match={m}
                        teamName={teamName}
                        standins={standinsByMatch.get(m.id)}
                      />
                    </CardBody>
                  </Card>
                ))}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-4">
        <SectionTitle>Regular season</SectionTitle>
        {regular.length === 0 ? (
          <EmptyState
            title="No matches scheduled yet"
            description="The schedule is generated once teams are drafted."
          />
        ) : (
          <div className="space-y-5">
            {weeks.map((week) => {
              const ws = weekStatus.get(week);
              const incomplete = !!ws && ws.pending > 0;
              return (
              <div key={week}>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
                  <span>Week {week}</span>
                  {ws ? (
                    <span className={incomplete ? "text-accent" : "text-success"}>
                      {ws.completed}/{ws.total} results in
                    </span>
                  ) : null}
                </h3>
                <Card>
                  <CardBody className="divide-y divide-line/60 p-0">
                    {regular
                      .filter((m) => m.week === week)
                      .map((m) => (
                        <MatchRow
                          key={m.id}
                          match={m}
                          teamName={teamName}
                          standins={standinsByMatch.get(m.id)}
                        />
                      ))}
                  </CardBody>
                </Card>
              </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function MatchRow({
  match: m,
  teamName,
  standins,
}: {
  match: Match;
  teamName: Map<string, string>;
  standins?: MatchStandin[];
}) {
  const homeName = teamName.get(m.homeTeamId) ?? "?";
  const awayName = teamName.get(m.awayTeamId) ?? "?";
  const done = m.status === "COMPLETED";
  const homeWin = m.winnerTeamId === m.homeTeamId;
  const awayWin = m.winnerTeamId === m.awayTeamId;
  return (
    <div className="transition-colors hover:bg-surface-2/30">
      <div className="flex items-center gap-2 px-4 py-2.5 sm:gap-3 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 text-sm">
          <Link
            href={`/teams/${m.homeTeamId}`}
            className={cn(
              "truncate hover:text-info",
              done && (homeWin ? "font-semibold text-fg" : "text-muted"),
            )}
          >
            {homeName}
          </Link>
          <TeamCrest
            name={homeName}
            seed={m.homeTeamId}
            size={24}
            className="rounded-lg"
          />
        </div>
        <div className="shrink-0 text-center">
          {done ? (
            <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-sm tabular-nums">
              <span className={homeWin ? "font-semibold text-fg" : "text-muted"}>
                {m.homeScore}
              </span>
              <span className="px-1 text-muted">–</span>
              <span className={awayWin ? "font-semibold text-fg" : "text-muted"}>
                {m.awayScore}
              </span>
            </span>
          ) : m.scheduledAt ? (
            <span className="whitespace-nowrap text-xs text-muted">
              {fmtWhen(m.scheduledAt)}
            </span>
          ) : (
            <span className="text-xs text-muted">vs</span>
          )}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <TeamCrest
            name={awayName}
            seed={m.awayTeamId}
            size={24}
            className="rounded-lg"
          />
          <Link
            href={`/teams/${m.awayTeamId}`}
            className={cn(
              "truncate hover:text-info",
              done && (awayWin ? "font-semibold text-fg" : "text-muted"),
            )}
          >
            {awayName}
          </Link>
        </div>
        {m.phase === "FINAL" ? (
          <Badge tone="accent" className="shrink-0">
            Final
          </Badge>
        ) : null}
        <Link
          href={`/matches/${m.id}`}
          className="shrink-0 text-xs text-muted hover:text-info"
        >
          details →
        </Link>
      </div>
      {standins && standins.length > 0 ? (
        <div className="space-y-0.5 border-t border-line/40 px-5 py-2">
          {standins.map((a) => (
            <div key={a.id} className="text-xs text-muted">
              🔁 {a.standin.name} in for {a.replaced?.name ?? "?"} ·{" "}
              {teamName.get(a.teamId)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
