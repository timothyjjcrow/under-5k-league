import { Suspense } from "react";
import Link from "@/components/app-link";
import {
  DRAFT_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "@/lib/constants";
import {
  addCaptain,
  changeCaptain,
  refreshPlayerData,
  removeCaptain,
  randomizeDraftOrder,
  setDraftNight,
  undoLastSaleAction,
  abortDraftAction,
  pauseDraftAction,
  resumeDraftAction,
  voidCurrentLotAction,
  transferCaptaincy,
} from "@/app/actions/admin-captains-draft";
import {
  renameTeam,
  withdrawSignup,
  withdrawTeam,
  reinstateTeam,
  reinstateSignup,
} from "@/app/actions/admin-roster";
import { formatLeagueTime } from "@/lib/zoned-time";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { formatProblems, knobsLabel } from "@/lib/season-builder";
import { parseFormatConfig, teamCountSeasonNote } from "@/lib/season-format";
import { DangerSubmit } from "@/components/danger-submit";
import { cn } from "@/lib/utils";
import {
  getGuildConfig,
  sweepGuildMemberships,
  type GuildMembership,
} from "@/lib/discord-roles";
import { signupNeedsReview } from "@/lib/signup-readiness";
import {
  signupRemovalBlockers,
  type SignupRemovalBlocker,
} from "@/lib/registration";
import { AdminSignupReview } from "@/components/admin-signup-review";
import {
  DRAFT_READINESS,
  draftReadiness,
  draftReadinessCounts,
} from "@/lib/draft-readiness";
import {
  teamWithdrawalLockedReason,
  withdrawalKickedOffFixtures,
} from "@/lib/team-withdrawal";
import { draftClocks, mmrWeightedBudgets } from "@/lib/draft";
import {
  profileSyncAllowed,
  undoSaleConfirm,
  undoSaleTarget,
  voidLotConfirm,
  type UndoTarget,
} from "@/lib/draft-admin";
import { captainMmrWarning, unverifiedCaptainMmrsFor } from "@/lib/captain-mmr";
import {
  captainTransferOpen,
  draftSetupLockedMessage,
  draftRosterCounts,
  draftSetupOpen,
  seatFitSentence,
  startDraftCheck,
  startDraftConfirm,
} from "@/lib/draft-setup";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  StartDraftControl,
  StartDraftForm,
} from "@/components/admin-start-draft";
import { StartDraftConfirmLine } from "@/components/start-draft-submit";
import { missingCaptainsConfirmLine } from "@/lib/draft-presence";
import { AdminPlayerRankEditor } from "@/components/admin-player-rank-editor";
import { TeamIdentityForm } from "@/components/team-identity-form";
import { isGeneratedTeamNameFor } from "@/lib/team-identity";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  PlayerLink,
  RankMedal,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { selectCls } from "@/components/admin/admin-fields";
import type { AdminData, Season } from "@/components/admin/season-admin-data";
import { formatBuilderAnchor } from "@/components/admin/season-admin-rules";
import {
  ROW_META_LINE,
  SignupRowMeta,
  regSignupFlags,
} from "@/components/admin/signup-row-meta";

/**
 * Stands in for a signup row's "remove" when withdrawSignup would only refuse
 * it (see signupRemovalBlockers): says why, and the title says what to do.
 */
function RemovalBlockedNote({ blocker }: { blocker: SignupRemovalBlocker }) {
  return (
    <span className="text-xs text-muted" title={blocker.fix}>
      {blocker.note}
    </span>
  );
}

