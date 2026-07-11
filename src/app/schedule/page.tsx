import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { pickBracketSize } from "@/lib/schedule";
import { buildBracketRounds, seedMap } from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { formByTeam } from "@/lib/team-matches";
import {
  regularSeasonStatus,
  pendingResultsMessage,
} from "@/lib/schedule-status";
import { teamAvailability, type TeamAvailability } from "@/lib/availability";
import { CheckinBanner } from "@/components/checkin-banner";
import { StandingsTable } from "@/app/page";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  ScheduleCallout,
  SectionTitle,
  TeamCrest,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Match, StandinAssignment, User } from "@prisma/client";

export const metadata = { title: "Schedule" };

type MatchStandin = StandinAssignment & { standin: User; replaced: User | null };

function fmtWhen(d: Date | null): string | null {
  if (!d) return null;
  // Weekday included — "Sat" is what players actually plan around.
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Phone-width variant: the weekday doesn't fit between two team names.
function fmtWhenShort(d: Date): string {
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

  const viewer = await getSessionUser();
  const [teams, matches, assignments, members, rsvps] = await Promise.all([
    prisma.team.findMany({ where: { seasonId: season.id } }),
    prisma.match.findMany({
      where: { seasonId: season.id },
      orderBy: [{ week: "asc" }, { createdAt: "asc" }],
    }),
    prisma.standinAssignment.findMany({
      where: { match: { seasonId: season.id } },
      include: { standin: true, replaced: true },
    }),
    prisma.teamMember.findMany({
      where: { seasonId: season.id },
      select: { teamId: true, userId: true },
    }),
    prisma.matchAvailability.findMany({
      where: { match: { seasonId: season.id } },
      select: { matchId: true, userId: true, status: true },
    }),
  ]);

  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  // Match-night RSVPs: roster per team + rows per match → per-side summaries.
  const rosterByTeam = new Map<string, string[]>();
  for (const m of members) {
    const arr = rosterByTeam.get(m.teamId) ?? [];
    arr.push(m.userId);
    rosterByTeam.set(m.teamId, arr);
  }
  const rsvpsByMatch = new Map<string, { userId: string; status: string }[]>();
  for (const r of rsvps) {
    const arr = rsvpsByMatch.get(r.matchId) ?? [];
    arr.push(r);
    rsvpsByMatch.set(r.matchId, arr);
  }
  const rsvpFor = (m: Match) =>
    m.status === "COMPLETED"
      ? undefined
      : {
          home: teamAvailability(
            rosterByTeam.get(m.homeTeamId) ?? [],
            rsvpsByMatch.get(m.id) ?? [],
          ),
          away: teamAvailability(
            rosterByTeam.get(m.awayTeamId) ?? [],
            rsvpsByMatch.get(m.id) ?? [],
          ),
        };

  // The viewer's next unplayed match (rostered players only) for the check-in card.
  const myTeamIds = new Set(
    members.filter((m) => viewer && m.userId === viewer.id).map((m) => m.teamId),
  );
  const myNextMatch = viewer
    ? matches.find(
        (m) =>
          m.status !== "COMPLETED" &&
          (myTeamIds.has(m.homeTeamId) || myTeamIds.has(m.awayTeamId)),
      )
    : undefined;
  const myRsvp = myNextMatch
    ? (rsvpsByMatch.get(myNextMatch.id) ?? []).find(
        (r) => r.userId === viewer!.id,
      )?.status ?? null
    : null;
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
  // The first week still missing results is "this week" — the one visitors
  // scroll past completed weeks to find.
  const currentWeek =
    season.status === "REGULAR_SEASON"
      ? weeks.find((w) => (weekStatus.get(w)?.pending ?? 0) > 0)
      : undefined;

  const champion =
    season.championTeamId && teamName.get(season.championTeamId)
      ? teamName.get(season.championTeamId)
      : null;

  // Full bracket tree (TBD slots included) for the interactive bracket.
  const bracketRoundsView = buildBracketRounds(
    playoff,
    teamName,
    // Same seeding rule createPlayoffBracket used, recomputed — regular-season
    // results are frozen once playoffs start, so the order is identical.
    seedMap(
      standings.map((s) => s.teamId),
      pickBracketSize(teams.length),
    ),
    (d) => fmtWhen(d) ?? "",
  );

  return (
    <div className="space-y-8">
      <PageTitle
        title="Schedule & Standings"
        subtitle={season.name}
        action={
          <a
            href="/api/calendar"
            className="text-xs text-muted hover:text-info"
            title="Subscribe to scheduled matches from your calendar app"
          >
            📅 Calendar (.ics)
          </a>
        }
      />

      <ScheduleCallout label={season.matchSchedule} />

      {myNextMatch ? (
        <CheckinBanner
          matchId={myNextMatch.id}
          heading={`Your next match — Week ${myNextMatch.week}: ${teamName.get(myNextMatch.homeTeamId)} vs ${teamName.get(myNextMatch.awayTeamId)}`}
          when={fmtWhen(myNextMatch.scheduledAt)}
          myRsvp={myRsvp}
          detailsHref={`/matches/${myNextMatch.id}`}
        />
      ) : null}

      {pendingMsg && season.status === "REGULAR_SEASON" ? (
        <div className="flex items-start gap-3 rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-5 py-3 text-sm">
          <span className="text-lg leading-none">⏳</span>
          <div>
            <div className="font-medium">Results outstanding</div>
            <div className="text-muted">
              {`${pendingMsg} Standings & playoff seeding update once they're entered.`}
            </div>
          </div>
        </div>
      ) : null}

      {champion && season.championTeamId ? (
        <Link
          href={`/teams/${season.championTeamId}`}
          className="flex items-center gap-3 rounded-[var(--radius)] border border-amber-400/40 bg-amber-400/10 px-5 py-4 transition-colors hover:border-amber-400/60"
        >
          <div className="relative shrink-0">
            <TeamCrest
              name={champion}
              seed={season.championTeamId}
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
            <div className="text-lg font-bold">{champion}</div>
          </div>
        </Link>
      ) : null}

      <Card>
        <CardHeader title="Standings" />
        <CardBody className="p-0">
          <StandingsTable
            standings={standings}
            teamName={teamName}
            formByTeam={teamForm}
            playoffCut={
              season.status === "REGULAR_SEASON"
                ? pickBracketSize(teams.length)
                : undefined
            }
          />
        </CardBody>
      </Card>

      {playoff.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle>Playoff bracket</SectionTitle>
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
              const isCurrent = week === currentWeek;
              return (
              <div key={week}>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
                  <span className={isCurrent ? "text-fg" : undefined}>
                    Week {week}
                  </span>
                  {isCurrent ? <Badge tone="accent">This week</Badge> : null}
                  {ws ? (
                    <span className={incomplete ? "text-accent" : "text-success"}>
                      {ws.completed}/{ws.total} results in
                    </span>
                  ) : null}
                </h3>
                <Card className={isCurrent ? "border-accent/40" : undefined}>
                  <CardBody className="divide-y divide-line/60 p-0">
                    {regular
                      .filter((m) => m.week === week)
                      .map((m) => (
                        <MatchRow
                          key={m.id}
                          match={m}
                          teamName={teamName}
                          standins={standinsByMatch.get(m.id)}
                          rsvp={rsvpFor(m)}
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

function RsvpBadge({ side }: { side: TeamAvailability }) {
  if (side.confirmed === 0 && side.out === 0) return null;
  const spoken = `${side.confirmed} confirmed${side.out > 0 ? `, ${side.out} unavailable` : ""}`;
  return (
    <span
      role="img"
      aria-label={spoken}
      title={spoken}
      // Hidden on phones — the row needs the width for team names; the
      // same RSVP detail lives one tap away on the match page.
      className="hidden whitespace-nowrap font-mono text-[11px] tabular-nums text-muted sm:inline"
    >
      <span aria-hidden className="text-success">
        ✓{side.confirmed}
      </span>
      {side.out > 0 ? (
        <span aria-hidden className="text-danger">
          {" "}
          ✗{side.out}
        </span>
      ) : null}
    </span>
  );
}

function MatchRow({
  match: m,
  teamName,
  standins,
  rsvp,
}: {
  match: Match;
  teamName: Map<string, string>;
  standins?: MatchStandin[];
  rsvp?: { home: TeamAvailability; away: TeamAvailability };
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
          {rsvp ? <RsvpBadge side={rsvp.home} /> : null}
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
              <span className="hidden sm:inline">{fmtWhen(m.scheduledAt)}</span>
              <span className="sm:hidden">{fmtWhenShort(m.scheduledAt)}</span>
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
          {rsvp ? <RsvpBadge side={rsvp.away} /> : null}
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
