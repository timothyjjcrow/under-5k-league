// Loads the team page's "Match prep" card for one of the team's own people:
// their side's check-ins (the same loader as the check-in banner, so the
// counts agree with Home, /schedule and the match page), the team's standin
// bookings, the standin requests waiting on a captain, and an open ready
// check. Read-only, and only called for the team's captain and roster.

import { prisma } from "./prisma";
import { STANDIN_REQUEST_STATUS } from "./constants";
import { loadCheckinSide } from "./checkin-side-service";
import type { CheckinSideView } from "./checkin-side";
import { parseRescheduleOptions } from "./reschedule-ready-check";
import { teamWeekNotes, type TeamWeekNote } from "./team-week";

export type TeamWeek = {
  side: CheckinSideView;
  notes: TeamWeekNote[];
};

/**
 * The card for `viewer` on `teamId`'s side of this match, or null when they
 * aren't on its match-night roster (a covered player has nothing to do
 * here). `standinsOpen` and `rescheduleOpen` are the match page's own card
 * gates (`captainCardsOpen`), so no line points at a card that isn't there.
 */
export async function loadTeamWeek(input: {
  match: { id: string; homeTeamId: string; awayTeamId: string };
  teamId: string;
  otherTeamName: string;
  viewer: { id: string; role: string };
  standinsOpen: boolean;
  rescheduleOpen: boolean;
  nowMs: number;
}): Promise<TeamWeek | null> {
  const { match, teamId } = input;
  const side = await loadCheckinSide({ matchId: match.id, viewer: input.viewer });
  if (!side) return null;
  const captain = side.role === "captain";
  const [bookings, requests, proposal] = await Promise.all([
    prisma.standinAssignment.findMany({
      where: { matchId: match.id, teamId },
      select: {
        standin: { select: { name: true } },
        replaced: { select: { name: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    // Only a captain answers or withdraws a request.
    captain
      ? prisma.standinRequest.findMany({
          where: { matchId: match.id, status: STANDIN_REQUEST_STATUS.PENDING },
          select: { teamId: true },
        })
      : Promise.resolve([]),
    input.rescheduleOpen
      ? prisma.rescheduleRequest.findFirst({
          where: { matchId: match.id, status: "PENDING" },
          // At most one is open; the order only makes a stray duplicate stable.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { proposedById: true, proposedTime: true, options: true },
        })
      : Promise.resolve(null),
  ]);
  // A check whose every time has passed asks nothing (readyCheckLive).
  const ahead = proposal
    ? parseRescheduleOptions(proposal.options, proposal.proposedTime).filter(
        (t) => t > input.nowMs,
      )
    : [];
  return {
    side,
    notes: teamWeekNotes({
      role: side.role,
      counts: side.counts,
      outNames: side.names?.out ?? null,
      standinsOpen: input.standinsOpen,
      bookings: bookings.map((b) => ({
        standinName: b.standin.name,
        replacingName: b.replaced?.name ?? null,
      })),
      requests: {
        mine: requests.filter((r) => r.teamId === teamId).length,
        theirs: requests.filter((r) => r.teamId !== teamId).length,
      },
      otherTeamName: input.otherTeamName,
      readyCheck:
        proposal && ahead.length > 0
          ? { mine: proposal.proposedById === input.viewer.id, options: ahead.length }
          : null,
    }),
  };
}
