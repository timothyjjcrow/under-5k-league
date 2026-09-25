import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { loadLineupCandidates } from "@/lib/match-lineups";
import { matchCheckinOpen } from "@/lib/league-lifecycle";
import { confirmLineupAction } from "@/app/actions/match-lineups";
import { ActionForm, SubmitButton } from "./action-form";
import { Card, CardBody, CardHeader, PlayerLink } from "./ui";
import { LocalTime } from "./local-time";
import { CheckinBanner } from "./checkin-banner";
import { formatMatchTime } from "@/lib/match-time";

/** Public plans are names only. Named check-in answers and candidate
 * forms are loaded solely for the captain who can confirm that side, or admin. */
export async function MatchLineups({ matchId }: { matchId: string }) {
  const [viewer, match, snapshots] = await Promise.all([
    getSessionUser(),
    prisma.match.findUnique({ where: { id: matchId }, include: {
      season: { select: { isActive: true, status: true, teamSize: true, draft: { select: { status: true } } } },
      homeTeam: { select: { id: true, name: true, captainId: true, withdrawn: true } },
      awayTeam: { select: { id: true, name: true, captainId: true, withdrawn: true } },
    } }),
    prisma.matchLineup.findMany({ where: { matchId }, orderBy: { revision: "desc" }, include: { seats: { orderBy: { seatKey: "asc" } } } }),
  ]);
  if (!match) return null;
  // Server component: one request-time decision, never a client render clock.
  // eslint-disable-next-line react-hooks/purity
  const open = match.season.isActive && matchCheckinOpen(match.season.status, match.season.draft?.status, match.status, match.scheduledAt, Date.now());
  const sides = await Promise.all([match.homeTeam, match.awayTeam].map(async (team) => {
    const editable = !!viewer && !team.withdrawn && open && (viewer.role === "ADMIN" || team.captainId === viewer.id);
    return { team, editable, snapshot: snapshots.find((row) => row.teamId === team.id), candidates: editable ? await loadLineupCandidates(prisma, match, team.id) : [] };
  }));
  let liveCheckin = null;
  if (viewer && open && match.status === "LIVE") {
    const [member, assignments, ownRsvp] = await Promise.all([
      prisma.teamMember.findFirst({ where: { seasonId: match.seasonId, userId: viewer.id, teamId: { in: [match.homeTeamId, match.awayTeamId] } }, select: { teamId: true } }),
      prisma.standinAssignment.findMany({ where: { matchId, OR: [{ standinUserId: viewer.id }, { replacingUserId: viewer.id }] }, select: { teamId: true, standinUserId: true, replacingUserId: true } }),
      prisma.matchAvailability.findFirst({ where: { matchId, userId: viewer.id, scheduleRevision: match.scheduleRevision }, select: { status: true } }),
    ]);
    const ownTeamId = member?.teamId ?? assignments.find((a) => a.standinUserId === viewer.id && [match.homeTeamId, match.awayTeamId].includes(a.teamId))?.teamId;
    const ownSide = sides.find((side) => side.team.id === ownTeamId);
    const ownCandidates = ownSide && !ownSide.team.withdrawn
      ? ownSide.editable ? ownSide.candidates : await loadLineupCandidates(prisma, match, ownSide.team.id)
      : [];
    if (ownCandidates.some((candidate) => candidate.userId === viewer.id && candidate.eligible)) {
      liveCheckin = <CheckinBanner matchId={match.id} scheduleRevision={match.scheduleRevision} heading="Ready for the next game" remainingGames myRsvp={ownRsvp?.status ?? null} />;
    }
  }
  if (!snapshots.length && !open) return null;
  return (
    <section id="match-lineups" aria-label="Playing lineups" className="scroll-mt-40 space-y-3">
      {liveCheckin}
      <Card>
        <CardHeader title="Playing lineups" headingLevel={2} subtitle="Captain-confirmed plans. Imported box scores record who actually played each game." />
        <CardBody className="grid gap-4 lg:grid-cols-2">
          {sides.map(({ team, editable, snapshot, candidates }) => (
            <section key={team.id} aria-label={`${team.name} playing lineup`} className="min-w-0 space-y-3 rounded-lg border border-line p-4">
              <h3 className="font-semibold">{team.name}</h3>
              {snapshot ? (
                <div className="space-y-2 text-sm">
                  <p className={snapshot.status === "CONFIRMED" ? "text-success" : "text-muted"}>
                    {snapshot.status === "CONFIRMED" ? "Confirmed" : "Previous plan superseded"} · revision {snapshot.revision}
                  </p>
                  <p className="text-xs text-muted">Confirmed by {snapshot.confirmedByName} · <LocalTime ts={snapshot.confirmedAt.getTime()} variant="full" initial={formatMatchTime(snapshot.confirmedAt, "full")} /></p>
                  <ul className="space-y-1">
                    {snapshot.seats.map((seat) => <li key={seat.id} className="flex flex-wrap items-baseline gap-x-2">
                      <PlayerLink userId={seat.userId}>{seat.userNameSnapshot}</PlayerLink>
                      {seat.entryKind === "STANDIN" ? <span className="text-xs text-muted">standin</span> : null}
                    </li>)}
                  </ul>
                  {snapshot.status !== "CONFIRMED" ? <p className="text-xs text-muted">{snapshot.reason ? /^[A-Z_]+$/.test(snapshot.reason) ? snapshot.reason.toLowerCase().replaceAll("_", " ") : snapshot.reason : "Match logistics changed."} Earlier games keep their original record.</p> : null}
                </div>
              ) : <p className="text-sm text-muted">The captain has not confirmed a playing lineup yet.</p>}
              {editable ? (
                <ActionForm action={confirmLineupAction} className="space-y-3 border-t border-line pt-3" hidden={{
                  matchId, teamId: team.id, expectedScheduleRevision: String(match.scheduleRevision),
                  expectedLogisticsRevision: String(match.logisticsRevision), expectedLineupRevision: String(snapshot?.revision ?? 0),
                }}>
                  <fieldset className="space-y-2">
                    <legend className="mb-2 text-sm font-medium">Select {match.season.teamSize} players who are checked in</legend>
                    <p className="text-xs text-muted">
                      {candidates.filter((c) => c.eligible && c.availability?.status === "IN").length} of {match.season.teamSize} needed have checked in. Players can only be picked once they check in for this match.
                    </p>
                    {candidates.map((candidate) => <div key={`${candidate.seatKey}:${candidate.userId}`} className="space-y-1 rounded-md bg-surface-2/50 p-2">
                      <label className="flex min-h-10 items-center gap-2 text-sm">
                        <input name="playerId" type="checkbox" value={candidate.userId} defaultChecked={candidate.eligible && candidate.availability?.status === "IN"} disabled={!candidate.eligible || candidate.availability?.status !== "IN"} />
                        <span>{candidate.userName} · {candidate.availability?.status === "IN" ? "Checked in" : candidate.availability?.status === "OUT" ? "Unavailable" : "Awaiting check-in"}</span>
                      </label>
                      {candidate.entryKind === "STANDIN" ? <p className="text-xs text-muted">Legacy cover assignment: offer acceptance is unknown. This player&apos;s current check-in is shown separately.</p> : null}
                    </div>)}
                  </fieldset>
                  <p className="text-xs text-muted">Optional. Confirming saves who is playing from now onward, including any standins. It does not change earlier game participants.</p>
                  <SubmitButton size="sm" disabled={candidates.filter((c) => c.eligible && c.availability?.status === "IN").length < match.season.teamSize}>Confirm playing lineup</SubmitButton>
                </ActionForm>
              ) : null}
            </section>
          ))}
        </CardBody>
      </Card>
    </section>
  );
}
