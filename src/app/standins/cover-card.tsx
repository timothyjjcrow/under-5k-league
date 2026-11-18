import { prisma } from "@/lib/prisma";
import { MATCH_STATUS } from "@/lib/constants";
import {
  coverBaselineMmr,
  coverChoices,
  namedCoverBaseline,
  seatValue,
  STANDIN_MMR_ALLOWANCE,
  standinApprovalReason,
  standinMmrLabel,
  standinPickOutcome,
  standinPickerBlock,
  type StandinBooking,
} from "@/lib/standin";
import { sortStandinOffers } from "@/lib/standin-offer";
import { roleShort } from "@/lib/roles";
import { standinAssignmentOpen } from "@/lib/league-lifecycle";
import {
  captainApproveStandinRequest,
  captainAssignStandin,
  captainCancelStandinRequest,
  captainDeclineStandinRequest,
  captainRemoveStandin,
} from "@/app/actions/standins";
import { canViewLeagueContact } from "@/lib/visibility";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { ActionForm, SubmitButton } from "@/components/action-form";
import Link from "@/components/app-link";
import { DiscordTag } from "@/components/discord-tag";
import { LocalTime } from "@/components/local-time";
import { CopyStandinLink } from "@/components/standin-offer-link";
import {
  StandinPicker,
  type StandinPickerCoverOption,
  type StandinPickerStandinOption,
} from "@/components/standin-picker";
import {
  Card,
  CardBody,
  CardHeader,
  LinkArrow,
  PlayerLink,
  textLink,
} from "@/components/ui";
import {
  loadDeclinedStandinIds,
  loadDraftStatus,
  loadOutUserIds,
  loadRosters,
  type MatchPageMatch,
  type MatchViewer,
} from "@/app/matches/[id]/load";

/** The card's id on the Standins page: `/standins?match=` scrolls to it. */
export function coverCardId(matchId: string): string {
  return `cover-${matchId}`;
}

