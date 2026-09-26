import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { loadLineupCandidates } from "@/lib/match-lineups";
import { matchCheckinOpen } from "@/lib/league-lifecycle";
import { CheckinBanner } from "./checkin-banner";

/** While a series is LIVE, a player on either side (or the standin covering
 * them) can say they're ready for the remaining games. Rendered only for that
 * viewer; everyone else gets nothing. */
export async function LiveSeriesCheckin({ matchId }: { matchId: string }) {
  const viewer = await getSessionUser();
  if (!viewer) return null;
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      season: { select: { isActive: true, status: true, draft: { select: { status: true } } } },
      homeTeam: { select: { id: true, withdrawn: true } },
      awayTeam: { select: { id: true, withdrawn: true } },
    },
  });
  if (!match || match.status !== "LIVE" || !match.season.isActive) return null;
  // Server component: one request-time decision, never a client render clock.
  // eslint-disable-next-line react-hooks/purity
  if (!matchCheckinOpen(match.season.status, match.season.draft?.status, match.status, match.scheduledAt, Date.now())) return null;
  const [member, assignments, ownRsvp] = await Promise.all([
    prisma.teamMember.findFirst({ where: { seasonId: match.seasonId, userId: viewer.id, teamId: { in: [match.homeTeamId, match.awayTeamId] } }, select: { teamId: true } }),
    prisma.standinAssignment.findMany({ where: { matchId, OR: [{ standinUserId: viewer.id }, { replacingUserId: viewer.id }] }, select: { teamId: true, standinUserId: true, replacingUserId: true } }),
    prisma.matchAvailability.findFirst({ where: { matchId, userId: viewer.id, scheduleRevision: match.scheduleRevision }, select: { status: true } }),
  ]);
  const ownTeamId = member?.teamId ?? assignments.find((a) => a.standinUserId === viewer.id && [match.homeTeamId, match.awayTeamId].includes(a.teamId))?.teamId;
  const ownTeam = [match.homeTeam, match.awayTeam].find((team) => team.id === ownTeamId);
  if (!ownTeam || ownTeam.withdrawn) return null;
  // The same who-plays-for-this-side rule check-ins use: a covered player is
  // out, and the standin covering them is in.
  const candidates = await loadLineupCandidates(prisma, match, ownTeam.id);
  if (!candidates.some((candidate) => candidate.userId === viewer.id && candidate.eligible)) return null;
  return (
    <section id="match-live-checkin" aria-label="Ready for the next game" className="scroll-mt-40">
      <CheckinBanner matchId={match.id} scheduleRevision={match.scheduleRevision} heading="Ready for the next game" remainingGames myRsvp={ownRsvp?.status ?? null} />
    </section>
  );
}
