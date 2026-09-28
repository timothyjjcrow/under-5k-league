import { seasonPageMetadata } from "@/lib/link-preview-metadata";
import { AddToCalendar } from "@/components/add-to-calendar";
import { resolveSiteUrl } from "@/lib/site-url";
import {
  PlayoffOutlook,
  PlayoffOutlookFootnote,
  playoffPathLines,
} from "@/components/playoff-outlook";
import { AnalysisDisclosure } from "@/components/analysis-disclosure";
import { leagueProgress, progressSummary } from "@/lib/league-progress";
import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { fixturesMatchNightLabel, seasonMatchNightLabel } from "@/lib/match-night";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeStandings, standingsMovement } from "@/lib/standings";
import { clinchFromReport, seasonScenarioReport } from "@/lib/stakes";
import {
  projectPlayoffField,
  publicDeadHeatTeamIds,
} from "@/lib/playoff-field";
import { TiebreakerNotice } from "@/components/tiebreaker-notice";
import { TiebreakerBracket } from "@/components/tiebreaker-bracket";
import {
  buildTiebreakerBrackets,
  tiebreakerResultLine,
} from "@/components/tiebreaker-bracket-view";
import type { ScenarioReport } from "@/lib/scenarios";
import { SeasonGrid } from "@/components/season-grid";
import {
  byeTeamsByWeek,
  byKickoff,
  groupPlayoffRounds,
  matchRoundLabel,
  orderScheduleWeeks,
  pickBracketSize,
  playoffFirstRound,
  roundName,
  teamByeWeek,
} from "@/lib/schedule";
import { formatMatchTime } from "@/lib/match-time";
import { ChampionBanner } from "@/components/champion-banner";
import { ByeWeekNote } from "@/components/bye-week-note";
import {
  bracketColumnCount,
  buildBracketRounds,
  seedsFromFirstRound,
} from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { formByTeam } from "@/lib/team-matches";
import {
  captainOverdueResults,
  regularSeasonStatus,
  pendingResultsMessage,
  resultOverdue,
  standingsCaption,
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
  ScheduleFold,
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
  textLink,
} from "@/components/ui";
import {
  canViewAvailabilitySummary,
  hasActiveLeagueParticipation,
} from "@/lib/visibility";
import type { Match, StandinAssignment, User } from "@prisma/client";

// The link preview names the page and the season.
export function generateMetadata() {
  return seasonPageMetadata("schedule");
}

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

