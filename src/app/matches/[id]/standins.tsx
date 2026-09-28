import { prisma } from "@/lib/prisma";
import { MATCH_STATUS } from "@/lib/constants";
import { coverChoices, seatValue, standinPickerBlock } from "@/lib/standin";
import { roleShort } from "@/lib/roles";
import { standinAssignmentOpen } from "@/lib/league-lifecycle";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import {
  captainAssignStandin,
  captainRemoveStandin,
} from "@/app/actions/standins";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardBody, CardHeader } from "@/components/ui";
import {
  loadDraftStatus,
  loadOutUserIds,
  loadRosters,
  type MatchPageMatch,
  type MatchViewer,
} from "./load";

// Captain-facing standin management (guards in standin-service): current
// cover for both sides, remove for your own team, and an assign form scoped
// to your roster + the season's unrostered ACTIVE signups.
export async function StandinSection({
  match,
  viewer,
  seriesStarted,
}: {
  match: MatchPageMatch;
  viewer: MatchViewer;
  /** A game is imported: removeStandinGuarded refuses every removal now. */
  seriesStarted: boolean;
}) {
  if (!viewer) return null;
  const myTeamId =
    match.homeTeam.captainId === viewer.id
      ? match.homeTeamId
      : match.awayTeam.captainId === viewer.id
        ? match.awayTeamId
        : null;
  // An admin passing by uses the Admin tools card near the top (any team's
  // cover); this card is the captain's tool. An admin who IS a captain still
  // gets their own team's view here.
  if (!myTeamId) return null;

  // The service refuses archived-season matches (its guards key on the
  // active season) — don't render a form that can only error.
  const season = match.season;
  if (!season.isActive) return null;
  // Mirror the service's PHASE GATE (render/guard pairing, the roster-moves
  // rule): assignment is open in REGULAR_SEASON/PLAYOFFS, and in DRAFT only
  // once the auction is COMPLETE (pool-dry short rosters arranging week-1
  // cover). Existing assignments still render — removal is legal cleanup in
  // every phase — but a form that can only error never should.
  const draftStatus =
    season.status === "DRAFT" ? await loadDraftStatus(match) : null;
  const assignOpen = standinAssignmentOpen(
    season.status,
    draftStatus,
    match.status,
  );

  // This match's standin bookings, loaded with the match.
  const assignments = match.standins;
  const [members, registrations, rostered, outIds] =
    await Promise.all([
      loadRosters(match),
      prisma.registration.findMany({
        where: { seasonId: match.seasonId, status: "ACTIVE" },
        // roles + Discord fields feed the picker's option text: a captain
        // choosing cover at 9pm needs "who fits the seat AND will answer a
        // ping" without opening five profiles. Contact-adjacent, but this
        // card only renders for the two captains, so the signed-in gate
        // contact info requires is already satisfied.
        include: {
          user: {
            select: {
              id: true,
              name: true,
              discordId: true,
              discordName: true,
            },
          },
        },
        orderBy: { mmr: "desc" },
      }),
      prisma.teamMember.findMany({
        where: { seasonId: match.seasonId },
        select: { userId: true },
      }),
      // OUT RSVPs on this match — the captain-facing uncovered-OUT alert.
      // The admin panel has always had this list; the captain, who owns the
      // fix (the assign form right below), had to notice a small ✗ in the
      // preview grid instead.
      loadOutUserIds(match),
    ]);
  const roster = members.filter((m) => m.teamId === myTeamId);
  const rosteredIds = new Set(rostered.map((m) => m.userId));
  const pool = registrations.filter((r) => !rosteredIds.has(r.userId));
  // The pool's bookings on unplayed fixtures (this one included): the server
  // refuses a standin already booked in this match or on another fixture the
  // same night, so those are listed last, disabled, with the reason.
  const bookings =
    assignOpen && pool.length > 0
      ? await prisma.standinAssignment.findMany({
          where: {
            standinUserId: { in: pool.map((r) => r.userId) },
            match: {
              seasonId: match.seasonId,
              status: { not: MATCH_STATUS.COMPLETED },
            },
          },
          select: {
            standinUserId: true,
            matchId: true,
            replaced: { select: { name: true } },
            match: {
              select: {
                scheduledAt: true,
                week: true,
                homeTeam: { select: { name: true } },
                awayTeam: { select: { name: true } },
              },
            },
          },
        })
      : [];
  const pickerTarget = {
    matchId: match.id,
    scheduledAt: match.scheduledAt,
    week: match.week,
  };
  const bookingRows = bookings.map((b) => ({
    standinUserId: b.standinUserId,
    matchId: b.matchId,
    replacedName: b.replaced?.name ?? null,
    homeName: b.match.homeTeam.name,
    awayName: b.match.awayTeam.name,
    scheduledAt: b.match.scheduledAt,
    week: b.match.week,
  }));
  const poolChoices = pool.map((r) => ({
    reg: r,
    blocked: standinPickerBlock(r.userId, pickerTarget, bookingRows),
  }));
  const pickerOptions = [
    ...poolChoices.filter((c) => !c.blocked),
    ...poolChoices.filter((c) => c.blocked),
  ];
  // One seat, one standin — players already covered leave the Covers list.
  const coveredIds = new Set(
    assignments.flatMap((a) => (a.replaced ? [a.replaced.id] : [])),
  );
  // OPEN SEATS on this captain's own roster. A team that lost a player
  // mid-season is short, and a standin filling that seat replaces nobody — the
  // case that previously had no UI anywhere, so a 4-of-5 side could not be
  // covered at all. Already-filled open seats are subtracted.
  const openSeatsFilled = assignments.filter(
    (a) => a.teamId === myTeamId && a.replaced == null,
  ).length;
  const openSeats = Math.max(
    0,
    season.teamSize - roster.length - openSeatsFilled,
  );
  const teamNameOf = (teamId: string) =>
    teamId === match.homeTeamId ? match.homeTeam.name : match.awayTeam.name;
  // OUT-and-uncovered on MY roster: the admin card has always alerted on
  // this; the captain — who owns the assign form below — saw only the small
  // ✗ in the preview grid. They also lead the Covers list, pre-selected when
  // there is exactly one, so covering them stays one pick and one tap.
  const cover = coverChoices(
    roster,
    outIds,
    coveredIds,
  );
  const uncoveredOut = cover.choices
    .filter((c) => c.out)
    .map((c) => c.member);

  // A phase where assignment is closed and nothing is booked has nothing to
  // say — don't render an empty card with a disabled story.
  if (!assignOpen && assignments.length === 0) return null;

  return (
    <Card id={MATCH_ANCHOR.standins} className="scroll-mt-24">
      <CardHeader
        title="Standins"
        subtitle="Someone can't make it? Line up cover from the standin pool yourself — the assignment announces to Discord."
      />
      <CardBody className="space-y-3">
        {uncoveredOut.length > 0 ? (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            ✗ Out and uncovered:{" "}
            <strong>{uncoveredOut.map((m) => m.user.name).join(", ")}</strong>
            {assignOpen ? " — line up cover below." : "."}
          </p>
        ) : null}
        {assignments.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {assignments.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-surface-2/40 px-3 py-1.5"
              >
                <span className="min-w-0">
                  <strong>{a.standin.name}</strong>{" "}
                  {/* A null `replaced` is an EMPTY-SEAT cover on a short
                      roster, not missing data — it rendered as "in for ?". */}
                  {a.replaced ? (
                    <>
                      <span className="text-muted">in for</span>{" "}
                      {a.replaced.name}{" "}
                    </>
                  ) : (
                    <span className="text-muted">filling an open seat </span>
                  )}
                  <span className="text-muted">· {teamNameOf(a.teamId)}</span>
                </span>
                {a.teamId !== myTeamId ? null : seriesStarted ? (
                  // Removing cover mid-series would drop the standin from the
                  // remaining games, so the server refuses it. Say so rather
                  // than offer a button that can only fail.
                  <span className="ml-auto text-xs text-muted">
                    Locked: series already started
                  </span>
                ) : (
                  <ActionForm
                    action={captainRemoveStandin}
                    hidden={{ assignmentId: a.id }}
                    className="ml-auto"
                  >
                    <SubmitButton
                      variant="ghost"
                      size="sm"
                      className="text-danger-soft"
                      confirm={`Remove ${a.standin.name} as standin? Discord is told to stand down.`}
                    >
                      Remove
                    </SubmitButton>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No standins assigned yet.</p>
        )}
        {!assignOpen ? (
          <p className="text-sm text-muted">
            {season.status === "COMPLETE"
              ? "The season is over — standins no longer apply."
              : "Standins can be assigned once the draft has run and rosters are settled."}
          </p>
        ) : pool.length === 0 ? (
          <p className="text-sm text-muted">
            Nobody is in the standin pool right now — ask around the Discord;
            late joiners can still sign up as standins.
          </p>
        ) : poolChoices.every((c) => c.blocked) ? (
          <p className="text-sm text-muted">
            Everyone in the standin pool is already booked for this match or
            another one that night — ask around the Discord; late joiners can
            still sign up as standins.
          </p>
        ) : (
          <ActionForm
            action={captainAssignStandin}
            hidden={{ matchId: match.id }}
            className="flex flex-wrap items-end gap-2"
          >
            <select
              name="standinUserId"
              required
              aria-label="Standin to bring in"
              className="h-10 min-w-0 max-w-full rounded-lg border border-line bg-surface-2/50 px-2 text-sm"
              defaultValue=""
            >
              <option value="" disabled>
                Standin…
              </option>
              {/* Option text carries what the 9pm decision needs: seat fit
                  (roles) and whether a ping can reach them at all. "no
                  Discord" = neither a verified link nor a typed handle. */}
              {/* Someone the server would refuse (already in this match, or
                  booked the same night) stays listed but can't be picked,
                  and says why. */}
              {pickerOptions.map(({ reg: r, blocked }) => {
                const roles = roleShort(r.roles).join("/");
                const unreachable = !r.user.discordId && !r.user.discordName;
                return (
                  <option key={r.userId} value={r.userId} disabled={!!blocked}>
                    {blocked
                      ? `${r.user.name} (${blocked})`
                      : `${r.user.name} (${r.mmr} MMR${roles ? ` · ${roles}` : ""}${unreachable ? " · no Discord" : ""})`}
                  </option>
                );
              })}
            </select>
            {/* Keyed on the pre-selection: an uncontrolled select keeps its
                first defaultValue, so a new "can't make it" needs a remount. */}
            <select
              key={cover.preselect ?? ""}
              name="replacingUserId"
              required
              aria-label="Player they cover"
              className="h-10 min-w-0 max-w-full rounded-lg border border-line bg-surface-2/50 px-2 text-sm"
              defaultValue={cover.preselect ?? ""}
            >
              <option value="" disabled>
                Covers…
              </option>
              {cover.choices
                .filter((c) => c.out)
                .map(({ member: m }) => (
                  <option key={m.userId} value={m.userId}>
                    {m.user.name} (can&apos;t make it)
                  </option>
                ))}
              {openSeats > 0 ? (
                <option value={seatValue(myTeamId)}>
                  an empty roster seat ({openSeats} unfilled)
                </option>
              ) : null}
              {cover.choices
                .filter((c) => !c.out)
                .map(({ member: m }) => (
                  <option key={m.userId} value={m.userId}>
                    {m.user.name}
                  </option>
                ))}
            </select>
            <SubmitButton variant="secondary" size="sm">
              Assign standin
            </SubmitButton>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
