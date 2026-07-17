import Link from "next/link";
import { Suspense } from "react";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { WeekReminderPing } from "@/components/week-reminder-ping";
import { prisma } from "@/lib/prisma";
import { computeStandings, standingsMovement } from "@/lib/standings";
import { clinchFromReport, seasonScenarioReport } from "@/lib/stakes";
import type { ScenarioReport } from "@/lib/scenarios";
import { crossTable, type CrossCell, type CrossMatch } from "@/lib/cross-table";
import {
  byeTeamsByWeek,
  groupPlayoffRounds,
  pickBracketSize,
  playoffFirstRound,
  remainingSchedule,
  roundName,
} from "@/lib/schedule";
import { formatMatchTime } from "@/lib/match-time";
import { buildBracketRounds, seedsFromFirstRound } from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { formByTeam } from "@/lib/team-matches";
import {
  regularSeasonStatus,
  pendingResultsMessage,
} from "@/lib/schedule-status";
import {
  matchNightRoster,
  teamAvailability,
  type TeamAvailability,
} from "@/lib/availability";
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
  // Shared standin-aware roster math — the dashboard's ThisWeek strip uses
  // the same helper, so the two surfaces can't drift.
  const sideRoster = (m: Match, teamId: string): string[] =>
    matchNightRoster(
      rosterByTeam.get(teamId) ?? [],
      assignments.filter((a) => a.matchId === m.id && a.teamId === teamId),
    );
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
  // The scenario engine's report drives the refined clinch marks and the
  // playoff-race notes — only a live regular season has a race to compute.
  const stakesReport =
    season.status === "REGULAR_SEASON"
      ? seasonScenarioReport(standings, matches, teams.length)
      : null;

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
  // collapsible weeks). Dates preformatted server-side. Shared with the
  // playoff round list below so RSVP/standin/reschedule chips work everywhere.
  const toMatchView = (m: Match): MatchView => ({
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
  });
  // The week's league night = its earliest kickoff (headers stay scannable
  // even when the weeks are collapsed).
  const earliestScheduled = (ms: Match[]): Date | null =>
    ms.reduce<Date | null>(
      (min, m) =>
        m.scheduledAt && (!min || m.scheduledAt < min) ? m.scheduledAt : min,
      null,
    );
  const byesByWeek = byeTeamsByWeek(
    regular,
    teams.map((t) => t.id),
  );
  const weekViews: WeekView[] = weeks.map((week) => {
    const ws = weekStatus.get(week);
    const raw = regular.filter((m) => m.week === week);
    const night = earliestScheduled(raw);
    return {
      week,
      completed: ws?.completed ?? 0,
      total: ws?.total ?? raw.length,
      isCurrent: week === currentWeek,
      matches: raw.map(toMatchView),
      byes: (byesByWeek.get(week) ?? []).map((id) => ({
        id,
        name: teamName.get(id) ?? "?",
      })),
      nightTs: night?.getTime() ?? null,
      nightInitial: night ? formatMatchTime(night, "date") : null,
    };
  });

  // Playoff rounds as schedule rows too — the bracket alone carries no RSVP
  // counts, standin lines, or reschedule chips. groupPlayoffRounds only holds
  // real matches, so TBD slots never render a row.
  const playoffGrouping = groupPlayoffRounds(playoff);
  const playoffRoundViews: WeekView[] = playoffGrouping.rounds.map((r) => {
    const night = earliestScheduled(r.matches);
    return {
      week: r.matches[0]?.week ?? r.round + 1,
      label: roundName(r.round, playoffGrouping.totalRounds),
      completed: r.matches.filter((m) => m.status === "COMPLETED").length,
      total: r.matches.length,
      isCurrent: false,
      matches: r.matches.map(toMatchView),
      byes: [],
      nightTs: night?.getTime() ?? null,
      nightInitial: night ? formatMatchTime(night, "date") : null,
    };
  });

  // Full bracket tree (TBD slots included) for the interactive bracket.
  const bracketRoundsView = buildBracketRounds(
    playoff,
    teamName,
    // Seeds come from the frozen first-round pairings, not live standings —
    // a corrected regular result must not relabel (or blank) bracket seeds.
    seedsFromFirstRound(playoff),
    (d) => fmtWhen(d) ?? "",
  );

  return (
    <div className="space-y-8">
      {/* Lazy match-night Discord reminder — invisible, never blocks paint. */}
      <Suspense fallback={null}>
        <WeekReminderPing season={season} />
      </Suspense>
      <PageTitle
        title="Schedule & Standings"
        subtitle={season.name}
        action={
          <div className="flex items-center gap-3">
            {currentWeek != null ? (
              <a href="#this-week" className="text-xs text-muted hover:text-info">
                This week ↓
              </a>
            ) : null}
            <a
              href="/api/calendar"
              className="text-xs text-muted hover:text-info"
              title="Subscribe to scheduled matches from your calendar app"
            >
              📅 Calendar (.ics)
            </a>
          </div>
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
            clinch={clinchFromReport(stakesReport)}
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
          <PlayoffPicture
            standings={standings}
            teamName={teamName}
            report={stakesReport}
          />
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
          {playoffRoundViews.length > 0 ? (
            // teams={[]} suppresses the filter chips — a bracket is too small
            // to need filtering, but the rows keep RSVP/standin/⏳ chips.
            <ScheduleWeeks weeks={playoffRoundViews} teams={[]} />
          ) : null}
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
          <>
            {teams.length > 1 ? (
              <SeasonGrid
                standings={standings}
                teamName={teamName}
                matches={matches}
              />
            ) : null}
            <ScheduleWeeks
              weeks={weekViews}
              teams={[...teams]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((t) => ({ id: t.id, name: t.name }))}
            />
          </>
        )}
      </section>
    </div>
  );
}

