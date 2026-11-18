import Link from "@/components/app-link";
import { CheckinBanner } from "@/components/checkin-banner";
import { LocalTime } from "@/components/local-time";
import { LinkArrow, textLink } from "@/components/ui";
import type { SessionUser } from "@/lib/auth";
import { loadCheckinSide } from "@/lib/checkin-side-service";
import {
  MATCH_STATUS,
  STANDIN_REQUEST_STATUS,
} from "@/lib/constants";
import { matchCheckinOpen } from "@/lib/league-lifecycle";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";
import { getSeasonDraftStatus, getSeasonMatches } from "@/lib/queries";
import { matchRoundLabel, playoffTotalRounds } from "@/lib/schedule";

const FIXTURE = {
  select: {
    id: true,
    week: true,
    phase: true,
    bracketSlot: true,
    bestOf: true,
    status: true,
    scheduledAt: true,
    scheduleRevision: true,
    homeTeamId: true,
    homeTeam: { select: { name: true } },
    awayTeam: { select: { name: true } },
  },
} as const;

/**
 * A standin's own games on the Standins page: each booking with its check-in
 * (and "Can't make it", which before the night gives the seat back), and each
 * game a captain asked for them where the other captain has yet to agree.
 * The games they said they can play for are marked on the list below.
 * Renders nothing for someone with neither.
 */
export async function MyStandinGames({
  season,
  viewer,
  nowMs,
}: {
  season: { id: string; status: string };
  viewer: SessionUser;
  nowMs: number;
}) {
  const unplayed = {
    seasonId: season.id,
    status: { not: MATCH_STATUS.COMPLETED },
  };
  const [bookings, asks] = await Promise.all([
    prisma.standinAssignment.findMany({
      where: { standinUserId: viewer.id, match: unplayed },
      select: {
        id: true,
        teamId: true,
        replaced: { select: { name: true } },
        match: FIXTURE,
      },
    }),
    prisma.standinRequest.findMany({
      where: {
        standinUserId: viewer.id,
        status: STANDIN_REQUEST_STATUS.PENDING,
        match: unplayed,
      },
      select: {
        id: true,
        teamId: true,
        match: FIXTURE,
      },
    }),
  ]);
  if (bookings.length === 0 && asks.length === 0) return null;
  const [matches, draftStatus] = await Promise.all([
    getSeasonMatches(season.id),
    getSeasonDraftStatus(season.id),
  ]);
  const rounds = playoffTotalRounds(matches);
  // Soonest first, an unscheduled fixture last; the id breaks ties.
  const byKickoff = <T extends { id: string; match: { scheduledAt: Date | null } }>(
    rows: T[],
  ) =>
    [...rows].sort(
      (a, b) =>
        (a.match.scheduledAt?.getTime() ?? Infinity) -
          (b.match.scheduledAt?.getTime() ?? Infinity) || a.id.localeCompare(b.id),
    );
  const sideName = (
    match: { homeTeamId: string; homeTeam: { name: string }; awayTeam: { name: string } },
    teamId: string,
    mine: boolean,
  ) =>
    (teamId === match.homeTeamId) === mine
      ? match.homeTeam.name
      : match.awayTeam.name;

  const rows = await Promise.all(
    byKickoff(bookings).map(async (b) => {
      const open = matchCheckinOpen(
        season.status,
        draftStatus,
        b.match.status,
        b.match.scheduledAt,
        nowMs,
      );
      const [side, rsvp] = open
        ? await Promise.all([
            loadCheckinSide({ matchId: b.match.id, viewer }),
            prisma.matchAvailability.findUnique({
              where: {
                matchId_userId: { matchId: b.match.id, userId: viewer.id },
              },
              select: { status: true, scheduleRevision: true },
            }),
          ])
        : [null, null];
      return { booking: b, side, rsvp };
    }),
  );

  return (
    <section aria-labelledby="my-standin-games-title" className="space-y-3">
      <h2
        id="my-standin-games-title"
        className="font-display text-xl font-semibold"
      >
        Your games
      </h2>
      {rows.map(({ booking: b, side, rsvp }) => {
        const team = sideName(b.match, b.teamId, true);
        const opponent = sideName(b.match, b.teamId, false);
        const label = matchRoundLabel(b.match, rounds, { bestOf: true });
        return side ? (
          <CheckinBanner
            key={b.id}
            matchId={b.match.id}
            scheduleRevision={b.match.scheduleRevision}
            remainingGames={b.match.status === MATCH_STATUS.LIVE}
            heading={`${label}: ${team} vs ${opponent}`}
            when={
              b.match.scheduledAt
                ? formatLeagueMatchTime(b.match.scheduledAt, "full")
                : undefined
            }
            whenTs={b.match.scheduledAt?.getTime()}
            myRsvp={
              rsvp && rsvp.scheduleRevision === b.match.scheduleRevision
                ? rsvp.status
                : null
            }
            side={side}
            detailsHref={`/matches/${b.match.id}`}
          />
        ) : (
          <p
            key={b.id}
            className="rounded-[var(--radius)] border border-info/40 bg-info/10 px-4 py-3 text-sm [overflow-wrap:anywhere]"
          >
            <span className="font-medium">
              {label}: you&apos;re standing in for{" "}
              {b.replaced ? `${b.replaced.name} on ` : ""}
              {team}
            </span>{" "}
            <span className="text-muted">
              vs {opponent}
              {" · "}
              {b.match.scheduledAt ? (
                <LocalTime
                  ts={b.match.scheduledAt.getTime()}
                  variant="full"
                  initial={formatLeagueMatchTime(b.match.scheduledAt, "full")}
                />
              ) : (
                "no kickoff yet"
              )}
              . Check-in opens once the kickoff is set.{" "}
            </span>
            <Link href={`/matches/${b.match.id}`} className={textLink()}>
              Match page <LinkArrow />
            </Link>
          </p>
        );
      })}
      {byKickoff(asks).map((a) => {
        const team = sideName(a.match, a.teamId, true);
        const opponent = sideName(a.match, a.teamId, false);
        return (
          <p
            key={a.id}
            className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-4 py-3 text-sm [overflow-wrap:anywhere]"
          >
            <span aria-hidden>⏳ </span>
            <span className="font-medium">
              {matchRoundLabel(a.match, rounds)}: {team} asked for you
            </span>{" "}
            <span className="text-muted">
              vs {opponent}. You&apos;re in once the {opponent} captain agrees,
              and you&apos;re pinged on Discord when they do.
            </span>
          </p>
        );
      })}
    </section>
  );
}
