import { coverProblemMatchIds } from "@/lib/admin-sections";
import { standinClashes } from "@/lib/admin-attention";
import Link from "@/components/app-link";
import { roundName, slotRound, groupPlayoffRounds } from "@/lib/schedule";
import { StandinMatchBlock } from "@/components/admin-match-tools";
import { Card, CardBody, CardHeader, textLink } from "@/components/ui";
import type { AdminData, Season } from "@/components/admin/season-admin-data";

export function StandinControls({
  season,
  data,
  viewerId,
}: {
  season: Season;
  data: AdminData;
  /** The admin viewing the page: no "agree" on their own side's request. */
  viewerId: string;
}) {
  const upcoming = data.matches.filter((m) => m.status !== "COMPLETED");
  const teamName = new Map(data.teams.map((t) => [t.id, t.name]));
  const byMatch = new Map<string, AdminData["assignments"]>();
  for (const a of data.assignments) {
    const arr = byMatch.get(a.matchId) ?? [];
    arr.push(a);
    byMatch.set(a.matchId, arr);
  }
  const requestsByMatch = new Map<string, AdminData["standinRequests"]>();
  for (const r of data.standinRequests) {
    const arr = requestsByMatch.get(r.matchId) ?? [];
    arr.push(r);
    requestsByMatch.set(r.matchId, arr);
  }
  // Mirror the service's phase gate (render/guard pairing): assignment is
  // open mid-season and in the post-auction DRAFT window; the card still
  // renders elsewhere because REMOVAL is legal cleanup in every phase.
  const assignOpen =
    season.status === "REGULAR_SEASON" ||
    season.status === "PLAYOFFS" ||
    (season.status === "DRAFT" && data.draft?.status === "COMPLETE");
  // DOUBLE-BOOKED standins, recomputed from live data. standinConflict runs
  // at assign time, but every retime path (setWeekNight, setMatchTime, an
  // accepted reschedule) can move a fixture onto a night the assign-time
  // check already approved — and the only report was a transient toast that
  // could land on a captain with no power to fix the other team's booking.
  // This is the durable, admin-owned surface.
  const standinName = new Map(
    data.assignments.map((a) => [a.standinUserId, a.standin.name]),
  );
  const clashes = standinClashes(data.assignments, data.matches);
  // The season's bookings on unplayed fixtures, in the shape the picker's
  // already-booked / same-night check reads (the match page loads the same).
  const bookings = data.assignments.flatMap((a) => {
    const fx = upcoming.find((m) => m.id === a.matchId);
    return fx
      ? [
          {
            standinUserId: a.standinUserId,
            matchId: a.matchId,
            replacedName: a.replaced?.name ?? null,
            homeName: teamName.get(fx.homeTeamId ?? "") ?? "?",
            awayName: teamName.get(fx.awayTeamId ?? "") ?? "?",
            scheduledAt: fx.scheduledAt,
            week: fx.week,
          },
        ]
      : [];
  });
  const clashLines = clashes.map(({ standinUserId, first, second }) => {
    const label = (m: (typeof upcoming)[number]) =>
      `${teamName.get(m.homeTeamId ?? "") ?? "?"} vs ${teamName.get(m.awayTeamId ?? "") ?? "?"} (wk ${m.week})`;
    return `${standinName.get(standinUserId) ?? "A standin"} covers both ${label(first)} and ${label(second)} the same night — remove one below`;
  });
  // The card opens on the exceptions only. Captains book nearly all cover
  // themselves from the match page, so a full assign form for every open
  // match made this one of the longest cards on /admin for the rare night
  // the admin steps in. Everything else, including the any-team override,
  // is one click away under "Assign any match".
  const problemIds = coverProblemMatchIds({
    matches: upcoming,
    teams: data.teams,
    bookings: data.assignments,
    outRsvps: data.outRsvps,
    clashes,
  });
  const problems = upcoming.filter((m) => problemIds.has(m.id));
  // Outside the assign window only matches with a booking or a request have
  // anything to show (removal, decline, withdraw); an empty block there is noise.
  const rest = upcoming.filter(
    (m) =>
      !problemIds.has(m.id) &&
      (assignOpen || byMatch.has(m.id) || requestsByMatch.has(m.id)),
  );
  // Standins are assigned for the imminent night — group by week and only
  // expand the earliest open one so the current night isn't a scroll away.
  const regularRest = rest.filter(
    (m) => m.phase === "REGULAR" || m.phase === "TIEBREAKER",
  );
  const playoffRest = rest.filter(
    (m) => m.phase === "PLAYOFF" || m.phase === "FINAL",
  );
  const weeks = [...new Set(regularRest.map((m) => m.week))].sort(
    (a, b) => a - b,
  );
  // Round names need the full bracket depth — deriving it from only the
  // upcoming (not-yet-played) rounds would drop the first-round count and
  // mislabel a lone remaining semifinal/final.
  const { totalRounds } = groupPlayoffRounds(
    data.matches.filter((m) => m.phase === "PLAYOFF" || m.phase === "FINAL"),
  );
  const matchLabel = (m: (typeof upcoming)[number]) => (
    <Link href={`/matches/${m.id}`} className={textLink()}>
      {m.phase === "PLAYOFF" || m.phase === "FINAL"
        ? roundName(slotRound(m.bracketSlot), totalRounds)
        : `${m.phase === "TIEBREAKER" ? "Tiebreaker week" : "Week"} ${m.week}`}
    </Link>
  );
  const block = (m: (typeof upcoming)[number]) => (
    <StandinMatchBlock
      key={m.id}
      m={m}
      teams={data.teams}
      pool={data.standins}
      bookings={bookings}
      outRsvps={data.outRsvps}
      assignments={byMatch.get(m.id) ?? []}
      requests={requestsByMatch.get(m.id) ?? []}
      teamName={teamName}
      teamSize={season.teamSize}
      assignOpen={assignOpen}
      viewerId={viewerId}
      label={matchLabel(m)}
    />
  );

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Standin assignments"
        subtitle="Captains book their own standins on the Standins page. This card shows cover problems and lets you book for any team."
      />
      <CardBody className="space-y-3">
        {clashLines.length > 0 ? (
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            <div className="font-medium">⚠ Standin double-bookings</div>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              {clashLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {!assignOpen && upcoming.length > 0 ? (
          <p className="rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-sm text-muted">
            {season.status === "COMPLETE"
              ? "The season is over — existing bookings can still be removed."
              : "Standin assignment opens once the draft has run — existing bookings can still be removed."}
          </p>
        ) : null}
        {/* The "no standins registered" branch used to swallow the WHOLE card,
            which hid the uncovered-OUT alerts inside it — the diagnostic was
            behind the cure. An admin with players declaring OUT and nobody
            registered as cover saw a blank card saying nothing was wrong, which
            is exactly the night they most needed the list. The note now rides
            ABOVE the match blocks instead of replacing them. */}
        {assignOpen && data.standins.length === 0 && upcoming.length > 0 ? (
          <p className="rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-sm text-muted">
            No standins have registered yet — players can sign up as a standin
            on their profile. Anyone registered but undrafted can cover too.
          </p>
        ) : null}
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted">No upcoming matches to fill.</p>
        ) : (
          <>
            {problems.length > 0 ? (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">
                  Cover problems ({problems.length})
                </h3>
                {problems.map(block)}
              </div>
            ) : (
              <p className="text-sm text-muted">
                Nothing needs cover right now.
              </p>
            )}
            {rest.length > 0 ? (
              <details className="rounded-lg border border-line">
                <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-sm font-medium">
                  {assignOpen ? "Assign any match" : "Other bookings"}
                  <span className="ml-2 text-xs font-normal text-muted">
                    {rest.length} {problems.length > 0 ? "other " : ""}
                    {assignOpen ? "open " : ""}
                    match{rest.length === 1 ? "" : "es"}
                  </span>
                </summary>
                <div className="space-y-3 px-3 pb-3">
                  {weeks.map((wk) => {
                    const wkMatches = regularRest.filter((m) => m.week === wk);
                    return (
                      <details
                        key={`w${wk}`}
                        open={wk === weeks[0]}
                        className="rounded-lg border border-line"
                      >
                        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                          {wkMatches[0]?.phase === "TIEBREAKER"
                            ? "Tiebreaker week · "
                            : ""}
                          Week {wk}
                          <span className="ml-2 text-xs font-normal text-muted">
                            {wkMatches.length} match
                            {wkMatches.length === 1 ? "" : "es"}
                          </span>
                        </summary>
                        <div className="space-y-3 px-3 pb-3">
                          {wkMatches.map(block)}
                        </div>
                      </details>
                    );
                  })}
                  {playoffRest.length > 0 ? (
                    <details
                      open={weeks.length === 0}
                      className="rounded-lg border border-accent/40"
                    >
                      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                        Playoffs
                        <span className="ml-2 text-xs font-normal text-muted">
                          {playoffRest.length} match
                          {playoffRest.length === 1 ? "" : "es"}
                        </span>
                      </summary>
                      <div className="space-y-3 px-3 pb-3">
                        {playoffRest.map(block)}
                      </div>
                    </details>
                  ) : null}
                </div>
              </details>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}
