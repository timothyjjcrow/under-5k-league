import { prisma } from "@/lib/prisma";
import { loadSidePlayerIds } from "@/lib/availability-service";
import { loadCheckinSide } from "@/lib/checkin-side-service";
import { matchCheckinOpen } from "@/lib/league-lifecycle";
import { CheckinBanner } from "@/components/checkin-banner";
import { loadDraftStatus, type MatchPageMatch, type MatchViewer } from "./load";

/** While a series is LIVE, a player on either side (or the standin covering
 * them) can say they're ready for the remaining games. Rendered only for that
 * viewer; everyone else gets nothing. `names: false` keeps the captain's
 * named list off when the page's Matchup card already shows it. */
export async function LiveSeriesCheckin({
  match,
  viewer,
  names = true,
}: {
  match: MatchPageMatch;
  viewer: MatchViewer;
  names?: boolean;
}) {
  if (!viewer) return null;
  if (match.status !== "LIVE" || !match.season.isActive) return null;
  const draftStatus = await loadDraftStatus(match);
  // Server component: one request-time decision, never a client render clock.
  // eslint-disable-next-line react-hooks/purity
  if (!matchCheckinOpen(match.season.status, draftStatus, match.status, match.scheduledAt, Date.now())) return null;
  const matchId = match.id;
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
  if (!(await loadSidePlayerIds(prisma, match, ownTeam.id)).has(viewer.id)) return null;
  const side = await loadCheckinSide({ matchId, viewer, names });
  return (
    <section id="match-live-checkin" aria-label="Ready for the next game" className="scroll-mt-24">
      <CheckinBanner matchId={match.id} scheduleRevision={match.scheduleRevision} heading="Ready for the next game" remainingGames myRsvp={ownRsvp?.status ?? null} viewerIsCaptain={ownTeam.captainId === viewer.id} side={side} />
    </section>
  );
}
