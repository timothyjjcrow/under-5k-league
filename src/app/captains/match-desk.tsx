import type { Match } from "@prisma/client";
import Link from "@/components/app-link";
import { CaptainTools } from "@/app/matches/[id]/captain-tools";
import { LiveSeriesCheckin } from "@/app/matches/[id]/live-series-checkin";
import {
  loadDraftStatus,
  loadMatch,
  parseMatchGames,
} from "@/app/matches/[id]/load";
import { RescheduleSection } from "@/app/matches/[id]/reschedule";
import { CheckinBanner } from "@/components/checkin-banner";
import { CheckinNudgeControl } from "@/components/checkin-nudge-control";
import { LocalTime } from "@/components/local-time";
import {
  Badge,
  Card,
  CardBody,
  LinkArrow,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";
import type { SessionUser } from "@/lib/auth";
import { CAPTAINS_ANCHOR, captainsHref } from "@/lib/captains";
import { captainTodoCountLine } from "@/lib/captain-todos";
import { loadCaptainNudge } from "@/lib/captains-service";
import { loadCheckinSide } from "@/lib/checkin-side-service";
import { MATCH_STATUS } from "@/lib/constants";
import { matchCheckinOpen, matchResultsOpen } from "@/lib/league-lifecycle";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import { captainCardsOpen, captainJumps } from "@/lib/match-captain-jumps";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";
import type { SeasonSnapshot } from "@/lib/queries";
import { matchRoundLabel } from "@/lib/schedule";
import { cn } from "@/lib/utils";

/** The team's unplayed fixtures: a live one first, then by week and kickoff. */
export function openFixtures(matches: readonly Match[], teamId: string): Match[] {
  return matches
    .filter(
      (m) =>
        m.status !== MATCH_STATUS.COMPLETED &&
        (m.homeTeamId === teamId || m.awayTeamId === teamId),
    )
    .sort(
      (a, b) =>
        Number(b.status === MATCH_STATUS.LIVE) -
          Number(a.status === MATCH_STATUS.LIVE) ||
        a.week - b.week ||
        (a.scheduledAt?.getTime() ?? Infinity) -
          (b.scheduledAt?.getTime() ?? Infinity) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * One of the team's open fixtures with every control a captain has for it,
 * the same cards the match page draws (so the same rules and the same server
 * checks): their own check-in, the side's check-ins and the Remind button,
 * then Captain tools (the ready check to move the match, standins, lobby
 * setup and reporting). A row of tiles picks the fixture (`?match=`), each
 * with its kickoff and how many things there wait on the captain, so the
 * whole run of open matches reads at a glance.
 */
export async function MatchDesk({
  fixtures,
  selectedId,
  teamId,
  teams,
  rounds,
  viewer,
  nowMs,
  todoCounts,
  scrimId,
}: {
  /** `openFixtures`, never empty. */
  fixtures: Match[];
  selectedId: string;
  teamId: string;
  teams: SeasonSnapshot["teams"];
  /** playoffTotalRounds over the season's matches. */
  rounds: number;
  viewer: SessionUser;
  nowMs: number;
  /** How many "Needs you" lines each open match has (`loadCaptainTodoRows`). */
  todoCounts: ReadonlyMap<string, number>;
  /** The scrim open further down (`?scrim=`), kept in the tiles' links. */
  scrimId: string | null;
}) {
  const nameOf = (id: string) => teams.find((t) => t.id === id)?.name ?? "TBD";
  const opponentOf = (m: Match) =>
    m.homeTeamId === teamId ? m.awayTeamId : m.homeTeamId;
  const match = await loadMatch(selectedId);
  if (!match) return null;
  const draftStatus = await loadDraftStatus(match);
  // Mirrors the match preview: an RSVP is about one published, upcoming
  // match night; a live series has its own readiness banner.
  const checkinOpen =
    match.status !== MATCH_STATUS.LIVE &&
    match.season.isActive &&
    matchCheckinOpen(
      match.season.status,
      draftStatus,
      match.status,
      match.scheduledAt,
      nowMs,
    );
  const [side, myRsvp, nudge] = await Promise.all([
    // Null when the captain isn't on the side's match-night roster (a
    // standin covers them): their side's answers are then on the Matchup card.
    checkinOpen
      ? loadCheckinSide({ matchId: match.id, viewer, names: true })
      : Promise.resolve(null),
    prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: match.id, userId: viewer.id } },
      select: { status: true, scheduleRevision: true },
    }),
    loadCaptainNudge({
      match,
      teamId,
      viewerId: viewer.id,
      checkinOpen,
      nowMs,
    }),
  ]);
  const games = parseMatchGames(match);
  const opponentId = opponentOf(match);
  const opponent = teams.find((t) => t.id === opponentId);
  const roundLabel = matchRoundLabel(match, rounds, { bestOf: true });
  const live = match.status === MATCH_STATUS.LIVE;
  // The match page's own shortcuts (`captainJumps`), each shown only while
  // its card would take the action: book a standin, move the match, set the
  // lobby up and report. The cards are further down this page, and a captain
  // shouldn't have to scroll to learn they are here.
  const jumps = captainJumps({
    resultsOpen: matchResultsOpen(match.season.status, match.phase),
    seriesStarted: live || games.length > 0,
    kickoffMs: match.scheduledAt?.getTime() ?? null,
    nowMs,
    ...captainCardsOpen(match, draftStatus),
  });

  return (
    <section
      id="matches"
      aria-labelledby="matches-title"
      className="scroll-mt-24 space-y-4"
    >
      <h2 id="matches-title" className="font-display text-2xl font-semibold">
        Your matches
      </h2>
      {fixtures.length > 1 ? (
        <nav
          aria-label="Pick a match"
          className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(13rem,100%),1fr))]"
        >
          {fixtures.map((m) => {
            const current = m.id === match.id;
            const waiting = todoCounts.get(m.id) ?? 0;
            return (
              <Link
                key={m.id}
                href={captainsHref(
                  { match: m.id, scrim: scrimId },
                  CAPTAINS_ANCHOR.matches,
                )}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex min-h-11 min-w-0 flex-col justify-center rounded-lg border px-3 py-2 text-sm",
                  current
                    ? "border-accent/50 bg-accent/15 text-fg"
                    : "border-line text-muted hover:border-muted/60 hover:text-fg",
                )}
              >
                <span
                  className={cn(
                    "flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]",
                    current && "font-medium",
                  )}
                >
                  {m.status === MATCH_STATUS.LIVE ? (
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
                  ) : null}
                  {matchRoundLabel(m, rounds)} · vs {nameOf(opponentOf(m))}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted">
                  {m.status === MATCH_STATUS.LIVE ? (
                    <span>Live now</span>
                  ) : m.scheduledAt ? (
                    <LocalTime
                      ts={m.scheduledAt.getTime()}
                      variant="short"
                      initial={formatLeagueMatchTime(m.scheduledAt, "short")}
                    />
                  ) : (
                    <span>No kickoff yet</span>
                  )}
                  {waiting > 0 ? (
                    <span className="font-medium text-accent">
                      {captainTodoCountLine(waiting)}
                    </span>
                  ) : null}
                </span>
              </Link>
            );
          })}
        </nav>
      ) : null}

      <Card>
        <CardBody className="flex flex-wrap items-center gap-3">
          {opponent ? (
            <TeamCrest
              name={opponent.name}
              seed={opponent.id}
              logoUrl={opponent.logoUrl}
              size={44}
            />
          ) : null}
          <div className="min-w-0 flex-1 basis-48">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold uppercase tracking-wider text-muted">
              {roundLabel}
              {live ? <Badge tone="danger">Live</Badge> : null}
            </p>
            <p className="font-semibold [overflow-wrap:anywhere]">
              vs{" "}
              <Link href={`/teams/${opponentId}`} className={textLink()}>
                {opponent?.name ?? "TBD"}
              </Link>
            </p>
            <p className="text-sm text-muted">
              {match.scheduledAt ? (
                <LocalTime
                  ts={match.scheduledAt.getTime()}
                  variant="full"
                  initial={formatLeagueMatchTime(match.scheduledAt, "full")}
                />
              ) : (
                "Kickoff not set yet: offer times in the ready check below"
              )}
            </p>
          </div>
          <Link
            href={`/matches/${match.id}`}
            className={textLink("text-sm")}
          >
            Match page <LinkArrow />
          </Link>
        </CardBody>
        <nav
          aria-label="Captain shortcuts"
          className="flex flex-wrap items-center gap-2 border-t border-line-soft px-4 py-3"
        >
          <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-muted">
            On this page
          </span>
          {jumps.map((jump) => (
            <a
              key={jump.anchor}
              href={`#${jump.anchor}`}
              className={buttonClasses(jump.variant, "sm")}
            >
              {jump.label} <span aria-hidden>↓</span>
            </a>
          ))}
        </nav>
      </Card>

      {/* The captain's own answer, with the side's names behind the count
          (the banner draws them for a captain). */}
      {side ? (
        <CheckinBanner
          matchId={match.id}
          scheduleRevision={match.scheduleRevision}
          heading="Your check-in"
          when={
            match.scheduledAt
              ? formatLeagueMatchTime(match.scheduledAt, "full")
              : undefined
          }
          whenTs={match.scheduledAt?.getTime()}
          myRsvp={
            myRsvp && myRsvp.scheduleRevision === match.scheduleRevision
              ? myRsvp.status
              : null
          }
          viewerIsCaptain
          side={side}
          // The Standins card is on this page, a few cards down.
          coverHref={`#${MATCH_ANCHOR.standins}`}
        />
      ) : null}
      {nudge ? (
        <div className="rounded-[var(--radius)] border border-line bg-surface px-4 pb-3">
          <CheckinNudgeControl matchId={match.id} nudge={nudge} />
        </div>
      ) : null}
      {live ? <LiveSeriesCheckin match={match} viewer={viewer} /> : null}
      <RescheduleSection match={match} viewer={viewer} part="moved" />
      <CaptainTools
        match={match}
        viewer={viewer}
        seriesStarted={games.length > 0}
        renderedAt={nowMs}
      />
    </section>
  );
}