// A captain's standin work for one match, on the Standins page: the one
// place every standin control lives (Tim, 2026-11-17). Guards are in
// standin-service. In the order a captain needs it: what needs cover, who
// said they can play (one tap books each), the share link while nobody has,
// requests waiting on a captain, the bookings (remove for your own team),
// then the full assign form, scoped to your roster + the season's unrostered
// ACTIVE signups, folded away once someone has offered. A standin over the
// MMR allowance waits for the other captain: their requests show here, with
// Agree and Decline for the other captain and Withdraw for the asking one.
// The assign form says which of the two a pick does before it is sent
// (StandinPicker over standinPickOutcome), and a booked standin's row carries
// what the captain needs to reach them: profile, MMR, roles, Discord handle.
export async function StandinCoverCard({
  match,
  viewer,
  seriesStarted,
  roundLabel,
  highlighted = false,
}: {
  match: MatchPageMatch;
  viewer: MatchViewer;
  /** A game is imported: removeStandinGuarded refuses every removal now. */
  seriesStarted: boolean;
  /** "Week 3", "Semifinal": the card's heading, with the opponent. */
  roundLabel: string;
  /** The game a link opened (`/standins?match=`). */
  highlighted?: boolean;
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

  // This match's standin bookings, loaded with the match, and the requests
  // still waiting for a captain's OK (moot once the match is played).
  const assignments = match.standins;
  const requests =
    match.status === MATCH_STATUS.COMPLETED ? [] : match.standinRequests;
  const otherTeamId =
    myTeamId === match.homeTeamId ? match.awayTeamId : match.homeTeamId;
  const teamNameOf = (teamId: string) =>
    teamId === match.homeTeamId ? match.homeTeam.name : match.awayTeam.name;
  const opponentName = teamNameOf(otherTeamId);
  const [members, registrations, rostered, outIds, declinedIds, offerRows] =
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
      // Standins the other captain declined for my team here: asking again
      // is refused, so the picker greys them out.
      loadDeclinedStandinIds(match, myTeamId),
      // Standins who said they can play for my side, first come first.
      prisma.standinOffer.findMany({
        where: { matchId: match.id, teamId: myTeamId },
        select: { userId: true, createdAt: true },
      }),
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
  // A standin the other captain declined for my team here can't be asked
  // for again, as the server refuses it.
  const declinedRows: StandinBooking[] = [...declinedIds].map(
    (standinUserId) => ({
      standinUserId,
      matchId: match.id,
      replacedName: null,
      homeName: match.homeTeam.name,
      awayName: match.awayTeam.name,
      scheduledAt: match.scheduledAt,
      week: match.week,
      declinedBy: opponentName,
    }),
  );
  // A request in this match holds its standin, as the server does.
  const requestRows = requests.map((r): StandinBooking => ({
    standinUserId: r.standinUserId,
    matchId: match.id,
    replacedName: r.replaced?.name ?? null,
    homeName: match.homeTeam.name,
    awayName: match.awayTeam.name,
    scheduledAt: match.scheduledAt,
    week: match.week,
    pending: true,
  })).concat(declinedRows);
  const poolChoices = pool.map((r) => ({
    reg: r,
    blocked: standinPickerBlock(r.userId, pickerTarget, [
      ...bookingRows,
      ...requestRows,
    ]),
  }));
  // Players a BOOKING covers. A request is not cover: it holds the seat, but
  // never takes its player out of the MMR rule's baseline (coverBaseline).
  const bookedIds = new Set(
    assignments.flatMap((a) => (a.replaced ? [a.replaced.id] : [])),
  );
  // One seat, one standin — players already covered, or whose cover waits
  // for the other captain, leave the Covers list (the server refuses both).
  const coveredIds = new Set([
    ...bookedIds,
    ...requests.flatMap((r) => (r.replacingUserId ? [r.replacingUserId] : [])),
  ]);
  // OPEN SEATS on this captain's own roster. A team that lost a player
  // mid-season is short, and a standin filling that seat replaces nobody — the
  // case that previously had no UI anywhere, so a 4-of-5 side could not be
  // covered at all. Already-filled open seats are subtracted.
  const openSeatsFilled =
    assignments.filter((a) => a.teamId === myTeamId && a.replaced == null)
      .length +
    requests.filter((r) => r.teamId === myTeamId && r.replacingUserId == null)
      .length;
  const openSeats = Math.max(
    0,
    season.teamSize - roster.length - openSeatsFilled,
  );
  // Signup MMRs for the Covers list: the number the MMR rule measures a
  // standin against (an empty seat: the roster's lowest).
  const mmrOf = new Map(registrations.map((r) => [r.userId, r.mmr]));
  const seatBaseline = coverBaselineMmr({
    rosterMmrs: roster.map((m) => mmrOf.get(m.userId) ?? 0),
  });
  // A named player counts as a lower teammate who said they can't make it
  // and has no booking yet, as the server judges it (namedCoverBaseline): a
  // waiting request for that teammate doesn't change it.
  const teammates = roster.map((m) => ({
    userId: m.userId,
    name: m.user.name,
    mmr: mmrOf.get(m.userId) ?? 0,
  }));
  // A named seat's baseline and who set it, as the server judges it.
  const baselineOf = (userId: string) =>
    namedCoverBaseline({
      replaced: { userId, mmr: mmrOf.get(userId) ?? 0 },
      teammates,
      outUserIds: outIds,
      coveredUserIds: bookedIds,
    });
  const countsAs = (userId: string) => {
    const { lowerOut } = baselineOf(userId);
    return lowerOut ? ` · counts as ${standinMmrLabel(lowerOut.mmr)}` : "";
  };
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

  // The form's two lists. Each seat carries the baseline the MMR rule will
  // measure against, so the picker can say what a pick does before it is
  // sent: uncovered OUT players first, then an empty seat, then the rest.
  const namedCover = (
    m: (typeof roster)[number],
    out: boolean,
  ): StandinPickerCoverOption => {
    const { baselineMmr, lowerOut } = baselineOf(m.userId);
    return {
      value: m.userId,
      label: `${m.user.name} (${standinMmrLabel(mmrOf.get(m.userId) ?? 0)}${
        out ? " · can't make it" : ""
      }${countsAs(m.userId)})`,
      baselineMmr,
      emptySeat: false,
      lowerOutName: lowerOut?.name ?? null,
    };
  };
  const coverOptions: StandinPickerCoverOption[] = [
    ...cover.choices.filter((c) => c.out).map((c) => namedCover(c.member, true)),
    ...(openSeats > 0
      ? [
          {
            value: seatValue(myTeamId),
            label: `an empty roster seat (${openSeats} unfilled · counts as ${standinMmrLabel(seatBaseline)})`,
            baselineMmr: seatBaseline,
            emptySeat: true,
            lowerOutName: null,
          },
        ]
      : []),
    ...cover.choices
      .filter((c) => !c.out)
      .map((c) => namedCover(c.member, false)),
  ];
  // Option text carries what the 9pm decision needs: seat fit (roles) and
  // whether a ping can reach them at all. "no Discord" = neither a verified
  // link nor a typed handle. Someone the server would refuse (already in
  // this match, booked the same night, declined) stays listed but can't be
  // picked, and says why.
  const offeredIds = new Set(offerRows.map((o) => o.userId));
  const standinOptions: StandinPickerStandinOption[] = poolChoices.map(
    ({ reg: r, blocked }) => {
      const roles = roleShort(r.roles).join("/");
      const unreachable = !r.user.discordId && !r.user.discordName;
      return {
        userId: r.userId,
        name: r.user.name,
        mmr: r.mmr,
        offered: offeredIds.has(r.userId),
        blocked,
        detail: `${standinMmrLabel(r.mmr)}${roles ? ` · ${roles}` : ""}${
          unreachable ? " · no Discord" : ""
        }`,
      };
    },
  );
  // What a booked standin's row says about them: MMR and roles from their
  // signup. A captain of this match in the active season may see contact.
  const signupOf = new Map(registrations.map((r) => [r.userId, r]));
  const standinFacts = (userId: string) => {
    const reg = signupOf.get(userId);
    if (!reg) return null;
    const roles = roleShort(reg.roles).join("/");
    return `${standinMmrLabel(reg.mmr)}${roles ? ` · ${roles}` : ""}`;
  };

  // "Said they can play": this side's offers from standins the form could
  // still pick (in the pool, not blocked), first come first. One tap books
  // each for the seat that needs cover first (an uncovered OUT player, else
  // an empty seat), the same order the Covers list leads with; with no such
  // seat there is nothing to tap for, and they stay marked in the form.
  const needSeat =
    coverOptions.find(
      (c) => c.emptySeat || uncoveredOut.some((m) => m.userId === c.value),
    ) ?? null;
  const pickable = new Map(
    poolChoices.filter((c) => !c.blocked).map((c) => [c.reg.userId, c.reg]),
  );
  const offers =
    assignOpen && needSeat
      ? sortStandinOffers(offerRows).flatMap((o) => {
          const reg = pickable.get(o.userId);
          return reg ? [reg] : [];
        })
      : [];
  const needSeatName = needSeat
    ? needSeat.emptySeat
      ? "the open seat"
      : (uncoveredOut.find((m) => m.userId === needSeat.value)?.user.name ??
        "the open seat")
    : "";

  // A booked standin of mine who said they can't make it. Before the night
  // that answer gives the seat back by itself (releaseOwnStandinBooking),
  // so this is a series already under way, where the booking stays.
  const standinsOut = assignments.filter(
    (a) => a.teamId === myTeamId && outIds.has(a.standin.id),
  );
  const myBookings = assignments.filter((a) => a.teamId === myTeamId);
  

  // A phase where assignment is closed and nothing is booked or asked has
  // nothing to say — don't render an empty card with a disabled story.
  if (!assignOpen && assignments.length === 0 && requests.length === 0)
    return null;

  // The full form: open while a seat needs cover and nobody offered (it is
  // the way to cover it), folded away once someone has (the list above is
  // the fast path) or when no seat needs anyone (booking ahead for a player
  // who told the captain they're out).
  const pickerForm = (
    <ActionForm action={captainAssignStandin} hidden={{ matchId: match.id }}>
      {/* Keyed on the pre-selection: the picker keeps its first
          choice, so a new "can't make it" needs a remount. */}
      <StandinPicker
        key={cover.preselect ?? ""}
        covers={coverOptions}
        standins={standinOptions}
        preselect={cover.preselect}
        otherTeamName={opponentName}
      />
    </ActionForm>
  );
  const foldPicker = offers.length > 0 || !needSeat;

  return (
    <Card
      id={coverCardId(match.id)}
      tone={highlighted ? "feature" : "default"}
      className="scroll-mt-24"
    >
      <CardHeader
        title={`${roundLabel} · vs ${opponentName}`}
        subtitle={
          match.scheduledAt ? (
            <LocalTime
              ts={match.scheduledAt.getTime()}
              variant="full"
              initial={formatLeagueMatchTime(match.scheduledAt, "full")}
            />
          ) : (
            "No kickoff yet"
          )
        }
        action={
          <Link href={`/matches/${match.id}`} className={textLink("text-sm")}>
            Match page <LinkArrow />
          </Link>
        }
      />
      <CardBody className="space-y-3">
        {uncoveredOut.length > 0 ? (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            ✗ Out and uncovered:{" "}
            <strong>{uncoveredOut.map((m) => m.user.name).join(", ")}</strong>
            {assignOpen ? "" : "."}
          </p>
        ) : null}
        {openSeats > 0 && assignOpen ? (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            ✗{" "}
            {openSeats === 1
              ? "1 empty roster seat has nobody lined up."
              : `${openSeats} empty roster seats have nobody lined up.`}
          </p>
        ) : null}
        {standinsOut.length > 0 ? (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            ✗ Your standin{" "}
            <strong>{standinsOut.map((a) => a.standin.name).join(", ")}</strong>{" "}
            said they can&apos;t make it. The series has started, so the
            booking stays; the remaining games record whoever actually plays.
          </p>
        ) : null}
        {assignOpen && needSeat && offers.length === 0 ? (
          // Nobody has offered yet: sharing the game is how they do.
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface-2/40 px-3 py-2">
            <p className="min-w-[12rem] flex-1 text-sm">
              Nobody has said they can play yet. This game is listed below
              for every standin; share it in Discord, and anyone who opens the
              link is added to your list.
            </p>
            <CopyStandinLink
              matchId={match.id}
              teamId={myTeamId}
              variant="secondary"
            />
          </div>
        ) : null}
        {assignOpen &&
        !needSeat &&
        myBookings.length === 0 &&
        requests.length === 0 &&
        standinsOut.length === 0 ? (
          <p className="text-sm text-muted">
            <span aria-hidden>✓ </span>Nobody needs cover for this match. A
            player who says they can&apos;t make it shows up here.
          </p>
        ) : null}
        {offers.length > 0 && needSeat ? (
          <section aria-labelledby="standin-offers-heading" className="space-y-1.5">
            <h3
              id="standin-offers-heading"
              className="text-xs font-semibold uppercase tracking-wide text-muted"
            >
              Said they can play
            </h3>
            <ul className="space-y-1.5 text-sm">
              {offers.map((reg) => {
                const outcome = standinPickOutcome(reg.mmr, needSeat);
                const descId = `standin-offer-${reg.userId}`;
                return (
                  <li
                    key={reg.userId}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-success/40 bg-success/10 px-3 py-2"
                  >
                    <span
                      id={descId}
                      className="min-w-[12rem] flex-1 [overflow-wrap:anywhere]"
                    >
                      <span aria-hidden>✋ </span>
                      <PlayerLink userId={reg.userId} className="font-semibold">
                        {reg.user.name}
                      </PlayerLink>{" "}
                      <span className="text-muted">
                        · {standinFacts(reg.userId)} · for {needSeatName}
                        {outcome.kind === "ask"
                          ? ` · needs the ${opponentName} captain's OK, since ${outcome.reason}`
                          : ""}
                      </span>
                    </span>
                    {canViewLeagueContact(viewer, reg.userId, true) &&
                    reg.user.discordName ? (
                      <DiscordTag
                        name={reg.user.discordName}
                        verified={!!reg.user.discordId}
                      />
                    ) : null}
                    <ActionForm
                      action={captainAssignStandin}
                      hidden={{
                        matchId: match.id,
                        standinUserId: reg.userId,
                        replacingUserId: needSeat.value,
                      }}
                      className="ml-auto"
                    >
                      <SubmitButton
                        variant={outcome.kind === "ask" ? "secondary" : "accent"}
                        size="sm"
                        aria-describedby={descId}
                      >
                        {outcome.kind === "ask"
                          ? "Ask the other captain"
                          : `Book ${reg.user.name}`}
                      </SubmitButton>
                    </ActionForm>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {assignments.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {assignments.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-surface-2/40 px-3 py-1.5"
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <PlayerLink userId={a.standin.id} className="font-semibold">
                    {a.standin.name}
                  </PlayerLink>{" "}
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
                  <span className="text-muted">
                    · {teamNameOf(a.teamId)}
                    {standinFacts(a.standin.id)
                      ? ` · ${standinFacts(a.standin.id)}`
                      : ""}
                  </span>
                </span>
                {/* How to reach the standin you booked: the toast says to
                    contact them, so the handle is on their row. */}
                {a.teamId === myTeamId &&
                canViewLeagueContact(viewer, a.standin.id, true) ? (
                  a.standin.discordName ? (
                    <DiscordTag
                      name={a.standin.discordName}
                      verified={!!a.standin.discordId}
                    />
                  ) : (
                    <span className="text-xs text-muted">
                      (no Discord on file)
                    </span>
                  )
                ) : null}
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
        ) : null}
        {requests.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {requests.map((r) => {
              const mine = r.teamId === myTeamId;
              const descId = `standin-request-${r.id}`;
              // A lower teammate who said they're out may have set the
              // baseline: the reason names them, and the covered player's
              // line then carries no number (the request didn't store theirs).
              const reason = standinApprovalReason({
                standinMmr: r.standinMmr,
                baselineMmr: r.baselineMmr,
                emptySeat: r.replacingUserId === null,
                lowerOutName: r.baselinePlayer?.name,
              });
              const who = (
                <>
                  <strong>{r.standin.name}</strong> (
                  {standinMmrLabel(r.standinMmr)}){" "}
                  {r.replaced ? (
                    r.baselinePlayer ? (
                      <>
                        in for <strong>{r.replaced.name}</strong>
                      </>
                    ) : (
                      <>
                        in for <strong>{r.replaced.name}</strong> (
                        {standinMmrLabel(r.baselineMmr)})
                      </>
                    )
                  ) : (
                    "for an open seat"
                  )}
                </>
              );
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2"
                >
                  {mine ? (
                    <span id={descId} className="min-w-[12rem] flex-1 [overflow-wrap:anywhere]">
                      <span aria-hidden>⏳ </span>
                      {who}{" "}
                      <span className="text-muted">
                        · waiting for the {opponentName} captain to
                        agree, since {reason}.
                      </span>
                    </span>
                  ) : (
                    <span id={descId} className="min-w-[12rem] flex-1 [overflow-wrap:anywhere]">
                      <strong>{r.requestedBy.name}</strong> wants {who} on{" "}
                      {teamNameOf(r.teamId)}. Your OK is needed, since {reason}.
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 gap-2">
                    {mine ? (
                      <ActionForm
                        action={captainCancelStandinRequest}
                        hidden={{ requestId: r.id }}
                      >
                        <SubmitButton
                          variant="ghost"
                          size="sm"
                          className="text-danger-soft"
                          aria-describedby={descId}
                        >
                          Withdraw
                        </SubmitButton>
                      </ActionForm>
                    ) : (
                      <>
                        {/* Agreeing books the standin, so it shows only
                            where a booking would be accepted; Decline is
                            cleanup and always shows. */}
                        {assignOpen ? (
                          <ActionForm
                            action={captainApproveStandinRequest}
                            hidden={{ requestId: r.id }}
                          >
                            <SubmitButton
                              variant="secondary"
                              size="sm"
                              aria-describedby={descId}
                            >
                              Agree
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                        <ActionForm
                          action={captainDeclineStandinRequest}
                          hidden={{ requestId: r.id }}
                        >
                          <SubmitButton
                            variant="ghost"
                            size="sm"
                            className="text-danger-soft"
                            aria-describedby={descId}
                            confirm={`Decline ${r.standin.name}? ${r.requestedBy.name} is told on Discord to find someone else.`}
                          >
                            Decline
                          </SubmitButton>
                        </ActionForm>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {!assignOpen ? (
          <p className="text-sm text-muted">
            {season.status === "COMPLETE"
              ? "The season is over — standins no longer apply."
              : "Standins can be assigned once the draft has run and rosters are settled."}
          </p>
        ) : pool.length === 0 ? (
          <p className="text-sm text-muted">
            Nobody is in the standin pool right now. Late joiners can still
            sign up as standins, and the game&apos;s link puts them on your
            list.
          </p>
        ) : poolChoices.every((c) => c.blocked) ? (
          <p className="text-sm text-muted">
            Everyone in the standin pool is already booked for this match or
            another one that night, or was declined for this one. Late joiners
            can still sign up as standins, and the game&apos;s link puts them
            on your list.
          </p>
        ) : foldPicker ? (
          <details className="rounded-lg border border-line-soft px-3">
            <summary className="cursor-pointer py-2.5 text-sm font-medium text-fg">
              {offers.length > 0
                ? "Pick someone else from the pool"
                : "Book a standin"}
            </summary>
            <div className="pb-3">{pickerForm}</div>
          </details>
        ) : (
          pickerForm
        )}
        {assignOpen && poolChoices.some((c) => !c.blocked) ? (
          <p className="text-xs text-muted">
            Up to {STANDIN_MMR_ALLOWANCE} MMR above the seat books straight
            away; higher, or an unknown MMR, needs the {opponentName}{" "}
            captain&apos;s OK.{" "}
            <Link href="/rules#rosters" className={textLink("whitespace-nowrap")}>
              Standin rules
            </Link>
            {" · "}
            <Link
              href="/players?status=standin"
              className={textLink("whitespace-nowrap")}
            >
              Browse the standin pool
            </Link>
          </p>
        ) : null}
        {assignOpen && needSeat && offers.length > 0 ? (
          // Someone offered; more can still be asked for.
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line-soft pt-3">
            <CopyStandinLink matchId={match.id} teamId={myTeamId} />
            <p className="min-w-[12rem] flex-1 text-xs text-muted">
              Anyone who opens the game&apos;s link is added to your list.
            </p>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
