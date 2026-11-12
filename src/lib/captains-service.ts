// The reads behind the Captains page (/captains) and Home's captain line.
//
// Only reads live here. The page's controls are the existing cards and
// forms (the match page's Standins, Reschedule and lobby cards, the team
// identity form, the scrim forms), whose server actions re-check every rule.
// This file gathers what waits on the captain across ALL of their team's open
// matches (the match page's own list covers one match), and the state a
// control needs before it is drawn.

import { cache } from "react";
import { matchNightRoster, teamAvailability } from "./availability";
import { captainTodos, type CaptainTodo } from "./captain-todos";
import { checkinNudgeBlockedSince } from "./checkin-nudge-service";
import { getWebhookUrl } from "./discord";
import { MATCH_STATUS, STANDIN_REQUEST_STATUS } from "./constants";
import { postAuctionWorkOpen } from "./league-lifecycle";
import { prisma } from "./prisma";
import { getSeasonMatches } from "./queries";
import { loadReadyCheckView } from "./reschedule-ready-check-service";
import { matchRoundLabel, playoffTotalRounds } from "./schedule";

/**
 * The team the viewer captains in this season, or null. `Team.captainId` is
 * the authority (a roster row's `isCaptain` is not), and `(seasonId,
 * captainId)` is unique. Request-cached: the layout's nav, Home's line and the
 * page may all ask.
 */
export const getCaptainTeam = cache(async function getCaptainTeam(
  seasonId: string,
  userId: string,
) {
  return prisma.team.findUnique({
    where: { seasonId_captainId: { seasonId, captainId: userId } },
    select: {
      id: true,
      name: true,
      logoUrl: true,
      withdrawn: true,
      captainId: true,
    },
  });
});

export type CaptainTodoRow = {
  matchId: string;
  /** "Week 3", "Semifinal", … (`matchRoundLabel`). */
  roundLabel: string;
  opponentName: string;
  todo: CaptainTodo;
};

/**
 * Everything waiting on this captain across their team's open matches,
 * earliest fixture first, each item decided by `captainTodos` exactly as the
 * match page decides it. Before the auction is done no match work is open,
 * so it reads nothing.
 */
