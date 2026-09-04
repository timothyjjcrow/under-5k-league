import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeStandings, standingsMovement } from "@/lib/standings";
import { clinchFromReport, seasonScenarioReport } from "@/lib/stakes";
import { projectPlayoffField } from "@/lib/playoff-field";
import type { ScenarioReport } from "@/lib/scenarios";
import { crossTable, type CrossCell, type CrossMatch } from "@/lib/cross-table";
import {
  byeTeamsByWeek,
  byKickoff,
  groupPlayoffRounds,
  pickBracketSize,
  playoffFirstRound,
  remainingSchedule,
  roundName,
} from "@/lib/schedule";
import { formatMatchTime } from "@/lib/match-time";
import { ChampionBanner } from "@/components/champion-banner";
import { buildBracketRounds, seedsFromFirstRound } from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { formByTeam } from "@/lib/team-matches";
import {
  regularSeasonStatus,
  pendingResultsMessage,
} from "@/lib/schedule-status";
import {
  expectedSideSize,
  matchNightRoster,
  teamAvailability,
  type TeamAvailability,
} from "@/lib/availability";
import { matchCheckinOpen, postAuctionWorkOpen } from "@/lib/league-lifecycle";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { AUTO_SYNC } from "@/lib/constants";
import { CheckinBanner } from "@/components/checkin-banner";
import {
  ScheduleWeeks,
  type MatchView,
  type RsvpSide,
  type WeekView,
} from "@/components/schedule-weeks";
import { StandingsTable } from "@/components/standings-table-server";
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  ScheduleCallout,
  SectionTitle,
  TeamCrest,
  buttonClasses,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  canViewAvailabilitySummary,
  hasActiveLeagueParticipation,
} from "@/lib/visibility";
import type { Match, StandinAssignment, User } from "@prisma/client";

export const metadata = { title: "Schedule" };

type MatchStandin = StandinAssignment & {
  standin: User;
  replaced: User | null;
};

// Both delegate to formatMatchTime — these strings are LocalTime hydration
// snapshots, so drifting from the client's formatter causes flicker.
// "full" keeps the weekday ("Sat" is what players actually plan around);
// "short" is the phone-width variant where it doesn't fit between team names.
function fmtWhen(d: Date | null): string | null {
  return d ? formatMatchTime(d, "full") : null;
}

function fmtWhenShort(d: Date): string {
  return formatMatchTime(d, "short");
}

// Strip the RSVP summary to the two numbers the row badge shows.
function pickRsvp(side: TeamAvailability, expected: number): RsvpSide {
  return { confirmed: side.confirmed, out: side.out, expected };
}

function calloutDescription(status: string): string {
  if (status === "SIGNUPS")
    return "Games run weekly. Confirm this slot works before you sign up.";
  if (status === "DRAFT")
    return "This is the default weekly slot. Exact kickoffs appear once the schedule is published.";
  if (status === "REGULAR_SEASON")
    return "Use the exact kickoffs below, then check in for the next match you're playing.";
  if (status === "PLAYOFFS")
    return "Playoff nights may move by round. Use the exact kickoff shown for each match.";
  return "The season is complete. The fixtures and results below are read-only history.";
}

function emptyScheduleCopy(status: string, draftStatus?: string | null) {
  if (status === "SIGNUPS")
    return {
      title: "Schedule opens after the draft",
      description:
        "Teams and rosters are still forming. Fixtures can be published once the auction is complete.",
    };
  if (status === "DRAFT" && draftStatus !== "COMPLETE")
    return {
      title: "Draft in progress",
      description:
        "The regular-season schedule stays locked until every auction result is final.",
    };
  if (status === "DRAFT")
    return {
      title: "Schedule not published yet",
      description:
        "The auction is complete. An administrator now needs to choose the first match night and generate the fixtures.",
    };
  if (status === "REGULAR_SEASON")
    return {
      title: "Regular-season schedule missing",
      description:
        "The season is underway, but no regular fixtures are published. An administrator should generate them before players check in.",
    };
  if (status === "PLAYOFFS")
    return {
      title: "No regular-season fixtures available",
      description:
        "The playoff bracket is shown above. The regular-season history is unavailable for this season.",
    };
  return {
    title: "No regular-season history",
    description: "This completed season has no regular fixtures to display.",
  };
}

