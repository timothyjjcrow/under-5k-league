import { Suspense } from "react";
import type { User } from "@prisma/client";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import {
  saveRegistration,
  confirmDraftReadiness,
  leaveLeague,
  updateDotaAccount,
  refreshMyAccounts,
  updateDiscordName,
  unlinkDiscord,
  setInhousePingOptIn,
} from "@/app/actions/registration";
import {
  fetchGuildMember,
  getGuildConfig,
  getRoleConfig,
  primeMembershipMemo,
  type GuildConfig,
  type GuildMemberInfo,
} from "@/lib/discord-roles";
import { AccountDiscordCard } from "@/components/account-discord-card";
import {
  AccountNextStepBanner,
  SignupNextSteps,
} from "@/components/account-next-steps";
import {
  accountNextSteps,
  auctionRunning,
  favoriteHeroSuggestions,
  fullPlayerChoiceOpen,
  mmrLeadLine,
  mmrRulesLine,
  rejoinPausedByDraft,
  returningJoinPlan,
  signupSummary,
  withdrawConfirmText,
  type AccountStepInput,
} from "@/lib/account-page";
import { ABOUT_MAX_LENGTH, aboutText } from "@/lib/about-you";
import { discordMutationsAllowed } from "@/lib/discord-mutation-policy";
import { steamIdToAccountId } from "@/lib/dota";
import {
  effectiveDotaAccountId,
  storedDotaAccountId,
} from "@/lib/dota-account";
import { pendingCoverWhere } from "@/lib/standin";
import { DRAFT_PASSED_LABEL } from "@/lib/season-copy";
import {
  AUTO_SYNC,
  HARD_MMR_CEILING,
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
} from "@/lib/constants";
import { registrationSeasonClosedError } from "@/lib/registration";
import { DRAFT_READINESS, draftReadiness } from "@/lib/draft-readiness";
import { draftSetupOpen } from "@/lib/draft-setup";
import { rankMedalName, rankTierExactMinMmr } from "@/lib/rank";
import { DOTA_ROLES, parseRoles } from "@/lib/roles";
import { matchRoundLabel } from "@/lib/schedule";
import { seasonMatchNightLabel } from "@/lib/match-night";
import { loadPlayoffRoundsBySeason } from "@/lib/playoff-rounds";
import { formatMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import { Countdown } from "@/components/countdown";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { HeroPicker } from "@/components/hero-picker";
import { MmrField } from "@/components/mmr-field";
import { SavedSignupForm } from "@/components/saved-signup-form";
import { ReturningJoinCard } from "@/components/returning-join-card";
import { AwayDatesCard } from "@/components/away-dates-card";
import { listAwayFixtures } from "@/lib/availability-service";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  PageTitle,
  RankMedal,
  ScheduleCallout,
  TeamCrest,
  textLink,
} from "@/components/ui";

