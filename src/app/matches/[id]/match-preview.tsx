import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { REGISTRATION_STATUS } from "@/lib/constants";
import { recentForm, headToHead } from "@/lib/team-matches";
import { CheckinBanner } from "@/components/checkin-banner";
import { loadCheckinSide } from "@/lib/checkin-side-service";
import { signInHref } from "@/lib/sign-in";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { matchNightRoster, teamAvailability } from "@/lib/availability";
import { checkinNudgeBlockedSince } from "@/lib/checkin-nudge-service";
import { getWebhookUrl } from "@/lib/discord";
import {
  canViewLeagueContact,
  canViewNamedMatchAvailability,
} from "@/lib/visibility";
import {
  matchCheckinOpen,
  postAuctionWorkOpen,
} from "@/lib/league-lifecycle";
import { pickemControlFor } from "@/lib/pickem";
import { textLink } from "@/components/ui";
import {
  loadDraftStatus,
  loadRosters,
  type MatchPageMatch,
  type MatchViewer,
} from "./load";
import { MatchupCard, type MatchupSide } from "./matchup-card";
import { ScoutingReport } from "./scouting-report";
import { StakesBanner } from "./stakes-banner";

// Pre-match scouting: rosters, recent form, prior meetings, and who's
// confirmed for match night — shown until the first game is recorded.
export async function MatchPreview({
  match,
  viewer,
  roundLabel,
}: {
  match: MatchPageMatch;
  viewer: MatchViewer;
  /** matchRoundLabel of this fixture, for the pick'em tray's legend. */
  roundLabel: string;
}) {
  const canSeeNamedAvailability = canViewNamedMatchAvailability(
    viewer,
    match.homeTeam.captainId,
    match.awayTeam.captainId,
  );
  const [rosterRows, seasonMatches, rsvps] = await Promise.all([
    loadRosters(match),
    prisma.match.findMany({
      where: { seasonId: match.seasonId },
      orderBy: [{ week: "asc" }, { createdAt: "asc" }],
    }),
    viewer
      ? prisma.matchAvailability.findMany({
          where: {
            matchId: match.id,
            scheduleRevision: match.scheduleRevision,
            ...(canSeeNamedAvailability ? {} : { userId: viewer.id }),
          },
          select: { userId: true, status: true },
        })
      : Promise.resolve([]),
  ]);
  // Most expensive signing first. The sort is stable, so equal prices (the
  // captain and $0 free agents) keep signing order.
  const members = [...rosterRows].sort((a, b) => b.price - a.price);
  const regs = await prisma.registration.findMany({
    where: {
      seasonId: match.seasonId,
      userId: { in: members.map((m) => m.userId) },
    },
    select: { userId: true, roles: true, mmr: true },
  });
  const regByUser = new Map(regs.map((r) => [r.userId, r]));
  const rsvpByUser = new Map(rsvps.map((r) => [r.userId, r.status]));

  // Mirror setAvailability's decisive capability gate: an RSVP is about one
  // published, upcoming match night. LIVE readiness is its own banner
  // (LiveSeriesCheckin), including after the first game's import.
  const [draftStatus, myPrediction, viewerRegistration] = await Promise.all([
    loadDraftStatus(match),
    // Signed-in only: the Matchup card's pick tray (pickemControlFor below).
    viewer
      ? prisma.prediction.findUnique({
          where: { matchId_userId: { matchId: match.id, userId: viewer.id } },
          select: { pickedTeamId: true },
        })
      : Promise.resolve(null),
    // The Matchup card's captain contact chips (canViewLeagueContact below).
    viewer
      ? prisma.registration.findUnique({
          where: {
            seasonId_userId: { seasonId: match.seasonId, userId: viewer.id },
          },
          select: { status: true },
        })
      : Promise.resolve(null),
  ]);
  // Each captain's Discord handle, for the people allowed league contact:
  // admins, active registrants (standins included, who need to reach the
  // captain they cover for) and the two captains of this match.
  const viewerIsMatchCaptain =
    !!viewer &&
    (viewer.id === match.homeTeam.captainId ||
      viewer.id === match.awayTeam.captainId);
  const captainContact = (captainId: string) =>
    canViewLeagueContact(
      viewer,
      captainId,
      match.season.isActive &&
        (viewerRegistration?.status === REGISTRATION_STATUS.ACTIVE ||
          viewerIsMatchCaptain),
    );
  const nightRoster = (teamId: string) =>
    matchNightRoster(
      members.filter((m) => m.teamId === teamId).map((m) => m.userId),
      match.standins
        .filter((s) => s.teamId === teamId)
        .map((s) => ({
          standinUserId: s.standin.id,
          replacingUserId: s.replaced?.id ?? null,
        })),
    );
  const activeNightRoster = new Set(
    [match.homeTeamId, match.awayTeamId].flatMap(nightRoster),
  );
  // Async server component: this captures request time once for the stale-
  // fixture guard; it is not client render state.
  // eslint-disable-next-line react-hooks/purity
  const previewNow = Date.now();
  const checkinOpen =
    match.status !== "LIVE" &&
    match.season.isActive &&
    matchCheckinOpen(
      match.season.status,
      draftStatus,
      match.status,
      match.scheduledAt,
      previewNow,
    );
  const isParticipant =
    !!viewer && checkinOpen && activeNightRoster.has(viewer.id);
  // The banner's side line (counts only: the Matchup card below already
  // names each answer for the captains who may see them).
  const checkinSideView =
    isParticipant && viewer
      ? await loadCheckinSide({ matchId: match.id, viewer, names: false })
      : null;
  const myRsvp = viewer ? (rsvpByUser.get(viewer.id) ?? null) : null;
  // A captain's optional "Remind the N who haven't answered" under their own
  // side: shown only while check-in is open, someone else on their side owes
  // an answer, and the league has a Discord channel. Once sent, it says when
  // the next one is allowed instead (sendCheckinNudge's throttle).
  const nudgeTeamId =
    viewer?.id === match.homeTeam.captainId
      ? match.homeTeamId
      : viewer?.id === match.awayTeam.captainId
        ? match.awayTeamId
        : null;
  const nudgeWaiting =
    nudgeTeamId && checkinOpen
      ? teamAvailability(
          nightRoster(nudgeTeamId),
          rsvps,
        ).unansweredUserIds.filter((id) => id !== viewer!.id).length
      : 0;
  const nudge =
    nudgeTeamId && nudgeWaiting > 0 && (await getWebhookUrl())
      ? {
          teamId: nudgeTeamId,
          waiting: nudgeWaiting,
          sentAt: await checkinNudgeBlockedSince(
            match.id,
            nudgeTeamId,
            match.scheduleRevision,
            previewNow,
          ),
        }
      : null;
  // Same rule as the dashboard's This-week cards. The season gate mirrors
  // /pickem's canPlay: savePrediction only ever writes to the ACTIVE season,
  // so an archived fixture must never render live buttons.
  const pick = pickemControlFor(
    match,
    {
      signedIn: !!viewer,
      canPlay:
        match.season.isActive &&
        postAuctionWorkOpen(match.season.status, draftStatus),
      pickedTeamId: myPrediction?.pickedTeamId,
    },
    new Date(previewNow),
  );

  const h2hRow = headToHead(match.homeTeamId, seasonMatches).find(
    (h) => h.opponentId === match.awayTeamId,
  );

  const side = (
    teamId: string,
    name: string,
    logoUrl: string | null,
    captainId: string,
  ): MatchupSide => {
    const roster = members.filter((m) => m.teamId === teamId);
    const captainRow = roster.find((m) => m.userId === captainId);
    const captain =
      captainRow?.user.discordName && captainContact(captainId)
        ? captainRow.user
        : null;
    const subs = match.standins.filter((s) => s.teamId === teamId);
    const replacedIds = new Set(
      subs.map((s) => s.replaced?.id).filter(Boolean),
    );
    const form = recentForm(
      teamId,
      seasonMatches.filter(
        (m) => m.homeTeamId === teamId || m.awayTeamId === teamId,
      ),
    );
    return { teamId, name, logoUrl, roster, subs, replacedIds, form, captain };
  };
  const sides = [
    side(
      match.homeTeamId,
      match.homeTeam.name,
      match.homeTeam.logoUrl,
      match.homeTeam.captainId,
    ),
    side(
      match.awayTeamId,
      match.awayTeam.name,
      match.awayTeam.logoUrl,
      match.awayTeam.captainId,
    ),
  ];

  return (
    <div className="space-y-5">
      {isParticipant ? (
        <CheckinBanner
          matchId={match.id}
          scheduleRevision={match.scheduleRevision}
          remainingGames={match.status === "LIVE"}
          heading="You're playing in this match"
          viewerIsCaptain={
            viewer?.id === match.homeTeam.captainId ||
            viewer?.id === match.awayTeam.captainId
          }
          when={
            match.scheduledAt
              ? formatLeagueMatchTime(match.scheduledAt, "full")
              : undefined
          }
          whenTs={match.scheduledAt?.getTime()}
          myRsvp={myRsvp}
          side={checkinSideView}
        />
      ) : !viewer && checkinOpen ? (
        // Signed out, nothing above tells a player they can check in here.
        // Sign-in returns to this page, where the banner then appears.
        <p className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm text-muted">
          Playing in this match?{" "}
          <Link href={signInHref(`/matches/${match.id}`)} className={textLink()}>
            Sign in to check in
          </Link>
        </p>
      ) : null}

      <StakesBanner match={match} seasonMatches={seasonMatches} />

      {/* Full width, one above the other: each card is split home | away
          inside, and their heights follow the data (check-ins, how many
          comfort picks), so side by side left a hole under one of them. */}
      <MatchupCard
        match={match}
        roundLabel={roundLabel}
        h2hRow={h2hRow}
        sides={sides}
        regByUser={regByUser}
        rsvpByUser={rsvpByUser}
        canSeeNamedAvailability={canSeeNamedAvailability}
        nudge={nudge}
        pick={pick}
      />

      <ScoutingReport
        sides={sides.map((s) => ({
          teamId: s.teamId,
          name: s.name,
          logoUrl: s.logoUrl,
          roster: s.roster.map((m) => ({
            userId: m.userId,
            name: m.user.name,
            roles: regByUser.get(m.userId)?.roles ?? "",
            pubStats: m.user.pubStats,
            pubStatsAt: m.user.pubStatsAt,
          })),
        }))}
      />
    </div>
  );
}
