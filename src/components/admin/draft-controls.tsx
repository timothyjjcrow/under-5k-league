import { adminHref } from "@/lib/admin-tabs";
import { Suspense } from "react";
import Link from "@/components/app-link";
import { DRAFT_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  refreshPlayerData,
  randomizeDraftOrder,
  setDraftNight,
  undoLastSaleAction,
  abortDraftAction,
  pauseDraftAction,
  resumeDraftAction,
  voidCurrentLotAction,
} from "@/app/actions/admin-captains-draft";
import { formatLeagueTime } from "@/lib/zoned-time";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { formatProblems, knobsLabel } from "@/lib/season-builder";
import { parseFormatConfig, teamCountSeasonNote } from "@/lib/season-format";
import { DangerSubmit } from "@/components/danger-submit";
import { cn } from "@/lib/utils";
import {
  DRAFT_READINESS,
  draftReadiness,
  draftReadinessCounts,
} from "@/lib/draft-readiness";
import { draftClocks } from "@/lib/draft";
import {
  profileSyncAllowed,
  undoSaleConfirm,
  undoSaleTarget,
  voidLotConfirm,
  type UndoTarget,
} from "@/lib/draft-admin";
import { captainMmrWarning, unverifiedCaptainMmrsFor } from "@/lib/captain-mmr";
import {
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
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { AdminAnchor, AdminSection } from "@/components/admin/admin-section";
import type { AdminData, Season } from "@/components/admin/season-admin-data";
import { formatBuilderAnchor } from "@/components/admin/season-admin-rules";

/**
 * The auction, on the Season tab: what it can do now first (on draft night
 * the room and the live controls, before it Start and the preflight), then
 * the way back (Abort, folded, until a result exists). Captains are made in
 * Signups and their teams kept in Teams, both on People. Once the season
 * has moved past the draft the card folds to what it sold.
 */
export function DraftControls({
  season,
  data,
}: {
  season: Season;
  data: AdminData;
}) {
  // Two tiers, matching the server guards: once the draft has RUN (live,
  // paused, or complete) captain management and Start draft are locked —
  // startDraft rejects re-runs server-side too. The draft-room link only
  // makes sense while the auction is actually live.
  const draftStarted = !!data.draft && data.draft.status !== "NOT_STARTED";
  const draftLive = data.draft?.status === "IN_PROGRESS";
  const setupOpen = draftSetupOpen(season.status, data.draft?.status);
  const draftPaused = data.draft?.status === DRAFT_STATUS.PAUSED;
  const draftComplete = data.draft?.status === DRAFT_STATUS.COMPLETE;
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
  const unverifiedMmr = unverifiedCaptainMmrsFor(season, data);
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

  // Once the season has moved past the draft, the auction is a record: the
  // card folds to what it sold and keeps the late tools (refresh, Abort
  // until a result).
  const finished =
    !setupOpen && !draftLive && !draftPaused && season.status !== SEASON_STATUS.DRAFT;
  const status = draftLive
    ? { tone: "accent" as const, label: "Live" }
    : draftPaused
      ? { tone: "danger" as const, label: "Paused" }
      : draftComplete
        ? { tone: "success" as const, label: "Done" }
        : setupOpen
          ? canStart
            ? { tone: "success" as const, label: "Can start" }
            : { tone: "accent" as const, label: "Not ready" }
          : { tone: "neutral" as const, label: "Not run" };
  const subtitle = draftLive
    ? "The auction is live. Pause parks both clocks if a dispute needs settling."
    : draftPaused
      ? "The auction is paused: nothing can sell until Resume."
      : draftComplete
        ? `The auction is finished: ${boughtCount} player${boughtCount === 1 ? "" : "s"} bought.`
        : setupOpen
          ? "Make captains in Signups on People, check the preflight, then start the auction."
          : draftSetupLockedMessage(season.status, data.draft?.status);

  // What the auction can do now. On draft night that is the room and the
  // live controls, so they lead; before it, Start and its two helpers.
  const actions = (
    <div className="flex flex-wrap items-center gap-2 empty:hidden">
      {draftLive || draftPaused ? (
        <Link href="/draft" className={buttonClasses("accent", "sm")}>
          Go to draft room →
        </Link>
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
    </div>
  );
  // The way back, folded: its type-to-confirm dialog sits one more tap away
  // from the routine Pause and Undo it used to share a strip with.
  const abort =
    draftStarted && !anyResultRecorded ? (
      <details className="group rounded-lg border border-danger/30 px-3 py-1 text-sm">
        <summary className="flex min-h-11 cursor-pointer list-none items-center font-medium text-danger-soft [&::-webkit-details-marker]:hidden">
          Abort the draft
          <span
            aria-hidden
            className="ml-auto text-muted transition-transform group-open:rotate-180"
          >
            ▾
          </span>
        </summary>
        <div className="space-y-2 pb-3">
          <p className="text-xs text-muted">
            Returns the season to Signups and refunds every sale; the captains
            and their teams stay. Offered until the first result is recorded.
          </p>
          {/* The way back from a premature "Start draft" — nothing else ever
              returns Draft.status to NOT_STARTED, so without this a season
              started with the wrong captains was capped forever. Shown in
              every phase while no result exists (recovering a season whose
              phase already moved is the point); abortDraft refuses once any
              match is completed or any game is imported. */}
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
        </div>
      </details>
    ) : null;

  if (finished) {
    return (
      <AdminSection
        id="adm-draft"
        title="Draft"
        headingLevel={2}
        subtitle={subtitle}
      >
        <CardBody className="space-y-3">
          {actions}
          {abort}
          <p className="text-xs text-muted">
            Rosters are locked. See{" "}
            <Link href="/teams" className={textLink()}>
              the teams
            </Link>
            ; top up a short roster with Roster moves on People.
          </p>
        </CardBody>
      </AdminSection>
    );
  }

  return (
    <AdminAnchor id="adm-draft">
      <Card>
        <CardHeader
          headingLevel={2}
          title="Draft"
          subtitle={subtitle}
          action={<Badge tone={status.tone}>{status.label}</Badge>}
        />
        <CardBody className="space-y-4">
          {actions}
        {/* ONE pre-draft box, the only place the card describes roster fit,
            draft night and confirmations. There used to be three: this list,
            a loose "N undrafted players for N roster seats" line computed a
            different way (it counted already-rostered players), and a
            confirmations box with a wall of every unconfirmed name, plus a
            readiness chip on every row. They could disagree with each other,
            and the pool sentence here is the same one the Start-draft confirm
            prints (seatFitSentence). */}
        {setupOpen ? (
          <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3">
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
                {season.budgetMmrWeight > 0 && captainCount >= 2 ? " " : ". "}
                <a href={adminHref("adm-signups")} className={textLink()}>
                  Make captains in Signups
                </a>
                .
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
                  <a href={adminHref(formatBuilderAnchor(season, data))} className={textLink()}>
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
          {draftComplete ? (
            <p className="text-xs text-muted">
              ✅ Draft complete — rosters are locked. See{" "}
              <Link href="/teams" className={textLink()}>
                the teams
              </Link>
              ; top up short rosters with Roster moves on People.
            </p>
          ) : null}
          {abort}
        </CardBody>
      </Card>
    </AdminAnchor>
  );
}
