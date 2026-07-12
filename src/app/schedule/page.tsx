import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  clinchStatuses,
  computeStandings,
  standingsMovement,
} from "@/lib/standings";
import {
  byeTeamsByWeek,
  pickBracketSize,
  playoffFirstRound,
  remainingSchedule,
} from "@/lib/schedule";
import { buildBracketRounds, seedMap } from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { formByTeam } from "@/lib/team-matches";
import {
  regularSeasonStatus,
  pendingResultsMessage,
} from "@/lib/schedule-status";
import { teamAvailability, type TeamAvailability } from "@/lib/availability";
import { CheckinBanner } from "@/components/checkin-banner";
import {
  ScheduleWeeks,
  type MatchView,
  type RsvpSide,
  type WeekView,
} from "@/components/schedule-weeks";
import { StandingsTable } from "@/app/page";
import {
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

// Strip the RSVP summary to the two numbers the row badge shows.
function pickRsvp(side: TeamAvailability): RsvpSide {
  return { confirmed: side.confirmed, out: side.out };
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
  const pendingReschedules = await prisma.rescheduleRequest.findMany({
    where: {
      // A proposal on a finished match can't be answered — no chip for it.
      match: { seasonId: season.id, status: { not: "COMPLETED" } },
      status: "PENDING",
    },
    include: { proposedBy: { select: { name: true } } },
  });
  // Structured, not preformatted: the chip's tooltip must render the proposed
  // time in the viewer's timezone (the client formats from the epoch).
  const rescheduleByMatch = new Map(
    pendingReschedules.map((r) => [
      r.matchId,
      {
        by: r.proposedBy.name,
        ts: r.proposedTime ? r.proposedTime.getTime() : null,
        initial: fmtWhen(r.proposedTime),
      },
    ]),
  );

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
  // A side's match-night roster = team roster, minus players covered by a
  // standin (their old ✗ isn't a gap anymore), plus the assigned standins
  // (whose own ✓/✗ is the answer that matters).
  const sideRoster = (m: Match, teamId: string): string[] => {
    const base = rosterByTeam.get(teamId) ?? [];
    const subs = assignments.filter(
      (a) => a.matchId === m.id && a.teamId === teamId,
    );
    if (subs.length === 0) return base;
    const covered = new Set(subs.map((a) => a.replacingUserId));
    return [
      ...base.filter((id) => !covered.has(id)),
      ...subs.map((a) => a.standinUserId),
    ];
  };
  const rsvpFor = (m: Match) =>
    m.status === "COMPLETED"
      ? undefined
      : {
          home: teamAvailability(
            sideRoster(m, m.homeTeamId),
            rsvpsByMatch.get(m.id) ?? [],
          ),
          away: teamAvailability(
            sideRoster(m, m.awayTeamId),
            rsvpsByMatch.get(m.id) ?? [],
          ),
        };

  // The viewer's next unplayed match (rostered players only) for the check-in card.
  const myTeamIds = new Set(
    members.filter((m) => viewer && m.userId === viewer.id).map((m) => m.teamId),
  );
  // Chronological (unscheduled last), not week order — reschedules can move a
  // match past the next week's night; point at whatever plays first.
  const myNextMatch = viewer
    ? [...matches]
        .sort(
          (a, b) =>
            (a.scheduledAt?.getTime() ?? Infinity) -
              (b.scheduledAt?.getTime() ?? Infinity) || a.week - b.week,
        )
        .find(
          (m) =>
            m.status !== "COMPLETED" &&
            (myTeamIds.has(m.homeTeamId) ||
              myTeamIds.has(m.awayTeamId) ||
              // Assigned standins are participants for their match too.
              assignments.some(
                (a) => a.matchId === m.id && a.standinUserId === viewer!.id,
              )),
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

  // Serialize weeks for the client-side ScheduleWeeks (filter chips +
  // collapsible weeks). Dates preformatted server-side.
  const byesByWeek = byeTeamsByWeek(
    regular,
    teams.map((t) => t.id),
  );
  const weekViews: WeekView[] = weeks.map((week) => {
    const ws = weekStatus.get(week);
    const weekMatches = regular
      .filter((m) => m.week === week)
      .map((m): MatchView => {
        return {
          id: m.id,
          homeTeamId: m.homeTeamId,
          awayTeamId: m.awayTeamId,
          homeName: teamName.get(m.homeTeamId) ?? "?",
          awayName: teamName.get(m.awayTeamId) ?? "?",
          homeScore: m.homeScore,
          awayScore: m.awayScore,
          done: m.status === "COMPLETED",
          homeWin: m.winnerTeamId === m.homeTeamId,
          awayWin: m.winnerTeamId === m.awayTeamId,
          whenFull: fmtWhen(m.scheduledAt),
          whenShort: m.scheduledAt ? fmtWhenShort(m.scheduledAt) : null,
          whenTs: m.scheduledAt?.getTime() ?? null,
          isFinalPhase: m.phase === "FINAL",
          standins: (standinsByMatch.get(m.id) ?? []).map(
            (a) =>
              `${a.standin.name} in for ${a.replaced?.name ?? "?"} · ${teamName.get(a.teamId) ?? "?"}`,
          ),
          rsvp: rsvpFor(m) && {
            home: pickRsvp(rsvpFor(m)!.home),
            away: pickRsvp(rsvpFor(m)!.away),
          },
          reschedulePending: rescheduleByMatch.get(m.id) ?? null,
        };
      });
    return {
      week,
      completed: ws?.completed ?? 0,
      total: ws?.total ?? weekMatches.length,
      isCurrent: week === currentWeek,
      matches: weekMatches,
      byes: (byesByWeek.get(week) ?? []).map((id) => ({
        id,
        name: teamName.get(id) ?? "?",
      })),
    };
  });

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
          whenTs={myNextMatch.scheduledAt?.getTime()}
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
            clinch={
              season.status === "REGULAR_SEASON"
                ? clinchStatuses(
                    standings,
                    matches,
                    pickBracketSize(teams.length),
                  )
                : undefined
            }
            viewerTeamId={[...myTeamIds][0]}
            movement={standingsMovement(
              teams.map((t) => t.id),
              matches,
            )}
          />
        </CardBody>
      </Card>

      {season.status === "REGULAR_SEASON" &&
      teams.length > 2 &&
      standings.some((s) => s.played > 0) ? (
        <>
          <PlayoffPicture standings={standings} teamName={teamName} />
          <RunIn
            standings={standings}
            teamName={teamName}
            remaining={remainingSchedule(
              teams.map((t) => t.id),
              matches,
            )}
            playoffCut={pickBracketSize(teams.length)}
          />
        </>
      ) : null}

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
          <ScheduleWeeks
            weeks={weekViews}
            teams={[...teams]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((t) => ({ id: t.id, name: t.name }))}
          />
        )}
      </section>
    </div>
  );
}