// The season at a glance: a who's-played-who grid in standings order — every
// cell is that meeting's result from the ROW team's side, linking to the
// match. Wide by nature, so it scrolls inside its own container on phones.
function SeasonGrid({
  standings,
  teamName,
  matches,
}: {
  standings: ReturnType<typeof computeStandings>;
  teamName: Map<string, string>;
  matches: CrossMatch[];
}) {
  const order = standings.map((s) => s.teamId);
  const table = crossTable(order, matches);
  const rankOf = new Map(order.map((id, i) => [id, i + 1]));

  const cellChip = (rowId: string, cell: CrossCell) => {
    const rowName = teamName.get(rowId) ?? "?";
    const label = cell.played
      ? `${rowName} ${
          cell.result === "W" ? "won" : cell.result === "L" ? "lost" : "drew"
        } ${cell.score} in week ${cell.week}`
      : cell.live
        ? `Week ${cell.week} — series in progress`
        : `Week ${cell.week} — not played yet`;
    return (
      <Link
        key={cell.matchId}
        href={`/matches/${cell.matchId}`}
        aria-label={label}
        title={label}
        className={cn(
          "block rounded px-1 py-0.5 font-mono text-[11px] tabular-nums transition-colors",
          cell.result === "W" && "bg-success/15 text-success hover:bg-success/25",
          cell.result === "L" && "bg-danger/10 text-danger/90 hover:bg-danger/20",
          cell.result === "D" && "bg-accent/15 text-accent hover:bg-accent/25",
          !cell.played && "text-muted hover:text-info",
        )}
      >
        {cell.played ? cell.score : `wk ${cell.week}`}
      </Link>
    );
  };

  return (
    <Card>
      <CardHeader
        title="Season grid"
        subtitle="Who's played who — each cell is the row team's result in that meeting"
      />
      <CardBody className="overflow-x-auto p-0">
        <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 border-b border-line bg-surface px-4 py-2" />
              {order.map((colId) => (
                <th
                  key={colId}
                  scope="col"
                  className="border-b border-line px-1.5 py-2 text-center"
                >
                  <Link
                    href={`/teams/${colId}`}
                    title={teamName.get(colId) ?? "?"}
                    className="inline-flex flex-col items-center gap-0.5"
                  >
                    <TeamCrest
                      name={teamName.get(colId) ?? "?"}
                      seed={colId}
                      size={22}
                      className="rounded"
                    />
                    <span className="sr-only">{teamName.get(colId)}</span>
                    <span
                      aria-hidden
                      className="font-mono text-[10px] tabular-nums text-muted"
                    >
                      #{rankOf.get(colId)}
                    </span>
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {order.map((rowId) => (
              <tr key={rowId}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-line/60 bg-surface px-4 py-1.5 text-left font-normal"
                >
                  <Link
                    href={`/teams/${rowId}`}
                    className="flex min-w-0 max-w-[11rem] items-center gap-2 hover:text-info"
                  >
                    <span className="w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted">
                      {rankOf.get(rowId)}
                    </span>
                    <TeamCrest
                      name={teamName.get(rowId) ?? "?"}
                      seed={rowId}
                      size={20}
                      className="shrink-0 rounded"
                    />
                    <span className="truncate">{teamName.get(rowId) ?? "?"}</span>
                  </Link>
                </th>
                {order.map((colId) => {
                  if (colId === rowId) {
                    return (
                      // Stays in the accessibility tree (empty, not
                      // aria-hidden) so screen readers keep every row's
                      // column mapping aligned with the header row.
                      <td
                        key={colId}
                        className="border-b border-line/60 bg-surface-2/60 px-1.5 py-1.5"
                      />
                    );
                  }
                  const meetings = table.cells.get(rowId)!.get(colId)!;
                  return (
                    <td
                      key={colId}
                      className="border-b border-line/60 px-1.5 py-1.5 text-center align-middle"
                    >
                      {meetings.length === 0 ? (
                        <span
                          role="img"
                          aria-label="No meeting scheduled"
                          className="text-xs text-muted/50"
                        >
                          <span aria-hidden>—</span>
                        </span>
                      ) : (
                        <span className="inline-flex flex-col gap-0.5">
                          {meetings.map((cell) => cellChip(rowId, cell))}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}

// Projected first-round matchups if the season ended today — the same
// seeding rule startPlayoffs will use, over the live table — plus what each
// team in the race still needs, from the exact scenario engine.
function PlayoffPicture({
  standings,
  teamName,
  report,
}: {
  standings: ReturnType<typeof computeStandings>;
  teamName: Map<string, string>;
  report: ScenarioReport | null;
}) {
  const order = standings.map((s) => s.teamId);
  const size = pickBracketSize(order.length);
  const seedOf = new Map(order.slice(0, size).map((id, i) => [id, i + 1]));
  const pairings = playoffFirstRound(order, size);

  // One line per team whose fate is still open — what tonight/this week means.
  const raceNotes = order
    .map((teamId) => {
      const s = report?.teams.get(teamId);
      if (!s || s.status !== null) return null;
      const bits: string[] = [];
      if (s.nextMatchId === null) {
        // Fate open with nothing left to play — other results (and maybe
        // tiebreakers) decide; the scenario bit below carries the odds.
        bits.push("done playing — waiting on other results");
      } else {
        if (s.winAndIn && s.loseAndOut)
          bits.push("win next and in, lose and out");
        else if (s.winAndIn) bits.push("win next and they're in");
        else if (s.loseAndOut) bits.push("lose next and they're out");
        if (s.magicNumber != null && s.magicNumber > 0 && !s.winAndIn)
          bits.push(`magic number ${s.magicNumber}`);
      }
      if (s.exact && s.madeCount != null && s.leafCount) {
        if (s.madeCount > 0) {
          // Guard on madeCount, not the rounded percent — a sub-0.5% path is
          // still a real points-only path, not "no scenario".
          const pct = Math.round((s.madeCount / s.leafCount) * 100);
          bits.push(`in ${pct > 0 ? `${pct}%` : "<1%"} of scenarios`);
        } else {
          // Never safe on points alone ≠ doomed — ties could still save them.
          bits.push("needs tiebreaks to fall right");
        }
      }
      if (bits.length === 0) return null;
      return { teamId, note: bits.join(" · ") };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);

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
        {raceNotes.length > 0 ? (
          <div className="sm:col-span-2">
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
              The race{report?.exact ? "" : " (points bounds)"}
            </div>
            <ul className="space-y-1">
              {raceNotes.map((n) => (
                <li
                  key={n.teamId}
                  className="flex min-w-0 items-center gap-2 text-sm"
                >
                  <TeamCrest
                    name={teamName.get(n.teamId) ?? "?"}
                    seed={n.teamId}
                    size={18}
                    className="shrink-0 rounded"
                  />
                  <Link
                    href={`/teams/${n.teamId}`}
                    className="max-w-[10rem] truncate hover:text-info"
                  >
                    {teamName.get(n.teamId) ?? "?"}
                  </Link>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted">
                    {n.note}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
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