export default async function SchedulePage() {
  const season = await getActiveSeason();
  if (!season) {
    return (
      <div>
        <PageTitle title="Schedule" />
        <EmptyState
          title="No active season"
          description="There is no live league schedule right now. Browse past seasons or join an inhouse game while the next season is prepared."
          action={
            <div className="flex flex-wrap justify-center gap-2 text-sm">
              <Link href="/seasons" className="text-info hover:underline">
                Browse past seasons →
              </Link>
              <Link href="/inhouse" className="text-info hover:underline">
                Find an inhouse →
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  const viewer = await getSessionUser();
  const [viewerRegistration, viewerTeamRole] = viewer
    ? await Promise.all([
        prisma.registration.findUnique({
          where: {
            seasonId_userId: { seasonId: season.id, userId: viewer.id },
          },
          select: { status: true },
        }),
        prisma.team.findFirst({
          where: {
            seasonId: season.id,
            OR: [
              { captainId: viewer.id },
              { members: { some: { userId: viewer.id } } },
            ],
          },
          select: { id: true },
        }),
      ])
    : [null, null];
  const showRsvpSummaries = canViewAvailabilitySummary(
    viewer,
    hasActiveLeagueParticipation(
      viewerRegistration?.status === "ACTIVE",
      !!viewerTeamRole,
    ),
  );
  const [teams, matches, assignments, members, rsvps, draft] =
    await Promise.all([
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
      showRsvpSummaries
        ? prisma.matchAvailability.findMany({
            where: { match: { seasonId: season.id } },
            select: { matchId: true, userId: true, status: true },
          })
        : Promise.resolve([]),
      prisma.draft.findUnique({
        where: { seasonId: season.id },
        select: { status: true },
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
  const teamLogoUrl = new Map(teams.map((t) => [t.id, t.logoUrl]));

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
  const rsvpFor = (m: Match) => {
    if (!showRsvpSummaries) return undefined;
    if (
      !matchCheckinOpen(season.status, draft?.status, m.status, m.scheduledAt)
    )
      return undefined;
    const homeRoster = sideRoster(m, m.homeTeamId);
    const awayRoster = sideRoster(m, m.awayTeamId);
    return {
      home: {
        summary: teamAvailability(homeRoster, rsvpsByMatch.get(m.id) ?? []),
        expected: expectedSideSize(season.teamSize, homeRoster.length),
      },
      away: {
        summary: teamAvailability(awayRoster, rsvpsByMatch.get(m.id) ?? []),
        expected: expectedSideSize(season.teamSize, awayRoster.length),
      },
    };
  };

  // The viewer's next unplayed match (rostered players only) for the check-in card.
  const myTeamIds = new Set(
    members
      .filter((m) => viewer && m.userId === viewer.id)
      .map((m) => m.teamId),
  );
  // Chronological, not week order — reschedules can move a fixture past the
  // next week's night. Only a timed, still-actionable match gets a check-in
  // prompt. An unreported old fixture is called out as overdue below instead
  // of trapping the player on a stale RSVP forever.
  // Async server component: Date.now is request-time state, not render replay.
  // eslint-disable-next-line react-hooks/purity
  const freshFrom = Date.now() - AUTO_SYNC.WINDOW_HOURS * 3600_000;
  const myNextMatch = viewer
    ? [...matches]
        .sort(byKickoff)
        .find(
          (m) =>
            matchCheckinOpen(
              season.status,
              draft?.status,
              m.status,
              m.scheduledAt,
            ) &&
            m.scheduledAt!.getTime() >= freshFrom &&
            (sideRoster(m, m.homeTeamId).includes(viewer.id) ||
              sideRoster(m, m.awayTeamId).includes(viewer.id)),
        )
    : undefined;
  const myRsvp = myNextMatch
    ? ((rsvpsByMatch.get(myNextMatch.id) ?? []).find(
        (r) => r.userId === viewer!.id,
      )?.status ?? null)
    : null;
  const standinsByMatch = new Map<string, MatchStandin[]>();
  for (const a of assignments) {
    const arr = standinsByMatch.get(a.matchId) ?? [];
    arr.push(a);
    standinsByMatch.set(a.matchId, arr);
  }
  const playoffField = projectPlayoffField(teams, matches);
  const standings = playoffField.standings;
  const teamForm = formByTeam(
    teams.map((t) => t.id),
    matches,
  );
  // The scenario engine's report drives the refined clinch marks and the
  // playoff-race notes — only a live regular season has a race to compute.
  const stakesReport =
    season.status === "REGULAR_SEASON"
      ? seasonScenarioReport(
          playoffField.eligibleStandings,
          matches,
          playoffField.eligibleTeamIds.length,
        )
      : null;

  const regular = matches.filter((m) => m.phase === "REGULAR");
  const playoff = matches.filter((m) => m.phase !== "REGULAR");
  const weeks = [...new Set(regular.map((m) => m.week))].sort((a, b) => a - b);
  const status = regularSeasonStatus(matches);
  const weekStatus = new Map(status.weeks.map((w) => [w.week, w]));
  const pendingMsg = pendingResultsMessage(status);
  const untimedOpen = matches.filter(
    (m) => m.status === "SCHEDULED" && m.scheduledAt == null,
  );
  const scheduleEditingOpen = postAuctionWorkOpen(season.status, draft?.status);
  // "This week" is the first live/fresh slate, not simply the oldest missing
  // result. A stale week stays visible with an explicit overdue badge but no
  // longer mislabels itself as tonight's games.
  const currentWeek =
    season.status === "REGULAR_SEASON"
      ? weeks.find((w) =>
          regular.some(
            (m) =>
              m.week === w &&
              m.status !== "COMPLETED" &&
              (m.status === "LIVE" ||
                (m.scheduledAt?.getTime() ?? -Infinity) >= freshFrom),
          ),
        )
      : undefined;

  const championPresentation = resolveChampionPresentation(season, matches);
  const champion =
    championPresentation.championTeamId &&
    teamName.get(championPresentation.championTeamId)
      ? teamName.get(championPresentation.championTeamId)
      : null;

  // Serialize weeks for the client-side ScheduleWeeks (filter chips +
  // collapsible weeks). Dates preformatted server-side. Shared with the
  // playoff round list below so RSVP/standin/reschedule chips work everywhere.
  const toMatchView = (m: Match): MatchView => {
    // Once per match — each call scans the season's whole assignment list
    // for both sides, and this used to run three times per row.
    const rsvp = rsvpFor(m);
    return {
      id: m.id,
      homeTeamId: m.homeTeamId,
      awayTeamId: m.awayTeamId,
      homeName: teamName.get(m.homeTeamId) ?? "?",
      awayName: teamName.get(m.awayTeamId) ?? "?",
      homeLogoUrl: teamLogoUrl.get(m.homeTeamId) ?? null,
      awayLogoUrl: teamLogoUrl.get(m.awayTeamId) ?? null,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
      done: m.status === "COMPLETED",
      forfeit: m.forfeit,
      live: m.status === "LIVE",
      homeWin: m.winnerTeamId === m.homeTeamId,
      awayWin: m.winnerTeamId === m.awayTeamId,
      whenFull: fmtWhen(m.scheduledAt),
      whenShort: m.scheduledAt ? fmtWhenShort(m.scheduledAt) : null,
      whenTs: m.scheduledAt?.getTime() ?? null,
      isFinalPhase: m.phase === "FINAL",
      standins: (standinsByMatch.get(m.id) ?? []).map((a) =>
        // A null `replaced` is EMPTY-SEAT cover (a standin filling an open
        // seat on a short roster), not missing data — the match page and the
        // admin card both say so, and this line used to render a literal "?"
        // on the league's main public fixture list instead.
        a.replaced
          ? `${a.standin.name} in for ${a.replaced.name} · ${teamName.get(a.teamId) ?? "?"}`
          : `${a.standin.name} filling an open seat · ${teamName.get(a.teamId) ?? "?"}`,
      ),
      rsvp: rsvp && {
        home: pickRsvp(rsvp.home.summary, rsvp.home.expected),
        away: pickRsvp(rsvp.away.summary, rsvp.away.expected),
      },
      reschedulePending: rescheduleByMatch.get(m.id) ?? null,
    };
  };
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
      isOverdue:
        (ws?.pending ?? 0) > 0 &&
        raw
          .filter((m) => m.status !== "COMPLETED")
          .every(
            (m) =>
              m.status !== "LIVE" &&
              m.scheduledAt != null &&
              m.scheduledAt.getTime() < freshFrom,
          ),
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
      isOverdue: false,
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
    teamLogoUrl,
  );
  const postseasonPhase =
    season.status === "PLAYOFFS" || season.status === "COMPLETE";
  const postseasonSection = postseasonPhase ? (
    <section id="playoff-bracket" className="scroll-mt-20 space-y-4">
      <SectionTitle>Playoff bracket</SectionTitle>
      {playoff.length > 0 ? (
        <>
          {/* Bracket owns horizontal scrolling; the card clips its intrinsic
              desktop width so phones never gain document-level overflow. */}
          <Card className="overflow-hidden">
            <CardBody className="p-0 pt-4">
              <Bracket
                rounds={bracketRoundsView}
                championTeamId={championPresentation.championTeamId}
              />
            </CardBody>
          </Card>
          {playoffRoundViews.length > 0 ? (
            <ScheduleWeeks weeks={playoffRoundViews} teams={[]} />
          ) : null}
        </>
      ) : (
        <EmptyState
          title={
            season.status === "COMPLETE"
              ? "No playoff bracket is recorded"
              : "The playoff bracket needs recovery"
          }
          description={
            season.status === "COMPLETE"
              ? championPresentation.championTeamId
                ? "This completed season does not include saved playoff fixtures. Its recorded champion and regular-season results remain available below."
                : "This season is marked complete without playoff fixtures. An administrator must return it to Regular season, verify the table, and use Start playoffs to create an authoritative bracket."
              : "The league is in Playoffs without first-round fixtures. An administrator must return it to Regular season, verify the table, and use Start playoffs so seeding and the phase change happen together."
          }
          action={
            viewer?.role === "ADMIN" &&
            !(
              season.status === "COMPLETE" &&
              championPresentation.championTeamId
            ) ? (
              <Link
                href="/admin#playoffs"
                className={buttonClasses("secondary", "sm")}
              >
                Open playoff controls →
              </Link>
            ) : undefined
          }
        />
      )}
    </section>
  ) : null;

  return (
    <div className="space-y-8">
      <PageTitle
        title={
          season.status === "COMPLETE"
            ? "Season results"
            : season.status === "PLAYOFFS"
              ? "Playoffs"
              : "Schedule & Standings"
        }
        subtitle={season.name}
        action={
          <div className="flex items-center gap-3">
            {currentWeek != null ? (
              <a
                href="#this-week"
                className="py-1 -my-1 text-xs text-muted hover:text-info"
              >
                This week ↓
              </a>
            ) : null}
            {matches.some((m) => m.scheduledAt) ? (
              <a
                href="/api/calendar"
                className="py-1 -my-1 text-xs text-muted hover:text-info"
                title="Download the active season's calendar feed"
              >
                📅 Calendar feed (.ics)
              </a>
            ) : null}
          </div>
        }
      />

      <nav aria-label="Schedule sections" className="flex flex-wrap gap-3 text-sm">
        <a href="#fixtures" className="inline-flex min-h-11 items-center text-info hover:underline">Fixtures</a>
        <a href="#standings" className="inline-flex min-h-11 items-center text-info hover:underline">Standings & analysis</a>
      </nav>
      <ScheduleCallout
        label={season.matchSchedule}
        description={calloutDescription(season.status)}
      />

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

      {scheduleEditingOpen && untimedOpen.length > 0 ? (
        <div className="flex items-start gap-3 rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-5 py-3 text-sm">
          <span aria-hidden className="text-lg leading-none">
            🕒
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-medium">Kickoff times still needed</div>
            <div className="text-muted">
              {untimedOpen.length} fixture
              {untimedOpen.length === 1 ? " has" : "s have"} no published time.
              Check-ins, reminders, automatic result sync and pick&apos;em locks
              stay off until {untimedOpen.length === 1 ? "it is" : "they are"}{" "}
              scheduled.
            </div>
          </div>
          {viewer?.role === "ADMIN" ? (
            <Link
              href="/admin#adm-schedule"
              className="shrink-0 text-xs text-info hover:underline"
            >
              Set times →
            </Link>
          ) : null}
        </div>
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

      {champion && championPresentation.championTeamId ? (
        <ChampionBanner
          teamId={championPresentation.championTeamId}
          teamName={champion}
          teamLogoUrl={teamLogoUrl.get(
            championPresentation.championTeamId,
          )}
          seasonName={season.name}
        />
      ) : null}

      {season.status === "COMPLETE" && !championPresentation.championTeamId ? (
        <div className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-5 py-3 text-sm">
          <div className="font-medium">Champion state needs review</div>
          <p className="mt-1 text-muted">
            This season is marked complete without an authoritative champion.
            The results remain visible, but no title is attributed until
            administrators{" "}
            {playoff.length > 0
              ? "return it to Playoffs and reconcile the existing grand final."
              : "return it to Regular season, verify the table, and seed a new playoff bracket."}
          </p>
        </div>
      ) : null}

      {postseasonSection}

      <div id="fixtures" className="scroll-mt-24 space-y-8">
        <section className="space-y-4">
          <SectionTitle>Regular season</SectionTitle>
          {regular.length === 0 ? (
            (() => {
              const copy = emptyScheduleCopy(season.status, draft?.status);
              return (
                <EmptyState
                  title={copy.title}
                  description={copy.description}
                  action={
                    viewer?.role === "ADMIN" ? (
                      <Link
                        href="/admin#adm-schedule"
                        className="text-sm text-info hover:underline"
                      >
                        Open schedule controls →
                      </Link>
                    ) : undefined
                  }
                />
              );
            })()
          ) : (
            <>
              <ScheduleWeeks
                weeks={[...weekViews].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.week - b.week)}
                initialTeamId={[...myTeamIds][0]}
                teams={[...teams]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((t) => ({
                    id: t.id,
                    name: t.name,
                    logoUrl: t.logoUrl,
                  }))}
              />
            </>
          )}
        </section>
      </div>

      <Card id="standings" className="scroll-mt-24">
        <CardHeader headingLevel={2} title="Standings" />
        <CardBody className="p-0">
          <StandingsTable
            standings={standings}
            teamName={teamName}
            teamLogoUrl={teamLogoUrl}
            eligibleTeams={playoffField.eligibleTeamIds.length}
            withdrawnIds={
              new Set(teams.filter((t) => t.withdrawn).map((t) => t.id))
            }
            formByTeam={teamForm}
            playoffCut={
              season.status === "REGULAR_SEASON"
                ? playoffField.bracketSize
                : undefined
            }
            playoffSeedByTeam={playoffField.seedByTeam}
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
      playoffField.eligibleTeamIds.length > 2 &&
      standings.some((s) => s.played > 0) ? (
        <>
          <PlayoffPicture
            standings={playoffField.eligibleStandings}
            teamName={teamName}
            teamLogoUrl={teamLogoUrl}
            report={stakesReport}
          />
          <RunIn
            standings={playoffField.eligibleStandings}
            teamName={teamName}
            teamLogoUrl={teamLogoUrl}
            remaining={remainingSchedule(playoffField.eligibleTeamIds, matches)}
            playoffCut={playoffField.bracketSize}
          />
        </>
      ) : null}


              {teams.length > 1 ? (
                <SeasonGrid
                  standings={standings}
                  teamName={teamName}
                  teamLogoUrl={teamLogoUrl}
                  matches={matches}
                />
              ) : null}
    </div>
  );
}

// The season at a glance: a who's-played-who grid in standings order — every
// cell is that meeting's result from the ROW team's side, linking to the
// match. Wide by nature, so it scrolls inside its own container on phones.
function SeasonGrid({
  standings,
  teamName,
  teamLogoUrl,
  matches,
}: {
  standings: ReturnType<typeof computeStandings>;
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
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
          "block rounded px-1 py-1.5 font-mono text-[11px] tabular-nums transition-colors",
          cell.result === "W" &&
            "bg-success/15 text-success hover:bg-success/25",
          cell.result === "L" && "bg-danger/10 text-danger hover:bg-danger/20",
          cell.result === "D" && "bg-accent/15 text-accent hover:bg-accent/25",
          !cell.played && "text-muted hover:text-info",
        )}
      >
        {cell.played ? cell.score : `wk ${cell.week}`}
      </Link>
    );
  };

  return (
    // overflow-hidden on the CARD is load-bearing: Chrome adds the inner
    // scroller's full table width to the page's scroll area through the
    // card otherwise, giving every phone a 100px+ horizontal page scroll
    // (caught by the mid-season mobile e2e). It also clips the table's
    // square corners to the card radius while scrolling.
    <Card className="overflow-hidden">
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
                    className="inline-flex min-w-6 flex-col items-center gap-0.5 py-1 -my-1"
                  >
                    <TeamCrest
                      name={teamName.get(colId) ?? "?"}
                      seed={colId}
                      logoUrl={teamLogoUrl.get(colId)}
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
                    className="flex min-w-0 max-w-[11rem] items-center gap-2 py-1 -my-1 hover:text-info"
                  >
                    <span className="w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted">
                      {rankOf.get(rowId)}
                    </span>
                    <TeamCrest
                      name={teamName.get(rowId) ?? "?"}
                      seed={rowId}
                      logoUrl={teamLogoUrl.get(rowId)}
                      size={20}
                      className="shrink-0 rounded"
                    />
                    <span className="truncate">
                      {teamName.get(rowId) ?? "?"}
                    </span>
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
                          className="text-xs text-muted"
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
  teamLogoUrl,
  report,
}: {
  standings: ReturnType<typeof computeStandings>;
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
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
        // tiebreakers) decide; the scenario bit below carries the equal-weight
        // outcome share, not a predictive probability.
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
          bits.push(
            `safe in ${pct > 0 ? `${pct}%` : "<1%"} of equal-weight result combinations`,
          );
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
        headingLevel={2}
        title="Playoff picture"
        subtitle="First-round matchups if the season ended today"
      />
      <CardBody className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {pairings.map((p) => (
          <div
            key={p.home}
            className="flex items-center gap-2 rounded-lg border border-line/70 bg-surface-2/30 px-3 py-2 text-sm"
          >
            <ProjectedSide
              teamId={p.home}
              seed={seedOf.get(p.home)}
              teamName={teamName}
              teamLogoUrl={teamLogoUrl}
              align="right"
            />
            <span className="shrink-0 text-xs text-muted">vs</span>
            <ProjectedSide
              teamId={p.away}
              seed={seedOf.get(p.away)}
              teamName={teamName}
              teamLogoUrl={teamLogoUrl}
              align="left"
            />
          </div>
        ))}
        {raceNotes.length > 0 ? (
          <div className="sm:col-span-2">
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
              The race{report?.exact ? "" : " (points bounds)"}
            </div>
            <ul className="space-y-2">
              {raceNotes.map((n) => (
                <li
                  key={n.teamId}
                  className="flex min-w-0 items-center gap-2 text-sm"
                >
                  <TeamCrest
                    name={teamName.get(n.teamId) ?? "?"}
                    seed={n.teamId}
                    logoUrl={teamLogoUrl.get(n.teamId)}
                    size={18}
                    className="shrink-0 rounded"
                  />
                  <Link
                    href={`/teams/${n.teamId}`}
                    className="max-w-[10rem] truncate py-1 -my-1 hover:text-info"
                  >
                    {teamName.get(n.teamId) ?? "?"}
                  </Link>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted">
                    {n.note}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">
              Scenario shares count every remaining win, loss, and draw
              combination equally; they are not forecasts or betting odds.
              “Safe” counts a tied cutoff against the team.
            </p>
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
  teamLogoUrl,
  align,
}: {
  teamId: string;
  seed: number | undefined;
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
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
      <TeamCrest
        name={name}
        seed={teamId}
        logoUrl={teamLogoUrl.get(teamId)}
        size={20}
        className="shrink-0 rounded"
      />
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
  teamLogoUrl,
  remaining,
  playoffCut,
}: {
  standings: ReturnType<typeof computeStandings>;
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
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
        headingLevel={2}
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
              className="flex w-32 min-w-0 shrink-0 items-center gap-2 py-1 -my-1 hover:text-info sm:w-44"
            >
              <TeamCrest
                name={teamName.get(s.teamId) ?? "?"}
                seed={s.teamId}
                logoUrl={teamLogoUrl.get(s.teamId)}
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
                      // min-w-0 matters: a wrap-line chip wider than the
                      // remaining row width must truncate, not push the page
                      // wider (CLAUDE.md mobile rules — a long team name once
                      // gave /schedule a 26px horizontal scroll on phones).
                      "flex min-w-0 max-w-[11rem] items-center gap-1 rounded-full border px-2 py-1 text-xs transition-colors hover:border-muted/70",
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