export async function loadCaptainTodoRows({
  season,
  draftStatus,
  teamId,
  viewerId,
  nowMs,
}: {
  season: { id: string; status: string; isActive: boolean; teamSize: number };
  draftStatus: string | null;
  teamId: string;
  viewerId: string;
  nowMs: number;
}): Promise<CaptainTodoRow[]> {
  if (!season.isActive || !postAuctionWorkOpen(season.status, draftStatus)) {
    return [];
  }
  const [open, roster, allMatches] = await Promise.all([
    prisma.match.findMany({
      where: {
        seasonId: season.id,
        status: { not: MATCH_STATUS.COMPLETED },
        OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
      },
      orderBy: [{ week: "asc" }, { scheduledAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        seasonId: true,
        week: true,
        phase: true,
        bracketSlot: true,
        bestOf: true,
        status: true,
        scheduledAt: true,
        scheduleRevision: true,
        homeTeamId: true,
        awayTeamId: true,
        homeTeam: { select: { name: true, captainId: true } },
        awayTeam: { select: { name: true, captainId: true } },
        standins: { select: { replacingUserId: true } },
        standinRequests: {
          where: { status: STANDIN_REQUEST_STATUS.PENDING },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            teamId: true,
            replacingUserId: true,
            requestedBy: { select: { name: true } },
            standin: { select: { name: true } },
          },
        },
        reschedules: {
          // As loadReadyCheckView reads it: at most one is open.
          where: { status: "PENDING" },
          select: { id: true },
          take: 1,
        },
      },
    }),
    prisma.teamMember.findMany({
      where: { seasonId: season.id, teamId },
      orderBy: { createdAt: "asc" },
      select: { userId: true, user: { select: { name: true } } },
    }),
    // Request-cached: Home has usually read it already.
    getSeasonMatches(season.id),
  ]);
  if (open.length === 0) return [];
  const [outRows, readyChecks] = await Promise.all([
    prisma.matchAvailability.findMany({
      where: {
        matchId: { in: open.map((m) => m.id) },
        status: "OUT",
      },
      select: { matchId: true, userId: true, scheduleRevision: true },
    }),
    // Only a match with a pending reschedule has a ready check to read.
    Promise.all(
      open.map((match) =>
        match.reschedules.length > 0
          ? loadReadyCheckView(
              { ...match, season },
              { id: viewerId, role: "USER" },
              nowMs,
            )
          : Promise.resolve(null),
      ),
    ),
  ]);
  const revision = new Map(open.map((m) => [m.id, m.scheduleRevision]));
  const outByMatch = new Map<string, Set<string>>();
  for (const row of outRows) {
    // Check-ins count for the fixture's current time only.
    if (row.scheduleRevision !== revision.get(row.matchId)) continue;
    const set = outByMatch.get(row.matchId) ?? new Set<string>();
    set.add(row.userId);
    outByMatch.set(row.matchId, set);
  }
  const rounds = playoffTotalRounds(allMatches);
  const members = roster.map((m) => ({ userId: m.userId, name: m.user.name }));
  return open.flatMap((match, i) => {
    const home = match.homeTeamId === teamId;
    const opponentName = home ? match.awayTeam.name : match.homeTeam.name;
    const roundLabel = matchRoundLabel(match, rounds);
    return captainTodos({
      myTeamId: teamId,
      seasonStatus: season.status,
      draftStatus,
      match: {
        status: match.status,
        coveredUserIds: match.standins.flatMap((s) =>
          s.replacingUserId ? [s.replacingUserId] : [],
        ),
        standinRequests: match.standinRequests.map((r) => ({
          teamId: r.teamId,
          replacingUserId: r.replacingUserId,
          requestedByName: r.requestedBy.name,
          standinName: r.standin.name,
        })),
      },
      roster: members,
      outUserIds: outByMatch.get(match.id) ?? new Set(),
      readyCheck: readyChecks[i],
    }).map((todo) => ({ matchId: match.id, roundLabel, opponentName, todo }));
  });
}

export type CaptainNudge = {
  /** Players on the side's match-night roster with no answer, but the captain. */
  waiting: number;
  /** When the last reminder went out while it still blocks another. */
  sentAt: Date | null;
};

/**
 * The captain's "Remind the N who haven't answered" for one match, exactly as
 * the match page's Matchup card decides it: only while check-in is open,
 * only when someone else on the side's match-night roster (standins in,
 * the players they cover out) owes an answer for the current kickoff, and
 * only when the league has a Discord channel. `sendCheckinNudge` re-checks
 * all of it when the button is pressed.
 */
export async function loadCaptainNudge({
  match,
  teamId,
  viewerId,
  checkinOpen,
  nowMs,
}: {
  match: { id: string; seasonId: string; scheduleRevision: number };
  teamId: string;
  viewerId: string;
  /** `matchCheckinOpen` for this match, and the series isn't live. */
  checkinOpen: boolean;
  nowMs: number;
}): Promise<CaptainNudge | null> {
  if (!checkinOpen) return null;
  const [members, standins, rsvps] = await Promise.all([
    prisma.teamMember.findMany({
      where: { seasonId: match.seasonId, teamId },
      select: { userId: true },
    }),
    prisma.standinAssignment.findMany({
      where: { matchId: match.id, teamId },
      select: { standinUserId: true, replacingUserId: true },
    }),
    prisma.matchAvailability.findMany({
      where: { matchId: match.id, scheduleRevision: match.scheduleRevision },
      select: { userId: true, status: true },
    }),
  ]);
  const roster = matchNightRoster(
    members.map((m) => m.userId),
    standins,
  );
  const waiting = teamAvailability(roster, rsvps).unansweredUserIds.filter(
    (id) => id !== viewerId,
  ).length;
  if (waiting === 0 || !(await getWebhookUrl())) return null;
  return {
    waiting,
    sentAt: await checkinNudgeBlockedSince(
      match.id,
      teamId,
      match.scheduleRevision,
      nowMs,
    ),
  };
}