// Projected first-round matchups if the season ended today — the same
// seeding rule startPlayoffs will use, over the live table.
function PlayoffPicture({
  standings,
  teamName,
}: {
  standings: ReturnType<typeof computeStandings>;
  teamName: Map<string, string>;
}) {
  const order = standings.map((s) => s.teamId);
  const size = pickBracketSize(order.length);
  const seedOf = new Map(order.slice(0, size).map((id, i) => [id, i + 1]));
  const pairings = playoffFirstRound(order, size);
  return (
    <Card>
      <CardHeader
        title="Playoff picture"
        subtitle="First-round matchups if the season ended today"
      />
      <CardBody className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {pairings.map((p) => (
          <div
            key={p.home}
            className="flex items-center gap-2 rounded-lg border border-line/70 bg-surface-2/30 px-3 py-2 text-sm"
          >
            <ProjectedSide teamId={p.home} seed={seedOf.get(p.home)} teamName={teamName} align="right" />
            <span className="shrink-0 text-xs text-muted">vs</span>
            <ProjectedSide teamId={p.away} seed={seedOf.get(p.away)} teamName={teamName} align="left" />
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

function ProjectedSide({
  teamId,
  seed,
  teamName,
  align,
}: {
  teamId: string;
  seed: number | undefined;
  teamName: Map<string, string>;
  align: "left" | "right";
}) {
  const name = teamName.get(teamId) ?? "?";
  return (
    <Link
      href={`/teams/${teamId}`}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1.5 hover:text-info",
        align === "right" && "flex-row-reverse text-right",
      )}
    >
      <span className="w-4 shrink-0 text-center font-mono text-[10px] tabular-nums text-muted">
        {seed}
      </span>
      <TeamCrest name={name} seed={teamId} size={20} className="shrink-0 rounded" />
      <span className="truncate">{name}</span>
    </Link>
  );
}

// Each team's remaining opponents in week order — the run-in a playoff race
// is decided by. Opponent chips carry their current rank; playoff-bound
// opponents (inside the cut) read as the tough dates.
function RunIn({
  standings,
  teamName,
  remaining,
  playoffCut,
}: {
  standings: ReturnType<typeof computeStandings>;
  teamName: Map<string, string>;
  remaining: Map<string, { week: number; opponentId: string }[]>;
  playoffCut: number;
}) {
  const rankOf = new Map(standings.map((s, i) => [s.teamId, i + 1]));
  const rows = standings.filter(
    (s) => (remaining.get(s.teamId) ?? []).length > 0,
  );
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title="Run-in"
        subtitle="Remaining opponents in week order — #rank shows current form"
      />
      <CardBody className="divide-y divide-line/60 p-0">
        {rows.map((s) => (
          <div
            key={s.teamId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-2.5 text-sm"
          >
            <Link
              href={`/teams/${s.teamId}`}
              className="flex w-44 min-w-0 shrink-0 items-center gap-2 hover:text-info"
            >
              <TeamCrest
                name={teamName.get(s.teamId) ?? "?"}
                seed={s.teamId}
                size={20}
                className="shrink-0 rounded"
              />
              <span className="truncate">{teamName.get(s.teamId) ?? "?"}</span>
            </Link>
            <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {(remaining.get(s.teamId) ?? []).map((r) => {
                const oppRank = rankOf.get(r.opponentId);
                const tough = oppRank != null && oppRank <= playoffCut;
                return (
                  <Link
                    key={`${r.week}-${r.opponentId}`}
                    href={`/teams/${r.opponentId}`}
                    title={`Week ${r.week} vs ${teamName.get(r.opponentId) ?? "?"} (currently #${oppRank})`}
                    className={cn(
                      "flex max-w-[11rem] items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors hover:border-muted/70",
                      tough
                        ? "border-accent/40 text-fg"
                        : "border-line text-muted",
                    )}
                  >
                    <span className="font-mono text-[10px] tabular-nums">
                      #{oppRank}
                    </span>
                    <span className="truncate">
                      {teamName.get(r.opponentId) ?? "?"}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