// Only shown before any fixture exists (SIGNUPS, DRAFT, REGULAR_SEASON);
// once fixtures exist the match night rides in the page subtitle. With no
// fixtures there are no kickoffs below it to point at, in any phase.
function calloutDescription(status: string): string {
  if (status === "SIGNUPS")
    return "Games run weekly. Confirm this slot works before you sign up.";
  return "This is the default weekly slot. Exact kickoffs appear once the schedule is published.";
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
            select: { matchId: true, userId: true, status: true, scheduleRevision: true },
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
    if (r.scheduleRevision !== matches.find((match) => match.id === r.matchId)?.scheduleRevision) continue;
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
  // One request-time snapshot keeps all public progress and freshness labels aligned.
  // eslint-disable-next-line react-hooks/purity
  const scheduleNow = Date.now();
  const freshFrom = scheduleNow - AUTO_SYNC.WINDOW_HOURS * 3600_000;
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
  // A rostered viewer whose team rests this week is told so above the
  // check-in for the match after it.
  const viewerTeam = teams.find((t) => myTeamIds.has(t.id));
  const viewerByeWeek =
    viewerTeam &&
    !viewerTeam.withdrawn &&
    (season.status === "REGULAR_SEASON" || season.status === "DRAFT")
      ? teamByeWeek(matches, viewerTeam.id, scheduleNow)
      : null;
  // A captain whose fixture outlived the automatic result check is asked to
  // report it, on the row and at the top of the page; everyone else keeps
  // the row's plain "Awaiting result".
  const captainTeamIds = new Set(
    viewer ? teams.filter((t) => t.captainId === viewer.id).map((t) => t.id) : [],
  );
  const reportDue = captainOverdueResults(
    matches,
    captainTeamIds,
    season.status,
    freshFrom,
  );
  const reportDueIds = new Set(reportDue.map((m) => m.id));
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
  // A tie mid-season is just a tie. Only once the regular season is over (or
  // tiebreaker fixtures exist) does it get a tiebreaker badge that holds back
  // its seeds and the projected matchups.
  const shownDeadHeatTeamIds = publicDeadHeatTeamIds(playoffField, matches);
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
          playoffField,
        )
      : null;

  const regular = matches.filter((m) => m.phase === "REGULAR");
  const tiebreakers = matches.filter((m) => m.phase === "TIEBREAKER");
  const playoff = matches.filter(
    (m) => m.phase === "PLAYOFF" || m.phase === "FINAL",
  );
  const weeks = [...new Set(regular.map((m) => m.week))].sort((a, b) => a - b);
  // Before the first fixture is published there is nothing to rank or cross-
  // reference: the standings would be every team on zero points, and the
  // head-to-head grid a sheet of dashes.
  const hasFixtures = regular.length > 0;
  const status = regularSeasonStatus(matches);
  const weekStatus = new Map(status.weeks.map((w) => [w.week, w]));
  const progress = leagueProgress(matches, scheduleNow);
  const pendingMsg = pendingResultsMessage(
    regularSeasonStatus(progress.awaiting),
  );
  const untimedOpen = matches.filter(
    (m) => m.status === "SCHEDULED" && m.scheduledAt == null,
  );
  const scheduleEditingOpen = postAuctionWorkOpen(season.status, draft?.status);
  // "This week" is the first live/fresh slate, not simply the oldest missing
  // result. A stale week stays visible with an explicit overdue badge but no
  // longer mislabels itself as tonight's games.
  const currentWeek =
    season.status === "REGULAR_SEASON"
      ? (progress.focusWeek ?? undefined)
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
      playoffPaths: m.phase === "REGULAR" && m.status !== "COMPLETED"
        ? {
            home: playoffPathLines(stakesReport?.teams.get(m.homeTeamId), m.id),
            away: playoffPathLines(stakesReport?.teams.get(m.awayTeamId), m.id),
          }
        : undefined,
      done: m.status === "COMPLETED",
      awaitingResult: resultOverdue(m, freshFrom),
      reportResult: reportDueIds.has(m.id),
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
  const tiebreakerWeeks = [...new Set(tiebreakers.map((m) => m.week))].sort(
    (a, b) => a - b,
  );
  const currentTiebreakerWeek = tiebreakerWeeks.find((week) =>
    tiebreakers.some((m) => m.week === week && m.status !== "COMPLETED"),
  );
  const tiebreakerWeekViews: WeekView[] = tiebreakerWeeks.map((week) => {
    const weekMatches = tiebreakers.filter((m) => m.week === week);
    const night = earliestScheduled(weekMatches);
    return {
      week,
      label: `Tiebreaker week · Week ${week} · ${weekMatches.every((match) => match.bestOf === 1) ? "Best of 1" : weekMatches.every((match) => match.bestOf === 3) ? "Best of 3" : "Best of 1 / Best of 3"}`,
      completed: weekMatches.filter((m) => m.status === "COMPLETED").length,
      total: weekMatches.length,
      isCurrent: week === currentTiebreakerWeek,
      isOverdue: false,
      matches: weekMatches.map(toMatchView),
      byes: [],
      nightTs: night?.getTime() ?? null,
      nightInitial: night ? formatMatchTime(night, "date") : null,
    };
  });
  const tiebreakerBrackets = buildTiebreakerBrackets({ projection: playoffField, teams, matches });
  const playoffRoundViews: WeekView[] = playoffGrouping.rounds.map((r) => {
    const night = earliestScheduled(r.matches);
    const seriesLengths = [...new Set(r.matches.map((m) => m.bestOf))];
    return {
      week: r.matches[0]?.week ?? r.round + 1,
      label: `${roundName(r.round, playoffGrouping.totalRounds)}${seriesLengths.length === 1 ? ` · Best of ${seriesLengths[0]}` : ""}`,
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
  const bracketFoldsOnPhones = bracketColumnCount(bracketRoundsView) > 1;
  const postseasonPhase =
    season.status === "PLAYOFFS" || season.status === "COMPLETE";
  const showTiebreakers =
    tiebreakers.length > 0 ||
    (status.allComplete && playoffField.seedingDeadHeatTeamIds.length > 0);
  // Once the playoffs start, a finished tiebreaker is history: it folds to
  // one line of results below the standings instead of sitting mid-page.
  const tiebreakersSettled =
    postseasonPhase &&
    !tiebreakerBrackets.error &&
    tiebreakerBrackets.groups.length > 0 &&
    tiebreakerBrackets.groups.every((bracket) => bracket.status === "resolved");
  const tiebreakerBody = (
    <>
      {tiebreakerBrackets.groups.map((bracket) => (
        <TiebreakerBracket key={bracket.key} bracket={bracket} teams={teams} postseasonStarted={postseasonPhase} />
      ))}
      {tiebreakerBrackets.error && season.status !== "REGULAR_SEASON" ? (
        <p className="text-sm text-accent">The tiebreaker bracket needs an administrator’s review. Recorded matches are available below.</p>
      ) : null}
      {tiebreakerWeekViews.length > 0 ? (
        <details data-testid="tiebreaker-match-details" className="rounded-xl border border-line p-4">
          <summary className="cursor-pointer text-sm font-medium text-info">Match details &amp; check-in</summary>
          <p className="mb-4 mt-2 text-xs text-muted">Published matches only. Later games are added as their teams are decided.</p>
          <ScheduleWeeks
            weeks={tiebreakerWeekViews}
            teams={teams.map((team) => ({
              id: team.id,
              name: team.name,
              logoUrl: team.logoUrl,
            }))}
            initialTeamId={[...myTeamIds][0]}
          />
        </details>
      ) : (
        <p className="text-sm text-muted">
          An administrator will schedule the required tiebreaker matches
          before the playoff bracket starts.
        </p>
      )}
    </>
  );
  const postseasonSection = postseasonPhase ? (
    <section id="playoff-bracket" className="scroll-mt-20 space-y-4">
      <SectionTitle>Playoff bracket</SectionTitle>
      {playoff.length > 0 ? (
        <>
          {/* Bracket owns horizontal scrolling; the card clips its intrinsic
              desktop width so phones never gain document-level overflow.
              A bracket with wings is wider than a phone, so below tablet
              width the round list leads and the drawn bracket folds away
              under it. The final alone fits, so it always shows. */}
          <Card
            className={
              bracketFoldsOnPhones
                ? "hidden overflow-hidden md:block"
                : "overflow-hidden"
            }
          >
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
          {bracketFoldsOnPhones ? (
            <div className="md:hidden">
              <AnalysisDisclosure
                title="Full bracket"
                description="Every round side by side. Tap a team to trace its path to the final."
              >
                <div className="min-w-0 overflow-hidden">
                  <Bracket
                    rounds={bracketRoundsView}
                    championTeamId={championPresentation.championTeamId}
                  />
                </div>
              </AnalysisDisclosure>
            </div>
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

  const sortedTeams = [...teams]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ id: t.id, name: t.name, logoUrl: t.logoUrl }));
  const regularWeeks = (
    <ScheduleWeeks
      weeks={orderScheduleWeeks(weekViews, progress.focusWeek)}
      initialTeamId={[...myTeamIds][0]}
      teams={sortedTeams}
    />
  );
  const hasTimes = matches.some((m) => m.scheduledAt);
  const calendarTeams = sortedTeams.map(({ id, name }) => ({ id, name }));
  // Once fixtures have kickoffs, the weekly night is read from them
  // (lib/match-night), never from the pre-signup text.
  const matchNight = hasTimes ? fixturesMatchNightLabel(matches) : null;

  return (
    <div className="space-y-6">
      <PageTitle
        title={
          season.status === "COMPLETE"
            ? "Season results"
            : season.status === "PLAYOFFS"
              ? "Playoffs"
              : hasFixtures
                ? "Schedule & Standings"
                : "Schedule"
        }
        // The week and the series count stand in for the progress ring the
        // home page carries: this page leads with the fixtures themselves.
        // The weekly slot is quoted in the league's zone; each fixture's own
        // kickoff renders in the reader's.
        subtitle={[
          season.name,
          season.status === "REGULAR_SEASON" ? progressSummary(progress) : null,
          hasTimes && season.status !== "COMPLETE" && matchNight
            ? `Match night ${matchNight}`
            : null,
          hasTimes ? "Kickoffs shown in your time zone" : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        action={
          hasTimes ? (
            <AddToCalendar
              site={resolveSiteUrl()}
              teams={calendarTeams}
              initialTeamId={[...myTeamIds][0]}
            />
          ) : undefined
        }
      />

      {viewerByeWeek != null ? (
        <ByeWeekNote week={viewerByeWeek} who="Your team" />
      ) : null}

      {myNextMatch ? (
        <CheckinBanner
          matchId={myNextMatch.id}
          scheduleRevision={myNextMatch.scheduleRevision}
          remainingGames={myNextMatch.status === "LIVE"}
          heading={`Your next match — ${matchRoundLabel(myNextMatch, playoffGrouping.totalRounds, { bestOf: true })}: ${teamName.get(myNextMatch.homeTeamId)} vs ${teamName.get(myNextMatch.awayTeamId)}`}
          when={fmtWhen(myNextMatch.scheduledAt)}
          whenTs={myNextMatch.scheduledAt?.getTime()}
          myRsvp={myRsvp}
          detailsHref={`/matches/${myNextMatch.id}`}
        />
      ) : null}

      {reportDue.length > 0 ? (
        <ReportResultPrompt
          match={reportDue[0]}
          more={reportDue.length - 1}
          label={matchRoundLabel(reportDue[0], playoffGrouping.totalRounds)}
          opponent={
            teamName.get(
              captainTeamIds.has(reportDue[0].homeTeamId)
                ? reportDue[0].awayTeamId
                : reportDue[0].homeTeamId,
            ) ?? "your opponent"
          }
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
          teamLogoUrl={teamLogoUrl.get(championPresentation.championTeamId)}
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

      {showTiebreakers && !tiebreakersSettled ? (
        <section id="tiebreakers" className="scroll-mt-24 space-y-4">
          <SectionTitle>Tiebreaker bracket</SectionTitle>
          {season.status === "REGULAR_SEASON" ? (
            <TiebreakerNotice
              report={stakesReport}
              projection={playoffField}
              teams={teams}
              regularComplete={status.allComplete}
              hasTiebreakers={tiebreakers.length > 0}
              scheduleLink={false}
            />
          ) : null}
          {tiebreakerBody}
        </section>
      ) : null}

      {postseasonPhase && hasFixtures ? (
        // The playoffs lead the page; the finished regular season folds into
        // one closed section so the standings stay close to the bracket.
        <ScheduleFold
          id="fixtures"
          title="Regular-season results"
          description={`${weeks.length} week${weeks.length === 1 ? "" : "s"} · ${status.completed} of ${status.total} series played`}
        >
          {regularWeeks}
        </ScheduleFold>
      ) : (
        <div id="fixtures" className="scroll-mt-24 space-y-8">
          <section className="space-y-4">
            <SectionTitle>Regular season</SectionTitle>
            {!hasFixtures ? (
              (() => {
                const copy = emptyScheduleCopy(season.status, draft?.status);
                const showMatchNight =
                  season.status === "SIGNUPS" ||
                  season.status === "DRAFT" ||
                  season.status === "REGULAR_SEASON";
                const links = [
                  teams.length > 0 ? (
                    <Link
                      key="teams"
                      href="/teams"
                      className={textLink("text-sm")}
                    >
                      See the teams →
                    </Link>
                  ) : null,
                  viewer?.role === "ADMIN" ? (
                    <Link
                      key="admin"
                      href="/admin#adm-schedule"
                      className={textLink("text-sm")}
                    >
                      Open schedule controls →
                    </Link>
                  ) : null,
                ].filter(Boolean);
                return (
                  <EmptyState
                    title={copy.title}
                    description={copy.description}
                    action={
                      showMatchNight || links.length > 0 ? (
                        <div className="flex w-full max-w-md flex-col gap-3">
                          {showMatchNight ? (
                            <ScheduleCallout
                              label={seasonMatchNightLabel(season, matches)}
                              description={calloutDescription(season.status)}
                              className="text-left"
                            />
                          ) : null}
                          {links.length > 0 ? (
                            <div className="flex flex-wrap justify-center gap-x-4 gap-y-2">
                              {links}
                            </div>
                          ) : null}
                        </div>
                      ) : undefined
                    }
                  />
                );
              })()
            ) : (
              regularWeeks
            )}
          </section>
        </div>
      )}

      {hasFixtures ? (
        <Card id="standings" className="scroll-mt-24">
          <CardHeader
            headingLevel={2}
            title="Standings"
            subtitle={standingsCaption({
              status,
              postseason: postseasonPhase,
              bracketSize: playoffField.bracketSize,
              eligibleTeams: playoffField.eligibleTeamIds.length,
            })}
          />
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
              unresolvedPlayoffTeamIds={shownDeadHeatTeamIds}
              clinch={clinchFromReport(stakesReport)}
              playoffScenarios={stakesReport?.forecast?.basis === "final" ? stakesReport.teams : undefined}
              viewerTeamId={[...myTeamIds][0]}
              movement={standingsMovement(
                teams.map((t) => t.id),
                matches,
              )}
            />
          </CardBody>
        </Card>
      ) : null}

      {showTiebreakers && tiebreakersSettled ? (
        <ScheduleFold
          id="tiebreakers"
          title="Tiebreaker bracket"
          description={
            tiebreakerResultLine(tiebreakerBrackets.groups) ??
            "Settled before the playoffs"
          }
          rememberParam="tiebreaker"
          openOnFilter={false}
        >
          <div className="space-y-4">{tiebreakerBody}</div>
        </ScheduleFold>
      ) : null}

      {season.status === "REGULAR_SEASON" &&
      playoffField.eligibleTeamIds.length > 2 &&
      standings.some((s) => s.played > 0) ? (
        <AnalysisDisclosure
          id="playoff-analysis"
          title="Playoff race & possible matchups"
          description="Projected from today's standings"
        >
          <PlayoffPicture
            standings={playoffField.eligibleStandings}
            teamName={teamName}
            teamLogoUrl={teamLogoUrl}
            report={stakesReport}
            unresolvedTeamIds={shownDeadHeatTeamIds}
            tiebreakerError={playoffField.tiebreakers.error}
          />
        </AnalysisDisclosure>
      ) : null}

      {hasFixtures && teams.length > 1 ? (
        <AnalysisDisclosure
          title="Head-to-head results grid"
          description="Each row shows that team's results"
        >
          <SeasonGrid
            teamIds={standings.map((s) => s.teamId)}
            teamName={teamName}
            teamLogoUrl={teamLogoUrl}
            matches={matches}
          />
        </AnalysisDisclosure>
      ) : null}
    </div>
  );
}

// A captain's own fixture that is past the automatic result check: say
// which one, and send them straight to the match page's report tools.
function ReportResultPrompt({
  match,
  more,
  label,
  opponent,
}: {
  match: Match;
  more: number;
  label: string;
  opponent: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-5 py-3 text-sm">
      <div className="min-w-[14rem] flex-1">
        <div className="font-medium [overflow-wrap:anywhere]">
          Your {label} result against {opponent} hasn&apos;t come through
        </div>
        <div className="text-muted">
          It didn&apos;t import by itself. Report it from the match page
          (auto-fetch, or paste the Dota match ID) so it counts.
          {more > 0
            ? ` ${more} more of your results ${more === 1 ? "is" : "are"} missing too; each is marked “Result needed” below.`
            : ""}
        </div>
      </div>
      <Link
        href={`/matches/${match.id}#match-tools`}
        className={buttonClasses("primary", "sm")}
      >
        Report result →
      </Link>
    </div>
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
  unresolvedTeamIds,
  tiebreakerError,
}: {
  standings: ReturnType<typeof computeStandings>;
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
  report: ScenarioReport | null;
  unresolvedTeamIds: string[];
  tiebreakerError: string | null;
}) {
  const order = standings.map((s) => s.teamId);
  const size = pickBracketSize(order.length);
  const seedOf = new Map(order.slice(0, size).map((id, i) => [id, i + 1]));
  const pendingTeamIds = report?.forecast?.basis === "final"
    ? unresolvedTeamIds.filter((id) => {
        const outlook = report.teams.get(id)?.outlook;
        return !outlook || outlook.qualificationTiebreaker > 0 || outlook.seedingTiebreaker > 0;
      })
    : unresolvedTeamIds;
  const pairings =
    pendingTeamIds.length > 0 || tiebreakerError
      ? []
      : playoffFirstRound(order, size);

  const raceNotes = order.flatMap((teamId) => {
    const scenario = report?.teams.get(teamId);
    return scenario ? [{ teamId, scenario }] : [];
  });

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Playoff picture"
        subtitle="Where each team stands"
      />
      <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {tiebreakerError ? (
          <p className="text-sm text-muted sm:col-span-2">
            An administrator must review the tiebreaker fixtures before playoff
            matchups can be confirmed.
          </p>
        ) : null}
        {pendingTeamIds.length > 0 ? (
          <p className="text-sm text-muted sm:col-span-2">
            Still tied:{" "}
            {pendingTeamIds.map((id) => teamName.get(id) ?? id).join(", ")}{" "}
            {report?.forecast?.basis === "final"
              ? "— tiebreaker results will settle the remaining places and seeds."
              : "— an extra week is needed only if the tie remains after regular-season results."}
          </p>
        ) : null}
        {pairings.map((p, index) => (
          <div
            key={p.home}
            className="relative grid grid-cols-1 overflow-hidden rounded-xl border border-line bg-gradient-to-br from-surface-2/70 to-surface text-sm"
          >
            <div className="flex items-center justify-between border-b border-line-soft px-4 py-2 text-[10px] uppercase tracking-wider text-muted">
              <span>Matchup {String(index + 1).padStart(2, "0")}</span>
              <span className="text-accent">Projected</span>
            </div>
            <ProjectedSide
              teamId={p.home}
              seed={seedOf.get(p.home)}
              teamName={teamName}
              teamLogoUrl={teamLogoUrl}
            />
            <div aria-hidden className="mx-4 h-px bg-line-soft" />
            <ProjectedSide
              teamId={p.away}
              seed={seedOf.get(p.away)}
              teamName={teamName}
              teamLogoUrl={teamLogoUrl}
            />
          </div>
        ))}
        {raceNotes.length > 0 ? (
          <div className="sm:col-span-2">
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
              Playoff tracker
            </div>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {raceNotes.map((n) => (
                <li
                  key={n.teamId}
                  className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-surface-2/20 p-3 text-sm"
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
                    className="min-w-0 flex-1 py-1 -my-1 font-medium [overflow-wrap:anywhere] hover:text-info"
                  >
                    {teamName.get(n.teamId) ?? "?"}
                  </Link>
                  <div className="w-full">
                    <PlayoffOutlook
                      scenario={n.scenario}
                      teamNames={teamName}
                      compact
                    />
                  </div>
                </li>
              ))}
            </ul>
            {/* One "How this works" for the whole tracker, not one per card. */}
            <div className="mt-2">
              <PlayoffOutlookFootnote
                scenarios={raceNotes.map((n) => n.scenario)}
                teamNames={teamName}
              />
            </div>
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
}: {
  teamId: string;
  seed: number | undefined;
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
}) {
  const name = teamName.get(teamId) ?? "?";
  return (
    <Link
      href={`/teams/${teamId}`}
      className="flex min-h-16 min-w-0 items-center gap-3 px-4 py-3 hover:bg-surface-2/60 hover:text-info"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-accent/20 bg-accent/5 font-display text-lg tabular-nums text-accent">
        <span className="sr-only">Seed </span>
        {seed}
      </span>
      <TeamCrest
        name={name}
        seed={teamId}
        logoUrl={teamLogoUrl.get(teamId)}
        size={28}
        className="shrink-0 rounded-lg"
      />
      <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
    </Link>
  );
}
