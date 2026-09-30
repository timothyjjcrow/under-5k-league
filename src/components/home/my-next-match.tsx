import type { Match } from "@prisma/client";
import Link from "next/link";
import { ByeWeekNote } from "@/components/bye-week-note";
import { CheckinBanner } from "@/components/checkin-banner";
import { LocalTime } from "@/components/local-time";
import { Card, LinkArrow, buttonClasses, textLink } from "@/components/ui";
import { loadCheckinSide } from "@/lib/checkin-side-service";
import { MATCH_ANCHOR, matchAnchorPath } from "@/lib/match-anchors";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { myMatchPanel, type PanelIdle } from "@/lib/my-match-panel";
import { prisma } from "@/lib/prisma";
import type { SeasonSnapshot } from "@/lib/queries";
import {
  matchRoundLabel,
  playoffTotalRounds,
  teamByeWeek,
} from "@/lib/schedule";
import type { VisibilityViewer } from "@/lib/visibility";
import { YourTeamLine, captainContact } from "./hero-controls";
import { fmtWhen } from "./when";

// The signed-in league member's panel in the hero mid-season: their next
// unplayed match with one-click check-in, the thing a rostered player most
// wants from the home page, and otherwise what is actually true for them.
export async function MyNextMatch({
  seasonId,
  seasonStatus,
  viewer,
  viewerHasActiveRegistration,
  teamSize,
  matches,
  teams,
  championTeamId,
  standin,
}: {
  seasonId: string;
  seasonStatus: string;
  viewer: NonNullable<VisibilityViewer>;
  viewerHasActiveRegistration: boolean;
  teamSize: number;
  /** The season's matches, as Home already read them. */
  matches: Match[];
  teams: SeasonSnapshot["teams"];
  /** The confirmed champion (`resolveChampionPresentation`), if any. */
  championTeamId: string | null;
  /** The viewer has an ACTIVE standin registration. */
  standin: boolean;
}) {
  const userId = viewer.id;
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const rosterTeams = teams.filter((t) =>
    t.members.some((m) => m.userId === userId),
  );
  // Assigned standins are participants too: without their bookings they'd
  // get no check-in prompt anywhere but the match page itself. The covered
  // player's bookings say when someone else has their seat.
  const bookings = await prisma.standinAssignment.findMany({
    where: {
      match: { seasonId },
      OR: [{ standinUserId: userId }, { replacingUserId: userId }],
    },
    select: {
      matchId: true,
      teamId: true,
      standinUserId: true,
      replacingUserId: true,
      standin: { select: { name: true } },
    },
  });
  // Async server component: Date.now is request-time state, not render replay.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const { next, live, covered, idle, teamId } = myMatchPanel({
    userId,
    seasonStatus,
    rosterTeamIds: rosterTeams.map((t) => t.id),
    withdrawnTeamIds: new Set(
      rosterTeams.filter((t) => t.withdrawn).map((t) => t.id),
    ),
    standin,
    championTeamId,
    matches,
    bookings,
    nowMs,
  });
  const playoffRounds = playoffTotalRounds(matches);
  const teamNameOf = (id: string) => teamById.get(id)?.name ?? "?";
  // A team resting this week is told so before the match after it, instead
  // of the panel jumping silently to a fixture a week away.
  const byeWeek =
    teamId && seasonStatus === "REGULAR_SEASON"
      ? teamByeWeek(matches, teamId, nowMs)
      : null;
  const notes = (
    <>
      {byeWeek != null ? <ByeWeekNote week={byeWeek} who="Your team" /> : null}
      {live ? (
        // A series being played is not the check-in (the match page has its
        // own "ready for the next game"), so it is a link, above the prompt.
        <Link
          href={`/matches/${live.match.id}`}
          className="group flex items-center gap-3 rounded-[var(--radius)] border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          <span
            aria-hidden
            className="animate-live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
          />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <span className="font-medium">Your series is live</span>{" "}
            <span className="text-muted">
              ·{" "}
              {live.teamId === live.match.homeTeamId
                ? `${live.match.homeScore}–${live.match.awayScore}`
                : `${live.match.awayScore}–${live.match.homeScore}`}{" "}
              vs{" "}
              {teamNameOf(
                live.teamId === live.match.homeTeamId
                  ? live.match.awayTeamId
                  : live.match.homeTeamId,
              )}
            </span>
          </span>
          <span className="shrink-0 text-info group-hover:underline">
            Match page <LinkArrow />
          </span>
        </Link>
      ) : null}
      {covered ? (
        <Link
          href={`/matches/${covered.match.id}`}
          className="group flex items-start gap-3 rounded-[var(--radius)] border border-line bg-surface-2/40 px-4 py-3 text-sm"
        >
          <span className="shrink-0 rounded bg-surface-2 px-2 py-0.5 text-xs font-semibold text-muted">
            Covered
          </span>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <span className="font-medium">
              {matchRoundLabel(covered.match, playoffRounds)}:
            </span>{" "}
            <span className="text-muted">
              {covered.booking.standin.name} is standing in for you.
            </span>
          </span>
          <span className="shrink-0 text-info group-hover:underline">
            <LinkArrow />
          </span>
        </Link>
      ) : null}
    </>
  );

  // The hero's control slot must never be an empty 23rem column, so every
  // branch below renders something.
  if (!next && (live || covered)) {
    return <div className="space-y-2">{notes}</div>;
  }
  if (!next && byeWeek != null) {
    return (
      <div className="space-y-2">
        {notes}
        <Link
          href="/schedule#fixtures"
          className={buttonClasses("secondary", "sm", "w-full")}
        >
          See this week&apos;s schedule <LinkArrow />
        </Link>
      </div>
    );
  }
  const myTeam = teamId ? teamById.get(teamId) : undefined;
  if (!next && idle === "no-fixtures" && myTeam) {
    // Rostered, schedule not out yet: who they play for is the useful part.
    return (
      <YourTeamLine
        team={myTeam}
        viewerId={userId}
        teamSize={teamSize}
        captainContact={await captainContact(
          viewer,
          myTeam.captainId,
          viewerHasActiveRegistration,
        )}
        fixturesSoon
      />
    );
  }
  if (!next) {
    const onlyFinalLeft =
      matches.some((m) => m.phase === "FINAL" && m.status !== "COMPLETED") &&
      !matches.some((m) => m.phase === "PLAYOFF" && m.status !== "COMPLETED");
    const copy = idleCopy(idle, onlyFinalLeft);
    return (
      <Card className="p-4 text-sm">
        <div className="font-medium">{copy.title}</div>
        <p className="mt-1 text-muted">{copy.text}</p>
        <Link
          href={copy.href}
          className={buttonClasses("secondary", "sm", "mt-3 w-full")}
        >
          {copy.cta} <LinkArrow />
        </Link>
      </Card>
    );
  }

  const homeTeam = teamById.get(next.homeTeamId);
  const awayTeam = teamById.get(next.awayTeamId);
  const [myRsvp, pendingReschedule, side] = await Promise.all([
    prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: next.id, userId }, scheduleRevision: next.scheduleRevision },
      select: { status: true },
    }),
    prisma.rescheduleRequest.findFirst({
      where: { matchId: next.id, status: "PENDING" },
      include: { proposedBy: { select: { name: true } } },
    }),
    // Who the viewer is in this match and how their side stands. A captain
    // gets the names behind the count right under the buttons, so chasing
    // the no-replies starts here rather than on the match page.
    loadCheckinSide({ matchId: next.id, viewer }),
  ]);

  // A proposal awaiting THIS viewer's answer gets a strip right on the
  // dashboard — proposals used to rot on the match page unseen.
  const awaitingMyAnswer =
    !!pendingReschedule &&
    pendingReschedule.proposedById !== userId &&
    (homeTeam?.captainId === userId || awayTeam?.captainId === userId);

  return (
    <div className="space-y-2">
      {notes}
      <CheckinBanner
        variant="panel"
        eyebrow={`Your next match · ${matchRoundLabel(next, playoffRounds, { bestOf: true })}`}
        matchId={next.id}
        scheduleRevision={next.scheduleRevision}
        heading={`${teamNameOf(next.homeTeamId)} vs ${teamNameOf(next.awayTeamId)}`}
        when={fmtWhen(next.scheduledAt)}
        whenTs={next.scheduledAt?.getTime()}
        myRsvp={myRsvp?.status ?? null}
        viewerIsCaptain={
          homeTeam?.captainId === userId || awayTeam?.captainId === userId
        }
        side={side}
        detailsHref={`/matches/${next.id}`}
      />
      {awaitingMyAnswer ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm">
          <span aria-hidden>⏳</span>
          <span className="min-w-0 flex-1">
            <strong>{pendingReschedule.proposedBy.name}</strong> proposed moving
            this match to{" "}
            <strong>
              <LocalTime
                ts={pendingReschedule.proposedTime.getTime()}
                variant="full"
                initial={formatLeagueMatchTime(
                  pendingReschedule.proposedTime,
                  "full",
                )}
              />
            </strong>
          </span>
          <Link
            href={matchAnchorPath(next.id, MATCH_ANCHOR.reschedule)}
            className={textLink("shrink-0")}
          >
            Respond <LinkArrow />
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** What the hero's panel says when there is nothing to check in for. */
function idleCopy(
  idle: PanelIdle,
  onlyFinalLeft: boolean,
): { title: string; text: string; href: string; cta: string } {
  const schedule = { href: "/schedule#fixtures", cta: "See the schedule" };
  const bracket = { href: "/schedule#playoff-bracket", cta: "See the bracket" };
  switch (idle) {
    case "no-fixtures":
      return {
        title: "Fixtures are coming soon",
        text: "Your team's schedule hasn't been published yet.",
        ...schedule,
      };
    case "games-played":
      return {
        title: "Your regular season is done",
        text: "Your team has played every regular-season fixture.",
        href: "/schedule#standings",
        cta: "See the standings",
      };
    case "no-upcoming":
      return {
        title: "Nothing to check in for yet",
        text: "Your team's next match has no kickoff time yet, or its result is still coming in.",
        ...schedule,
      };
    case "bracket-pending":
      return {
        title: "The playoff bracket is on its way",
        text: "Playoff fixtures show here once the bracket is drawn.",
        href: "/schedule#playoff-bracket",
        cta: "See the playoff schedule",
      };
    case "through":
      return {
        title: "You're through",
        text: "Your next round is drawn once the other series finish.",
        ...bracket,
      };
    case "champion":
      return {
        title: "Champions",
        text: "Your team won the final.",
        ...bracket,
      };
    case "final-review":
      return {
        title: "The final is under review",
        text: "Your team played the final. The champion is named once the league confirms the result.",
        ...bracket,
      };
    case "season-over":
      return {
        title: "Your season is over",
        text: "Thanks for playing. The playoffs go on without you.",
        href: "/schedule#playoff-bracket",
        cta: onlyFinalLeft ? "Follow the final" : "Follow the playoffs",
      };
    case "withdrawn":
      return {
        title: "Your team has withdrawn",
        text: "Its remaining fixtures were forfeited. The rest of the league is still worth watching.",
        ...schedule,
      };
    case "standin-list":
      return {
        title: "You're on the standin list",
        text: "No booking yet. Captains book standins from a match page when they need cover.",
        href: "/schedule#fixtures",
        cta: "See this week's schedule",
      };
    default:
      return {
        title: "No match of your own coming up",
        text: "You're not on a team this season. The week's games are still worth watching.",
        href: "/schedule#fixtures",
        cta: "See this week's schedule",
      };
  }
}