export const metadata = { title: "My account" };

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ discord?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/me");
  // Season/profile reads do not depend on one another. Keeping them parallel
  // avoids making every profile visit pay three sequential database waits.
  const [{ discord: discordParam }, season, dbUser] = await Promise.all([
    searchParams,
    getActiveSeason(),
    prisma.user.findUnique({ where: { id: user.id } }),
  ]);
  const [reg, member, draft] = await Promise.all([
    season
      ? prisma.registration.findUnique({
          where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
        })
      : null,
    season
      ? prisma.teamMember.findUnique({
          where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
          include: { team: true },
        })
      : null,
    season
      ? prisma.draft.findUnique({
          where: { seasonId: season.id },
          select: { status: true },
        })
      : null,
  ]);

  // Async server component: Date.now is request-time state, not render replay.
  // eslint-disable-next-line react-hooks/purity
  const freshFrom = new Date(Date.now() - AUTO_SYNC.WINDOW_HOURS * 3600_000);
  // Returning player: no signup for this season yet, but one from a past
  // season — carry those answers into the fresh form so they don't retype.
  const [previous, standinAssignments, nextTeamMatch] = await Promise.all([
    season && !reg
      ? prisma.registration.findFirst({
          where: { userId: user.id, NOT: { seasonId: season.id } },
          orderBy: { createdAt: "desc" },
          include: { season: { select: { name: true } } },
        })
      : null,
    season && reg?.status === "ACTIVE"
      ? prisma.standinAssignment.findMany({
          where: pendingCoverWhere(user.id, season.id),
          include: { match: { include: { homeTeam: true, awayTeam: true } } },
          orderBy: { match: { week: "asc" } },
        })
      : null,
    // A rostered player's next fixture, shown under "Your team" instead of
    // the signup-era match-night callout. The dashboard's freshness rule: a
    // days-old fixture nobody reported isn't "next".
    season && member
      ? prisma.match.findFirst({
          where: {
            seasonId: season.id,
            status: { not: MATCH_STATUS.COMPLETED },
            AND: [
              {
                OR: [
                  { homeTeamId: member.teamId },
                  { awayTeamId: member.teamId },
                ],
              },
              {
                OR: [
                  { scheduledAt: null },
                  { scheduledAt: { gte: freshFrom } },
                ],
              },
            ],
          },
          orderBy: [
            { scheduledAt: { sort: "asc", nulls: "last" } },
            { week: "asc" },
            { createdAt: "asc" },
          ],
          include: {
            homeTeam: { select: { name: true } },
            awayTeam: { select: { name: true } },
          },
        })
      : null,
  ]);
  const form = reg ?? previous;
  // A playoff fixture (booked cover, or the team's next match) is named by
  // its round ("Semifinal"), the way the match page, /schedule and Discord
  // name it. Only read when one is shown.
  const playoffRounds = await loadPlayoffRoundsBySeason(
    [
      ...(standinAssignments ?? []).map((a) => a.match),
      ...(nextTeamMatch ? [nextTeamMatch] : []),
    ]
      .filter((m) => m.phase === MATCH_PHASE.PLAYOFF)
      .map((m) => m.seasonId),
  );

  // The medal's plausible MMR window — signup claims outside it are snapped
  // to its floor by saveRegistration, so tell the player up front. A medal
  // whose EXACT band floor clears the hard ceiling (Divine 3+/Immortal) is
  // ineligible outright — registrationGate will reject it whatever they type.
  const medalFloor = rankTierExactMinMmr(dbUser?.rankTier ?? null);
  const medalBlocked = medalFloor != null && medalFloor > HARD_MMR_CEILING;
  const mmrLead = mmrLeadLine(dbUser?.rankTier ?? null);

  // Your-season context: the roster seat (from DRAFT on) or, for standins,
  // the matches they've been assigned to cover.
  // Gated on "ACTIVE and not rostered" — the SAME predicate the assign pools
  // use — never on type: both assign forms deliberately offer undrafted
  // PLAYER-type free agents as cover ("anyone registered but undrafted"), and
  // the type gate hid this card from exactly those people. The member check
  // rides below (isRostered), so a rostered player never sees a stray card.
  const isRostered = !!member;
  const isCaptain = !!member?.isCaptain;

  const isRegistered = reg?.status === "ACTIVE";
  const signupsOpen = season?.status === "SIGNUPS";
  const draftConfirmationOpen = season
    ? draftSetupOpen(season.status, draft?.status)
    : false;
  const registrationRemoved = reg?.status === REGISTRATION_STATUS.REMOVED;
  const seasonRegistrationClosed = !!registrationSeasonClosedError(
    season?.status ?? "",
  );
  // Post-signups, PLAYER stays available only to those already registered as
  // one, withdrawn included (matches registrationGate — standins can't upgrade
  // mid-season), and not to a withdrawn player while the auction runs. When
  // it isn't, the form has no choice to show: it registers a standin.
  const signupChoice = {
    seasonStatus: season?.status ?? "",
    draftStatus: draft?.status,
    existing: reg ? { type: reg.type, status: reg.status } : null,
  };
  const playerLocked = !fullPlayerChoiceOpen(signupChoice);
  // A withdrawn full player can't return at all while the auction runs.
  const rejoinPaused = rejoinPausedByDraft(signupChoice);
  const myRoles = parseRoles(form?.roles);
  const myDraftReadiness = reg
    ? draftReadiness(reg, season?.draftRevision ?? 0)
    : DRAFT_READINESS.AWAITING;

  // The draft time printed on the signup card, posted back with any join so
  // saveRegistration can count the join as confirming it (only if the
  // season still has exactly this schedule when it saves).
  const seenDraftFields =
    season?.draftAt && draftConfirmationOpen
      ? {
          seenDraftSeasonId: season.id,
          seenDraftRevision: String(season.draftRevision),
          seenDraftAtTs: String(season.draftAt.getTime()),
        }
      : undefined;
  // A returning player (a signup from an earlier season, none in this one)
  // gets a one-tap join of last season's answers, run through the same
  // saveRegistration as the form. Null when that can't be offered honestly
  // (the medal or last season's MMR is over the ceiling): the form says why.
  const returningPlan =
    season && !reg && previous && !medalBlocked
      ? returningJoinPlan({
          seasonName: season.name,
          previous,
          rankTier: dbUser?.rankTier ?? null,
          playerChoiceOpen: !playerLocked,
        })
      : null;
  // The form's Participation default. A returning standin is NOT pre-set to
  // Standin from last season: neither tile is ticked and the form asks.
  const typeDefault: string | null = reg
    ? reg.type
    : previous?.type === REGISTRATION_TYPE.STANDIN
      ? null
      : REGISTRATION_TYPE.PLAYER;
  // Someone who can press Join as a full player right now: that submit also
  // confirms the draft time printed above the form (saveRegistration).
  const joinConfirmsDraft =
    !(isRegistered && reg?.type === REGISTRATION_TYPE.PLAYER) &&
    !playerLocked &&
    !registrationRemoved &&
    !seasonRegistrationClosed &&
    !rejoinPaused;
  const needsDraftConfirmation = !!(
    season?.draftAt &&
    draftConfirmationOpen &&
    isRegistered &&
    reg?.type === REGISTRATION_TYPE.PLAYER &&
    myDraftReadiness !== DRAFT_READINESS.READY
  );
  // What is still left to do, derived fresh on every render (never a stored
  // flag). Signed up in a season that still takes changes: listed under the
  // signup form, where the player just pressed the button. Everyone else can
  // only have the match-data step, shown as one line at the top.
  const signupLive = isRegistered && !seasonRegistrationClosed;
  const stepFacts = {
    signedUp: signupLive,
    draftConfirmation: needsDraftConfirmation
      ? myDraftReadiness === DRAFT_READINESS.STALE
        ? ("changed" as const)
        : ("needed" as const)
      : ("none" as const),
    isCaptain,
    discordLinked: !!dbUser?.discordId,
    discordHandle: !!dbUser?.discordName,
    discordLinkable: !!(
      process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET
    ),
    matchDataPrivate: dbUser?.fhUnavailable === true,
  };
  // ONE live member lookup, shared by the next-steps list and the Discord
  // card, so a cold visit costs Discord a single request. Never awaited here:
  // both readers sit behind their own <Suspense>.
  const guildCfg = getGuildConfig();
  const memberInfo: Promise<GuildMemberInfo> =
    dbUser?.discordId && guildCfg
      ? fetchGuildMember(dbUser.discordId, guildCfg)
      : Promise.resolve(null);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageTitle title="My account" />
      {signupLive ? null : (
        <AccountNextStepBanner
          step={accountNextSteps({ ...stepFacts, membership: null })[0]}
        />
      )}

      <section id="profile-signup" className="scroll-mt-24">
      {!season ? (
        <Card>
          <CardBody className="text-center text-muted">
            There is no active season to sign up for right now.
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            headingLevel={2}
            title={`Signup — ${season.name}`}
            subtitle={
              registrationRemoved
                ? "An admin removed this signup. Only a league admin can reinstate it."
                : seasonRegistrationClosed
                  ? isRegistered
                    ? "The season is complete. Your signup is now read-only."
                    : "The season is complete, so registrations are closed."
                  : isRegistered
                    ? `You're currently ${reg?.type === "STANDIN" ? "a standin" : "signed up to play"}.`
                    : reg?.status === REGISTRATION_STATUS.WITHDRAWN
                      ? rejoinPaused
                        ? "You withdrew from this season."
                        : "You withdrew from this season. You can rejoin below."
                      : signupsOpen
                      ? "Fill this out to join the season."
                      : "Player signups are closed, but you can still register as a standin."
            }
            action={
              registrationRemoved ? (
                <Badge tone="danger">Removed</Badge>
              ) : seasonRegistrationClosed && isRegistered ? (
                <Badge>Closed</Badge>
              ) : isRegistered ? (
                <Badge tone={reg?.type === "STANDIN" ? "info" : "success"}>
                  {reg?.type === "STANDIN" ? "Standin" : "Playing"}
                </Badge>
              ) : null
            }
          />
          <CardBody className="space-y-5">
            {season.draftAt && draftConfirmationOpen ? (
              <p className="text-sm text-muted">
                🗓️ Draft night:{" "}
                <strong className="text-fg">
                  <LocalTime
                    ts={season.draftAt.getTime()}
                    variant="full"
                    initial={formatMatchTime(season.draftAt, "full")}
                  />
                </strong>
                <Countdown
                  targetMs={season.draftAt.getTime()}
                  eventLabel="Draft"
                  passedLabel={DRAFT_PASSED_LABEL}
                />
                {joinConfirmsDraft ? (
                  <span className="mt-0.5 block text-xs">
                    Joining as a full player confirms you&apos;ve seen this
                    time and plan to be there.
                  </span>
                ) : null}
              </p>
            ) : null}
            {season.draftAt &&
            draftConfirmationOpen &&
            isRegistered &&
            reg?.type === REGISTRATION_TYPE.PLAYER ? (
              <div
                id="draft-commitment"
                className={
                  myDraftReadiness === DRAFT_READINESS.READY
                    ? "scroll-mt-24 rounded-lg border border-success/35 bg-success/10 px-4 py-3"
                    : "scroll-mt-24 rounded-lg border border-accent/35 bg-accent/10 px-4 py-3"
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {/* The CheckinBanner rule: a floor on the copy column so
                      the confirm button WRAPS below it on phones. With only
                      `min-w-0 flex-1` (basis 0) the row never wrapped and
                      the copy shrank to one word per line (58px at 390px).
                      min() keeps the floor from overflowing a 320px screen. */}
                  <div className="min-w-[min(14rem,100%)] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-fg">Draft commitment</h3>
                      {myDraftReadiness === DRAFT_READINESS.READY ? (
                        <Badge tone="success">Ready for draft ✓</Badge>
                      ) : myDraftReadiness === DRAFT_READINESS.STALE ? (
                        <Badge tone="accent">Reconfirmation required</Badge>
                      ) : (
                        <Badge tone="accent">Confirmation needed</Badge>
                      )}
                    </div>
                    {myDraftReadiness === DRAFT_READINESS.READY ? (
                      <p className="mt-1 text-sm text-muted">
                        You&apos;ve seen the draft time and confirmed
                        you&apos;re still committed to playing this season.
                        {reg.draftConfirmedAt ? (
                          <>
                            {" "}
                            Confirmed{" "}
                            <LocalTime
                              ts={reg.draftConfirmedAt.getTime()}
                              variant="short"
                              initial={formatMatchTime(
                                reg.draftConfirmedAt,
                                "short",
                              )}
                            />
                            .
                          </>
                        ) : null}
                      </p>
                    ) : (
                      <>
                        <p className="mt-1 text-sm text-muted">
                          {myDraftReadiness === DRAFT_READINESS.STALE
                            ? "The draft time changed after your last confirmation. Review the current time above and confirm again."
                            : "Confirm that you have seen the draft time above and are still committed to playing this season."}
                        </p>
                        {myDraftReadiness === DRAFT_READINESS.STALE &&
                        reg.draftConfirmedFor ? (
                          <p className="mt-1 text-xs text-muted">
                            Previously confirmed for{" "}
                            <LocalTime
                              ts={reg.draftConfirmedFor.getTime()}
                              variant="full"
                              initial={formatMatchTime(
                                reg.draftConfirmedFor,
                                "full",
                              )}
                            />
                            .
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                  {myDraftReadiness !== DRAFT_READINESS.READY ? (
                    <ActionForm
                      action={confirmDraftReadiness}
                      hidden={{
                        expectedActiveSeasonId: season.id,
                        draftRevision: String(season.draftRevision),
                        draftAtTs: String(season.draftAt.getTime()),
                      }}
                    >
                      <SubmitButton
                        variant={
                          myDraftReadiness === DRAFT_READINESS.STALE
                            ? "accent"
                            : "primary"
                        }
                        size="sm"
                      >
                        {myDraftReadiness === DRAFT_READINESS.STALE
                          ? "Confirm updated draft time"
                          : "Confirm I’m ready for draft"}
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                </div>
                <p className="mt-2 text-xs text-muted">
                  If your plans change later, withdraw your signup below or
                  message an admin.
                </p>
              </div>
            ) : null}
            {member ? (
              <Link
                href={`/teams/${member.team.id}`}
                className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5 transition-colors hover:border-muted/60"
              >
                <TeamCrest
                  name={member.team.name}
                  seed={member.team.id}
                  logoUrl={member.team.logoUrl}
                  size={40}
                />
                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-wide text-muted">
                    Your team
                  </div>
                  <div className="truncate font-medium">{member.team.name}</div>
                </div>
                <div className="ml-auto shrink-0">
                  {member.isCaptain ? (
                    <Badge tone="brand">Captain</Badge>
                  ) : (
                    <span className="text-sm text-muted">
                      Drafted for{" "}
                      <span className="font-semibold text-fg">
                        ${member.price}
                      </span>
                    </span>
                  )}
                </div>
              </Link>
            ) : null}
            {member && nextTeamMatch ? (
              <Link
                href={`/matches/${nextTeamMatch.id}`}
                className="block rounded-lg border border-line bg-surface-2/40 px-3 py-2.5 transition-colors hover:border-muted/60"
              >
                <div className="text-xs uppercase tracking-wide text-muted">
                  Your next match
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone="info">
                    {matchRoundLabel(
                      nextTeamMatch,
                      playoffRounds.get(nextTeamMatch.seasonId) ?? 0,
                    )}
                  </Badge>
                  <span className="min-w-0">
                    vs{" "}
                    <span className="font-medium text-fg">
                      {nextTeamMatch.homeTeamId === member.teamId
                        ? nextTeamMatch.awayTeam.name
                        : nextTeamMatch.homeTeam.name}
                    </span>
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted">
                  {nextTeamMatch.scheduledAt ? (
                    <LocalTime
                      ts={nextTeamMatch.scheduledAt.getTime()}
                      variant="full"
                      initial={formatMatchTime(nextTeamMatch.scheduledAt, "full")}
                    />
                  ) : (
                    "Time TBD"
                  )}
                </div>
              </Link>
            ) : null}

            {/* Renders for a STANDIN signup (empty state included) and for ANY
                unrostered signup that actually holds a booking — undrafted
                PLAYER-type free agents are legal cover in both assign forms,
                and the old type gate hid their own bookings from them. The
                bare card stays standin-only: during SIGNUPS every registrant
                is unrostered, and an empty "your assignments" box for the
                whole pool would be noise. */}
            {isRegistered &&
            !member &&
            standinAssignments &&
            (reg?.type === "STANDIN" || standinAssignments.length > 0) ? (
              <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                <div className="text-xs uppercase tracking-wide text-muted">
                  Your standin assignments
                </div>
                {standinAssignments.length === 0 ? (
                  <p className="mt-1 text-sm text-muted">
                    No assignments yet — captains grab cover from the standin
                    pool on each match page as their players drop out. Keep your
                    Discord linked so their ping reaches you.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {standinAssignments.map((a) => {
                      const fillFor =
                        a.match.homeTeamId === a.teamId
                          ? a.match.homeTeam
                          : a.match.awayTeam;
                      const opponent =
                        a.match.homeTeamId === a.teamId
                          ? a.match.awayTeam
                          : a.match.homeTeam;
                      return (
                        <li key={a.id}>
                          <Link
                            href={`/matches/${a.match.id}`}
                            className="block rounded-md border border-line bg-surface/60 px-3 py-2 transition-colors hover:border-muted/60"
                          >
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                              <Badge tone="info">
                                {matchRoundLabel(
                                  a.match,
                                  playoffRounds.get(a.match.seasonId) ?? 0,
                                )}
                              </Badge>
                              <span className="min-w-0">
                                Filling in for{" "}
                                <span className="font-medium text-fg">
                                  {fillFor.name}
                                </span>{" "}
                                vs{" "}
                                <span className="font-medium text-fg">
                                  {opponent.name}
                                </span>
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-muted">
                              {a.match.scheduledAt ? (
                                <LocalTime
                                  ts={a.match.scheduledAt.getTime()}
                                  variant="short"
                                  initial={formatMatchTime(
                                    a.match.scheduledAt,
                                    "short",
                                  )}
                                />
                              ) : (
                                "Time TBD"
                              )}
                            </div>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ) : null}

            {registrationRemoved ? (
              <div
                role="alert"
                className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
              >
                <p className="font-medium text-danger">
                  You can&apos;t rejoin this season from this form.
                </p>
                <p className="mt-1 text-muted">
                  A league admin removed the signup. Contact an admin in Discord
                  if this was a mistake; they can review and reinstate the same
                  record without losing your answers.
                </p>
              </div>
            ) : seasonRegistrationClosed ? (
              <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm">
                <p className="font-medium text-fg">Registration is closed.</p>
                <p className="mt-1 text-muted">
                  {isRegistered
                    ? "Your final signup details stay attached to this season's history. Your Discord, Steam and Dota settings below remain editable."
                    : "This season has finished. Watch the dashboard for the next season; your Discord, Steam and Dota settings below are ready to carry forward."}
                </p>
              </div>
            ) : rejoinPaused ? (
              <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm">
                <p className="font-medium text-fg">The draft is running.</p>
                <p className="mt-1 text-muted">
                  You withdrew, so you&apos;re not in the pool captains are
                  bidding on. Once the draft finishes you can rejoin here, as a
                  full player or a standin.
                </p>
              </div>
            ) : (
              <>
                {/* The weekly slot is for deciding whether to sign up. Once
                    the player has a fixture listed above (their team's next
                    match, or cover they're booked for), that says when they
                    play instead. */}
                {(member && nextTeamMatch) ||
                (standinAssignments?.length ?? 0) > 0 ? null : (
                  <ScheduleCallout
                    label={seasonMatchNightLabel(season)}
                    description={
                      playerLocked ||
                      (isRegistered && reg?.type === REGISTRATION_TYPE.STANDIN)
                        ? "Games run weekly. Captains book standins for this night when one of their players can't make it."
                        : isRegistered
                          ? "Games run weekly on this night."
                          : undefined
                    }
                  />
                )}
                {returningPlan && previous ? (
                  <ReturningJoinCard
                    plan={returningPlan}
                    seasonName={previous.season.name}
                    roles={previous.roles}
                    action={saveRegistration}
                    notice={<SignupPublicNotice />}
                    hidden={{
                      ...seenDraftFields,
                      mmr: previous.mmr > 0 ? String(previous.mmr) : "",
                      favoriteHeroes: previous.favoriteHeroes,
                      about: aboutText(previous),
                      ...(previous.wantsCaptain &&
                      previous.type === REGISTRATION_TYPE.PLAYER
                        ? { wantsCaptain: "on" }
                        : {}),
                    }}
                  />
                ) : !reg && previous ? (
                  <div className="flex items-start gap-2 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-xs">
                    <span aria-hidden>↩️</span>
                    <span>
                      Welcome back! We prefilled this from your{" "}
                      <b>{previous.season.name}</b> signup — update anything
                      that changed, then submit to join.
                    </span>
                  </div>
                ) : null}
                <SavedSignupForm
                  saved={isRegistered || !!returningPlan}
                  label={returningPlan ? "Change answers" : undefined}
                  summary={
                    reg && isRegistered
                      ? signupSummary(reg)
                      : returningPlan
                        ? "Opens the full signup form"
                        : undefined
                  }
                >
                <ActionForm
                  action={saveRegistration}
                  trackChanges
                  className="space-y-5"
                  // The draft time printed above this form. Joining the pool
                  // with it counts as confirming it; the server stamps that
                  // only if these still match the season when it saves.
                  hidden={seenDraftFields}
                >
                  {/* The one-tap card above already says it. */}
                  {returningPlan ? null : <SignupPublicNotice />}

                  {playerLocked ? (
                    /* Only a standin signup is possible here (signups closed,
                       and this viewer was never a full player), so there is
                       no choice to make: no greyed-out Full player tile, no
                       captain box, no draft wording. */
                    <div>
                      <p className="mb-1.5 text-sm font-medium">Participation</p>
                      <input type="hidden" name="type" value="STANDIN" />
                      <div className="rounded-lg border border-accent bg-accent/10 p-3">
                        <span className="block text-sm font-medium">Standin</span>
                        <span className="block text-xs text-muted">
                          Fill in for teams when someone can&apos;t play.
                          Full-player signups are closed for this season.
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <label className="mb-1.5 block text-sm font-medium">
                        Participation
                      </label>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <RadioTile
                          name="type"
                          value="PLAYER"
                          defaultChecked={typeDefault === REGISTRATION_TYPE.PLAYER}
                          required={typeDefault === null}
                          title="Full player"
                          desc="Get drafted onto a team and play every week."
                        />
                        <RadioTile
                          name="type"
                          value="STANDIN"
                          defaultChecked={typeDefault === REGISTRATION_TYPE.STANDIN}
                          required={typeDefault === null}
                          title="Standin"
                          desc="Fill in for teams when someone can't play."
                        />
                      </div>
                      {/* Captain volunteering is a signup-phase choice for
                          full players, so it sits with the participation
                          choice and only while signups are open. Afterwards
                          the server keeps the stored answer (a missing box
                          submits nothing). */}
                      {signupsOpen ? (
                        <label className="mt-2 flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 p-3">
                          <input
                            type="checkbox"
                            name="wantsCaptain"
                            defaultChecked={form?.wantsCaptain ?? false}
                            className="h-4 w-4 accent-[var(--color-brand)]"
                          />
                          <span className="text-sm">
                            <span className="block">
                              I&apos;d like to be considered as a team captain
                            </span>
                            <span className="block text-xs text-muted">
                              Full players only.
                            </span>
                          </span>
                        </label>
                      ) : null}
                    </div>
                  )}

                  <div>
                    <label
                      htmlFor="mmr"
                      className="block text-sm font-medium"
                    >
                      Dota 2 MMR
                    </label>
                    {/* The medal first: many players don't know their exact
                        number. The line under the box shows what will be
                        stored as they type (display only; the server still
                        judges the raw claim and clamps it). */}
                    {medalBlocked ? (
                      <p id="mmr-lead" className="mb-1.5 mt-0.5 text-xs text-danger">
                        Your {rankMedalName(dbUser?.rankTier)} medal puts you
                        above {HARD_MMR_CEILING} MMR, so this league can&apos;t
                        take your signup.
                      </p>
                    ) : mmrLead ? (
                      <p id="mmr-lead" className="mb-1.5 mt-0.5 text-xs text-muted">
                        {mmrLead}
                      </p>
                    ) : null}
                    <MmrField
                      // Remount when the saved number changes, so the preview
                      // starts from what the server stored.
                      key={String(reg?.mmr ?? "new")}
                      // `|| ""` (not ??): a stored unknown (0) must render
                      // blank, or resubmitting trips the min=1 validation.
                      defaultValue={String(form?.mmr || "")}
                      rankTier={dbUser?.rankTier ?? null}
                      storedMmr={reg ? reg.mmr : null}
                      frozen={
                        reg?.type === REGISTRATION_TYPE.PLAYER &&
                        reg.status === REGISTRATION_STATUS.ACTIVE &&
                        auctionRunning(draft?.status)
                      }
                      describedBy={medalBlocked || mmrLead ? "mmr-lead" : undefined}
                    />
                    <p className="mt-1 text-xs text-muted">
                      {mmrRulesLine(season.maxMmr)}
                    </p>
                  </div>

                  {/* Out of the optional disclosure: one tap each, and the
                      pool, the home page's role mix and the admin's "blank
                      signup" check all read them. Still never required. */}
                  <fieldset>
                    <legend className="mb-1.5 block text-sm font-medium">
                      Preferred roles
                    </legend>
                    <div className="flex flex-wrap gap-2">
                      {DOTA_ROLES.map((r) => (
                        <label
                          key={r.key}
                          className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10"
                        >
                          <input
                            type="checkbox"
                            name="roles"
                            value={r.key}
                            defaultChecked={myRoles.includes(r.key)}
                            className="h-4 w-4 accent-[var(--color-accent)]"
                          />
                          {r.label}{" "}
                          <span className="text-xs text-muted">
                            ({r.short})
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      Optional. Tick every position you&apos;re happy to play.
                    </p>
                  </fieldset>

                  <details className="rounded-lg border border-line p-3">
                    <summary className="min-h-11 cursor-pointer font-medium">Optional scouting profile</summary>
                    <div className="space-y-5 pt-3">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">
                      Favorite heroes
                    </label>
                    <HeroPicker
                      name="favoriteHeroes"
                      defaultValue={form?.favoriteHeroes}
                      suggestions={favoriteHeroSuggestions(
                        form?.favoriteHeroes,
                        dbUser?.pubStats,
                      )}
                    />
                    <p className="mt-1 text-xs text-muted">
                      Pick the heroes you&apos;re known for.
                    </p>
                  </div>

                  {/* One box where there used to be two near-identical ones
                      (goals, and a note for captains). An older signup's two
                      answers show here joined, so nothing is lost. */}
                  <div>
                    <label
                      htmlFor="about"
                      className="mb-1.5 block text-sm font-medium"
                    >
                      About you (shown to captains)
                    </label>
                    <textarea
                      id="about"
                      name="about"
                      rows={4}
                      maxLength={ABOUT_MAX_LENGTH}
                      defaultValue={form ? aboutText(form) : ""}
                      placeholder="How you play, what you're working on, what you want from the league…"
                      className="w-full rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-accent/60"
                    />
                  </div>

                    </div>
                  </details>

                  <div className="flex flex-wrap gap-3">
                    <SubmitButton>
                      {isRegistered
                        ? "Update signup"
                        : playerLocked
                          ? "Register as a standin"
                          : "Join the season"}
                    </SubmitButton>
                  </div>
                </ActionForm>
                </SavedSignupForm>

                {signupLive ? (
                  <Suspense
                    fallback={
                      <SignupNextSteps
                        steps={accountNextSteps({
                          ...stepFacts,
                          membership: null,
                        })}
                      />
                    }
                  >
                    <LiveSignupNextSteps
                      facts={stepFacts}
                      memberInfo={memberInfo}
                    />
                  </Suspense>
                ) : null}

                {isRegistered ? (
                  <div className="mt-4 border-t border-line pt-4">
                    {isRostered || isCaptain ? (
                      <p className="text-xs text-muted">
                        {isCaptain ? (
                          <>
                            You captain <b>{member?.team.name}</b> — ask an
                            admin to replace you before you can withdraw.
                          </>
                        ) : (
                          <>
                            You&apos;re on <b>{member?.team.name}</b>&apos;s
                            roster — ask an admin to release you before
                            withdrawing.
                          </>
                        )}
                      </p>
                    ) : (
                      <ActionForm action={leaveLeague}>
                        <SubmitButton
                          variant="ghost"
                          size="sm"
                          confirm={withdrawConfirmText({
                            type: reg?.type ?? REGISTRATION_TYPE.PLAYER,
                            seasonStatus: season.status,
                            draftStatus: draft?.status,
                          })}
                        >
                          Withdraw from this season
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>
      )}
      </section>

      <Suspense fallback={null}>
        <AwayDatesSection userId={user.id} />
      </Suspense>

      <Suspense fallback={<section id="profile-discord" className="scroll-mt-24"><Card><CardBody><p role="status">Checking your Discord…</p></CardBody></Card></section>}>
        <ProfileDiscordSection dbUser={dbUser} discordParam={discordParam} isRegistered={isRegistered} isCaptain={isCaptain} signupsOpen={signupsOpen} guildCfg={guildCfg} memberInfo={memberInfo} />
      </Suspense>

      <SteamDotaCard
        userId={user.id}
        name={dbUser?.name ?? user.name}
        avatar={dbUser ? dbUser.avatar : user.avatar}
        isAdmin={user.role === "ADMIN"}
        steamUrl={
          // A player whose Steam profile URL was never fetched still has a
          // Steam id; "#" opened a blank tab.
          dbUser?.profileUrl ||
          `https://steamcommunity.com/profiles/${encodeURIComponent(user.steamId)}`
        }
        effectiveId={
          dbUser
            ? effectiveDotaAccountId(dbUser)
            : steamIdToAccountId(user.steamId)
        }
        steamAccountId={steamIdToAccountId(user.steamId)}
        override={dbUser ? storedDotaAccountId(dbUser) : null}
        rankTier={dbUser?.rankTier ?? null}
        fhUnavailable={dbUser?.fhUnavailable ?? null}
      />
    </div>
  );
}

/**
 * "I'm away": only for a viewer with at least one upcoming fixture they can
 * check in for, judged by the same seat rules the save uses. Streamed, so the
 * roster and cover lookups never hold up the rest of the profile.
 */
async function AwayDatesSection({ userId }: { userId: string }) {
  // Async server component: the clock is request-time state, not render replay.
  // eslint-disable-next-line react-hooks/purity
  const away = await listAwayFixtures(userId, Date.now());
  if (!away) return null;
  return (
    <AwayDatesCard
      seasonId={away.seasonId}
      fixtures={away.fixtures.map((f) => ({
        ...f,
        whenLabel: formatMatchTime(new Date(f.kickoffMs), "short"),
      }))}
    />
  );
}

/**
 * The next-steps list once Discord has answered. The fallback above renders
 * the same list without the membership steps, so an unknown or slow answer
 * simply leaves them out: never "not in the server" on a guess.
 */
async function LiveSignupNextSteps({
  facts,
  memberInfo,
}: {
  facts: Omit<AccountStepInput, "membership">;
  memberInfo: Promise<GuildMemberInfo>;
}) {
  const info = await memberInfo;
  return (
    <SignupNextSteps
      steps={accountNextSteps({
        ...facts,
        membership: info === null ? null : info.membership,
      })}
    />
  );
}

async function ProfileDiscordSection({ dbUser, discordParam, isRegistered, isCaptain, signupsOpen, guildCfg, memberInfo: memberInfoPromise }: {
  dbUser: User | null;
  discordParam?: string;
  isRegistered: boolean;
  isCaptain: boolean;
  signupsOpen: boolean;
  guildCfg: GuildConfig | null;
  /** The page's one live member lookup (null without a link or a bot). */
  memberInfo: Promise<GuildMemberInfo>;
}) {
  // Server component, so we can check the OAuth app config directly and only
  // offer "Link Discord" when clicking it can actually work.
  const discordLinkAvailable = !!(
    process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET
  );
  // With a bot + server configured the OAuth consent also carries
  // `guilds.join`, so linking adds them to the server in the same click. The
  // copy has to match what the consent screen actually asks for.
  const discordWritesEnabled = discordMutationsAllowed();
  const discordAutoJoins = discordWritesEnabled && !!guildCfg;

  const [memberInfo, pingCfg] = await Promise.all([
    memberInfoPromise,
    dbUser?.discordId && discordWritesEnabled ? getRoleConfig() : null,
  ]);
  // ONE live member lookup answers both questions this page has about the
  // linked account: is the player actually IN the league's server (linking
  // proves ownership of the handle; only membership makes them reachable), and
  // do they hold the ping role. `membership` null = we can't tell — no bot
  // configured, or Discord didn't answer — and null renders as the plain
  // "Linked ✓" card, never as "not in the server": telling a player they left
  // a server they're sitting in reads as broken (the hasPingRole rule).
  const membership = memberInfo === null ? null : memberInfo.membership;
  if (dbUser?.discordId && guildCfg) {
    // Keep the dashboard's memoised join nag in step with what this page is
    // about to render — the player mid-fix is exactly who would notice the
    // two surfaces disagreeing for a memo window.
    primeMembershipMemo(dbUser.discordId, membership);
  }
  // Inhouse ping opt-in. `on: null` = we genuinely don't know (Discord slow,
  // or the player isn't in the server) — rendered as unknown rather than "off",
  // because showing an unticked box to someone already opted in makes them
  // click it and change nothing, which reads as broken.
  const pingOptIn = {
    available: !!pingCfg,
    on: pingCfg
      ? memberInfo && memberInfo.membership !== "not-member"
        ? memberInfo.roles.includes(pingCfg.roleId)
        : null
      : false,
  };
  // The league coordinates on Discord — this is how captains reach their
  // roster for scheduling, check-ins, and standin scrambles. One card: its
  // badge and main button follow the state, the invite stays beside any
  // one-click join, and the typed handle is the fallback.
  return (
    <section id="profile-discord" className="scroll-mt-24">
      <AccountDiscordCard
        discordId={dbUser?.discordId ?? null}
        discordName={dbUser?.discordName || null}
        membership={membership}
        param={discordParam}
        linkAvailable={discordLinkAvailable}
        autoJoins={discordAutoJoins}
        isCaptain={isCaptain}
        warnBeforeLeaving={!isRegistered && signupsOpen}
        pingOptIn={pingOptIn}
        unlinkAction={unlinkDiscord}
        saveHandleAction={updateDiscordName}
        pingAction={setInhousePingOptIn}
      />
    </section>
  );
}

/**
 * The one line that says what joining makes public. Said once, in neutral
 * colours: the accent box this used to be looked exactly like the
 * "Confirmation needed" box, and each field then repeated "shown publicly".
 * Rendered wherever a Join button is, since joining is the consent.
 */
function SignupPublicNotice() {
  return (
    <p className="rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-xs leading-relaxed text-muted">
      Everything in your signup, and your medal, is public in the player
      pool and on your profile. Your Discord is only shown to league admins and
      players signed up this season. Keep contact, health and availability
      details out of the About you box. Joining lets the league refresh your
      public Steam and Dota data.
    </p>
  );
}

function RadioTile({
  name,
  value,
  title,
  desc,
  defaultChecked,
  required,
}: {
  name: string;
  value: string;
  title: string;
  desc: string;
  defaultChecked?: boolean;
  required?: boolean;
}) {
  return (
    <label className="flex cursor-pointer gap-3 rounded-lg border border-line p-3 transition-colors hover:border-muted/60 has-[:checked]:border-accent has-[:checked]:bg-accent/10">
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        required={required}
        className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{desc}</span>
      </span>
    </label>
  );
}

const PUBLIC_MATCH_DATA_PATH =
  "Settings → Options → Advanced → Social → Expose Public Match Data";

/**
 * Steam and Dota in one short card: who you are, your medal, the three
 * outside profiles and one refresh button. Steam already refreshes the name
 * and avatar on every sign-in, so the long ids and the per-provider buttons
 * were noise; the match-data how-to shows only when it is the likely fix
 * (data private, or no medal yet).
 */
function SteamDotaCard({
  userId,
  name,
  avatar,
  isAdmin,
  steamUrl,
  effectiveId,
  steamAccountId,
  override,
  rankTier,
  fhUnavailable,
}: {
  userId: string;
  name: string;
  avatar: string | null;
  isAdmin: boolean;
  steamUrl: string;
  effectiveId: number | null;
  steamAccountId: number | null;
  override: number | null;
  rankTier: number | null;
  /** OpenDota fh_unavailable: true = match data private (auto-import blind). */
  fhUnavailable: boolean | null;
}) {
  return (
    <Card id="profile-dota" className="scroll-mt-24">
      <CardHeader
        headingLevel={2}
        title="Steam & Dota"
        subtitle="Your Steam sign-in verifies your Dota account, which your medal, scouting stats and match imports come from. To use another Dota account, sign in with the Steam account that owns it."
      />
      <CardBody className="space-y-3">
        {fhUnavailable === true ? (
          <div
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
          >
            <b>Your Dota match data is private</b> — league results can&apos;t
            auto-import your games, and your medal/stats stay invisible. In Dota
            2: <b>{PUBLIC_MATCH_DATA_PATH}</b>, play a game, then press Refresh
            my Steam &amp; Dota info below.
          </div>
        ) : null}
        {/* shrink-0 on the avatar: Avatar sets width/height but no shrink
            floor, and beside the name it rendered 19px wide in its 56px box.
            min-w-0 lets a long Steam name wrap instead of widening the card. */}
        <div className="flex items-center gap-4">
          <Avatar name={name} src={avatar} size={56} className="shrink-0" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-xl font-semibold [overflow-wrap:anywhere]">
                {name}
              </span>
              {isAdmin ? <Badge tone="accent">Admin</Badge> : null}
              {rankTier ? (
                <RankMedal rankTier={rankTier} showLabel />
              ) : (
                <span className="text-xs text-muted">No medal yet</span>
              )}
            </div>
            {/* Stacked TAP_SAFE links need real spacing between them. */}
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-2 text-sm">
              <a
                href={steamUrl}
                target="_blank"
                rel="noreferrer"
                className={textLink()}
              >
                Steam <span aria-hidden>↗</span>
              </a>
              {effectiveId ? (
                <>
                  <a
                    href={`https://www.dotabuff.com/players/${effectiveId}`}
                    target="_blank"
                    rel="noreferrer"
                    className={textLink()}
                  >
                    Dotabuff <span aria-hidden>↗</span>
                  </a>
                  <a
                    href={`https://www.opendota.com/players/${effectiveId}`}
                    target="_blank"
                    rel="noreferrer"
                    className={textLink()}
                  >
                    OpenDota <span aria-hidden>↗</span>
                  </a>
                </>
              ) : null}
            </div>
          </div>
        </div>

        {!effectiveId ? (
          <p className="text-sm text-muted">
            We couldn&apos;t derive a Dota account from this Steam identity.
            Contact a league admin before playing.
          </p>
        ) : null}

        {override != null ? (
          <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
            <p>
              Your Dota account ({override}) is a manual link from an older
              version of the league site and is not ownership-verified. You
              can keep refreshing it, or switch permanently to the account
              verified by your Steam sign-in.
            </p>
            {steamAccountId != null ? (
              <ActionForm action={updateDotaAccount}>
                <SubmitButton variant="secondary" size="sm">
                  Use my verified Steam account
                </SubmitButton>
              </ActionForm>
            ) : null}
          </div>
        ) : null}

        {effectiveId && !rankTier && fhUnavailable !== true ? (
          <p className="text-xs text-muted">
            No medal showing? In Dota 2, turn on{" "}
            <b>{PUBLIC_MATCH_DATA_PATH}</b>, play a game, then refresh.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <ActionForm action={refreshMyAccounts}>
            <SubmitButton variant="secondary" size="sm">
              Refresh my Steam &amp; Dota info
            </SubmitButton>
          </ActionForm>
          <Link
            href={`/players/${userId}`}
            className={textLink("whitespace-nowrap text-sm")}
          >
            View my public profile →
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}