export function CaptainControls({
  season,
  data,
  nowMs,
}: {
  season: Season;
  data: AdminData;
  nowMs: number;
}) {
  // Two tiers, matching the server guards: once the draft has RUN (live,
  // paused, or complete) captain management and Start draft are locked —
  // startDraft rejects re-runs server-side too. The draft-room link only
  // makes sense while the auction is actually live.
  const draftStarted = !!data.draft && data.draft.status !== "NOT_STARTED";
  const draftLive = data.draft?.status === "IN_PROGRESS";
  const setupOpen = draftSetupOpen(season.status, data.draft?.status);
  const transferOpen = captainTransferOpen(season.status, data.draft?.status);
  const teamWithdrawalLocked =
    teamWithdrawalLockedReason(season.status) ??
    (data.matches.some((m) => m.phase === "TIEBREAKER")
      ? "Reset the tiebreaker week before changing team eligibility."
      : null);
  const captainUserIds = new Set(data.teams.map((t) => t.captainId));
  const nonCaptains = data.players.filter((p) => !captainUserIds.has(p.userId));
  // Real STANDIN registrations, for the moderation list below (data.standins
  // also carries undrafted PLAYERs for the cover dropdowns — those rows are
  // already in the eligible list above).
  const standinRegs = data.standins.filter(
    (s) => s.type === REGISTRATION_TYPE.STANDIN,
  );
  // Rows withdrawSignup can only refuse (rostered, or owing cover on an
  // unplayed match) get a note instead of a "remove" button. Mid-season that
  // is every drafted player in the list below.
  const removalBlockers = signupRemovalBlockers({
    teams: data.teams,
    assignments: data.assignments,
    matches: data.matches,
  });
  // The signup lists' "is this player actually IN the Discord server?" chips.
  // STARTED here, never awaited: this card is on /admin's blocking path, which
  // must stay Discord-free (the DiscordSection rule) — each row's chip
  // suspends on this promise individually, so the list and its make-captain /
  // remove controls paint immediately and the chips stream in when the
  // rate-paced sweep answers. The catch degrades a sweep-level failure to the
  // chips' honest "couldn't check" state; a Discord outage must never cost the
  // panel. (The funnel card and the Start-draft confirm sweep the same ids —
  // the membership memo and its in-flight dedupe make the third consumer
  // nearly free.)
  const guildCfg = getGuildConfig();
  const linkedIds = [
    ...new Set(
      [...nonCaptains, ...standinRegs]
        .map((p) => p.user.discordId)
        .filter((id): id is string => !!id),
    ),
  ];
  const membershipSweep =
    guildCfg && linkedIds.length > 0
      ? sweepGuildMemberships(linkedIds, guildCfg).catch(
          () => new Map<string, GuildMembership>(),
        )
      : null;
  // Captains are ACTIVE PLAYER registrations too (addCaptain requires it), so
  // their row is in `data.players` — it is only filtered out of the list above.
  const captainReg = new Map(data.players.map((p) => [p.userId, p]));
  const confirmationCounts = draftReadinessCounts(
    data.players,
    season.draftRevision,
  );
  const readyConfirmation = data.players.filter(
    (p) => draftReadiness(p, season.draftRevision) === DRAFT_READINESS.READY,
  );
  const awaitingConfirmation = data.players.filter(
    (p) => draftReadiness(p, season.draftRevision) === DRAFT_READINESS.AWAITING,
  );
  const staleConfirmation = data.players.filter(
    (p) => draftReadiness(p, season.draftRevision) === DRAFT_READINESS.STALE,
  );
  const regularCount = data.matches.filter((m) => m.phase === "REGULAR").length;
  const collateral = data.collateral;
  const unverifiedMmr = unverifiedCaptainMmrsFor(season, data);
  const unverifiedMmrByTeam = new Map(
    unverifiedMmr.map((c) => [c.teamId, c]),
  );

  // Starting the draft locks addCaptain/removeCaptain, but it is NOT a one-way
  // door — this comment used to say it was, and the confirm below repeated it.
  // `abortDraft` (draft-service.ts) writes Draft.status back to NOT_STARTED,
  // drops the season to SIGNUPS, refunds every purchase and deliberately KEEPS
  // the captains and their teams, precisely so captain management reopens. The
  // team count is final only once a RESULT exists, which is the line abort
  // itself guards on. Saying "this can't be undone" on draft night pointed a
  // mis-clicking admin at "create a new season" — which archives every
  // registration made so far — while the real recovery sat in the same header.
  // The confirm still names the count being locked in and calls out a shortfall
  // against the season's own team target.
  // Abort is only offered while nothing has been played — the same line the
  // action guards on, so the button never appears where it would be refused.
  const anyResultRecorded =
    data.matches.some((m) => m.status === "COMPLETED") ||
    data.matches.some((m) => (m.games?.length ?? 0) > 0);
  // Seat math, mirroring startDraft's own (pool = ACTIVE PLAYER signups not
  // already rostered; seats = one team per CAPTAIN, captain's own seat taken).
  // Signups are uncapped by design — minTeams is a floor — so the pool is
  // routinely not a multiple of teamSize, and the count is settled HERE by
  // choosing how many captains to start with. startDraft accepts both a short
  // pool (standins fill in) and a long one, silently: an overflow leaves those
  // players undrafted as free agents with no warning anywhere, which is a thing
  // to learn before pressing the button, not after.
  const { captainCount, boughtCount, poolCount } = draftRosterCounts(
    data.teams,
    data.players,
  );
  // A saved layout that this many captains can't build: the preflight says
  // so in red, since Generate will refuse it after the auction.
  const storedFormat = parseFormatConfig(season.formatConfig);
  const formatUnfitError =
    storedFormat.kind === "CUSTOM"
      ? formatProblems(storedFormat.knobs, captainCount).errors[0]
      : undefined;
  // The note quotes one fewer and one more captain only where the saved
  // layout could be built.
  const formatFits = (count: number) =>
    storedFormat.kind !== "CUSTOM" || formatProblems(storedFormat.knobs, count).errors.length === 0;
  const formatUnfit =
    storedFormat.kind === "CUSTOM" && formatUnfitError
      ? { knobs: storedFormat.knobs, error: formatUnfitError }
      : null;
  // The sale Undo last sale would revert — the newest AUCTION purchase
  // (price > 0; $0 rows are free-agent signings), the same row undoLastSale
  // picks — so the confirm can name it like the draft room's does. The form
  // posts its roster row, and undoLastSale refuses if a newer sale landed
  // after this render: /admin doesn't poll during the auction.
  const lastAuctionRow = undoSaleTarget(
    data.teams.flatMap((t) =>
      t.members.map((m) => ({ ...m, teamName: t.name })),
    ),
  );
  const lastAuctionSale: UndoTarget | null = lastAuctionRow
    ? {
        membershipId: lastAuctionRow.id,
        name: lastAuctionRow.user.name,
        teamName: lastAuctionRow.teamName,
        price: lastAuctionRow.price,
      }
    : null;
  const {
    seats,
    canStart,
    blocker: startBlocker,
  } = startDraftCheck({
    captainCount,
    teamSize: season.teamSize,
    poolCount,
    boughtCount,
  });
  const rosterAlreadyBuilt = boughtCount > 0;
  const startConfirm = startDraftConfirm({
    captainCount,
    minTeams: season.minTeams,
    teamSize: season.teamSize,
    seats,
    draftScheduled: !!season.draftAt,
    confirmations: confirmationCounts,
    // DB-only, so it belongs in the base confirm: the Suspense fallback button
    // carries it too, and a click before the Discord line lands still warns.
    mmrWarning: captainMmrWarning(unverifiedMmr),
  });
  const startDisabled = !setupOpen || !canStart;
  // Named last in the confirm, as in the draft room, but only as of this
  // page load: /admin doesn't poll.
  const captainsAwayLine = missingCaptainsConfirmLine(
    data.teams
      .filter((t) => !data.captainsInRoom.has(t.captainId))
      .map((t) => t.captain.name),
    "pageLoad",
  );

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Captains & draft"
        subtitle={
          setupOpen
            ? "Designate captains, review readiness and seat fit, then start the auction."
            : draftSetupLockedMessage(season.status, data.draft?.status)
        }
        action={
          /* flex-wrap like every other row in this file: this header holds up to
             six controls (refresh player data, randomize, start,
             pause/resume, undo, abort) and without wrapping they pushed /admin
             past a phone — caught by the mobile tripwire on CI, whose fonts
             are a few px wider than macOS's, so it read as a 7px page scroll. */
          <div className="flex flex-wrap justify-end gap-2">
            {/* Off while the auction is live or paused: it rewrites the
                medals, names and avatars captains are reading in the room.
                The automation worker refreshes the same data hourly; this is
                for right before a draft. */}
            {profileSyncAllowed(data.draft?.status) ? (
              <ActionForm action={refreshPlayerData}>
                <SubmitButton variant="secondary" size="sm">
                  Refresh player data now
                </SubmitButton>
              </ActionForm>
            ) : null}
            {setupOpen ? (
              <>
                <ActionForm
                  action={randomizeDraftOrder}
                  hidden={{ expectedActiveSeasonId: season.id }}
                >
                  <SubmitButton
                    variant="secondary"
                    size="sm"
                    disabled={captainCount < 2}
                  >
                    Randomize order
                  </SubmitButton>
                </ActionForm>
                {/* The confirm's Discord reachability line needs a (memoised)
                    Discord lookup, and this card renders on the blocking path
                    — so the button appears instantly with the base confirm and
                    upgrades when the check resolves. Both renders are the same
                    working control; a down Discord costs the warning line,
                    never the panel (the DiscordSection rule). ACCEPTED
                    trade-off: the reveal swaps component instances, so a click
                    landed inside the fallback window carries the base confirm
                    and can lose its pending spinner/toast when the swap lands
                    (the action itself still commits). The sweep's aggregate
                    deadline bounds that window to seconds; the alternative — a
                    disabled fallback — would block starting the draft on
                    Discord's health, which is the exact failure this Suspense
                    exists to avoid. */}
                <StartDraftConfirmLine line={captainsAwayLine}>
                  <Suspense
                    fallback={
                      <StartDraftForm
                        seasonId={season.id}
                        confirm={startConfirm}
                        disabled={startDisabled}
                      />
                    }
                  >
                    <StartDraftControl
                      seasonId={season.id}
                      confirmBase={startConfirm}
                      disabled={startDisabled}
                    />
                  </Suspense>
                </StartDraftConfirmLine>
              </>
            ) : null}
            {draftLive ? (
              <ActionForm
                action={pauseDraftAction}
                hidden={{ expectedActiveSeasonId: season.id }}
              >
                <SubmitButton variant="secondary" size="sm">
                  Pause auction
                </SubmitButton>
              </ActionForm>
            ) : null}
            {data.draft?.status === "PAUSED" ? (
              <ActionForm
                action={resumeDraftAction}
                hidden={{ expectedActiveSeasonId: season.id }}
              >
                <SubmitButton variant="accent" size="sm">
                  Resume auction
                </SubmitButton>
              </ActionForm>
            ) : null}
            {data.draft?.status === DRAFT_STATUS.PAUSED &&
            data.draft.nominatedUserId ? (
              <ActionForm
                action={voidCurrentLotAction}
                hidden={{ expectedActiveSeasonId: season.id }}
              >
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  confirm={voidLotConfirm({
                    playerName:
                      data.players.find(
                        (p) => p.userId === data.draft?.nominatedUserId,
                      )?.user.name ?? null,
                    nominatorName:
                      data.teams.find(
                        (t) => t.id === data.draft?.nominatorTeamId,
                      )?.name ?? null,
                  })}
                >
                  Void live lot
                </SubmitButton>
              </ActionForm>
            ) : null}
            {/* Draft phase only — after that the newest non-captain roster row
                is a free-agent signing, not an auction sale, and re-opening the
                auction mid-season lets the stalled-nomination resolver
                auto-draft someone onto that team. The action refuses too.
                And only once something has sold: before that there is
                nothing to undo, and the click could only be refused. */}
            {draftStarted &&
            season.status === SEASON_STATUS.DRAFT &&
            lastAuctionSale ? (
              <ActionForm
                action={undoLastSaleAction}
                hidden={{
                  expectedActiveSeasonId: season.id,
                  expectedSaleMembershipId: lastAuctionSale.membershipId,
                }}
              >
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  /* The COMPLETE case is the one the old copy hid. This button
                     renders whenever the draft has started, something has
                     sold and the season is still in DRAFT — which includes a
                     FINISHED auction, i.e.
                     exactly where the panel's own "Draft complete — rosters are
                     locked" banner parks the admin. undoLastSale accepts
                     COMPLETE and writes IN_PROGRESS with a 90s nomination
                     clock, so one click on a card that says the draft is over
                     puts ten captains back into a live auction and
                     resolveStalledNomination will auto-sell the top remaining
                     player on the next poll from any visitor. Say so. The
                     text is shared with the draft room's Undo. */
                  confirm={undoSaleConfirm({
                    draftComplete:
                      data.draft?.status === DRAFT_STATUS.COMPLETE,
                    sale: lastAuctionSale,
                    nominationSeconds: draftClocks(season).nominationSeconds,
                  })}
                >
                  Undo last sale
                </SubmitButton>
              </ActionForm>
            ) : null}
            {/* The way back from a premature "Start draft" — nothing else ever
                returns Draft.status to NOT_STARTED, so without this a season
                started with the wrong captains was capped forever. Shown in
                every phase while no result exists (recovering a season whose
                phase already moved is the point); abortDraft refuses once any
                match is completed or any game is imported. */}
            {draftStarted && !anyResultRecorded ? (
              <ActionForm
                action={abortDraftAction}
                hidden={{ expectedActiveSeasonId: season.id }}
              >
                {/* TYPE-TO-CONFIRM: an auction is three hours of ten to sixteen
                    people's evening, and NOTHING records what was bought for
                    how much once this runs — re-running it produces different
                    rosters at different prices, so the outcome is gone even
                    though the structure is recoverable. It also sits in the
                    same header strip as the routine Pause / Undo last sale
                    controls, which is exactly where a mis-click lands on
                    draft night. */}
                <DangerSubmit
                  token={season.name}
                  title="Abort the draft and return to Signups?"
                  consequences={[
                    boughtCount > 0
                      ? `All ${boughtCount} non-captain roster member(s) go back to the pool and every team is refunded. The discarded roster and prices cannot be restored.`
                      : "The auction is reset to not-started.",
                    "Current captains and teams stay, but any auction price paid for a current captain is cleared and refunded.",
                    "The season drops back to Signups, so players can register again.",
                    "Every unplayed fixture and its check-ins, pick'em picks, standin bookings and reschedule requests are cleared because they were composed against these rosters.",
                    "Fantasy rosters are cleared because their players and salary cap came from this auction.",
                    "Sent week-reminder markers are cleared so a replacement schedule can notify players again.",
                    "You will have to re-run the whole auction with everyone present.",
                  ]}
                  recovery={`The ${data.teams.length} captain(s) and their teams are KEPT, so captain management reopens and you can start again.`}
                >
                  Abort draft
                </DangerSubmit>
              </ActionForm>
            ) : null}
          </div>
        }
      />
      {/* grid-cols-1 is explicit on purpose (see the CLAUDE.md mobile rules):
          without it the implicit track is `auto`, so a long team or player
          name sizes the column past the viewport and widens the whole page.
          Once setup is closed and everyone is drafted, the second column is
          one "no signups" line; beside the captain list it was a large empty
          block, so the card stacks instead. */}
      <CardBody
        className={cn(
          "grid grid-cols-1 gap-6",
          (setupOpen || nonCaptains.length > 0) && "md:grid-cols-2",
        )}
      >
        {/* ONE pre-draft box, the only place the card describes roster fit,
            draft night and confirmations. There used to be three: this list,
            a loose "N undrafted players for N roster seats" line computed a
            different way (it counted already-rostered players), and a
            confirmations box with a wall of every unconfirmed name, plus a
            readiness chip on every row. They could disagree with each other,
            and the pool sentence here is the same one the Start-draft confirm
            prints (seatFitSentence). */}
        {setupOpen ? (
          <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 md:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-fg">Draft preflight</h3>
                <p className="mt-0.5 text-xs text-muted">
                  Captains, the pool and an existing roster can block Start.
                  Everything else here is a warning.
                </p>
              </div>
              <Badge tone={canStart ? "success" : "accent"}>
                {canStart ? "Can start" : "Action needed"}
              </Badge>
            </div>
            <ul className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <li className="rounded-md border border-line/70 px-3 py-2 text-muted">
                <b className="text-fg">Captains:</b> {captainCount} designated
                {captainCount < 2
                  ? ", at least 2 are required"
                  : captainCount < season.minTeams
                    ? `, below the ${season.minTeams}-team target (allowed)`
                    : `, ${season.minTeams}-team target met`}
                {season.budgetMmrWeight > 0 && captainCount >= 2
                  ? `. Budgets are MMR-weighted (±${season.budgetMmrWeight}%), so lower-MMR captains get more to spend.`
                  : null}
              </li>
              <li className="rounded-md border border-line/70 px-3 py-2 text-muted">
                <b className="text-fg">Player pool:</b>{" "}
                {poolCount === 0
                  ? "no undrafted players yet, at least 1 is required"
                  : captainCount < 2
                    ? `${poolCount} draftable so far; the seat fit shows once there are 2 captains`
                    : seatFitSentence(seats, season.teamSize)}
              </li>
              {captainCount >= 2 ? (
                <li
                  className={cn(
                    "rounded-md border border-line/70 px-3 py-2 sm:col-span-2",
                    formatUnfit ? "text-danger" : "text-muted",
                  )}
                >
                  <b className="text-fg">Season format:</b>{" "}
                  {formatUnfit
                    ? `the saved layout (${knobsLabel(formatUnfit.knobs).toLowerCase()}) can't be generated with ${captainCount} teams: ${formatUnfit.error}`
                    : `${teamCountSeasonNote(season, captainCount, formatFits)} One captain is one team; ${
                        storedFormat.kind === "CUSTOM"
                          ? "the layout is the one saved in the season builder."
                          : "Recommended follows that count."
                      }`}{" "}
                  <a href={formatBuilderAnchor(season, data)} className={textLink()}>
                    Change it in Season format
                  </a>
                  .
                </li>
              ) : null}
              <li className="rounded-md border border-line/70 px-3 py-2 text-muted sm:col-span-2">
                <ActionForm
                  action={setDraftNight}
                  hidden={{ expectedActiveSeasonId: season.id }}
                  className="flex flex-wrap items-end gap-2"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <label htmlFor="draftAt" className="text-xs text-muted">
                      <b className="text-fg">Draft night</b> (optional):
                      shown with countdowns on the dashboard, /me and the draft
                      room, and announced to Discord
                    </label>
                    <LocalDatetimeField
                      id="draftAt"
                      name="draftAt"
                      tsName="draftAtTs"
                      defaultTs={season.draftAt?.getTime()}
                      timeZone={LEAGUE_CONFIG.timeZone}
                      className="h-8 rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg"
                    />
                  </div>
                  <SubmitButton variant="secondary" size="sm">
                    {season.draftAt ? "Update draft night" : "Set draft night"}
                  </SubmitButton>
                  {/* League time, like the box beside it: the admin's own
                      clock is what hid a mis-entered night before. */}
                  {season.draftAt ? (
                    <span className="text-xs text-muted">
                      Currently {formatLeagueTime(season.draftAt)}
                    </span>
                  ) : null}
                </ActionForm>
              </li>
              <li className="rounded-md border border-line/70 px-3 py-2 text-muted sm:col-span-2">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-fg">Confirmations:</b>
                  {season.draftAt ? (
                    <>
                      <Badge
                        tone={
                          confirmationCounts.ready === confirmationCounts.total &&
                          confirmationCounts.total > 0
                            ? "success"
                            : "accent"
                        }
                      >
                        {confirmationCounts.ready}/{confirmationCounts.total} ready
                      </Badge>
                      <span>
                        {confirmationCounts.awaiting} awaiting
                        {confirmationCounts.stale
                          ? `, ${confirmationCounts.stale} must reconfirm`
                          : ""}
                        . A warning only; the draft can start without them.
                      </span>
                    </>
                  ) : (
                    <span>none yet. Players are asked to confirm once a draft night is set.</span>
                  )}
                </div>
                {season.draftAt && confirmationCounts.total > 0 ? (
                  <details id="adm-draft-confirmations" className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                      Show who
                    </summary>
                    <div className="mt-1.5 space-y-1">
                      {(
                        [
                          ["Ready", readyConfirmation, "text-success"],
                          ["Waiting on", awaitingConfirmation, "text-fg"],
                          ["Must reconfirm", staleConfirmation, "text-accent"],
                        ] as const
                      ).map(([label, regs, tone]) =>
                        regs.length > 0 ? (
                          <div key={label} className="min-w-0 break-words">
                            <span className={cn("font-medium", tone)}>
                              {label} ({regs.length}):
                            </span>{" "}
                            <ul aria-label={label} className="inline">
                              {regs.map((p, i) => (
                                <li key={p.id} className="inline">
                                  {p.user.name}
                                  {i < regs.length - 1 ? ", " : ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null,
                      )}
                    </div>
                  </details>
                ) : null}
              </li>
              <li className="rounded-md border border-line/70 px-3 py-2 text-muted sm:col-span-2">
                <b className="text-fg">Existing roster:</b>{" "}
                {rosterAlreadyBuilt
                  ? `${boughtCount} non-captain member${boughtCount === 1 ? " is" : "s are"} already assigned, so Start is blocked to protect later-season roster data`
                  : "captain-only teams, ready for a fresh auction"}
              </li>
              {/* Beside draft night on purpose: that is when week 1 gets its
                  date, and the ticket has to be applied for ~15 days before. */}
              {!season.dotaLeagueId ? (
                <li className="rounded-md border border-danger/40 px-3 py-2 text-muted sm:col-span-2">
                  <b className="text-fg">League ticket:</b> not set. Valve
                  needs about 15 days to issue one; without it, league games
                  may not reach OpenDota.{" "}
                  <a href="#adm-league" className={textLink()}>
                    Set the league id →
                  </a>
                </li>
              ) : null}
            </ul>
            {!canStart && startBlocker ? (
              <p className="mt-2 text-xs font-medium text-accent">
                Start unavailable: {startBlocker}
              </p>
            ) : null}
          </div>
        ) : null}
        <div>
          <h3 className="mb-2 text-sm font-medium text-muted">
            Captains ({data.teams.length})
          </h3>
          <div className="space-y-2">
            {data.teams.length === 0 ? (
              <p className="text-sm text-muted">
                {setupOpen
                  ? "No captains yet. Use “make captain” beside an eligible player; each designation creates their team."
                  : "No captain teams were recorded for this season."}
              </p>
            ) : (
              (() => {
                // Preview the MMR-weighted budgets captains will start with.
                const mmrByUser = new Map(
                  data.players.map((p) => [p.userId, p.mmr]),
                );
                const projected = mmrWeightedBudgets(
                  season.draftBudget,
                  season.budgetMmrWeight,
                  data.teams.map((t) => ({
                    teamId: t.id,
                    // `|| null`: stored 0 = unknown MMR → base budget (must
                    // match startDraft's mapping or projections lie).
                    mmr: mmrByUser.get(t.captainId) || null,
                  })),
                  season.teamSize - 1,
                );
                return data.teams.map((t) => (
                  <div
                    key={t.id}
                    className="rounded-lg border border-line px-3 py-2 text-sm"
                  >
                    {/* Wraps on a phone: the budget + remove drop to their
                        own line once the name's basis-48 can't fit beside
                        them, and the name itself wraps rather than truncates,
                        because the order number and crest take ~60px of that
                        basis (a long name read "The Couriers of Catastrophe
                        Wi…" at 390px). The captain is named in words under
                        the team: a Steam-less captain's avatar is only
                        initials, which named the link "RR" to a screen
                        reader and nobody at all to a sighted admin. */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                        <span className="w-5 shrink-0 text-center text-xs text-muted">
                          {t.draftOrder + 1}
                        </span>
                        <TeamCrest
                          name={t.name}
                          seed={t.id}
                          logoUrl={t.logoUrl}
                          size={28}
                        />
                        <span className="min-w-12 [overflow-wrap:anywhere]">
                          <Link
                            href={`/teams/${t.id}`}
                            className="hover:text-info hover:underline"
                          >
                            {t.name}
                          </Link>
                          <span className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                            <span aria-hidden className="shrink-0">
                              <Avatar
                                name={t.captain.name}
                                src={t.captain.avatar}
                                size={20}
                              />
                            </span>
                            <span className="min-w-0">
                              Captain{" "}
                              <PlayerLink userId={t.captainId}>
                                {t.captain.name}
                              </PlayerLink>
                            </span>
                          </span>
                        </span>
                      </span>
                      <span className="ml-auto flex shrink-0 items-center gap-2">
                        <Badge tone="accent" className="shrink-0">
                          $
                          {setupOpen
                            ? (projected.get(t.id) ?? t.budget)
                            : t.budget}
                          {setupOpen ? " projected" : null}
                        </Badge>
                        {setupOpen ? (
                          <ActionForm
                            action={removeCaptain}
                            hidden={{
                              teamId: t.id,
                              expectedActiveSeasonId: season.id,
                            }}
                          >
                            {/* Once any fixture exists this deletes the team AND
                                every match in the SEASON — taking all check-ins,
                                pick'em picks, standin bookings and open proposals
                                with it by cascade. It is the twin of Regenerate
                                schedule and needs the same barrier; it was a bare
                                `remove` link 12px from "✎ Rename team". With no
                                schedule only the team goes, which a plain confirm
                                covers (and Change captain keeps the team). */}
                            {regularCount === 0 ? (
                              <SubmitButton
                                variant="ghost"
                                size="sm"
                                className="shrink-0 text-danger-soft hover:underline"
                                confirm={`Remove ${t.captain.name} as captain and delete ${t.name}? Its name and logo go with it. To keep the team and hand it to someone else, use Change captain instead.`}
                              >
                                remove
                              </SubmitButton>
                            ) : (
                            <DangerSubmit
                              token={t.name}
                              className="shrink-0"
                              title={`Remove ${t.captain.name} as captain and delete ${t.name}?`}
                              consequences={[
                                `${t.name} and its ${t.members.length} roster place(s) are deleted.`,
                                `All ${regularCount} fixture(s) in the season are cleared — not just this team's — because the round robin no longer fits.`,
                                ...(collateral.rsvps
                                  ? [
                                      `${collateral.rsvps} check-in(s) go with them.`,
                                    ]
                                  : []),
                                ...(collateral.picks
                                  ? [
                                      `${collateral.picks} pick'em pick(s) go with them.`,
                                    ]
                                  : []),
                                ...(collateral.covers
                                  ? [
                                      `${collateral.covers} standin booking(s) go with them.`,
                                    ]
                                  : []),
                              ]}
                              recovery="Regenerate the schedule once the captains are final. The check-ins, picks and bookings cannot be restored."
                            >
                              remove
                            </DangerSubmit>
                            )}
                          </ActionForm>
                        ) : null}
                      </span>
                    </div>
                    {unverifiedMmrByTeam.has(t.id) ? (
                      /* Its own line, not beside the budget badge: that row
                         is already at its phone-width limit, and the reason
                         has to be readable without a hover. */
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                        <Badge tone="accent" className="shrink-0">
                          unverified MMR
                        </Badge>
                        <span className="min-w-0">
                          {unverifiedMmrByTeam.get(t.id)!.reason}
                        </span>
                      </p>
                    ) : null}
                    {/* The row's disclosures share one line, and the one
                        opened takes the full width under it: stacked, their
                        summaries took up to four lines a team. */}
                    <div className="mt-1.5 flex flex-wrap items-start gap-x-4 gap-y-1.5 empty:hidden [&>details]:mt-0 [&>details[open]]:basis-full">
                    {season.status !== SEASON_STATUS.COMPLETE ? (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                          ✎ Edit team
                        </summary>
                        <div className="mt-1.5">
                          <TeamIdentityForm
                            key={`${t.name}|${t.logoUrl ?? ""}`}
                            action={renameTeam}
                            teamId={t.id}
                            name={t.name}
                            logoUrl={t.logoUrl}
                            hidden={{ expectedActiveSeasonId: season.id }}
                            note="Captains can also change this themselves on their team page."
                          />
                        </div>
                      </details>
                    ) : null}
                    {/* Before the draft a team is its captain alone, so handing it
                        to another signup keeps the team row: name, logo and
                        draft-order slot. The outgoing captain goes back to the
                        pool. Nothing is deleted, so a plain confirm. */}
                    {setupOpen && nonCaptains.length > 0 ? (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                          ⇄ Change captain
                        </summary>
                        <ActionForm
                          action={changeCaptain}
                          className="mt-1.5 flex flex-wrap items-center gap-2"
                          hidden={{
                            teamId: t.id,
                            expectedActiveSeasonId: season.id,
                            expectedCaptainUserId: t.captainId,
                          }}
                        >
                          <select
                            name="newCaptainUserId"
                            required
                            defaultValue=""
                            aria-label={`New captain for ${t.name}`}
                            className={selectCls}
                          >
                            <option value="" disabled>
                              New captain…
                            </option>
                            {nonCaptains.map((p) => (
                              <option key={p.userId} value={p.userId}>
                                {p.user.name}
                              </option>
                            ))}
                          </select>
                          <SubmitButton
                            variant="secondary"
                            size="sm"
                            confirm={`Hand ${t.name} to the selected player? ${t.captain.name} goes back to the player pool. The team keeps its logo and draft-order slot${isGeneratedTeamNameFor(t.name, t.captain.name) ? ", and its name follows the new captain" : ", and its name"}.`}
                          >
                            Change captain
                          </SubmitButton>
                        </ActionForm>
                        <p className="mt-1 text-xs text-muted">
                          Keeps the team, unlike remove. {t.captain.name} stays
                          signed up and can be drafted.
                        </p>
                      </details>
                    ) : null}
                    {season.status !== SEASON_STATUS.COMPLETE && captainReg.get(t.captainId) ? (
                      <AdminPlayerRankEditor
                        key={`${captainReg.get(t.captainId)!.id}:${captainReg.get(t.captainId)!.mmr}:${t.captain.rankTier}:${t.captain.rankTierManual}`}
                        registrationId={captainReg.get(t.captainId)!.id}
                        name={t.captain.name}
                        mmr={captainReg.get(t.captainId)!.mmr}
                        rankTier={t.captain.rankTier}
                        rankTierManual={t.captain.rankTierManual}
                        mmrLocked={data.draft?.status === DRAFT_STATUS.IN_PROGRESS || data.draft?.status === DRAFT_STATUS.PAUSED}
                      />
                    ) : null}
                    {/* Post-draft only: before the auction runs, removeCaptain
                        (which deletes the empty team) is the right tool. After
                        it, this is the ONLY way to move captaincy off an
                        inactive player — and it's what makes them releasable,
                        since releasePlayer refuses captains. */}
                    {transferOpen &&
                    !setupOpen &&
                    t.members.some((m) => m.userId !== t.captainId) ? (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                          ⇄ Hand over captaincy
                        </summary>
                        <ActionForm
                          action={transferCaptaincy}
                          className="mt-1.5 flex flex-wrap items-center gap-2"
                          hidden={{
                            teamId: t.id,
                            expectedActiveSeasonId: season.id,
                            expectedCaptainUserId: t.captainId,
                          }}
                        >
                          <select
                            name="newCaptainUserId"
                            required
                            defaultValue=""
                            aria-label={`New captain for ${t.name}`}
                            className={selectCls}
                          >
                            <option value="" disabled>
                              New captain…
                            </option>
                            {t.members
                              .filter((m) => m.userId !== t.captainId)
                              .map((m) => (
                                <option key={m.userId} value={m.userId}>
                                  {m.user.name}
                                </option>
                              ))}
                          </select>
                          <SubmitButton
                            variant="secondary"
                            size="sm"
                            confirm={`Hand ${t.name} to a new captain? ${t.captain.name} stays on the roster as a normal player (you can release them afterwards).`}
                          >
                            Make captain
                          </SubmitButton>
                        </ActionForm>
                        <p className="mt-1 text-xs text-muted">
                          For a captain who&apos;s gone inactive — the team
                          keeps its own reschedule, standin and result-reporting
                          controls.
                        </p>
                      </details>
                    ) : null}
                    </div>
                    {t.withdrawn ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <Badge>withdrew</Badge>
                        {teamWithdrawalLocked ? (
                          <span className="text-xs text-muted">
                            Reinstatement locked: {teamWithdrawalLocked}
                          </span>
                        ) : (
                          <ActionForm
                            action={reinstateTeam}
                            hidden={{
                              teamId: t.id,
                              expectedActiveSeasonId: season.id,
                            }}
                          >
                            <SubmitButton
                              variant="ghost"
                              size="sm"
                              confirm={`Reinstate ${t.name}? They rejoin playoff-seeding contention. Forfeited fixtures stay as recorded — reverse any you want undone with "Reopen for import" on each row, then rebook any standin cover (the withdrawal cancelled it).`}
                            >
                              reinstate
                            </SubmitButton>
                          </ActionForm>
                        )}
                      </div>
                    ) : null}
                  </div>
                ));
              })()
            )}
          </div>
          {/* Team dropout — the most common amateur-league disaster, which used
              to be a weekly hand-typed-forfeit grind. ONE control with a team
              picker, deliberately: a DangerSubmit per team would put N client
              dialogs on the app's heaviest page (the release form beside it
              uses the same idiom). Mid-season only — pre-season the tool is
              removeCaptain, and a playoff slot needs an explicit per-match
              ruling, which the action's errors say. */}
          {!teamWithdrawalLocked && data.teams.some((t) => !t.withdrawn) ? (
            <details className="mt-3 rounded-lg border border-line px-3 py-2">
              <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                🏳️ A team has quit the season
              </summary>
              <ActionForm
                action={withdrawTeam}
                hidden={{ expectedActiveSeasonId: season.id }}
                className="mt-2 flex flex-wrap items-center gap-2"
              >
                <select
                  name="teamId"
                  required
                  defaultValue=""
                  aria-label="Team withdrawing from the season"
                  className={selectCls}
                >
                  <option value="" disabled>
                    Team…
                  </option>
                  {/* The confirm's consequences are static strings on a
                      one-picker form, so the per-team REAL numbers (confirms
                      must name real numbers) ride in the option label:
                      standin bookings on the fixtures this withdrawal would
                      forfeit — either side's, since the opponent's cover dies
                      with the fixture too — and those fixtures already past
                      kickoff, which may have been played and only be waiting
                      on their import (withdrawalKickedOffFixtures). */}
                  {(() => {
                    const openRegular = data.matches.filter(
                      (m) => m.phase === "REGULAR" && m.status !== "COMPLETED",
                    );
                    const bookingsFor = (teamId: string) => {
                      const ids = new Set(
                        openRegular
                          .filter(
                            (m) =>
                              m.homeTeamId === teamId ||
                              m.awayTeamId === teamId,
                          )
                          .map((m) => m.id),
                      );
                      return data.assignments.filter((a) => ids.has(a.matchId))
                        .length;
                    };
                    return data.teams
                      .filter((t) => !t.withdrawn)
                      .map((t) => {
                        const n = bookingsFor(t.id);
                        const kickedOff = withdrawalKickedOffFixtures(
                          data.matches,
                          t.id,
                          nowMs,
                        ).length;
                        const notes = [
                          n > 0
                            ? `${n} standin booking(s) on their open fixtures`
                            : null,
                          kickedOff > 0
                            ? `${kickedOff} series past kickoff with no result`
                            : null,
                        ].filter(Boolean);
                        return (
                          <option key={t.id} value={t.id}>
                            {t.name}
                            {notes.length > 0 ? ` — ${notes.join(" · ")}` : ""}
                          </option>
                        );
                      });
                  })()}
                </select>
                <DangerSubmit
                  token={season.name}
                  title="Withdraw this team from the season?"
                  consequences={[
                    "Every unplayed regular fixture of the selected team is forfeited 0-N to the opponent; that official score counts in the game-diff tiebreak.",
                    "A series past its kickoff with no result on the site is forfeited too, even if it was played and its games just haven't imported yet: a final match takes no more games. The team picker counts these per team; wait for those results before withdrawing.",
                    "Open reschedule proposals on those fixtures are cancelled.",
                    "Standins booked on those fixtures — either side's — are stood down with an @-mention.",
                    "The team is excluded from playoff seeding — its played results and roster are kept.",
                  ]}
                  recovery={`"Reinstate" (beside the team above) undoes the exclusion, and each forfeited fixture without games is individually reversible with "Reopen for import". Standin bookings on those fixtures are cancelled, so rebook cover after reopening one.`}
                >
                  Withdraw team
                </DangerSubmit>
              </ActionForm>
            </details>
          ) : teamWithdrawalLocked && data.teams.some((t) => !t.withdrawn) ? (
            <p className="mt-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-xs text-muted">
              Team withdrawal locked: {teamWithdrawalLocked}
            </p>
          ) : null}
          {draftLive ? (
            <Link
              href="/draft"
              className={buttonClasses("accent", "sm", "mt-3")}
            >
              Go to draft room →
            </Link>
          ) : data.draft?.status === "COMPLETE" ? (
            <p className="mt-3 text-xs text-muted">
              ✅ Draft complete — rosters are locked. See{" "}
              <Link href="/teams" className={textLink()}>
                the teams
              </Link>
              ; top up short rosters with the free-agent tools below.
            </p>
          ) : null}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium text-muted">
            {setupOpen ? "Eligible players" : "Active player signups"}
          </h3>
          {/* One scroll surface on a phone: the page. The list only gets its
              own scroller from md up, where it sits beside the captains.
              Each row wraps like the captain rows: the name keeps a real
              width and the actions drop below it on a phone, and the
              "wants C" / "private data" badges ride in the chip line, where
              they used to overlap "make captain". */}
          {nonCaptains.length === 0 ? (
            <p className="text-sm text-muted">
              {setupOpen
                ? "No other active full-player signups. At least one undrafted player is required to start."
                : "No other active full-player signups."}
            </p>
          ) : (
            // "Needs review" narrows this to the signups worth a look before
            // the draft. The soft MMR limit is a review threshold, not a
            // block, and this is the review tool it points at.
            <AdminSignupReview
              label={setupOpen ? "Eligible players" : "Active player signups"}
              listClassName="space-y-1.5 md:max-h-[32rem] md:overflow-y-auto md:pr-1 md:has-[details[open]]:max-h-[70vh]"
              rowClassName="rounded-lg border border-line px-3 py-1.5 text-sm"
              rows={nonCaptains.map((p) => ({
                key: p.id,
                needsReview: signupNeedsReview(
                  regSignupFlags(p, season.maxMmr),
                  !!p.user.discordId,
                ),
                node: (
                  <>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                        <Avatar
                          name={p.user.name}
                          src={p.user.avatar}
                          size={22}
                        />
                        <PlayerLink
                          userId={p.userId}
                          className="min-w-12 truncate"
                        >
                          {p.user.name}
                        </PlayerLink>
                        {/* Medal beside the claimed number: the pair is what
                            makes an inflated claim scannable, and the flag
                            below states the window when they disagree. */}
                        <RankMedal
                          rankTier={p.user.rankTier}
                          size={18}
                          className="shrink-0"
                        />
                        <span className="shrink-0 text-xs text-muted">
                          {p.mmr}
                        </span>
                      </span>
                      <span className="ml-auto flex shrink-0 items-center gap-3">
                        {setupOpen ? (
                          <ActionForm
                            action={addCaptain}
                            hidden={{
                              userId: p.userId,
                              expectedActiveSeasonId: season.id,
                            }}
                          >
                            {/* Confirmed because an undo can be expensive:
                                removing a captain again deletes the team and,
                                once fixtures exist, the season's whole
                                schedule. Change captain is the cheap way back.
                                Also a real SubmitButton, so it has a pending
                                state and can't be double-submitted. */}
                            <SubmitButton
                              variant="ghost"
                              size="sm"
                              className="text-xs text-accent hover:underline"
                              confirm={`Make ${p.user.name} a captain? They get their own team. Change captain can hand that team to someone else later; removing the team also clears the schedule once one exists.`}
                            >
                              make captain
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                        {/* NOT phase-gated. This used to render only during
                            SIGNUPS and was the action's only control anywhere, so
                            from the moment the draft started an admin could not
                            remove a signup at all — while the action itself has no
                            phase gate and carries an explicit "player is on the
                            block" guard, i.e. it was written to be used mid-draft.
                            A player who ghosts after signing up stayed in the
                            auction pool (where the stall resolver can sell them),
                            and afterwards in the free-agent and standin dropdowns
                            for the rest of the season. `withdrawGateError` is the
                            real gate — it refuses a captain, a rostered player, a
                            standin who still owes cover, and a non-ACTIVE row.
                            Rows it can only refuse (removalBlockers) show why
                            instead of a button that can only error. */}
                        {season.status !== SEASON_STATUS.COMPLETE ? (
                          removalBlockers.has(p.userId) ? (
                            <RemovalBlockedNote blocker={removalBlockers.get(p.userId)!} />
                          ) : (
                            <ActionForm
                              action={withdrawSignup}
                              hidden={{ registrationId: p.id }}
                            >
                              <SubmitButton
                                variant="ghost"
                                size="sm"
                                className="text-danger-soft hover:underline"
                                confirm={
                                  season.status === "SIGNUPS"
                                    ? `Remove ${p.user.name}'s signup? They leave the player pool and can't re-add themselves — you can reinstate them below.`
                                    : `Remove ${p.user.name}'s signup? They leave the draft pool and the free-agent and standin lists — you can reinstate them below.`
                                }
                              >
                                remove
                              </SubmitButton>
                            </ActionForm>
                          )
                        ) : null}
                      </span>
                    </div>
                    {/* The chips and the medal editor's summary share a
                        line (the editor, opened, takes the full width): a
                        line each made every row about 24px taller. */}
                    <div className={ROW_META_LINE}>
                    <SignupRowMeta
                      reg={p}
                      sweep={membershipSweep}
                      maxMmr={season.maxMmr}
                      leading={
                        <>
                          {p.wantsCaptain ? (
                            <Badge tone="accent">wants C</Badge>
                          ) : null}
                          {p.user.fhUnavailable === true ? (
                            <Badge
                              tone="danger"
                              title="OpenDota reports their match data as private — automatic result import can't see this player's games"
                            >
                              private data
                            </Badge>
                          ) : null}
                        </>
                      }
                    />
                    {season.status !== SEASON_STATUS.COMPLETE ? (
                      <AdminPlayerRankEditor
                        key={`${p.id}:${p.mmr}:${p.user.rankTier}:${p.user.rankTierManual}`}
                        registrationId={p.id}
                        name={p.user.name}
                        mmr={p.mmr}
                        rankTier={p.user.rankTier}
                        rankTierManual={p.user.rankTierManual}
                        mmrLocked={data.draft?.status === DRAFT_STATUS.IN_PROGRESS || data.draft?.status === DRAFT_STATUS.PAUSED}
                      />
                    ) : null}
                    </div>
                  </>
                ),
              }))}
            />
          )}
          {/* Registered STANDINs get the same moderation as players. Standin
              signups stay open through PLAYOFFS, and
              until this list existed the remove/MMR controls rendered only
              over type=PLAYER rows — so a troll or duplicate standin signup
              sat in every standin dropdown, the reach funnel and the reminder
              machinery all season with no button anywhere to touch it. The
              actions never had a type gate; this was a missing render.
              (Undrafted PLAYERs in data.standins are covered by the eligible
              list above — standinRegs, hoisted above for the membership
              sweep, is filtered to real STANDIN registrations.) */}
          {(() => {
            if (standinRegs.length === 0) return null;
            return (
              <div className="mt-4 border-t border-line/60 pt-3">
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                  Registered standins ({standinRegs.length})
                </h4>
                <ul
                  aria-label="Registered standins"
                  className="space-y-1.5 md:max-h-80 md:overflow-y-auto md:pr-1"
                >
                  {standinRegs.map((s) => (
                    <li
                      key={s.id}
                      className="rounded-lg border border-line px-3 py-1.5 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                          <Avatar
                            name={s.user.name}
                            src={s.user.avatar}
                            size={22}
                          />
                          <PlayerLink
                            userId={s.userId}
                            className="min-w-12 truncate"
                          >
                            {s.user.name}
                          </PlayerLink>
                          <RankMedal
                            rankTier={s.user.rankTier}
                            size={18}
                            className="shrink-0"
                          />
                          <span className="shrink-0 text-xs text-muted">
                            {s.mmr}
                          </span>
                        </span>
                        {season.status !== SEASON_STATUS.COMPLETE ? (
                          removalBlockers.has(s.userId) ? (
                            <span className="ml-auto shrink-0">
                              <RemovalBlockedNote blocker={removalBlockers.get(s.userId)!} />
                            </span>
                          ) : (
                            <ActionForm
                              action={withdrawSignup}
                              hidden={{ registrationId: s.id }}
                              className="ml-auto shrink-0"
                            >
                              <SubmitButton
                                variant="ghost"
                                size="sm"
                                className="text-danger-soft hover:underline"
                                confirm={`Remove ${s.user.name}'s standin signup? They leave the standin lists and can't re-add themselves — you can reinstate them below.`}
                              >
                                remove
                              </SubmitButton>
                            </ActionForm>
                          )
                        ) : null}
                      </div>
                      <div className={ROW_META_LINE}>
                      <SignupRowMeta
                        reg={s}
                        sweep={membershipSweep}
                        maxMmr={season.maxMmr}
                      />
                      {season.status !== SEASON_STATUS.COMPLETE ? (
                        <AdminPlayerRankEditor
                          key={`${s.id}:${s.mmr}:${s.user.rankTier}:${s.user.rankTierManual}`}
                          registrationId={s.id}
                          name={s.user.name}
                          mmr={s.mmr}
                          rankTier={s.user.rankTier}
                          rankTierManual={s.user.rankTierManual}
                        />
                      ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
          {/* Removal is sticky (the player can't re-add themselves from /me),
              so it has to be undoable from here. */}
          {data.removed.length > 0 ? (
            <div className="mt-4 border-t border-line/60 pt-3">
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                Removed signups ({data.removed.length})
              </h4>
              <div className="space-y-1.5">
                {data.removed.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5 text-sm"
                  >
                    <span className="min-w-0 truncate text-muted">
                      {r.user.name}
                    </span>
                    {season.status === SEASON_STATUS.COMPLETE ? null : r.type ===
                        REGISTRATION_TYPE.PLAYER &&
                      (data.draft?.status === DRAFT_STATUS.IN_PROGRESS ||
                        data.draft?.status === DRAFT_STATUS.PAUSED) ? (
                      // reinstateSignup refuses a player signup while the
                      // auction runs (they'd rejoin a pool mid-lot), so say
                      // when it opens instead of offering a button that fails.
                      <span className="shrink-0 text-xs text-muted">
                        reinstate after the auction
                      </span>
                    ) : (
                      <ActionForm
                        action={reinstateSignup}
                        hidden={{ registrationId: r.id }}
                      >
                        <SubmitButton variant="ghost" size="sm">
                          reinstate
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}
