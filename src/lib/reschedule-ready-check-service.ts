// Read side of the reschedule ready check: one match's open proposal, as one
// viewer may see it. Shared by the match page's card, the home strip and the
// card's poll (GET /api/matches/[id]/reschedule), so they can't disagree.
// Writes live in reschedule-service.ts; the rules in reschedule-ready-check.ts.

import { prisma } from "./prisma";
import { loadSidePlayerIds } from "./availability-service";
import { matchLogisticsOpen } from "./league-lifecycle";
import { getSeasonDraftStatus } from "./queries";
import { canViewNamedMatchAvailability } from "./visibility";
import {
  buildReadyCheckView,
  parseRescheduleOptions,
  type ReadyCheckPerson,
  type ReadyCheckView,
} from "./reschedule-ready-check";

/** The match fields the ready check reads (the match page has them all). */
export type ReadyCheckMatch = {
  id: string;
  seasonId: string;
  status: string;
  scheduledAt: Date | null;
  homeTeamId: string;
  awayTeamId: string;
  homeTeam: { name: string; captainId: string };
  awayTeam: { name: string; captainId: string };
  season: { isActive: boolean; status: string; teamSize: number };
};

export type ReadyCheckViewer = { id: string; role: string } | null;

/**
 * The open proposal on `match` as `viewer` sees it, or null when there is
 * none. Names only for the captains and admins
 * (canViewNamedMatchAvailability), the rule the check-in lists follow.
 */
export async function loadReadyCheckView(
  match: ReadyCheckMatch,
  viewer: ReadyCheckViewer,
  nowMs: number,
): Promise<ReadyCheckView | null> {
  const request = await prisma.rescheduleRequest.findFirst({
    where: { matchId: match.id, status: "PENDING" },
    // At most one is open; the order only makes a stray duplicate stable.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      proposedBy: { select: { name: true } },
      votes: { select: { userId: true, time: true, ready: true } },
    },
  });
  if (!request) return null;
  const [homeSeats, awaySeats, draftStatus] = await Promise.all([
    loadSidePlayerIds(prisma, match, match.homeTeamId),
    loadSidePlayerIds(prisma, match, match.awayTeamId),
    getSeasonDraftStatus(match.seasonId),
  ]);
  const named = canViewNamedMatchAvailability(
    viewer,
    match.homeTeam.captainId,
    match.awayTeam.captainId,
  );
  // Seats in a stable order: the captain first, then by name.
  const peopleIds = [
    ...new Set([
      ...homeSeats,
      ...awaySeats,
      ...(viewer ? [viewer.id] : []),
    ]),
  ];
  const people = new Map<string, ReadyCheckPerson>(
    (
      await prisma.user.findMany({
        where: { id: { in: peopleIds } },
        select: { id: true, name: true, avatar: true },
      })
    ).map((u) => [u.id, u]),
  );
  const ordered = (ids: Set<string>, captainId: string) =>
    [...ids].sort((a, b) =>
      a === captainId
        ? -1
        : b === captainId
          ? 1
          : (people.get(a)?.name ?? "").localeCompare(
              people.get(b)?.name ?? "",
            ) || a.localeCompare(b),
    );
  return buildReadyCheckView({
    request: {
      id: request.id,
      matchId: match.id,
      proposedById: request.proposedById,
      createdAtMs: request.createdAt.getTime(),
      note: request.note,
      options: parseRescheduleOptions(request.options, request.proposedTime),
    },
    proposerName: request.proposedBy.name,
    kickoffMs: match.scheduledAt?.getTime() ?? null,
    teamSize: match.season.teamSize,
    home: {
      teamId: match.homeTeamId,
      captainId: match.homeTeam.captainId,
      name: match.homeTeam.name,
      seatIds: ordered(homeSeats, match.homeTeam.captainId),
    },
    away: {
      teamId: match.awayTeamId,
      captainId: match.awayTeam.captainId,
      name: match.awayTeam.name,
      seatIds: ordered(awaySeats, match.awayTeam.captainId),
    },
    votes: request.votes.map((v) => ({
      userId: v.userId,
      timeMs: v.time.getTime(),
      ready: v.ready,
    })),
    people,
    viewer: viewer ? { id: viewer.id, isAdmin: viewer.role === "ADMIN" } : null,
    named,
    open:
      match.season.isActive &&
      matchLogisticsOpen(match.season.status, draftStatus, match.status),
    nowMs,
  });
}

/** loadReadyCheckView by match id, for the card's poll. */
export async function loadReadyCheckViewById(
  matchId: string,
  viewer: ReadyCheckViewer,
  nowMs: number,
): Promise<ReadyCheckView | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      seasonId: true,
      status: true,
      scheduledAt: true,
      homeTeamId: true,
      awayTeamId: true,
      homeTeam: { select: { name: true, captainId: true } },
      awayTeam: { select: { name: true, captainId: true } },
      season: { select: { isActive: true, status: true, teamSize: true } },
    },
  });
  return match ? loadReadyCheckView(match, viewer, nowMs) : null;
}

/** How long the match page shows "moved by ready check" after a lock. */
export const RECENT_LOCK_MS = 24 * 60 * 60 * 1000;
/** A lock this fresh plays the burst: it is the moment it happened. */
export const LOCK_BURST_MS = 20 * 1000;

export type RecentLock = {
  timeMs: number;
  lockedAtMs: number;
  /** Players (seats) who said yes to the locked time, out of `seats`. */
  ready: number;
  seats: number;
  /** Locked in the last few seconds: the card celebrates. */
  burst: boolean;
};

/**
 * The ready check that last moved this match, when it did so within
 * RECENT_LOCK_MS and its time is still the kickoff (an admin move after it
 * makes the card wrong, so it hides). Null otherwise.
 */
export async function loadRecentLock(
  match: {
    id: string;
    seasonId: string;
    scheduledAt: Date | null;
    homeTeamId: string;
    awayTeamId: string;
  },
  nowMs: number,
): Promise<RecentLock | null> {
  if (!match.scheduledAt) return null;
  const lock = await prisma.rescheduleRequest.findFirst({
    where: {
      matchId: match.id,
      status: "ACCEPTED",
      lockedAt: { gte: new Date(nowMs - RECENT_LOCK_MS) },
    },
    orderBy: [{ lockedAt: "desc" }, { id: "desc" }],
    select: { proposedById: true, proposedTime: true, lockedAt: true, votes: true },
  });
  if (
    !lock?.lockedAt ||
    lock.proposedTime.getTime() !== match.scheduledAt.getTime()
  )
    return null;
  const [home, away] = await Promise.all([
    loadSidePlayerIds(prisma, match, match.homeTeamId),
    loadSidePlayerIds(prisma, match, match.awayTeamId),
  ]);
  const seats = new Set([...home, ...away]);
  const answers = new Map(
    lock.votes
      .filter((v) => v.time.getTime() === lock.proposedTime.getTime())
      .map((v) => [v.userId, v.ready]),
  );
  // The proposer's yes is implied unless they said otherwise.
  if (!answers.has(lock.proposedById)) answers.set(lock.proposedById, true);
  return {
    timeMs: lock.proposedTime.getTime(),
    lockedAtMs: lock.lockedAt.getTime(),
    ready: [...seats].filter((id) => answers.get(id) === true).length,
    seats: seats.size,
    burst: nowMs - lock.lockedAt.getTime() <= LOCK_BURST_MS,
  };
}
