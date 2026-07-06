import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { bracketRounds, roundName } from "@/lib/schedule";
import { StandingsTable } from "@/app/page";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
} from "@/components/ui";
import type { Match, StandinAssignment, User } from "@prisma/client";

export const metadata = { title: "Schedule · Under 5k League" };

type MatchStandin = StandinAssignment & { standin: User; replaced: User | null };

function slotRound(slot: string | null): number {
  const m = slot?.match(/^R(\d+)M/);
  return m ? Number(m[1]) : 0;
}

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

  const regular = matches.filter((m) => m.phase === "REGULAR");
  const playoff = matches.filter((m) => m.phase !== "REGULAR");
  const weeks = [...new Set(regular.map((m) => m.week))].sort((a, b) => a - b);

  const champion =
    season.championTeamId && teamName.get(season.championTeamId)
      ? teamName.get(season.championTeamId)
      : null;

  // Group playoff matches into rounds for a simple bracket view.
  const firstRoundCount = playoff.filter(
    (m) => slotRound(m.bracketSlot) === 0,
  ).length;
  const totalRounds = firstRoundCount > 0 ? bracketRounds(firstRoundCount * 2) : 0;
  const playoffRounds = [...new Set(playoff.map((m) => slotRound(m.bracketSlot)))]
    .sort((a, b) => a - b)
    .map((r) => ({
      round: r,
      matches: playoff
        .filter((m) => slotRound(m.bracketSlot) === r)
        .sort((a, b) => (a.bracketSlot ?? "").localeCompare(b.bracketSlot ?? "")),
    }));

  return (
    <div className="space-y-8">
      <PageTitle title="Schedule & Standings" subtitle={season.name} />

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
          <StandingsTable standings={standings} teamName={teamName} />
        </CardBody>
      </Card>

      {playoff.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Playoff bracket</h2>
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
        <h2 className="text-lg font-semibold">Regular season</h2>
        {regular.length === 0 ? (
          <EmptyState
            title="No matches scheduled yet"
            description="The schedule is generated once teams are drafted."
          />
        ) : (
          <div className="space-y-5">
            {weeks.map((week) => (
              <div key={week}>
                <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">
                  Week {week}
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
            ))}
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
  return (
    <div>
      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <div className="flex flex-1 items-center justify-end text-sm">
          <span
            className={m.winnerTeamId === m.homeTeamId ? "font-semibold" : ""}
          >
            {teamName.get(m.homeTeamId) ?? "?"}
          </span>
        </div>
        <div className="shrink-0 text-center">
          {m.status === "COMPLETED" ? (
            <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-sm">
              {m.homeScore} – {m.awayScore}
            </span>
          ) : (
            <span className="text-xs text-muted">vs</span>
          )}
        </div>
        <div className="flex flex-1 items-center text-sm">
          <span
            className={m.winnerTeamId === m.awayTeamId ? "font-semibold" : ""}
          >
            {teamName.get(m.awayTeamId) ?? "?"}
          </span>
        </div>
        {m.scheduledAt ? (
          <span className="shrink-0 text-xs text-muted">
            {fmtWhen(m.scheduledAt)}
          </span>
        ) : null}
        {m.phase === "FINAL" ? <Badge tone="accent">Final</Badge> : null}
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
