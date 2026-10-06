import { listPage } from "@/lib/list-page";
import { webAnalyticsUrl } from "@/lib/web-analytics";
import {
  adminSeasonCards,
  coverProblemMatchIds,
  openBookingCount,
} from "@/lib/admin-sections";
import {
  adminAttention,
  attentionTitle,
  matchAttention,
  outStandins,
  shortTeams,
  rosterPingsLive,
  standinClashes,
  unlinkedRoster,
} from "@/lib/admin-attention";
import { cache, Suspense } from "react";
import { SectionNav, SectionReady } from "@/components/section-nav";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { completedSeasonArchiveReadiness, getActiveSeason } from "@/lib/season";
import { capacityInfo } from "@/lib/capacity";
import { prisma } from "@/lib/prisma";
import { parseRescheduleOptions } from "@/lib/reschedule-ready-check";
import {
  AUTO_SYNC,
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_PHASE_ORDER,
  SEASON_STATUS,
  type SeasonStatus,
} from "@/lib/constants";
import {
  AUTO_CHECK_BACKED_OFF_SCANS,
  autoCheckStatus,
} from "@/lib/result-sync";
import { ImportProgress } from "@/components/import-progress";
import { DatabaseHealth } from "@/components/database-health";
import { HistoryCoverage } from "@/components/history-coverage";
import { ADMIN_PHASE_LABEL as PHASE_LABEL } from "@/lib/season-copy";
import {
  carriedSeasonSettings,
  carriedSettingsLine,
  nextSeasonName,
  type CarriedSeasonSettings,
} from "@/lib/season-handoff";
import {
  createSeason,
  archiveCompletedSeasonAction,
  archiveIncompleteSeasonAction,
  setSeasonPhase,
  setMaxMmr,
  setMatchSchedule,
  renameSeason,
  setSeriesLengths,
  setLeagueId,
  revokeAllSessions,
  setDraftSettings,
  setNextSeasonDate,
  clearNextSeasonDate,
  setLeagueStreamUrl,
} from "@/app/actions/admin-season";
import { parseNextSeasonPlan } from "@/lib/next-season";
import {
  parseStoredStream,
  WATCH_OPENS_BEFORE_KICKOFF_MS,
} from "@/lib/broadcast";
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
  signFreeAgent,
  releasePlayer,
  promoteStandinToPlayer,
  withdrawTeam,
  reinstateTeam,
  reinstateSignup,
} from "@/app/actions/admin-roster";
import {
  generateSchedule,
  startPlayoffs,
  returnToRegularSeasonAction,
  setWeekNight,
  syncLeagueAction,
} from "@/app/actions/admin-schedule-results";
import {
  setDiscordWebhook,
  clearDiscordWebhook,
  testDiscordWebhook,
  discardWaitingDiscordPosts,
  setInhouseWebhook,
  clearInhouseWebhook,
  setInhouseAlertWebhook,
  clearInhouseAlertWebhook,
  setInhousePingRole,
  testInhouseWebhook,
  postInhouseBoard,
  deleteInhouseBoard,
} from "@/app/actions/admin-discord";
import { runMaintenanceNow } from "@/app/actions/automation";
import {
  scheduleTiebreakerWeek,
  resetTiebreakerWeek,
} from "@/app/actions/tiebreakers";
import { parseTiebreakerStage, TIEBREAKER_RULES, TIEBREAKER_SUMMARY } from "@/lib/tiebreaker-format";
import { TiebreakerBracket } from "@/components/tiebreaker-bracket";
import { buildTiebreakerBrackets } from "@/components/tiebreaker-bracket-view";
import { schedulableAdminTiebreakerGroups } from "@/components/admin-tiebreaker-view";
import { cancelReschedule } from "@/app/actions/reschedule";
import {
  createNewsPost,
  deleteNewsPost,
  toggleNewsPin,
  updateNewsPost,
} from "@/app/actions/news";
import { NEWS_LIMITS, newsDiscordCopy, type NewsDiscordCopy } from "@/lib/news";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { formatLeagueTime } from "@/lib/zoned-time";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { LocalTime } from "@/components/local-time";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { MatchNightPollControls } from "@/components/admin/match-night-poll-controls";
import {
  closedPollStatus,
  pollOnHome,
  pollResultMarker,
  pollTurnoutLine,
} from "@/lib/match-night-poll";
import { loadLatestPoll } from "@/lib/match-night-poll-service";
import {
  ANNOUNCE_FAILED_PREFIX,
  getSetting,
  HONORS_ANNOUNCED_PREFIX,
  playoffGamesArchiveKey,
  tiebreakerGamesArchiveKey,
  SETTING_KEYS,
} from "@/lib/settings";
import { HONORS_STALE_PREFIX } from "@/lib/announcement-marker";
import {
  adminNextStep,
  phaseAdvance,
  type AdminNextStep,
} from "@/lib/admin-next-step";
import { recentAdminActions } from "@/lib/admin-log";
import { AUTOMATION_RUN_KEY } from "@/lib/automation-service";
import { getAutomationGateDecision } from "@/lib/automation-gate";
import {
  AUTOMATION_BACKLOG_STUCK_MS,
  automationAttention,
  automationHealthView,
  automationQuiet,
  type AutomationBacklog,
  type AutomationHealthRecord,
  type AutomationHealthView,
} from "@/lib/automation-health";
import {
  LEAGUE_ANNOUNCEMENT_STATUS,
  loadLeagueDeliveryHealth,
} from "@/lib/league-announcement-outbox";
import {
  deliveryErrorLabel,
  deliveryPaused,
  leagueDeliveryAttention,
  refusedPostsSentence,
  type LeagueDeliveryHealth,
} from "@/lib/league-delivery";
import { INHOUSE_ANNOUNCEMENT_STATUS } from "@/lib/inhouse-announcement-outbox";
import { DangerSubmit } from "@/components/danger-submit";
import { ChaseCopy } from "@/components/chase-copy";
import { ReturningCopy } from "@/components/returning-copy";
import { loadReturningPlayers } from "@/lib/returning-players-service";
import { cn } from "@/lib/utils";
import { maskWebhookUrl } from "@/lib/discord";
import { discordMutationsAllowed } from "@/lib/discord-mutation-policy";
import {
  getInhouseBoardStatus,
  type InhouseBoardStatus,
} from "@/lib/inhouse-board-service";
import {
  getDiscordReachFunnel,
  getGuildConfig,
  getPingHealth,
  sweepGuildMemberships,
  type DiscordReachFunnel,
  type GuildMembership,
  type PingHealth,
} from "@/lib/discord-roles";
import {
  membershipChipView,
  signupFlags,
  signupNeedsReview,
} from "@/lib/signup-readiness";
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
import { DiscordTag } from "@/components/discord-tag";
import {
  MATCH_LIST_ORDER,
  roundName,
  slotRound,
  groupPlayoffRounds,
  hasLaterBracketRound,
  matchRoundLabel,
  playoffTotalRounds,
} from "@/lib/schedule";
import {
  matchNightSide,
  matchNightSlate,
  nightSideLabel,
} from "@/lib/admin-match-night";
import { fixturesMatchNightLabel } from "@/lib/match-night";
import { projectPlayoffField } from "@/lib/playoff-field";
import { playoffSetupRevision } from "@/lib/playoff-command";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import {
  matchCorrectionContext,
  matchResultsOpen,
  postAuctionWorkOpen,
} from "@/lib/league-lifecycle";
import {
  recoverablePostseasonBracket,
  seasonPhasePolicy,
} from "@/lib/season-phase-policy";
import { teamWithdrawalLockedReason } from "@/lib/team-withdrawal";
import { mmrWeightedBudgets } from "@/lib/draft";
import {
  profileSyncAllowed,
  undoSaleConfirm,
  voidLotConfirm,
} from "@/lib/draft-admin";
import {
  captainMmrWarning,
  unverifiedCaptainMmrsFor,
} from "@/lib/captain-mmr";
import {
  captainTransferOpen,
  draftSetupLockedMessage,
  draftRosterCounts,
  draftSetupOpen,
  seatFitSentence,
  startDraftCheck,
  startDraftConfirm,
} from "@/lib/draft-setup";
import {
  MATCH_SCHEDULE,
  HARD_MMR_CEILING,
} from "@/lib/constants";
import {
  nextRegularKickoff,
  regularResultsDue,
  regularSeasonStatus,
  pendingResultsMessage,
  weekList,
} from "@/lib/schedule-status";
import {
  AutoCheckLine,
  LATER_ROUND_NOTE,
  MatchResultRow,
  MatchRowsHelp,
  StandinMatchBlock,
  adminStandinPoolWhere,
  resultsLockNote,
} from "@/components/admin-match-tools";
import { RevealHashTarget } from "@/components/reveal-hash-target";
import {
  ADMIN_MATCH_ROW_PREFIX,
  MATCH_ANCHOR,
  adminMatchRowId,
  matchAnchorPath,
} from "@/lib/match-anchors";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  StartDraftControl,
  StartDraftForm,
} from "@/components/admin-start-draft";
import { StartDraftConfirmLine } from "@/components/start-draft-submit";
import { missingCaptainsConfirmLine } from "@/lib/draft-presence";
import { readCaptainPresence } from "@/lib/draft-presence-service";
import { AdminPlayerRankEditor } from "@/components/admin-player-rank-editor";
import { TeamIdentityForm } from "@/components/team-identity-form";
import { isGeneratedTeamNameFor } from "@/lib/team-identity";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  EmptyState,
  LinkArrow,
  PageTitle,
  PlayerLink,
  RankMedal,
  RoleBadges,
  StatCell,
  StatStrip,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";

export const metadata = { title: "Admin" };

// Server Actions invoked from this page inherit the segment's function budget.
// The bulk OpenDota syncs (ranks, league) fan out network calls that can each
// hit an 8s timeout, so give them headroom above the platform default rather
// than being killed mid-run (which leaves the button spinning "Working…").
// 60s is the Hobby-plan ceiling; the actions themselves stop well before it.
export const maxDuration = 60;

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ newsPage?: string | string[]; importPage?: string | string[] }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin");
  if (user.role !== "ADMIN") {
    return (
      <div className="space-y-8">
        <PageTitle
          title="Admin access required"
          subtitle="This area is limited to league administrators."
        />
        <EmptyState
          title="You do not have administrator access"
          description="Your account is signed in, but it is not on the administrator allowlist. Ask a league administrator if you believe this is a mistake."
          action={
            <Link href="/" className={buttonClasses("secondary")}>
              Return to league home
            </Link>
          }
        />
      </div>
    );
  }

  const season = await getActiveSeason();

  // Delivery health is database-only, so it can sit on the blocking path.
  const [data, delivery] = await Promise.all([
    season ? loadSeasonAdminData(season.id) : null,
    season ? loadLeagueDeliveryHealth().catch(() => null) : null,
  ]);
  // Async server component: it renders once per request, so Date.now() has
  // no re-render to be inconsistent across. "Outstanding" means past kickoff.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const nextStep =
    season && data ? adminNextStepFor(season, data, nowMs) : null;
  const tonight =
    season && data ? matchNightSlate(season.status, data.matches, nowMs) : [];
  // DB-only and shared with the streamed runner card below.
  const automationLines = season && data ? await loadAutomationAttention() : [];
  const cards =
    season && data
      ? adminSeasonCards({
          seasonStatus: season.status,
          draftStatus: data.draft?.status,
          matches: data.matches,
          openBookings: openBookingCount(data.assignments, data.matches),
          archivedPostseasonGames:
            data.playoffArchive.length + data.tiebreakerArchive.length,
        })
      : null;
  const showTiebreakers = data != null && (
    data.matches.some((match) => match.phase === MATCH_PHASE.TIEBREAKER) ||
    (regularSeasonStatus(data.matches).allComplete &&
      projectPlayoffField(data.teams, data.matches).tiebreakers.groups.length > 0)
  );
  const handoffReadiness =
    season && data
      ? completedSeasonArchiveReadiness(
          season,
          data.matches,
          data.teams.map((team) => team.id),
        )
      : null;
  // The season a new one follows: the active one, or from the offseason the
  // most recent (createSeason carries its settings the same way).
  const newSeasonDefaults =
    season ??
    (await prisma.season.findFirst({
      where: { isActive: false },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));

  // During signups and the draft phase, setting up the season is the job:
  // the phase and captains cards and the Discord reach card come first.
  const setupFirst = season?.status === "SIGNUPS" || season?.status === "DRAFT";
  const setupControls = season && data && nextStep ? <>
          <AdminAnchor id="adm-season">
            <SeasonControls season={season} data={data} nextStep={nextStep} />
          </AdminAnchor>
          <AdminAnchor id="adm-captains">
            <CaptainControls season={season} data={data} />
          </AdminAnchor>
  </> : null;
  // Between seasons the job left on this page is opening the next one, so
  // its card leads, right under the title: once a champion is crowned, and
  // in the offseason. A crowned season's own cards can no longer change much,
  // so they fold into one "<season> record" section instead of standing
  // between the admin and the handoff. A Complete season WITHOUT a valid
  // champion is a recovery state: its cards stay open and the locked handoff
  // stays last.
  const handoffFirst = !season || handoffReadiness?.ready === true;
  const seasonRecord = season && data && handoffReadiness?.ready ? season : null;
  const championName = handoffReadiness?.ready
    ? (data?.teams.find((team) => team.id === handoffReadiness.championTeamId)
        ?.name ?? null)
    : null;
  // The next season's signup date Home prints, set on the handoff card.
  const nextSeasonPlan =
    season?.status === SEASON_STATUS.COMPLETE && handoffReadiness?.ready
      ? parseNextSeasonPlan(
          await getSetting(SETTING_KEYS.NEXT_SEASON_PLAN),
          season.id,
        )
      : null;
  const importQuery = await searchParams;
  // Chasing Discord links is a weekly people task, so it sits beside the
  // signups (before the draft) or the rosters (after it), not inside the
  // collapsed Discord settings. Streamed: its membership sweep calls Discord.
  const reachCard = season ? (
    <AdminAnchor id="adm-reach">
      <Suspense fallback={<CardSkeleton rows={3} />}>
        <DiscordReachCard
          seasonId={season.id}
          rosterUnlinked={data ? unlinkedRosterFor(season, data) : null}
          signupsSeasonName={season.status === "SIGNUPS" ? season.name : null}
        />
      </Suspense>
    </AdminAnchor>
  ) : null;
  // The auto-sync card and the import review are spaced like every other
  // card, and the anchor hides when neither has anything to show (outside
  // the regular season and playoffs, with no import waiting) so it adds no
  // gap. Database performance is its own folded section after them: inside
  // the anchor, a jump to Auto-sync would unfold it too.
  const syncCards = season ? (
    <>
      <AdminAnchor id="adm-sync" className="space-y-5 empty:hidden">
        <AutoSyncHealth season={season} />
        <Suspense fallback={<CardSkeleton rows={3} />}>
          <ImportProgress seasonId={season.id} page={importQuery.importPage} query={importQuery} />
        </Suspense>
      </AdminAnchor>
      <AdminSection
        title="Database performance"
        subtitle="Connection waits, busy connections and timeouts on this server instance."
      >
        <Suspense fallback={<CardSkeleton rows={3} />}>
          <DatabaseHealth />
        </Suspense>
      </AdminSection>
    </>
  ) : null;

  // The chips follow the page's order, so the active chip only ever moves
  // forward as the admin scrolls down: with setupFirst the phase, captains
  // and Discord reach chips lead, as their cards do; later they follow the
  // season's working cards.
  const setupItems = [
    { id: "adm-season", label: "Phase" },
    { id: "adm-captains", label: "Captains & draft" },
  ];
  const reachItem = { id: "adm-reach", label: "Discord reach" };
  const jumpItems: { id: string; label: string }[] = [
    ...(handoffFirst
      ? [
          {
            id: "adm-new-season",
            label: season ? "Season handoff" : "Open a new season",
          },
        ]
      : []),
    ...(season && data && seasonRecord
      ? [
          { id: "adm-attention", label: "Needs attention" },
          { id: "adm-record", label: "Season record" },
          { id: "adm-league", label: "League id" },
        ]
      : season && data
      ? [
          ...(tonight.length > 0
            ? [{ id: "adm-tonight", label: "Tonight" }]
            : []),
          { id: "adm-attention", label: "Needs attention" },
          ...(showTiebreakers ? [{ id: "adm-tiebreakers", label: "Tiebreakers" }] : []),
          ...(setupFirst ? [...setupItems, reachItem] : []),
          ...(cards?.schedule
            ? [{ id: "adm-schedule", label: "Schedule & results" }]
            : []),
          ...(cards?.playoffs ? [{ id: "adm-playoffs", label: "Playoffs" }] : []),
          ...(rosterMovesVisible(season, data)
            ? [{ id: "adm-roster", label: "Roster moves" }]
            : []),
          ...(cards?.standins
            ? [{ id: "adm-standins", label: "Standins" }]
            : []),
          ...(setupFirst ? [] : [reachItem]),
          ...(autoSyncVisible(season)
            ? [{ id: "adm-sync", label: "Auto-sync" }]
            : []),
          ...(setupFirst ? [] : setupItems),
          { id: "adm-league", label: "League id" },
        ]
      : []),
    { id: "adm-stream", label: "Match stream" },
    { id: "adm-history", label: "Historical records" },
    { id: "adm-automation", label: "Automation" },
    // Season-independent: inhouse alerts and the queue board are most
    // important in the offseason, when inhouse is the live mode.
    { id: "adm-discord", label: "Discord" },
    { id: "adm-activity", label: "Activity" },
    { id: "adm-poll", label: "Match night poll" },
    { id: "adm-news", label: "News" },
    { id: "adm-security", label: "Security" },
    ...(handoffFirst
      ? []
      : [{ id: "adm-new-season", label: "Season handoff" }]),
  ];

  return (
    // 20px between cards (was 32): about twenty cards stack here.
    <div className="space-y-5">
      <PageTitle
        title="Admin"
        subtitle="Run the league — create seasons, pick captains, run the draft, enter results."
      />

      {nextStep ? <NextStepBanner nextStep={nextStep} /> : null}

      <AdminJump items={jumpItems} />

      {handoffFirst ? (
        <OpenNextSeason
          season={season}
          previous={newSeasonDefaults}
          championName={championName}
          nextSignupsAtMs={nextSeasonPlan?.signupsAtMs ?? null}
        />
      ) : null}

      {season && data && seasonRecord ? (
        <>
          <AdminAttention
            season={season}
            data={data}
            delivery={delivery}
            automation={automationLines}
            jumpItems={jumpItems}
          />
          {/* The match page's "Open this match in the admin panel" link lands
              on a result row, often inside a folded week or the folded season
              record. */}
          <RevealHashTarget prefix={ADMIN_MATCH_ROW_PREFIX} />
          <AdminSection
            id="adm-record"
            title={`${seasonRecord.name} record`}
            subtitle="Schedule and results, playoffs, standins, phase and draft settings for the finished season. Correct the grand final or reset the playoffs here."
            headingLevel={2}
          >
            <div className="space-y-6 p-3 sm:p-4">
              {showTiebreakers ? (
                <AdminAnchor id="adm-tiebreakers">
                  <TiebreakerControls season={season} data={data} nowMs={nowMs} />
                </AdminAnchor>
              ) : null}
              {cards?.schedule ? (
                <AdminAnchor id="adm-schedule">
                  <ScheduleControls
                    season={season}
                    data={data}
                    nowMs={nowMs}
                  />
                </AdminAnchor>
              ) : null}
              {cards?.playoffs ? (
                <AdminAnchor id="adm-playoffs">
                  <PlayoffControls season={season} data={data} nowMs={nowMs} />
                </AdminAnchor>
              ) : null}
              <AdminAnchor id="adm-roster">
                <RosterMoves season={season} data={data} />
              </AdminAnchor>
              {cards?.standins ? (
                <AdminAnchor id="adm-standins">
                  <StandinControls season={season} data={data} />
                </AdminAnchor>
              ) : null}
              {setupControls}
            </div>
          </AdminSection>
          {syncCards}
          <LeagueControls season={season} />
        </>
      ) : season && data ? (
        <>
          {tonight.length > 0 ? (
            <TonightMatches
              season={season}
              data={data}
              slate={tonight}
              nowMs={nowMs}
            />
          ) : null}
          <AdminAttention
            season={season}
            data={data}
            delivery={delivery}
            automation={automationLines}
            jumpItems={jumpItems}
          />
          {/* The match page's "Open this match in the admin panel" link lands
              on a result row, often inside a folded week or the folded season
              record. */}
          <RevealHashTarget prefix={ADMIN_MATCH_ROW_PREFIX} />
          {showTiebreakers ? (
            <AdminAnchor id="adm-tiebreakers">
              <TiebreakerControls season={season} data={data} nowMs={nowMs} />
            </AdminAnchor>
          ) : null}
          {setupFirst ? (
            <>
              {setupControls}
              {reachCard}
            </>
          ) : null}
          {/* Each card only where it has work or data (adminSeasonCards):
              the same answer the jump bar above was built from. */}
          {cards?.schedule ? (
            <AdminAnchor id="adm-schedule">
              <ScheduleControls
                season={season}
                data={data}
                nowMs={nowMs}
              />
            </AdminAnchor>
          ) : null}
          {cards?.playoffs ? (
            <AdminAnchor id="adm-playoffs">
              <PlayoffControls season={season} data={data} nowMs={nowMs} />
            </AdminAnchor>
          ) : null}
          <AdminAnchor id="adm-roster">
            <RosterMoves season={season} data={data} />
          </AdminAnchor>
          {cards?.standins ? (
            <AdminAnchor id="adm-standins">
              <StandinControls season={season} data={data} />
            </AdminAnchor>
          ) : null}
          {setupFirst ? null : reachCard}
          {syncCards}
          {setupFirst ? null : setupControls}
          <LeagueControls season={season} />
        </>
      ) : null}

      {/* League-wide, like everything below: the stream link outlives the
          season and needs no active one. */}
      <AdminAnchor id="adm-stream">
        <Suspense fallback={<CardSkeleton rows={2} />}>
          <StreamControls />
        </Suspense>
      </AdminAnchor>

      <AdminAnchor id="adm-history">
        <AdminSection
          title="Historical records"
          subtitle="How many imported games are indexed and how much roster history is kept, with the tools to fill gaps."
        >
          <Suspense fallback={<CardSkeleton rows={3} />}>
            <HistoryCoverage />
          </Suspense>
        </AdminSection>
      </AdminAnchor>

      {/* Evergreen: cron also owns offseason/inhouse maintenance, and an
          absent active season must never hide the only production scheduler
          health surface. The query is isolated so an unavailable health table
          does not take the rest of the admin panel down with it. */}
      <AdminAnchor id="adm-automation">
        <Suspense fallback={<CardSkeleton rows={5} />}>
          <AutomationRunnerHealth />
        </Suspense>
      </AdminAnchor>

      {/* Evergreen because its inhouse channel, ping role and live board do
          not belong to a season; every inhouse control stays usable in the
          offseason. Streamed: Discord health has bounded network calls and
          must never hold up the rest of the admin page. */}
      <Suspense fallback={<CardSkeleton rows={6} />}>
        <DiscordSection />
      </Suspense>

      <div>
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <AdminActivity />
        </Suspense>
      </div>

      {/* Season-independent, like news: a league polls for its night between
          seasons as often as during one. */}
      <Suspense fallback={<CardSkeleton rows={3} />}>
        <AdminMatchNightPoll
          admin={user}
          season={season}
          fixturesNight={data ? fixturesMatchNightLabel(data.matches) : null}
        />
      </Suspense>

      <Suspense fallback={<CardSkeleton rows={4} />}><AdminNews searchParams={searchParams} /></Suspense>

      <SecurityControls />

      {season && handoffReadiness && !handoffReadiness.ready ? (
        <AdminSection
          id="adm-new-season"
          title="Season handoff"
          subtitle="The normal handoff unlocks after an authoritative champion is crowned."
        >
          <CardBody className="space-y-3">
            <div className="rounded-lg border border-accent/40 bg-accent/10 px-4 py-3 text-sm">
              <div className="font-medium text-fg">Handoff locked</div>
              <p className="mt-1 text-muted">{handoffReadiness.reason}</p>
              <p className="mt-1 text-muted">
                No data has to be discarded to continue the league. Use the
                phase, result, or playoff recovery controls above first.
              </p>
            </div>
            {season.status !== SEASON_STATUS.COMPLETE ? (
              <details className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
                <summary className="cursor-pointer font-medium text-danger">
                  Need to cancel this unfinished season?
                </summary>
                <p className="mt-2 text-muted">
                  This is separate from a normal handoff. It closes every
                  active-season signup, draft, match, sync, and reminder
                  workflow immediately. Saved teams, signups, matches, and
                  games remain in History, and an admin can reactivate the
                  season later. If an auction is live, its lot and bids are
                  preserved with both clocks paused for an admin to review.
                </p>
                <ActionForm
                  action={archiveIncompleteSeasonAction}
                  hidden={{
                    expectedActiveSeasonId: season.id,
                    expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
                  }}
                  className="mt-3"
                >
                  <SubmitButton
                    variant="danger"
                    confirm={`Cancel and archive unfinished ${season.name}? Active league workflows stop immediately. Nothing is deleted; a live auction is paused, and reactivation remains available from Season history after you enter the offseason.`}
                  >
                    Cancel season and enter offseason
                  </SubmitButton>
                </ActionForm>
              </details>
            ) : null}
          </CardBody>
        </AdminSection>
      ) : null}

      {/* One outbound link, so a footer line rather than a card. Each league
          is its own Vercel project; the link follows this deployment's region. */}
      <p className="border-t border-line-soft pt-4 text-xs text-muted">
        Website traffic:{" "}
        <a
          href={webAnalyticsUrl(LEAGUE_CONFIG.region)}
          target="_blank"
          rel="noopener noreferrer"
          className={textLink()}
        >
          open {LEAGUE_CONFIG.name} in Vercel Web Analytics ↗
        </a>{" "}
        (needs access to the league&rsquo;s Vercel project; admin, account and
        sign-in pages aren&rsquo;t counted).
      </p>
    </div>
  );
}

/**
 * The season handoff once a champion is crowned, and the new-season form in
 * the offseason: the first card on the page in both states. One titled form
 * with the one button. Archiving without opening the next season is no longer
 * a peer choice: staying in Season complete keeps the champion and bracket on
 * the home page, while the offseason turns them into empty pages. It stays
 * reachable, folded, because reactivating an older season needs no active
 * season.
 */
function OpenNextSeason({
  season,
  previous,
  championName,
  nextSignupsAtMs,
}: {
  /** The crowned active season; null in the offseason. */
  season: Season | null;
  /** The season the new one follows (carried settings); null for the first. */
  previous: CarriedSeasonSettings & { name: string } | null;
  championName: string | null;
  /** The next season's planned signup date Home shows; null for none. */
  nextSignupsAtMs: number | null;
}) {
  const nextName = nextSeasonName(previous?.name ?? null);
  return (
    <Card id="adm-new-season" tone="feature" className="scroll-mt-40 lg:scroll-mt-56">
      <CardHeader
        headingLevel={2}
        title={season ? "Season handoff" : "Open a new season"}
        subtitle={
          season
            ? `${championName ? `${championName} won ${season.name}. ` : ""}The league stays in Complete, with the champion on the home page, until you open the next season.`
            : previous
              ? "The league is in the offseason. Archived seasons remain public; open the next season when signups should begin."
              : "No active season yet. Open the first one to start signups."
        }
      />
      <CardBody className="space-y-5">
        <ActionForm
          action={createSeason}
          className="space-y-3 [overflow-wrap:anywhere]"
          hidden={{ expectedActiveSeasonId: season?.id ?? "" }}
        >
          <h3 className="text-base font-semibold text-fg">
            {nextName ? `Open ${nextName} signups` : "Open the next season's signups"}
          </h3>
          <p className="text-sm text-muted">
            {season
              ? `Players see the new season on the home page with signups open. ${season.name} moves to Season history with its champion, results and rosters.`
              : "Players see the new season on the home page with signups open."}
          </p>
          <Field label="New season name" htmlFor="newSeasonName">
            <input
              id="newSeasonName"
              name="name"
              required
              maxLength={60}
              defaultValue={nextName}
              placeholder="Season 1"
              className={cn(inputCls, "sm:max-w-sm")}
            />
          </Field>
          <p className="text-sm text-muted">
            {previous ? `Carried over from ${previous.name}: ` : "Starts with: "}
            <span className="text-fg">
              {carriedSettingsLine(carriedSeasonSettings(previous))}
            </span>
            . You can change any of them once the season is open.
          </p>
          <SubmitButton
            variant="accent"
            confirm={
              season
                ? `Archive completed ${season.name} and open a new signup season? All history remains available.`
                : "Open this season's signup window now?"
            }
          >
            Open signups
          </SubmitButton>
        </ActionForm>
        {season ? (
          <div className="space-y-3 border-t border-line-soft pt-4">
            <h3 className="text-base font-semibold text-fg">
              Next season&rsquo;s date
            </h3>
            <p className="text-sm text-muted">
              Until you open signups, the home page tells players the next
              season is coming soon. Set the date its signups will open and
              Home shows that date with a countdown instead. It only informs
              players: signups still open when you press Open signups above.
            </p>
            <ActionForm
              action={setNextSeasonDate}
              hidden={{ expectedActiveSeasonId: season.id }}
              className="flex flex-wrap items-end gap-2"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor="nextSignupsAt" className="text-xs text-muted">
                  Signups open
                </label>
                <LocalDatetimeField
                  id="nextSignupsAt"
                  name="nextSignupsAt"
                  tsName="nextSignupsAtTs"
                  required
                  defaultTs={nextSignupsAtMs}
                  timeZone={LEAGUE_CONFIG.timeZone}
                  className="h-8 rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg"
                />
              </div>
              <SubmitButton variant="secondary" size="sm">
                {nextSignupsAtMs != null ? "Update date" : "Set date"}
              </SubmitButton>
            </ActionForm>
            {nextSignupsAtMs != null ? (
              <ActionForm
                action={clearNextSeasonDate}
                className="flex flex-wrap items-center gap-2 text-xs text-muted"
              >
                <span>
                  Home shows {formatLeagueTime(new Date(nextSignupsAtMs))}.
                </span>
                <SubmitButton variant="ghost" size="sm">
                  Clear date
                </SubmitButton>
              </ActionForm>
            ) : null}
          </div>
        ) : null}
        {season ? (
          <details className="rounded-lg border border-line bg-surface-2/40 px-4 py-2 text-sm">
            <summary className="flex min-h-11 cursor-pointer items-center font-medium text-fg">
              Archive without opening the next season
            </summary>
            <div className="space-y-3 pb-2">
              <p className="text-muted">
                Use this only to reactivate an older season from Season
                history, which needs the league to have no active season.
                Archiving takes the league out of Complete: the home page
                swaps the champion card and bracket for an offseason notice
                that still names the champion as the defending champion, and
                nobody can sign up until you open the next season here. Results, the champion,
                rosters and records stay public under Season history. For a
                long break, stay in Complete and pin a League news post
                instead.
              </p>
              <ActionForm
                action={archiveCompletedSeasonAction}
                hidden={{ expectedActiveSeasonId: season.id }}
              >
                <SubmitButton
                  variant="secondary"
                  confirm={`Archive ${season.name} and enter the offseason? No league history is deleted, but active-season signup and match tools will close until another season is opened.`}
                >
                  Archive and enter offseason
                </SubmitButton>
              </ActionForm>
            </div>
          </details>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * The admin page is 13 cards in one column — 6,948px on a desktop and 11,501px
 * on a phone, the longest page in the app by 36%. Two things fix that without
 * hiding a single control:
 *
 *  - every card is an anchor target, and `AdminJump` puts them one tap away;
 *  - the cards an admin touches ONCE (wire up Discord, set the league id, write
 *    news, break glass, open next season) render collapsed.
 *
 * `AdminSection` is the collapsed form. The title stays in the `<summary>`, so
 * it is still a visible heading when shut — which matters for both a scanning
 * admin and the e2e checks that assert those headings render.
 */
function AdminSection({
  id,
  title,
  subtitle,
  children,
  defaultOpen = false,
  headingLevel = 3,
}: {
  /** Omit when a wrapping AdminAnchor already carries the section's id. */
  id?: string;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** 2 for a section that stands in for top-level cards (the season record). */
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <details
      id={id}
      data-section-jump
      open={defaultOpen}
      className="group scroll-mt-40 lg:scroll-mt-56 rounded-[var(--radius)] border border-line bg-surface/80 shadow-sm backdrop-blur"
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <SectionReady />
        {/* Set like CardHeader's title and subtitle (padding, sizes), so a
            folded section and an open card read as the same kind of heading
            and their titles share one left edge. */}
        <div className="min-w-0">
          <Heading className="text-[0.9375rem] font-semibold leading-snug text-fg [overflow-wrap:anywhere]">
            {title}
          </Heading>
          {subtitle ? (
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted [overflow-wrap:anywhere]">
              {subtitle}
            </p>
          ) : null}
        </div>
        <span
          aria-hidden
          className="shrink-0 text-muted transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="border-t border-line">{children}</div>
    </details>
  );
}

/** Anchor target + header offset for a card that keeps its own frame. */
function AdminAnchor({
  id,
  className,
  children,
}: {
  id: string;
  /** Spacing for an anchor that wraps more than one card. */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className={cn("scroll-mt-40 lg:scroll-mt-56", className)}>
      {children}
    </div>
  );
}

/**
 * The jump bar. From desktop width it is sticky under the 64px header
 * (`top-16`, the same offset the draft room's clock bar uses) so it stays
 * reachable however far down the page an admin has scrolled. On a phone it
 * scrolls away with the page like every section bar (see SectionNav): pinned,
 * it cost a fifth of the screen on top of the header and the tab bar.
 *
 * With up to twenty chips it can't fit one desktop row, and a desktop mouse
 * can't scroll sideways, so from `lg` it wraps (`wrap`): two rows at most
 * desktop widths, three near 1024px, about 135px at most. Every jump target
 * here therefore clears the header plus that bar at `lg` with
 * `lg:scroll-mt-56` (224px), beside the phone's `scroll-mt-40`.
 *
 * A jump opens the section and, inside it, only a folded AdminSection
 * (`data-section-jump`). Every other disclosure in a card (Fix the phase,
 * Fix the bracket, Assign any match, a news Edit form, the handoff's archive
 * option) stays as the page rendered it, so a jump to a card never unfolds
 * its danger controls or an edit form.
 */
function AdminJump({ items }: { items: { id: string; label: string }[] }) {
  return (
    <SectionNav
      items={items}
      label="Admin sections"
      sticky
      openNested="marked"
      wrap
    />
  );
}

/**
 * Which optional cards actually render, so the jump bar and the cards can never
 * disagree.
 *
 * `AdminJump` listed every anchor unconditionally, but two cards return null in
 * some phases — Roster moves (wrong phase, live auction, or nothing to move) and
 * Auto-sync (only REGULAR_SEASON/PLAYOFFS). A chip that scrolls nowhere reads as
 * a broken page, and on a sticky nav the admin is using to find a control under
 * time pressure it is worse than that: it looks like the tool is gone. One
 * predicate, two consumers — the ROW_GRID discipline.
 */
function rosterMovesVisible(season: Season, data: AdminData): boolean {
  if (season.status === "SIGNUPS" || season.status === "COMPLETE") return false;
  // `?.status !== COMPLETE`, so a MISSING Draft row counts as "the auction
  // hasn't run" — matching the actions. In the DRAFT phase with no draft row
  // (reachable by clicking the Draft phase button before Start draft) the
  // sign/release forms must stay hidden, or the $0 free-agent path bypasses
  // the auction entirely. PROMOTION is the one exception: promoteGateError
  // explicitly blesses the pre-start window ("they'll be auctioned normally"),
  // and a late joiner who filed as a standin the week before draft night is
  // exactly who it serves — yet the form had no render anywhere in that
  // window, so the only workaround was re-opening signups league-wide to move
  // one person. The card shows with ONLY the promote form (see preStart in
  // RosterMoves); a LIVE/PAUSED auction still hides everything.
  if (
    season.status === "DRAFT" &&
    data.draft?.status !== DRAFT_STATUS.COMPLETE
  ) {
    const preStart =
      !data.draft || data.draft.status === DRAFT_STATUS.NOT_STARTED;
    if (!preStart) return false;
    const rostered = new Set(
      data.teams.flatMap((t) => t.members.map((m) => m.userId)),
    );
    return data.standins.some(
      (s) => s.type === REGISTRATION_TYPE.STANDIN && !rostered.has(s.userId),
    );
  }
  const rosteredIds = new Set(
    data.teams.flatMap((t) => t.members.map((m) => m.userId)),
  );
  // A WITHDRAWN team is not a signing target and not a short-team alarm: its
  // fixtures are all forfeited, so "short" is its permanent normal state and
  // the alarm would cry wolf all season — the reason the team most likely to
  // BE short (it usually withdrew because players left) must be excluded
  // here. It stays releasable: freeing its players for standin duty is the
  // documented post-withdrawal cleanup.
  const liveTeams = data.teams.filter((t) => !t.withdrawn);
  const canSign =
    data.players.some((p) => !rosteredIds.has(p.userId)) &&
    liveTeams.some((t) => t.members.length < season.teamSize);
  const releasable = data.teams.some((t) =>
    t.members.some((m) => !m.isCaptain),
  );
  const promotable = data.standins.some(
    (s) => s.type === REGISTRATION_TYPE.STANDIN && !rosteredIds.has(s.userId),
  );
  // A SHORT team keeps the card open even when nothing can be done about it
  // yet: "this team is a player down" is the thing the admin most needs to
  // know, and it used to disappear precisely when no free agent existed.
  const short = liveTeams.some((t) => t.members.length < season.teamSize);
  return canSign || releasable || promotable || short;
}

function autoSyncVisible(season: Season): boolean {
  return season.status === "REGULAR_SEASON" || season.status === "PLAYOFFS";
}

type ArchivedPlayoffGame = { dotaMatchId: string; slot: string; week: number };

/** Tolerate a corrupt archive rather than 500 the whole admin page over it. */
function parsePlayoffArchive(raw: string | null): ArchivedPlayoffGame[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ArchivedPlayoffGame[]) : [];
  } catch {
    return [];
  }
}

async function loadSeasonAdminData(seasonId: string) {
  const [players, standins, removed, teams, matches, draft, assignments] =
    await Promise.all([
      prisma.registration.findMany({
        where: { seasonId, status: "ACTIVE", type: "PLAYER" },
        include: { user: true },
        orderBy: [{ wantsCaptain: "desc" }, { mmr: "desc" }],
      }),
      // Registered standins PLUS undrafted full players — the same pool the
      // match page's Admin tools offer (adminStandinPoolWhere).
      prisma.registration.findMany({
        where: adminStandinPoolWhere(seasonId),
        include: { user: true },
        orderBy: { mmr: "desc" },
      }),
      // Admin-removed signups: listed so the removal stays reversible (the
      // player can no longer re-add themselves from /me).
      prisma.registration.findMany({
        where: { seasonId, status: REGISTRATION_STATUS.REMOVED },
        include: { user: true },
        orderBy: { mmr: "desc" },
      }),
      prisma.team.findMany({
        where: { seasonId },
        orderBy: { draftOrder: "asc" },
        include: { captain: true, members: { include: { user: true } } },
      }),
      prisma.match.findMany({
        where: { seasonId },
        orderBy: MATCH_LIST_ORDER,
        include: {
          games: { select: { id: true, dotaMatchId: true, winnerTeamId: true, durationSecs: true } },
          availability: { select: { id: true, userId: true, status: true, scheduleRevision: true } },
          standins: {
            select: {
              id: true,
              teamId: true,
              standinUserId: true,
              replacingUserId: true,
            },
          },
          predictions: {
            select: { id: true, userId: true, pickedTeamId: true },
          },
          reschedules: {
            select: {
              id: true,
              proposedById: true,
              proposedTime: true,
              status: true,
            },
          },
        },
      }),
      prisma.draft.findUnique({ where: { seasonId } }),
      prisma.standinAssignment.findMany({
        where: { match: { seasonId } },
        include: { standin: true, replaced: true },
      }),
    ]);
  const outRsvps = await prisma.matchAvailability.findMany({
    where: { match: { seasonId }, status: "OUT" },
    include: { user: true },
  });
  // Captains with the draft room open as this page renders, for the
  // Start-draft confirm (the draft room itself shows it live).
  const captainsInRoom = await readCaptainPresence(
    prisma,
    seasonId,
    teams.map((t) => t.captainId),
  );
  // OpenDota ids of playoff games a bracket reset deleted. Archived by
  // createPlayoffBracket so the postseason can be re-imported by hand — without
  // them the ids were simply gone, which is what made "recreate the bracket"
  // (the only correction path past an advanced round) irreversible.
  const [playoffArchive, tiebreakerArchive] = await Promise.all([
    getSetting(playoffGamesArchiveKey(seasonId)),
    getSetting(tiebreakerGamesArchiveKey(seasonId)),
  ]);
  // What a schedule REGENERATE would destroy. These rows hang off a fixture id
  // and cascade with it, and none of them is archived anywhere — so the confirm
  // has to be able to state them BEFORE the click, not just the toast after.
  const regularWhere = { match: { seasonId, phase: MATCH_PHASE.REGULAR } };
  // ALL ACTIVE registrations, standins included — deliberately the same
  // population as getDiscordReachFunnel's, because the next-step banner quotes
  // this number and then points at that card ("names them"); counting only
  // data.players (type PLAYER) made the two disagree whenever an unlinked
  // standin existed. DB-only, so the blocking path stays Discord-free.
  const [rsvps, picks, covers, proposals, unlinkedDiscord, importsNeedingReview] = await Promise.all([
    prisma.matchAvailability.count({ where: regularWhere }),
    prisma.prediction.count({ where: regularWhere }),
    prisma.standinAssignment.count({ where: regularWhere }),
    prisma.rescheduleRequest.count({
      where: { ...regularWhere, status: "PENDING" },
    }),
    prisma.registration.count({
      where: {
        seasonId,
        status: REGISTRATION_STATUS.ACTIVE,
        user: { discordId: null },
      },
    }),
    // Imports the automatic sync could not place on its own (Auto-sync card).
    prisma.importCandidate.count({
      where: { seasonId, status: "NEEDS_REVIEW" },
    }),
  ]);
  return {
    players,
    standins,
    removed,
    teams,
    matches: matches.map((match) => ({ ...match, availability: match.availability.filter((rsvp) => rsvp.scheduleRevision === match.scheduleRevision) })),
    draft,
    assignments,
    outRsvps: outRsvps.filter((rsvp) => rsvp.scheduleRevision === matches.find((match) => match.id === rsvp.matchId)?.scheduleRevision),
    playoffArchive: parsePlayoffArchive(playoffArchive),
    tiebreakerArchive: parsePlayoffArchive(tiebreakerArchive),
    collateral: { rsvps, picks, covers, proposals },
    unlinkedDiscord,
    importsNeedingReview,
    captainsInRoom,
  };
}

type AdminData = Awaited<ReturnType<typeof loadSeasonAdminData>>;
type Season = NonNullable<Awaited<ReturnType<typeof getActiveSeason>>>;

/**
 * Match night at the top of the page: each of tonight's fixtures with its
 * state, check-ins, standins and next automatic result check, and a jump to
 * its full result controls further down ("Result controls"). The fixture
 * name opens the public match page (rosters, check-ins, games), which has no
 * admin controls of its own.
 */
function TonightMatches({
  season,
  data,
  slate,
  nowMs,
}: {
  season: Season;
  data: AdminData;
  slate: AdminData["matches"];
  nowMs: number;
}) {
  const totalRounds = playoffTotalRounds(data.matches);
  const names = new Map(data.teams.map((team) => [team.id, team.name]));
  const rosters = new Map(
    data.teams.map((team) => [
      team.id,
      team.members.map((member) => member.userId),
    ]),
  );
  return (
    <AdminAnchor id="adm-tonight">
      <Card>
        <CardHeader
          headingLevel={2}
          title="Tonight"
          subtitle="Fixtures kicking off soon, being played, or still waiting on a result."
        />
        <CardBody>
          <ul className="space-y-2">
            {slate.map((m) => {
              const home = m.homeTeamId ? names.get(m.homeTeamId) : undefined;
              const away = m.awayTeamId ? names.get(m.awayTeamId) : undefined;
              const open = m.status !== MATCH_STATUS.COMPLETED;
              const check = autoCheckStatus(m, season, nowMs);
              const sides =
                open && m.homeTeamId && m.awayTeamId
                  ? ([
                      [home, m.homeTeamId],
                      [away, m.awayTeamId],
                    ] as const).map(([name, teamId]) => ({
                      name: name ?? "?",
                      label: nightSideLabel(
                        matchNightSide(
                          rosters.get(teamId) ?? [],
                          teamId,
                          m.standins,
                          m.availability,
                          season.teamSize,
                        ),
                        m.status === MATCH_STATUS.LIVE,
                      ),
                    }))
                  : [];
              return (
                <li
                  key={m.id}
                  data-testid="admin-tonight-match"
                  className="space-y-1 rounded-lg border border-line p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-xs text-muted">
                      {matchRoundLabel(m, totalRounds, { bestOf: true })}
                    </span>
                    <Link
                      href={`/matches/${m.id}`}
                      className={textLink(
                        "min-w-0 flex-1 basis-48 font-medium [overflow-wrap:anywhere]",
                      )}
                    >
                      {home ?? "TBD"} vs {away ?? "TBD"}
                    </Link>
                    {m.status === MATCH_STATUS.LIVE ? (
                      <Badge tone="accent">
                        Live · {m.homeScore}–{m.awayScore}
                      </Badge>
                    ) : m.status === MATCH_STATUS.COMPLETED ? (
                      <Badge tone="success">
                        Final · {m.homeScore}–{m.awayScore}
                        {m.forfeit ? " · forfeit" : ""}
                      </Badge>
                    ) : null}
                  </div>
                  {m.scheduledAt ? (
                    <p className="text-xs text-muted">
                      Kickoff{" "}
                      <LocalTime
                        ts={m.scheduledAt.getTime()}
                        variant="short"
                        initial={formatLeagueMatchTime(m.scheduledAt, "short")}
                      />
                    </p>
                  ) : null}
                  {sides.map((side, index) => (
                    <p
                      key={index}
                      className="text-xs text-muted [overflow-wrap:anywhere]"
                    >
                      {side.name}: {side.label}
                    </p>
                  ))}
                  {check ? <AutoCheckLine check={check} /> : null}
                  {open ? (
                    <a
                      href={`#adm-match-${m.id}`}
                      className={textLink("inline-block text-xs")}
                    >
                      Result controls ↓
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>
    </AdminAnchor>
  );
}

/** The auction has finished (or the season has moved past it): rosters are real. */
function draftRostersReady(season: Season, data: AdminData): boolean {
  return (
    data.draft?.status === DRAFT_STATUS.COMPLETE ||
    season.status === SEASON_STATUS.REGULAR_SEASON ||
    season.status === SEASON_STATUS.PLAYOFFS ||
    season.status === SEASON_STATUS.COMPLETE
  );
}

/**
 * The unlinked players and booked standins match-night pings are for, or null
 * while pings still go to signups (or the season is over). Needs attention
 * counts this list and the Discord reach card names it.
 */
function unlinkedRosterFor(season: Season, data: AdminData): string[] | null {
  if (!rosterPingsLive(season.status, draftRostersReady(season, data)))
    return null;
  const openIds = new Set(
    data.matches
      .filter((match) => match.status !== MATCH_STATUS.COMPLETED)
      .map((match) => match.id),
  );
  return unlinkedRoster(data.teams, data.assignments, openIds);
}

/**
 * Every problem on the page as one list, each line linking to the control
 * that fixes it: season-wide alarms first, then the matches to review. All of
 * it is read from the database; the Discord line is the DB count of unlinked
 * players, and the membership details stream into the Discord reach card.
 */
function AdminAttention({
  season,
  data,
  delivery,
  automation,
  jumpItems,
}: {
  season: Season;
  data: AdminData;
  /** League post delivery: a stuck backlog or a paused webhook is a line
   *  here (leagueDeliveryAttention), linking to the Discord card. */
  delivery: LeagueDeliveryHealth | null;
  automation: string[];
  jumpItems: { id: string; label: string }[];
}) {
  const names = new Map(data.teams.map((team) => [team.id, team.name]));
  const fixture = (match: AdminData["matches"][number]) =>
    `${names.get(match.homeTeamId ?? "") ?? "TBD"} vs ${names.get(match.awayTeamId ?? "") ?? "TBD"}`;
  const openMatches = data.matches.filter(
    (match) => match.status !== MATCH_STATUS.COMPLETED,
  );
  const openIds = new Set(openMatches.map((match) => match.id));
  const matchById = new Map(data.matches.map((match) => [match.id, match]));
  const standinName = new Map(
    data.assignments.map((booking) => [
      booking.standinUserId,
      booking.standin.name,
    ]),
  );
  // Stalled or dropped league announcements lead the list, pointing at the
  // Discord card whose delivery health says which and why.
  const deliveryItems = (delivery ? leagueDeliveryAttention(delivery) : []).map(
    (text, index) => ({ key: `delivery-${index}`, text, href: "#adm-discord" }),
  );
  const items = [
    ...deliveryItems,
    ...adminAttention({
      seasonStatus: season.status,
      draftComplete: draftRostersReady(season, data),
      automation,
      importsNeedingReview: data.importsNeedingReview,
      shortTeams: shortTeams(data.teams, season.teamSize).map(
        ({ team, missing }) => ({ name: team.name, missing }),
      ),
      standinClashes: standinClashes(data.assignments, data.matches).map(
        (clash) => ({
          standin: standinName.get(clash.standinUserId) ?? "A standin",
          first: fixture(clash.first),
          second: fixture(clash.second),
        }),
      ),
      outStandins: outStandins(data.assignments, data.outRsvps, openIds).map(
        (out) => ({
          standin: standinName.get(out.userId) ?? "A standin",
          fixture: fixture(matchById.get(out.matchId)!),
        }),
      ),
      championIssue: resolveChampionPresentation(season, data.matches).issue,
      unlinkedSignups: data.unlinkedDiscord,
      unlinkedRostered: unlinkedRosterFor(season, data)?.length ?? 0,
    }),
  ];
  const matches = matchAttention(data.matches, data.teams);
  // A section folded into the season record, or not shown this phase, has no
  // jump target; its line still reads, just without a link.
  const sectionLabel = new Map(jumpItems.map((item) => [`#${item.id}`, item.label]));
  const standinsLabel = sectionLabel.get("#adm-standins");
  return (
    <Card id="adm-attention" className="scroll-mt-40 lg:scroll-mt-56">
      <CardHeader
        headingLevel={2}
        title={attentionTitle(season.name, items.length + matches.length)}
      />
      <CardBody className="space-y-3">
        {items.length > 0 ? (
          <ul className="space-y-2">
            {items.map((item) => {
              const label = sectionLabel.get(item.href);
              return (
                <li
                  key={item.key}
                  className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm"
                >
                  {item.text}
                  {label ? (
                    <>
                      {" "}
                      <a href={item.href} className={textLink()}>
                        {label} →
                      </a>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {matches.length > 0 ? (
          <details open={matches.length <= 5}>
            <summary className="min-h-11 cursor-pointer text-sm font-medium">
              {matches.length} match{matches.length === 1 ? "" : "es"} to
              review
            </summary>
            {/* One ruled list, not a box per match. */}
            <ul className="divide-y divide-line-soft rounded-lg border border-line">
              {matches.map((item) => (
                <li
                  key={item.id}
                  className="px-3 py-2 text-sm"
                >
                  {/* The fixture opens the match page's Admin tools, where
                      it can be fixed; its row in Schedule & results or
                      Playoffs here holds the same controls. */}
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
                    <Link
                      href={matchAnchorPath(item.id, MATCH_ANCHOR.admin)}
                      className={textLink()}
                    >
                      {fixture(matchById.get(item.id)!)}
                    </Link>
                    <a href={`#adm-match-${item.id}`} className={textLink("text-xs")}>
                      Result controls ↓
                    </a>
                  </span>
                  <p className="mt-0.5 text-muted">
                    {item.reasons.join(" · ")}
                    {item.uncovered > 0 && standinsLabel ? (
                      <>
                        {" "}
                        <a href="#adm-standins" className={textLink()}>
                          {standinsLabel} →
                        </a>
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {/* inline-flex min-h-6: on 12px text TAP_SAFE alone left a 22px
            target, under the 24px minimum. gap-y-2 keeps 8px between the
            two links when they wrap. */}
        <p className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
          <Link
            href={`/admin/data-quality?season=${season.id}`}
            className={textLink("inline-flex min-h-6 items-center")}
          >
            Check imported-game quality <LinkArrow />
          </Link>
          <Link
            href={`/admin/health?season=${season.id}`}
            className={textLink("inline-flex min-h-6 items-center")}
          >
            League health <LinkArrow />
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * The admin page's "what do I do next?" line, from the pure, tested
 * adminNextStep. Built once per render: the banner under the page title and
 * the phase card both read it.
 */
function adminNextStepFor(
  season: Season,
  data: AdminData,
  nowMs: number,
): AdminNextStep {
  const cap = capacityInfo(season, data.players.length);
  const nextKickoff = nextRegularKickoff(data.matches, nowMs);
  const regular = data.matches.filter((m) => m.phase === "REGULAR");
  const playoff = data.matches.filter(
    (m) => m.phase === "PLAYOFF" || m.phase === "FINAL",
  );
  const championPresentation = resolveChampionPresentation(
    season,
    data.matches,
  );
  const captainIds = new Set(data.teams.map((team) => team.captainId));
  return adminNextStep({
    seasonStatus: season.status,
    draftStatus: data.draft?.status ?? null,
    playerCount: data.players.length,
    minPlayers: cap.minPlayers,
    teamCount: data.teams.length,
    // Panel-only: the signup steps say how many teams the pool makes and
    // how many players offered to captain (Home repeats only the title).
    teamSize: season.teamSize,
    captainVolunteers: data.players.filter(
      (player) => player.wantsCaptain && !captainIds.has(player.userId),
    ).length,
    regularMatchCount: regular.length,
    untimedRegularCount: regular.filter(
      (m) =>
        m.status !== MATCH_STATUS.COMPLETED &&
        m.status !== MATCH_STATUS.LIVE &&
        !m.scheduledAt,
    ).length,
    pendingRegularResults: regular.filter((m) => m.status !== "COMPLETED")
      .length,
    outstandingRegularResults: regularResultsDue(data.matches, nowMs).length,
    nextKickoff: nextKickoff && {
      week: nextKickoff.week,
      label: formatLeagueTime(nextKickoff.at),
    },
    pendingTiebreakerResults: data.matches.filter(
      (m) => m.phase === "TIEBREAKER" && m.status !== "COMPLETED",
    ).length,
    existingTiebreakerCount: data.matches.filter(
      (match) => match.phase === MATCH_PHASE.TIEBREAKER,
    ).length,
    unresolvedPlayoffTieCount: projectPlayoffField(data.teams, data.matches)
      .seedingDeadHeatTeamIds.length,
    playoffMatchCount: playoff.length,
    unfinishedPlayoffCount: playoff.filter((m) => m.status !== "COMPLETED")
      .length,
    hasChampion: championPresentation.championTeamId != null,
    unlinkedDiscordCount: data.unlinkedDiscord,
    unverifiedCaptainMmrNames: unverifiedCaptainMmrsFor(season, data).map(
      (c) => c.name,
    ),
    hasLeagueTicket: !!season.dotaLeagueId,
  });
}

/**
 * THE ROADMAP, pinned under the page title. Several league transitions are
 * silent and fail quietly: the auction finishing does NOT advance the phase,
 * a schedule with no kickoff times disables auto-sync, reminders and pick'em
 * locks, and nothing else prompts "start the playoffs" or "record the final".
 * This line is the page's answer to "what do I do next?" in EVERY phase. It
 * used to sit inside the phase card, about 7,000px down a phone mid-season.
 */
function NextStepBanner({ nextStep }: { nextStep: AdminNextStep }) {
  return (
    <section aria-label="Next step" className="space-y-2">
      <p
        className={cn(
          "rounded-lg border px-3 py-2 text-sm",
          nextStep.tone === "action"
            ? "border-accent/30 bg-accent/10 text-fg"
            : nextStep.tone === "warning"
              ? "border-danger/40 bg-danger/10 text-fg"
              : nextStep.tone === "done"
                ? "border-success/40 bg-success/10 text-fg"
                : "border-line bg-surface-2/40 text-muted",
        )}
      >
        <b className="text-fg">{nextStep.title}</b>
        {nextStep.detail ? <> {nextStep.detail}</> : null}
        {nextStep.jump ? (
          <>
            {" "}
            <a href={nextStep.jump.href} className={textLink("whitespace-nowrap")}>
              {nextStep.jump.label} →
            </a>
          </>
        ) : null}
      </p>
      {/* A standing condition, not this phase's step: Valve needs about 15
          days to issue a ticket, so this shows from the first signup rather
          than surfacing when week 1 is already lost. The link opens the
          collapsed league-id section (the jump bar reveals it on hash). */}
      {nextStep.ticketWarning ? (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-fg">
          {nextStep.ticketWarning}{" "}
          <a href="#adm-league" className={textLink()}>
            Set the league id →
          </a>
        </p>
      ) : null}
    </section>
  );
}

function SeasonControls({
  season,
  data,
  nextStep,
}: {
  season: Season;
  data: AdminData;
  nextStep: AdminNextStep;
}) {
  const configLocked = !draftSetupOpen(season.status, data.draft?.status);
  const cap = capacityInfo(season, data.players.length);
  const playoff = data.matches.filter(
    (m) => m.phase === "PLAYOFF" || m.phase === "FINAL",
  );
  const championPresentation = resolveChampionPresentation(
    season,
    data.matches,
  );
  const hasPlayedResult = data.matches.some(
    (match) => match.status === MATCH_STATUS.COMPLETED,
  );
  const hasImportedGame = data.matches.some((match) => match.games.length > 0);
  // seasonPhasePolicy is the only authority on what a phase button may do;
  // this card only decides where each move is shown.
  const moves = SEASON_PHASE_ORDER.filter((phase) => phase !== season.status).map(
    (phase) => ({
      phase,
      state: seasonPhasePolicy({
        current: season.status,
        target: phase,
        draftStatus: data.draft?.status,
        matchCount: data.matches.length,
        regularMatchCount: data.matches.filter(
          (match) => match.phase === MATCH_PHASE.REGULAR,
        ).length,
        hasPlayedResult,
        hasImportedGame,
        postseasonMatchCount: playoff.length,
        postseasonBracketReady: recoverablePostseasonBracket(playoff),
        hasChampion: season.championTeamId != null,
      }),
    }),
  );
  const advance = phaseAdvance(season.status);
  const advanceState = advance
    ? moves.find((move) => move.phase === advance.target)?.state ?? null
    : null;
  const fixMoves = moves.filter((move) => move.phase !== advance?.target);
  // Reopening signups before the auction is routine, not a repair. Any other
  // move the policy allows means the page found a phase to put right, so the
  // disclosure opens itself.
  const reopenSignups = (phase: string) =>
    season.status === SEASON_STATUS.DRAFT && phase === SEASON_STATUS.SIGNUPS;
  const fixNeeded = fixMoves.some(
    (move) => move.state.available && !reopenSignups(move.phase),
  );
  const currentIndex = SEASON_PHASE_ORDER.indexOf(season.status as SeasonStatus);
  // The next step points here exactly when this button is the thing to do.
  const advanceIsNextStep = nextStep.jump?.href === "#adm-season";
  // What /me and /schedule print as the match night once fixtures have times.
  const fixturesNight = fixturesMatchNightLabel(data.matches);
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title={`${season.name} — phase control`}
        subtitle="Move the league on one stage at a time. Stages that change other league data start from their own controls."
        action={<Badge tone="accent">{PHASE_LABEL[season.status]}</Badge>}
      />
      <CardBody className="space-y-5">
        {/* The signup counters only mean something while signups can still
            change the draft; once it has run, the league is teams and
            fixtures. One band with the phase stepper, not a tile each: four
            tiles took two rows on a phone. */}
        <StatStrip className="bg-surface-2/30">
          {configLocked ? null : (
            <>
              <StatCell label="Players" value={data.players.length} />
              <StatCell
                label="To start"
                value={cap.minPlayers}
                hint={cap.canDraft ? "reached" : `${cap.needed} more`}
              />
            </>
          )}
          <StatCell label="Teams" value={data.teams.length} />
          <StatCell label="Matches" value={data.matches.length} />
          {/* Read-only: where the league is (moving it is the one button
              below), in the same band as the counts. */}
          <ol
            aria-label="Season phases"
            className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-xs sm:ml-auto"
          >
            {SEASON_PHASE_ORDER.map((phase, index) => (
              <li
                key={phase}
                aria-current={phase === season.status ? "step" : undefined}
                className="flex items-center gap-1.5"
              >
                {index > 0 ? (
                  <span aria-hidden="true" className="text-muted">
                    →
                  </span>
                ) : null}
                <span
                  className={cn(
                    "rounded-full border px-2.5 py-1",
                    phase === season.status
                      ? "border-accent/60 bg-accent/15 font-semibold text-fg"
                      : index < currentIndex
                        ? "border-line text-muted"
                        : "border-dashed border-line text-muted",
                  )}
                >
                  {PHASE_LABEL[phase]}
                  <span className="sr-only">
                    {phase === season.status
                      ? " (current)"
                      : index < currentIndex
                        ? " (done)"
                        : ""}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </StatStrip>

        <div className="space-y-1.5">
          {advance && advanceState ? (
            advanceState.available ? (
              <ActionForm
                action={setSeasonPhase}
                hidden={{ expectedActiveSeasonId: season.id }}
              >
                <input type="hidden" name="phase" value={advance.target} />
                <SubmitButton
                  variant={advanceIsNextStep ? "primary" : "secondary"}
                  confirm={advanceState.confirmation}
                >
                  {advance.label}
                </SubmitButton>
              </ActionForm>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  disabled
                  aria-describedby="phase-advance-reason"
                >
                  {advance.label}
                </Button>
                <p id="phase-advance-reason" className="text-xs text-muted">
                  {advanceState.reason}
                </p>
              </>
            )
          ) : null}
          <p className="text-xs text-muted">
            {advance
              ? advance.hint
              : season.status === SEASON_STATUS.REGULAR_SEASON
                ? "The playoffs start from Start playoffs in the Playoffs card, which seeds the bracket and moves the season into Playoffs in one step."
                : season.status === SEASON_STATUS.PLAYOFFS
                  ? "Complete is set automatically when the grand final crowns a champion."
                  : "The season is finished. The next one opens from Season handoff."}
          </p>
        </div>

        {/* The two folded tools share one ruled box. */}
        <div className="divide-y divide-line rounded-lg border border-line">
        <details
          open={fixNeeded}
          className="px-3 py-1 text-sm"
        >
          <summary className="flex min-h-11 cursor-pointer items-center font-medium">
            Fix the phase
          </summary>
          <div className="space-y-3 pb-3">
            <p className="text-xs text-muted">
              Only for putting the league back in the right phase after a
              mistake. These buttons never start or abort an auction, seed or
              remove a playoff bracket, or crown a champion. Use Start draft,
              Abort draft, Start playoffs, Return to regular season and the
              result controls for those, so related league data changes
              together.
            </p>
            <div className="flex flex-wrap items-start gap-3">
              {fixMoves.map(({ phase, state }) => {
                const reasonId = `phase-${phase.toLowerCase()}-reason`;
                const label = reopenSignups(phase)
                  ? "Reopen signups"
                  : `${state.recovery ? "Recover " : ""}${PHASE_LABEL[phase]}`;
                return (
                  <div key={phase} className="max-w-52">
                    {state.available ? (
                      <ActionForm
                        action={setSeasonPhase}
                        hidden={{ expectedActiveSeasonId: season.id }}
                      >
                        <input type="hidden" name="phase" value={phase} />
                        <SubmitButton
                          variant="secondary"
                          size="sm"
                          confirm={state.confirmation}
                        >
                          {label}
                        </SubmitButton>
                      </ActionForm>
                    ) : (
                      <>
                        <span title={state.reason}>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled
                            aria-describedby={reasonId}
                          >
                            {label}
                          </Button>
                        </span>
                        <span
                          id={reasonId}
                          className="mt-1 block text-[11px] leading-snug text-muted"
                        >
                          {state.reason}
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {season.status === SEASON_STATUS.COMPLETE &&
            championPresentation.championTeamId ? (
              <p className="text-xs text-muted">
                A crowned season is locked against generic phase reversal.
                Correct the grand final, or use Reset playoffs or Return to
                regular season under &ldquo;Fix the bracket&rdquo;, all in the
                Playoffs card; each recovery clears the champion and affected
                postseason state atomically.
              </p>
            ) : season.status === SEASON_STATUS.COMPLETE &&
              season.championTeamId ? (
              <p className="text-xs text-danger">
                The stored champion does not agree with one authoritative
                completed grand final. Generic phase reversal remains locked;
                use the targeted final correction when that team is a finalist,
                or &ldquo;Fix the bracket&rdquo; in the Playoffs card.
              </p>
            ) : season.status === SEASON_STATUS.PLAYOFFS ? (
              <p className="text-xs text-muted">
                To edit regular-season results, use Return to regular season
                under &ldquo;Fix the bracket&rdquo; in the Playoffs card so
                stale seeds cannot survive the phase change.
              </p>
            ) : null}
          </div>
        </details>
        {/* Set once at the start and rarely touched after (the US log shows
            none of these used past setup), so they fold away instead of
            standing between the phase controls and the rest of the page. */}
        <details
          id="adm-season-settings"
          className="px-3 py-1 text-sm"
        >
          <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 font-medium">
            Season settings
            <span className="text-xs font-normal text-muted">
              name, soft MMR limit, draft settings, match night, series
              lengths
            </span>
          </summary>
          <div className="space-y-3 pb-3">
            <ActionForm
              action={renameSeason}
              hidden={{
                expectedActiveSeasonId: season.id,
                expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
              }}
              className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm"
            >
              <label htmlFor="seasonName" className="text-muted">
                Season name
              </label>
              <input
                id="seasonName"
                name="name"
                type="text"
                maxLength={60}
                defaultValue={season.name}
                className="h-9 w-80 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-sm"
              />
              <SubmitButton variant="secondary" size="sm">
                Save name
              </SubmitButton>
              <span className="text-xs text-muted">
                the big title on the home page
              </span>
            </ActionForm>
            <ActionForm
              action={setMaxMmr}
              hidden={{
                expectedActiveSeasonId: season.id,
                expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
              }}
              className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm"
            >
              <label htmlFor="seasonMaxMmr" className="text-muted">
                Soft MMR limit
              </label>
              <input
                id="seasonMaxMmr"
                name="maxMmr"
                type="number"
                min={0}
                max={HARD_MMR_CEILING}
                defaultValue={season.maxMmr}
                className="h-9 w-28 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
              />
              <SubmitButton variant="secondary" size="sm">
                Save limit
              </SubmitButton>
              <span className="text-xs text-muted">
                {season.maxMmr >= HARD_MMR_CEILING
                  ? `equals the hard ceiling ${HARD_MMR_CEILING}, so it flags nobody and player pages don't mention it · set it lower to flag signups for review, or 0 to turn it off`
                  : season.maxMmr > 0
                    ? `soft limit: signups over ${season.maxMmr} MMR still join the pool, flagged “over soft limit” under Needs review on Captains & draft · only the hard ceiling ${HARD_MMR_CEILING} refuses (no Immortals)`
                    : `no soft limit · hard ceiling ${HARD_MMR_CEILING} (no Immortals)`}
              </span>
            </ActionForm>
            {/* Editable until the auction starts. These used to be write-once at
                Create season, so changing your mind about team size or budget meant
                creating a NEW season and orphaning every signup so far. */}
            <ActionForm
              action={setDraftSettings}
              hidden={{
                expectedActiveSeasonId: season.id,
                expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
              }}
              className="flex flex-wrap items-end gap-2 border-t border-line pt-3 text-sm"
            >
              <Field label="Team size" htmlFor="cfgTeamSize">
                <input
                  id="cfgTeamSize"
                  name="teamSize"
                  type="number"
                  min={2}
                  max={10}
                  defaultValue={season.teamSize}
                  className="h-9 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
                />
              </Field>
              <Field label="Min teams" htmlFor="cfgMinTeams">
                <input
                  id="cfgMinTeams"
                  name="minTeams"
                  type="number"
                  min={2}
                  max={32}
                  defaultValue={season.minTeams}
                  className="h-9 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
                />
              </Field>
              <Field label="Draft budget ($)" htmlFor="cfgBudget">
                <input
                  id="cfgBudget"
                  name="draftBudget"
                  type="number"
                  min={10}
                  defaultValue={season.draftBudget}
                  className="h-9 w-28 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
                />
              </Field>
              <Field label="Budget MMR weight %" htmlFor="cfgWeight">
                <input
                  id="cfgWeight"
                  name="budgetMmrWeight"
                  type="number"
                  min={0}
                  max={50}
                  defaultValue={season.budgetMmrWeight}
                  className="h-9 w-28 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
                />
              </Field>
              <SubmitButton variant="secondary" size="sm" disabled={configLocked}>
                Save draft settings
              </SubmitButton>
              <span className="text-xs text-muted">
                {configLocked
                  ? draftSetupLockedMessage(season.status, data.draft?.status)
                  : "applied when the draft starts"}
              </span>
            </ActionForm>
            <ActionForm
              action={setMatchSchedule}
              hidden={{
                expectedActiveSeasonId: season.id,
                expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
              }}
              className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm"
            >
              <label htmlFor="matchSchedule" className="text-muted">
                Match night
              </label>
              <input
                id="matchSchedule"
                name="matchSchedule"
                type="text"
                maxLength={80}
                defaultValue={season.matchSchedule ?? ""}
                placeholder={MATCH_SCHEDULE.label}
                className="h-9 w-80 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-sm"
              />
              <SubmitButton variant="secondary" size="sm">
                Save schedule
              </SubmitButton>
              <span className="text-xs text-muted">
                {/* Once fixtures have kickoffs, pages print the night most of
                    them use (a single moved week doesn't change it). */}
                {fixturesNight
                  ? `players now see the night most fixtures use: ${fixturesNight}`
                  : `shown before signup${season.matchSchedule ? "" : " · using default"}`}
              </span>
            </ActionForm>
            <ActionForm
              action={setSeriesLengths}
              hidden={{
                expectedActiveSeasonId: season.id,
                expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
              }}
              className="flex flex-wrap items-end gap-3 border-t border-line pt-3 text-sm"
            >
              <SeriesField
                label="Regular season"
                name="regularBestOf"
                value={season.regularBestOf}
                options={[1, 2, 3]}
              />
              <SeriesField
                label="Playoffs"
                name="playoffBestOf"
                value={season.playoffBestOf}
                options={[1, 3, 5, 7]}
              />
              <SeriesField
                label="Grand final"
                name="finalBestOf"
                value={season.finalBestOf}
                options={[1, 3, 5, 7]}
              />
              <SubmitButton variant="secondary" size="sm">
                Save series lengths
              </SubmitButton>
              {/* Each Match row carries its own length, copied when it is
                  created. Saving once wrote only the Season, so an existing
                  grand final stayed Bo5 under a "Bo3" setting; setSeriesLengths
                  now moves every fixture that has not started, and its toast
                  names what moved and what it left. */}
              <span className="text-xs text-muted">
                games per match — saving also updates every match that hasn&apos;t
                kicked off yet. Matches already played or under way keep their
                length, and tiebreakers keep theirs.
              </span>
            </ActionForm>
          </div>
        </details>
        </div>
      </CardBody>
    </Card>
  );
}

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

function CaptainControls({
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
  // The sale Undo last sale would revert — the newest AUCTION purchase
  // (price > 0; $0 rows are free-agent signings), the same row undoLastSale
  // picks — so the confirm can name it like the draft room's does.
  const lastAuctionSale =
    data.teams
      .flatMap((t) =>
        t.members
          .filter((m) => !m.isCaptain && m.price > 0)
          .map((m) => ({
            id: m.id,
            at: m.createdAt.getTime(),
            sale: { name: m.user.name, teamName: t.name, price: m.price },
          })),
      )
      .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))[0]?.sale ??
    null;
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
                auto-draft someone onto that team. The action refuses too. */}
            {draftStarted && season.status === SEASON_STATUS.DRAFT ? (
              <ActionForm
                action={undoLastSaleAction}
                hidden={{ expectedActiveSeasonId: season.id }}
              >
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  /* The COMPLETE case is the one the old copy hid. This button
                     renders whenever the draft has started and the season is
                     still in DRAFT — which includes a FINISHED auction, i.e.
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
                              confirm={`Reinstate ${t.name}? They rejoin playoff-seeding contention. Forfeited fixtures stay as recorded — reverse any you want undone with "Reopen for import" on each row.`}
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
                      one-picker form, so the per-team REAL number (confirms
                      must name real numbers) rides in the option label:
                      standin bookings on the fixtures this withdrawal would
                      forfeit — either side's, since the opponent's cover dies
                      with the fixture too. */}
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
                        return (
                          <option key={t.id} value={t.id}>
                            {t.name}
                            {n > 0
                              ? ` — ${n} standin booking(s) on their open fixtures`
                              : ""}
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
                    "Open reschedule proposals on those fixtures are cancelled.",
                    "Standins booked on those fixtures — either side's — are stood down with an @-mention.",
                    "The team is excluded from playoff seeding — its played results and roster are kept.",
                  ]}
                  recovery={`"Reinstate" (beside the team above) undoes the exclusion, and each forfeited fixture is individually reversible with "Reopen for import" — forfeits carry no games.`}
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

function TiebreakerControls({
  season,
  data,
  nowMs,
}: {
  season: Season;
  data: AdminData;
  nowMs: number;
}) {
  const projection = projectPlayoffField(data.teams, data.matches);
  const brackets = buildTiebreakerBrackets({ projection, teams: data.teams, matches: data.matches });
  const tiebreakerMatches = data.matches.filter((match) => match.phase === MATCH_PHASE.TIEBREAKER);
  const hasBo1Bracket = brackets.groups.some((bracket) => bracket.format === "BO1_DOUBLE_ELIMINATION");
  const hasSingle = brackets.groups.some((bracket) => bracket.format === "BO1_SINGLE_ELIMINATION");
  const postseasonStarted = season.status !== SEASON_STATUS.REGULAR_SEASON ||
    data.matches.some((match) => match.phase === MATCH_PHASE.PLAYOFF || match.phase === MATCH_PHASE.FINAL);
  const canSchedule = !postseasonStarted && regularSeasonStatus(data.matches).allComplete &&
    schedulableAdminTiebreakerGroups(projection.tiebreakers).length > 0;
  const pending = tiebreakerMatches.filter((match) => match.status !== MATCH_STATUS.COMPLETED);
  const names = new Map(data.teams.map((team) => [team.id, team.name]));
  return (
    <Card>
      <CardHeader headingLevel={2} title="Tiebreakers" subtitle="Full bracket, match times and results — before playoffs." action={
        <Link href="/schedule#tiebreakers" className={textLink("text-sm")}>Player view →</Link>
      } />
      <CardBody className="space-y-5">
        <div className="space-y-2 rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm">
          {hasSingle ? <p>Record or import each BO1 result below. Ready opponents get their next match automatically, in the same week, with no scheduled break. Independent brackets continue in parallel.</p> : hasBo1Bracket ? (
            <p>Only games with decided opponents have match controls. Finalizing or importing a result creates the next game automatically. Games 2–5 stay in the same tiebreaker week; Game 5 is only created if needed.</p>
          ) : (
            <p>Manage each created tiebreaker match below. Finish all required tiebreakers before starting playoffs.</p>
          )}
          {hasBo1Bracket && !postseasonStarted ? (
            <p className="text-xs text-muted">Keep the season in Regular season. Check the next game’s kickoff after each result; if the opening game has no time, set each new game’s time below.</p>
          ) : null}
          {canSchedule ? (
            <a href="#adm-playoffs" className={textLink("inline-block py-1")}>
              {tiebreakerMatches.length > 0 ? "Next match is ready to create — open tiebreaker controls →" : "Schedule the opening matches in Playoffs controls →"}
            </a>
          ) : null}
          {pending.length > 0 && !postseasonStarted ? (
            <div className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Current tiebreaker matches">
              {pending.map((match) => (
                <a key={match.id} href={`#admin-tiebreaker-match-${match.id}`} className={textLink("py-1")}>
                  Manage {match.bestOf === 1 ? "game" : "series"}: {names.get(match.homeTeamId ?? "")} vs {names.get(match.awayTeamId ?? "")} →
                </a>
              ))}
            </div>
          ) : null}
          {projection.tiebreakers.resolved && tiebreakerMatches.length > 0 && !postseasonStarted ? (
            <p>Tiebreakers complete. <a href="#adm-playoffs" className={textLink()}>Review the seeds and start playoffs →</a></p>
          ) : null}
          {postseasonStarted ? <p className="text-xs text-muted">Tiebreaker results are read-only once playoffs begin.</p> : null}
        </div>
        {brackets.error ? <p role="alert" className="text-sm text-danger">{brackets.error} Review the recorded matches below and the recovery controls in Playoffs.</p> : null}
        {brackets.groups.map((bracket) => (
          <TiebreakerBracket key={bracket.key} bracket={bracket} teams={data.teams} postseasonStarted={postseasonStarted} admin />
        ))}
        {tiebreakerMatches.length > 0 ? (
          <>
            <h3 className="font-medium">Match controls</h3>
            <MatchRowsHelp
              id="adm-import-help-tiebreaker"
              seasonStatus={season.status}
              draftStatus={data.draft?.status ?? null}
              canImport={
                matchResultsOpen(season.status, MATCH_PHASE.TIEBREAKER) &&
                pending.length > 0
              }
              hasScheduled={tiebreakerMatches.some(
                (m) => m.status === MATCH_STATUS.SCHEDULED,
              )}
              notes={[resultsLockNote(season.status, MATCH_PHASE.TIEBREAKER)]}
            />
          </>
        ) : null}
        {[...new Set(tiebreakerMatches.map((m) => m.week))].map((week) => {
          const weekMatches = tiebreakerMatches.filter(
            (m) => m.week === week,
          );
          const pending = weekMatches.filter(
            (m) => m.status !== "COMPLETED",
          ).length;
          return (
            <details
              key={`tb${week}`}
              open
              className="rounded-lg border border-accent/40"
            >
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                Tiebreaker week · Week {week} · {weekMatches.every((match) => match.bestOf === 1) ? "Best of 1" : weekMatches.every((match) => match.bestOf === 3) ? "Best of 3" : "Best of 1 / Best of 3"}
                <span className="ml-2 text-xs font-normal text-muted">
                  {weekMatches.length - pending}/{weekMatches.length}{" "}
                  created matches entered
                </span>
              </summary>
              <div className="space-y-2 px-3 pb-3">
                {weekMatches.map((m) => (
                  <div key={m.id} id={`admin-tiebreaker-match-${m.id}`} data-testid="admin-tiebreaker-match" className="scroll-mt-40 lg:scroll-mt-56">
                    <MatchResultRow
                      id={adminMatchRowId(m.id)}
                      m={m}
                      teams={data.teams}
                      expectedActiveSeasonId={season.id}
                      seasonStatus={season.status}
                      leagueId={season.dotaLeagueId}
                      nowMs={nowMs}
                      draftStatus={data.draft?.status ?? null}
                      championTeamId={season.championTeamId}
                      {...matchCorrectionContext(m, data.matches)}
                      importHelpId="adm-import-help-tiebreaker"
                      label={
                        <Link
                          href={`/matches/${m.id}`}
                          className={textLink("shrink-0 text-xs")}
                        >
                          TB · {parseTiebreakerStage(m.bracketSlot) ? `Game ${parseTiebreakerStage(m.bracketSlot)!.stage}` : `Wk ${m.week}`} · BO{m.bestOf}
                        </Link>
                      }
                    />
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </CardBody>
    </Card>
  );
}

function ScheduleControls({
  season,
  data,
  nowMs,
}: {
  season: Season;
  data: AdminData;
  nowMs: number;
}) {
  const status = regularSeasonStatus(data.matches);
  // Only fixtures past kickoff (or live) are missing a result.
  const due = regularSeasonStatus(regularResultsDue(data.matches, nowMs));
  const nextKickoff = nextRegularKickoff(data.matches, nowMs);
  const regularMatches = data.matches.filter((m) => m.phase === "REGULAR");
  const regularCount = regularMatches.length;
  const regularResultsOpen = matchResultsOpen(
    season.status,
    MATCH_PHASE.REGULAR,
  );
  const tiebreakerMatches = data.matches.filter(
    (m) => m.phase === "TIEBREAKER",
  );
  const playoffField = projectPlayoffField(data.teams, data.matches);
  const collateral = data.collateral;
  const draftStatus = data.draft?.status ?? null;
  const scheduleEditingOpen = postAuctionWorkOpen(season.status, draftStatus);
  const scheduleEditingLockedReason = scheduleEditingOpen
    ? null
    : season.status === SEASON_STATUS.COMPLETE
      ? "The completed season is read-only. Use the postseason or phase recovery controls before changing fixtures."
      : season.status === SEASON_STATUS.SIGNUPS
        ? "Fixtures open after captain setup and the auction are complete."
        : season.status === SEASON_STATUS.DRAFT
          ? "Finish the auction before generating or moving fixtures."
          : "Fixture editing is locked in the current league phase.";
  const resultsLanded =
    status.completed > 0 ||
    data.matches.some((match) => match.games.length > 0);
  const withdrawnTeams = data.teams.filter((team) => team.withdrawn);
  const scheduleGenerationLockedReason =
    scheduleEditingLockedReason ??
    (resultsLanded
      ? "A regular-season result or imported game already exists. Correct fixtures individually; replacing the round robin would discard recorded competition."
      : withdrawnTeams.length > 0
        ? `${withdrawnTeams.map((team) => team.name).join(", ")} ${withdrawnTeams.length === 1 ? "is" : "are"} withdrawn. Reinstate ${withdrawnTeams.length === 1 ? "that team" : "those teams"} before generating or replacing the round robin.`
        : data.teams.length < 2
          ? "At least two drafted teams are required before a schedule can be generated."
          : null);
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Schedule & results"
        subtitle="Generate the round-robin and enter weekly scores."
        action={
          // The lock reason sits where the control would be, not in a banner
          // over the card: once any result exists it is true all season.
          scheduleGenerationLockedReason ? (
            <p className="max-w-sm text-xs text-muted">
              {regularCount > 0 ? "Regenerate schedule" : "Generate schedule"}{" "}
              is unavailable: {scheduleGenerationLockedReason}
            </p>
          ) : (
            <ActionForm
              action={generateSchedule}
              hidden={{ expectedActiveSeasonId: season.id }}
              className="flex flex-wrap items-center gap-2"
            >
              <label
                htmlFor="firstNight"
                className="text-xs text-muted"
                title="Week 1 plays at this time on the league's clock; each later week (and playoff round) is +7 days at the same time."
              >
                First match night
              </label>
              {/* Required: a fixture with no kickoff gets no check-in, no
                  reminder, no automatic results and no pick'em lock. */}
              <LocalDatetimeField
                id="firstNight"
                name="firstNight"
                tsName="firstNightTs"
                required
                defaultTs={season.firstMatchNight?.getTime()}
                timeZone={LEAGUE_CONFIG.timeZone}
                className="h-8 rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg"
              />
              {/* The lib always supported the mirrored second leg; this box is
                what finally wires it. Decide BEFORE generating: switching
                later is a full Regenerate, which clears every check-in, pick
                and booking on the old fixtures. */}
              <label
                className="flex items-center gap-1.5 text-xs text-muted"
                title="Every pairing plays twice, home/away swapped — roughly doubles the season length. Best for small leagues (4-6 teams), whose single round robin is only 3-5 weeks."
              >
                <input
                  type="checkbox"
                  name="doubleRound"
                  className="h-3.5 w-3.5 accent-[var(--color-brand)]"
                />
                double round robin
              </label>
              {/* GENERATE and REGENERATE are the same action and were the same
                button. The first is routine; the second deletes every regular
                fixture and recreates the identical pairings with NEW ids, so
                every check-in, pick'em pick, arranged standin booking and open
                reschedule proposal cascades away — none of which is archived
                anywhere, and mid-season that is cover captains spent days
                arranging. Different controls, so the routine one can stay
                cheap. */}
              {regularCount > 0 ? (
                <DangerSubmit
                  token={season.name}
                  title="Replace the regular-season schedule?"
                  consequences={[
                    `All ${regularCount} regular-season fixture(s) are deleted and recreated — same pairings, new ids.`,
                    ...(collateral.rsvps
                      ? [`${collateral.rsvps} player check-in(s) are cleared.`]
                      : []),
                    ...(collateral.picks
                      ? [`${collateral.picks} pick'em pick(s) are deleted.`]
                      : []),
                    ...(collateral.covers
                      ? [
                          `${collateral.covers} standin booking(s) are cancelled — captains will have to arrange that cover again.`,
                        ]
                      : []),
                    ...(collateral.proposals
                      ? [
                          `${collateral.proposals} open reschedule proposal(s) are cancelled.`,
                        ]
                      : []),
                  ]}
                  recovery="Playoff matches are untouched, and the fixtures themselves regenerate identically. None of the check-ins, picks or bookings can be restored."
                >
                  Regenerate schedule
                </DangerSubmit>
              ) : (
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  confirm="Generate the regular-season schedule?"
                >
                  Generate schedule
                </SubmitButton>
              )}
            </ActionForm>
          )
        }
      />
      <CardBody>
        {data.matches.length === 0 ? (
          <p className="text-sm text-muted">
            No fixtures have been generated for this season.
          </p>
        ) : (
          <div className="space-y-2">
            {status.total > 0 ? (
              <div
                className={`rounded-lg border px-3 py-2 text-sm ${
                  due.pending > 0
                    ? "border-accent/40 bg-accent/10"
                    : status.pending > 0
                      ? "border-line bg-surface-2/30"
                      : "border-success/40 bg-success/10 text-success"
                }`}
              >
                {/* `status` counts REGULAR matches only, so once the last one
                    is in this line was true forever — it kept telling the admin
                    to "start the playoffs" all through the postseason and next
                    to a crowned champion, pointing at a button that by then says
                    RESET and deletes the whole bracket. Branch on the phase. */}
                {/* Only fixtures past kickoff are missing a result; on day
                    one every fixture is still to play, and "15 matches still
                    need results, enter them" asked for scores nobody had. */}
                {due.pending > 0
                  ? `⏳ ${pendingResultsMessage(due)} Enter them to keep standings & seeding correct.`
                  : status.pending > 0
                    ? `${status.pending} regular-season fixture${status.pending === 1 ? "" : "s"} still to play${
                        nextKickoff
                          ? `. Week ${nextKickoff.week} kicks off ${formatLeagueTime(nextKickoff.at)}`
                          : ""
                      }. Results are due from kickoff.`
                    : season.status === SEASON_STATUS.PLAYOFFS
                      ? `✓ All ${status.total} regular-season results in — the bracket is running. Enter playoff scores in the Playoffs card.`
                      : season.status === SEASON_STATUS.COMPLETE
                        ? `✓ Season complete — all ${status.total} regular-season results recorded.`
                        : playoffField.seedingDeadHeatTeamIds.length > 0 ||
                            playoffField.tiebreakers.error
                          ? `All ${status.total} regular-season results in — finish the bracket in Tiebreakers above before starting playoffs.`
                          : `✓ All ${status.total} results in — ready to start the playoffs.`}
              </div>
            ) : null}
            <MatchRowsHelp
              id="adm-import-help-regular"
              seasonStatus={season.status}
              draftStatus={draftStatus}
              canImport={
                regularResultsOpen &&
                tiebreakerMatches.length === 0 &&
                status.pending > 0
              }
              hasScheduled={regularMatches.some(
                (m) => m.status === MATCH_STATUS.SCHEDULED,
              )}
              notes={[
                regularCount > 0
                  ? resultsLockNote(season.status, MATCH_PHASE.REGULAR)
                  : null,
                regularResultsOpen && tiebreakerMatches.length > 0
                  ? "Tiebreaker games depend on the regular-season results. Use Reset tiebreaker week in the Playoffs card before correcting one."
                  : null,
              ]}
            />
            <PendingReschedules seasonId={season.id} teams={data.teams} />
            {(() => {
              const openWeeks = [
                ...new Set(
                  data.matches
                    .filter((m) => m.status === MATCH_STATUS.SCHEDULED)
                    .map((m) => m.week),
                ),
              ].sort((a, b) => a - b);
              return scheduleEditingOpen && openWeeks.length > 0 ? (
                <ActionForm
                  action={setWeekNight}
                  hidden={{ expectedActiveSeasonId: season.id }}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2/30 p-3 text-xs"
                >
                  <span className="font-medium text-fg">
                    Move a match night
                  </span>
                  <select
                    name="week"
                    aria-label="Week to move"
                    className="h-8 rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg"
                  >
                    {openWeeks.map((w) => (
                      <option key={w} value={w}>
                        Week {w}
                      </option>
                    ))}
                  </select>
                  <span aria-label="New match night" role="group">
                    <LocalDatetimeField
                      name="night"
                      tsName="nightTs"
                      timeZone={LEAGUE_CONFIG.timeZone}
                      className="h-8 rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg"
                    />
                  </span>
                  <label className="flex items-center gap-1.5 text-muted">
                    <input type="checkbox" name="cascade" />
                    shift later weeks too
                  </label>
                  {/* This had NO confirmation, and with the cascade ticked it
                      retimes every LATER week too and deletes the check-ins on
                      all of them — the widest-reaching unconfirmed control on
                      the page. The times can be moved back; the check-ins
                      cannot, so ten players per fixture have to be asked again.
                      The dialog cannot know whether the cascade box is ticked
                      (it is server-rendered), so it names both effects. */}
                  <SubmitButton
                    variant="secondary"
                    size="sm"
                    confirm={`Move this week's match night?\n\nEvery scheduled match in the week is retimed and its check-ins are cleared — players will have to check in again. Live and final matches stay on their recorded kickoff. If "shift later weeks too" is ticked, every later scheduled week moves by the same amount and loses its check-ins as well.`}
                  >
                    Move night
                  </SubmitButton>
                  <span className="w-full text-muted">
                    Retimes every scheduled match in the week and clears its
                    check-ins and any open reschedule proposals; the cascade
                    keeps the weekly rhythm by moving later scheduled weeks by
                    the same amount.
                  </span>
                </ActionForm>
              ) : null;
            })()}
            {/* Regular season, grouped by week — completed weeks collapse so
                the enter-scores workflow starts at the week that needs it.
                One ruled box: a bordered box per week spent a gap on each. */}
            {status.weeks.length > 0 ? (
            <div className="divide-y divide-line rounded-lg border border-line">
            {status.weeks.map((w) => {
              const weekMatches = data.matches.filter(
                (m) => m.phase === "REGULAR" && m.week === w.week,
              );
              return (
                <details
                  key={`w${w.week}`}
                  open={w.pending > 0}
                >
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                    Week {w.week}
                    <span className="ml-2 text-xs font-normal text-muted">
                      {w.completed}/{w.total} entered
                    </span>
                    {w.pending === 0 ? (
                      <Badge tone="success" className="ml-2">
                        done
                      </Badge>
                    ) : null}
                  </summary>
                  <div className="space-y-2 px-3 pb-3">
                    {weekMatches.map((m) => (
                      <MatchResultRow
                        key={m.id}
                        id={adminMatchRowId(m.id)}
                        m={m}
                        teams={data.teams}
                        expectedActiveSeasonId={season.id}
                        seasonStatus={season.status}
                        leagueId={season.dotaLeagueId}
                        nowMs={nowMs}
                        draftStatus={data.draft?.status ?? null}
                        championTeamId={season.championTeamId}
                        {...matchCorrectionContext(m, data.matches)}
                        laterRoundNote="none"
                        importHelpId="adm-import-help-regular"
                        label={
                          <Link
                            href={`/matches/${m.id}`}
                            className={textLink("w-14 shrink-0 text-xs")}
                          >
                            Wk {m.week}
                          </Link>
                        }
                      />
                    ))}
                  </div>
                </details>
              );
            })}
            </div>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The bracket's series with their result controls, in the Playoffs card:
 * the series still to play first, then the decided ones folded away (open
 * once nothing is left to play, so the grand-final correction is in view).
 * They used to sit at the bottom of Schedule & results, so on match night
 * the Playoffs card held only its two reset buttons.
 */
function PlayoffSeries({
  season,
  data,
  playoff,
  nowMs,
}: {
  season: Season;
  data: AdminData;
  playoff: AdminData["matches"];
  nowMs: number;
}) {
  const { totalRounds } = groupPlayoffRounds(playoff);
  const toPlay = playoff.filter((m) => m.status !== MATCH_STATUS.COMPLETED);
  const decided = playoff.filter((m) => m.status === MATCH_STATUS.COMPLETED);
  // Labelled by round so the admin entering a bracket-advancing result can
  // tell the final from a semifinal.
  const row = (m: AdminData["matches"][number]) => (
    <MatchResultRow
      key={m.id}
      id={adminMatchRowId(m.id)}
      m={m}
      teams={data.teams}
      expectedActiveSeasonId={season.id}
      seasonStatus={season.status}
      leagueId={season.dotaLeagueId}
      nowMs={nowMs}
      draftStatus={data.draft?.status ?? null}
      championTeamId={season.championTeamId}
      {...matchCorrectionContext(m, data.matches)}
      laterRoundNote="short"
      importHelpId="adm-import-help-playoffs"
      label={
        <Link href={`/matches/${m.id}`} className={textLink("shrink-0 text-xs")}>
          {roundName(slotRound(m.bracketSlot), totalRounds)}
        </Link>
      }
    />
  );
  const anyLaterRound = decided.some((m) =>
    hasLaterBracketRound(playoff, m.bracketSlot),
  );
  return (
    <div className="space-y-2">
      <MatchRowsHelp
        id="adm-import-help-playoffs"
        seasonStatus={season.status}
        draftStatus={data.draft?.status ?? null}
        canImport={
          matchResultsOpen(season.status, MATCH_PHASE.PLAYOFF) &&
          toPlay.length > 0
        }
        hasScheduled={toPlay.some((m) => m.status === MATCH_STATUS.SCHEDULED)}
        notes={[resultsLockNote(season.status, MATCH_PHASE.PLAYOFF)]}
      />
      {toPlay.length > 0 ? (
        <section
          aria-labelledby="playoff-series-to-play"
          className="space-y-2 rounded-lg border border-accent/40 p-3"
        >
          <h3 id="playoff-series-to-play" className="text-sm font-medium">
            Series to play
            <span className="ml-2 text-xs font-normal text-muted">
              {decided.length}/{playoff.length} entered
            </span>
          </h3>
          {toPlay.map(row)}
        </section>
      ) : null}
      {decided.length > 0 ? (
        <details
          open={toPlay.length === 0}
          className="rounded-lg border border-line"
        >
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
            Decided series
            <span className="ml-2 text-xs font-normal text-muted">
              {decided.length}
            </span>
          </summary>
          <div className="space-y-2 px-3 pb-3">
            {anyLaterRound ? (
              <p className="text-xs text-muted">{LATER_ROUND_NOTE}</p>
            ) : null}
            {decided.map(row)}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function PlayoffControls({
  season,
  data,
  nowMs,
}: {
  season: Season;
  data: AdminData;
  nowMs: number;
}) {
  const playoffMatches = data.matches.filter(
    (m) => m.phase === "PLAYOFF" || m.phase === "FINAL",
  );
  const championPresentation = resolveChampionPresentation(
    season,
    data.matches,
  );
  const playoffField = projectPlayoffField(data.teams, data.matches);
  const bracketSize = playoffField.bracketSize;
  const status = regularSeasonStatus(data.matches);
  const dueRegular = regularSeasonStatus(regularResultsDue(data.matches, nowMs));
  const teamNameById = new Map(data.teams.map((t) => [t.id, t.name]));
  const tiebreakerMatches = data.matches.filter(
    (m) => m.phase === "TIEBREAKER",
  );
  const tiebreakerGameCount = tiebreakerMatches.reduce(
    (count, m) => count + m.games.length,
    0,
  );
  const unresolvedTeams = playoffField.seedingDeadHeatTeamIds.map(
    (teamId) => teamNameById.get(teamId) ?? teamId,
  );
  const tiebreakerLockedReason =
    playoffField.tiebreakers.error ??
    (unresolvedTeams.length > 0
      ? playoffField.tiebreakers.pending
        ? "Complete every scheduled tiebreaker series before starting playoffs."
        : "Schedule the tiebreaker week to settle playoff qualification and seeding."
      : null);
  const schedulableTiebreakers = schedulableAdminTiebreakerGroups(playoffField.tiebreakers);
  const scheduleTiebreakersOpen =
    season.status === SEASON_STATUS.REGULAR_SEASON &&
    status.allComplete &&
    playoffMatches.length === 0 &&
    schedulableTiebreakers.length > 0;
  const champion = championPresentation.championTeamId
    ? data.teams.find((t) => t.id === championPresentation.championTeamId)
    : null;
  const storedChampion = season.championTeamId
    ? data.teams.find((team) => team.id === season.championTeamId)
    : null;
  // Reset is the only correction path once a round has advanced, and Game
  // cascades with Match — so name what it actually costs rather than the old
  // "Existing playoff games are removed", which reads like housekeeping.
  const playoffGameCount = playoffMatches.reduce(
    (n, m) => n + m.games.length,
    0,
  );
  const commandClaim = {
    expectedActiveSeasonId: season.id,
    expectedSeasonStatus: season.status,
    expectedRevision: playoffSetupRevision({
      season,
      teams: data.teams,
      matches: data.matches,
    }),
  };
  const startPlayoffsLockedReason =
    season.status !== SEASON_STATUS.REGULAR_SEASON
      ? season.status === SEASON_STATUS.PLAYOFFS ||
        season.status === SEASON_STATUS.COMPLETE
        ? "A new bracket can only start from Regular season. With no bracket to preserve, return to Regular season in phase control, verify the table, then start it here."
        : "Move the league to Regular season before seeding a new playoff bracket."
      : status.total === 0
        ? "Generate and complete the regular-season schedule before starting playoffs."
        : status.pending > 0
          ? `${status.pending} regular-season result${status.pending === 1 ? " is" : "s are"} still outstanding.`
          : playoffField.eligibleTeamIds.length < 2
            ? "At least two non-withdrawn teams are needed before a bracket can be seeded."
            : tiebreakerLockedReason;
  const resetPlayoffsLockedReason =
    season.status !== SEASON_STATUS.PLAYOFFS &&
    season.status !== SEASON_STATUS.COMPLETE
      ? "A bracket can only be reset while the season is in Playoffs or Complete."
      : status.total === 0
        ? "Generate and complete the regular-season schedule before reseeding playoffs."
        : status.pending > 0
          ? `${status.pending} regular-season result${status.pending === 1 ? " is" : "s are"} still outstanding.`
          : playoffField.eligibleTeamIds.length < 2
            ? "At least two non-withdrawn teams are needed before the bracket can be reseeded."
            : tiebreakerLockedReason;

  return (
    <Card id="playoffs" className="scroll-mt-20">
      <CardHeader
        headingLevel={2}
        title="Playoffs"
        subtitle="Seed the top teams into a single-elimination bracket, then enter each series here."
        action={
          /* START and RESET are the same action, and used to be the same
             button in the same pixel of the card header — so muscle memory
             aimed at "Start playoffs" hits "Reset playoffs" once a bracket
             exists. They are different controls: Start stays an ordinary
             button up here, and Reset lives in "Fix the bracket" below as a
             type-to-confirm, because it deletes the whole postseason and the
             playoff RSVPs, standin bookings and pick'em picks are not
             archived by anything. */
          playoffMatches.length > 0 ? null : (
            <ActionForm
              action={startPlayoffs}
              hidden={{ ...commandClaim, intent: "start" }}
            >
              <SubmitButton
                variant="secondary"
                size="sm"
                disabled={startPlayoffsLockedReason != null}
                confirm="Seed and start the playoff bracket?"
              >
                Start playoffs
              </SubmitButton>
            </ActionForm>
          )
        }
      />
      <CardBody className="space-y-2 text-sm">
        {champion ? (
          <div className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2">
            🏆 Champion: <b>{champion.name}</b>
          </div>
        ) : null}
        {season.status === SEASON_STATUS.COMPLETE &&
        championPresentation.issue ? (
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger-soft">
            <b>Champion state needs review.</b>{" "}
            {storedChampion
              ? `${storedChampion.name} is stored as champion, but that record does not match one authoritative completed grand-final winner.`
              : "No authoritative champion is stored for this completed season."}{" "}
            Reconcile the final with its result controls below, or use
            &ldquo;Fix the bracket&rdquo;; public pages do not attribute the
            title while this conflict exists.
          </div>
        ) : null}
        {/* Outstanding results get the red line below, which also names the
            weeks; repeating them here said the same thing twice. */}
        {playoffMatches.length === 0 &&
        startPlayoffsLockedReason &&
        !(season.status === SEASON_STATUS.REGULAR_SEASON && status.pending > 0) ? (
          <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-xs text-muted">
            Start playoffs is unavailable: {startPlayoffsLockedReason}
          </div>
        ) : null}
        {status.pending > 0 && playoffMatches.length === 0 ? (
          dueRegular.pending > 0 ? (
            // The count past kickoff, like the next step and the Schedule
            // card above: counting every unplayed fixture here asked for
            // scores of games that kick off later tonight.
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger-soft">
              ⚠ {dueRegular.pending} regular-season result
              {dueRegular.pending === 1 ? "" : "s"} past kickoff still needed (
              {weekList(dueRegular.pendingWeeks)})
              {status.pending > dueRegular.pending
                ? `, ${status.pending - dueRegular.pending} still to play`
                : ""}{" "}
              — the playoffs are locked until every regular-season result is
              in.
            </div>
          ) : (
            // Nothing is overdue: these fixtures just haven't been played, so
            // a red warning on day one would be crying wolf.
            <p className="text-xs text-muted">
              The playoffs unlock once every regular-season result is in (
              {status.pending} fixture{status.pending === 1 ? "" : "s"} still
              to play).
            </p>
          )
        ) : null}
        {/* Every team reads as "tied" at zero matches, so gating this on
            unresolved ties alone printed the whole tiebreaker rulebook from
            signups on. The rules matter once the regular season is over;
            before that, one line says ties are provisional. */}
        {unresolvedTeams.length > 0 &&
        !status.allComplete &&
        status.completed > 0 &&
        tiebreakerMatches.length === 0 &&
        !playoffField.tiebreakers.error &&
        playoffMatches.length === 0 ? (
          <p className="text-xs text-muted">
            Ties on the table are provisional until the regular season ends.
            Any tie that still decides qualification or seeding then needs a
            tiebreaker week, set up here.
          </p>
        ) : null}
        {((unresolvedTeams.length > 0 && status.allComplete) ||
          tiebreakerMatches.length > 0 ||
          playoffField.tiebreakers.error) &&
        playoffMatches.length === 0 ? (
          <div className="space-y-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-3">
            <h3 className="font-medium">Playoff tiebreaker week</h3>
            <p className="text-sm text-muted">
              {playoffField.tiebreakers.error
                ? "An administrator must review the tiebreaker fixtures before the playoff order is final."
                : !status.allComplete
                  ? "Ties are provisional until the regular season finishes. Any remaining tie affecting qualification or seeding then requires a tiebreaker week."
                  : unresolvedTeams.length > 0
                    ? `${unresolvedTeams.join(", ")} still need to be separated for playoff qualification or seeding.`
                    : "The tiebreaker results have settled the playoff order."}{" "}
              These matches do not change regular-season points. Playoffs stay
              locked until every relevant tie is resolved.
            </p>
            {unresolvedTeams.length > 0 && playoffField.tiebreakers.groups.some((group) => group.format === "BO1_SINGLE_ELIMINATION") ? <div className="space-y-2 text-sm text-muted">
              <p>{TIEBREAKER_SUMMARY}</p>
              <p>{TIEBREAKER_RULES}</p>
              <p>A one-team qualifying bracket is a bye into playoffs. The draw is saved and cannot be rerolled by resetting.</p>
            </div> : unresolvedTeams.length > 0 ? (
              <p className="text-sm text-muted">
                Two tied teams play one best-of-three series. Three tied teams
                play a best-of-one double-elimination bracket in the same week:
                four games, with a fifth only if the undefeated team loses the
                first final. The opening matchup and bye are randomly drawn
                when scheduled. Each result creates the next game automatically;
                check its time in Tiebreakers. Two losses eliminate a
                team, giving a definite first, second and third place.
                {playoffField.tiebreakers.groups.some((group) => group.format === "BO3_ROUND_ROBIN" && group.teamIds.length > 2)
                  ? " Existing round robins and groups of four or more use best-of-three series; wins, then game differential rank each round. Remaining relevant ties play again."
                  : ""}
              </p>
            ) : null}
            {[...new Set(playoffField.tiebreakers.groups.flatMap((group) => group.byeTeamId ? [group.byeTeamId] : []))].map((id) => (
              <p key={`bye-${id}`} className="text-xs text-muted">
                Opening bye drawn: {teamNameById.get(id) ?? id}. This team enters
                game 2 against the game 1 winner.
              </p>
            ))}
            {playoffField.tiebreakers.error ? (
              <p className="text-danger" role="alert">
                {playoffField.tiebreakers.error}
              </p>
            ) : null}
            {!status.allComplete ? (
              <p className="text-xs text-muted">
                Finish all regular-season results before scheduling a tiebreaker
                week.
              </p>
            ) : null}
            {playoffField.tiebreakers.pending ? (
              <a href="#adm-tiebreakers" className={textLink("inline-block py-1 text-sm")}>
                Manage the tiebreaker bracket, times and scores →
              </a>
            ) : null}
            {scheduleTiebreakersOpen ? (
              <div className="space-y-2">
                <ul className="space-y-1 text-xs text-muted">
                  {schedulableTiebreakers
                    .flatMap((group) => group.drawRequired ? [
                      <li key={group.key}>
                        {group.teamIds.map((id) => teamNameById.get(id) ?? id).join(", ")} · Best of 1 · Draw and byes published when scheduled
                      </li>,
                    ] : group.pairings.map((pairing) => (
                        <li
                          key={`${group.key}:${pairing.home}:${pairing.away}`}
                        >
                          {teamNameById.get(pairing.home) ?? pairing.home} vs{" "}
                          {teamNameById.get(pairing.away) ?? pairing.away} ·
                          Best of {group.bestOf}{group.stage ? ` · Game ${group.stage}` : ""}
                        </li>
                      )),
                    )}
                </ul>
                {playoffField.tiebreakers.groups.some(
                  (group) =>
                    group.status === "needed" && group.teamIds.length > 2,
                ) ? (
                  <p className="text-xs text-muted">
                    Check each match time in Tiebreakers. Reserve
                    enough time in the tiebreaker week for the whole bracket;
                    later games appear as their participants are decided.
                  </p>
                ) : null}
                <ActionForm
                  action={scheduleTiebreakerWeek}
                  hidden={{
                    seasonId: season.id,
                    expectedRevision: commandClaim.expectedRevision,
                  }}
                >
                  <SubmitButton variant="secondary" size="sm">
                    {schedulableTiebreakers.some((group) => (group.stage ?? 1) > 1)
                      ? "Create next tiebreaker match"
                      : "Schedule tiebreaker week"}
                  </SubmitButton>
                </ActionForm>
              </div>
            ) : null}
            {tiebreakerMatches.length > 0 &&
            season.status === SEASON_STATUS.REGULAR_SEASON ? (
              <ActionForm
                action={resetTiebreakerWeek}
                hidden={{
                  seasonId: season.id,
                  expectedRevision: commandClaim.expectedRevision,
                }}
              >
                <DangerSubmit
                  token={season.name}
                  title="Reset the tiebreaker week?"
                  consequences={[
                    `All ${tiebreakerMatches.length} tiebreaker fixture(s) and their results are removed.`,
                    ...(tiebreakerGameCount
                      ? [
                          `Their ${tiebreakerGameCount} imported game(s), box scores, fantasy points and record entries are removed.`,
                        ]
                      : []),
                    "Tiebreaker check-ins, standin bookings, reschedule requests and pick'em picks are removed.",
                    "Regular-season result corrections reopen. Resolve any remaining playoff ties by scheduling fresh tiebreakers after corrections.",
                  ]}
                  recovery="Deleted OpenDota match IDs are saved below for re-import. Check-ins, bookings and picks cannot be restored."
                >
                  Reset tiebreaker week
                </DangerSubmit>
              </ActionForm>
            ) : null}
          </div>
        ) : null}
        {playoffMatches.length > 0 ? (
          <div className="space-y-3">
            <p className="text-muted">
              {season.status === SEASON_STATUS.COMPLETE
                ? champion
                  ? `Postseason complete. The bracket and ${champion.name}'s title are preserved here; use the grand-final correction below for a final-series error, or “Fix the bracket” for an earlier-round or seeding error.`
                  : "The season is marked Complete, but no authoritative champion is available. Use the phase control or “Fix the bracket” to reconcile the final before publishing a title."
                : `${playoffMatches.length} playoff match(es) created. Enter each series' score below; the bracket advances and crowns the champion automatically.`}
            </p>
            <PlayoffSeries
              season={season}
              data={data}
              playoff={playoffMatches}
              nowMs={nowMs}
            />
            {/* Both repairs remove postseason data, so they sit folded away
                from the series an admin works through on match night, each
                still behind typing the season name. */}
            <details
              open={
                season.status === SEASON_STATUS.COMPLETE &&
                championPresentation.issue != null
              }
              className="rounded-lg border border-line px-3 py-1"
            >
              <summary className="flex min-h-11 cursor-pointer items-center font-medium">
                Fix the bracket
              </summary>
              <div className="space-y-3 pb-3">
                <p className="text-xs text-muted">
                  Only for a seeding mistake, a wrong result in an earlier
                  round, or a regular-season result that needs correcting. Both
                  remove playoff data, and each asks you to type the season
                  name first.
                </p>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/30 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">Reseed the bracket?</div>
                    <p className="text-xs text-muted">
                      {resetPlayoffsLockedReason
                        ? `Reset playoffs is unavailable: ${resetPlayoffsLockedReason}`
                        : "Reset playoffs deletes every playoff series and seeds a fresh bracket from the current standings."}
                    </p>
                  </div>
                  <ActionForm
                    action={startPlayoffs}
                    hidden={{ ...commandClaim, intent: "reset" }}
                  >
                    <DangerSubmit
                      token={season.name}
                      disabled={resetPlayoffsLockedReason != null}
                      title="Reset the playoff bracket?"
                      consequences={[
                        `All ${playoffMatches.length} playoff match(es) are deleted and reseeded from the current standings.`,
                        ...(playoffGameCount
                          ? [
                              `Their ${playoffGameCount} imported game(s) go too — postseason box scores, MVPs, fantasy points and record-book entries with them.`,
                            ]
                          : []),
                        "Playoff check-ins, standin bookings and pick'em picks on those matches are deleted and are NOT archived.",
                        ...(season.status === SEASON_STATUS.COMPLETE
                          ? [
                              "The stored champion record is cleared and the season reopens into Playoffs.",
                            ]
                          : []),
                      ]}
                      recovery={
                        playoffGameCount
                          ? "The OpenDota match IDs of the deleted games are archived in this card, so their box scores can be re-imported one at a time."
                          : "The bracket itself reseeds from the standings, so nothing is lost if no games have been imported yet."
                      }
                    >
                      Reset playoffs
                    </DangerSubmit>
                  </ActionForm>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/30 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">Need to correct the table?</div>
                    <p className="text-xs text-muted">
                      Return to Regular season removes this postseason first, so
                      a corrected result can never coexist with stale seeds or a
                      stale champion.
                    </p>
                  </div>
                  <ActionForm
                    action={returnToRegularSeasonAction}
                    hidden={commandClaim}
                  >
                    <DangerSubmit
                      token={season.name}
                      title="Return to the regular season?"
                      consequences={[
                        `All ${playoffMatches.length} playoff match(es) are removed; earlier regular-season matches and standings remain.`,
                        ...(playoffGameCount
                          ? [
                              `${playoffGameCount} imported playoff game(s), their box scores, fantasy points and record entries are removed.`,
                            ]
                          : []),
                        "Playoff check-ins, standin bookings, reschedule requests and pick'em picks are removed.",
                        ...(season.championTeamId
                          ? ["The stored champion record is cleared."]
                          : []),
                      ]}
                      recovery={
                        playoffGameCount
                          ? "Deleted OpenDota match IDs are archived here for re-import after the corrected bracket is seeded."
                          : "After correcting regular results, Start playoffs creates a fresh bracket from the authoritative table."
                      }
                    >
                      Return to regular season
                    </DangerSubmit>
                  </ActionForm>
                </div>
              </div>
            </details>
          </div>
        ) : (
          <p className="text-muted">
            {playoffField.eligibleTeamIds.length < 2
              ? "At least two non-withdrawn teams are needed before a bracket can be seeded."
              : `Will seed the top ${bracketSize} of ${playoffField.eligibleTeamIds.length} eligible team(s) by standings${data.teams.length !== playoffField.eligibleTeamIds.length ? `; ${data.teams.length - playoffField.eligibleTeamIds.length} withdrawn team(s) keep their results but cannot take a seed` : ""}. Start this after the regular season is finished.`}
          </p>
        )}
        {data.tiebreakerArchive.length > 0 ? (
          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted hover:text-fg">
              {data.tiebreakerArchive.length} removed tiebreaker game(s) —
              OpenDota IDs kept for re-import
            </summary>
            <p className="mt-2 text-xs text-muted">
              After recreating the matching tiebreaker fixture, add these IDs
              with its Add game control in <a href="#adm-tiebreakers" className={textLink()}>Tiebreakers</a>.
            </p>
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {data.tiebreakerArchive.map((game) => (
                <li key={game.dotaMatchId}>
                  {game.dotaMatchId} · Week {game.week}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {data.playoffArchive.length > 0 ? (
          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted hover:text-fg">
              {data.playoffArchive.length} playoff game(s) removed by a bracket
              reset — OpenDota IDs kept for re-import
            </summary>
            <p className="mt-2 text-xs text-muted">
              Paste these into the &ldquo;Match ID or URL&rdquo; box on the
              matching series in this card and press &ldquo;Add game&rdquo; to
              restore its box score.
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              {data.playoffArchive.map((g) => (
                <li key={g.dotaMatchId} className="tabular-nums text-muted">
                  <span className="text-fg">{g.dotaMatchId}</span> · {g.slot} ·
                  week {g.week}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <p className="text-xs text-muted">
          New tiebreakers use BO1 knockouts, up to three games per team. Existing brackets keep their published format.
          Series lengths for the regular
          season, playoffs and final are under Season settings on the phase
          control card.
        </p>
      </CardBody>
    </Card>
  );
}

function StandinControls({
  season,
  data,
}: {
  season: Season;
  data: AdminData;
}) {
  const upcoming = data.matches.filter((m) => m.status !== "COMPLETED");
  const teamName = new Map(data.teams.map((t) => [t.id, t.name]));
  const byMatch = new Map<string, AdminData["assignments"]>();
  for (const a of data.assignments) {
    const arr = byMatch.get(a.matchId) ?? [];
    arr.push(a);
    byMatch.set(a.matchId, arr);
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
  // Outside the assign window only matches with a booking have anything to
  // show (removal); an empty block there is noise.
  const rest = upcoming.filter(
    (m) => !problemIds.has(m.id) && (assignOpen || byMatch.has(m.id)),
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
      teamName={teamName}
      teamSize={season.teamSize}
      assignOpen={assignOpen}
      label={matchLabel(m)}
    />
  );

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Standin assignments"
        subtitle="Captains book their own standins from the match page. This card shows cover problems and lets you book for any team."
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

function AutomationTimestamp({
  value,
  emptyLabel,
}: {
  value: Date | null | undefined;
  emptyLabel: string;
}) {
  return value ? (
    <LocalTime
      ts={value.getTime()}
      variant="short"
      initial={formatLeagueMatchTime(value, "short")}
    />
  ) : (
    emptyLabel
  );
}

type AutomationSnapshot = {
  now: number;
  /** undefined = the runner row could not be read; null = it never ran. */
  state: AutomationHealthRecord | null | undefined;
  backlog: AutomationBacklog | undefined;
  idleWindow: { nextWakeAtMs: number; hardWakeAtMs: number } | undefined;
};

/**
 * The runner row, the Discord delivery backlog and the gate's idle window,
 * read once per request: the runner card and Needs attention share it. DB
 * only (the gate snapshot is cached), and it never throws — a readiness
 * incident reads as "unavailable" instead of taking the admin page down.
 */
const loadAutomationSnapshot = cache(async (): Promise<AutomationSnapshot> => {
  const now = Date.now();
  const stuckBefore = new Date(now - AUTOMATION_BACKLOG_STUCK_MS);
  const queuedLeague = {
    status: {
      in: [
        LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
        LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
      ],
    },
  };
  const queuedInhouse = {
    status: {
      in: [
        INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
        INHOUSE_ANNOUNCEMENT_STATUS.SENDING,
      ],
    },
  };
  try {
    const [
      runner,
      league,
      inhouse,
      stuckLeague,
      stuckInhouse,
      markerRetries,
      gate,
    ] = await Promise.all([
      prisma.automationRunState.findUnique({
        where: { key: AUTOMATION_RUN_KEY },
        select: {
          lastStatus: true,
          leaseExpiresAt: true,
          lastAttemptAt: true,
          lastStartedAt: true,
          lastFinishedAt: true,
          lastSuccessAt: true,
          lastSource: true,
          lastDurationMs: true,
          consecutiveFailures: true,
          lastErrorCode: true,
          lastSummary: true,
        },
      }),
      prisma.leagueAnnouncement.count({ where: queuedLeague }),
      prisma.inhouseAnnouncement.count({ where: queuedInhouse }),
      prisma.leagueAnnouncement.count({
        where: { ...queuedLeague, createdAt: { lt: stuckBefore } },
      }),
      prisma.inhouseAnnouncement.count({
        where: { ...queuedInhouse, createdAt: { lt: stuckBefore } },
      }),
      prisma.setting.count({
        where: {
          OR: [
            { value: { startsWith: ANNOUNCE_FAILED_PREFIX } },
            {
              key: { startsWith: HONORS_ANNOUNCED_PREFIX },
              value: { startsWith: HONORS_STALE_PREFIX },
            },
          ],
        },
      }),
      getAutomationGateDecision(now).catch(() => ({ run: true }) as const),
    ]);
    return {
      now,
      state: runner,
      backlog: {
        league,
        inhouse,
        markerRetries,
        stuck: stuckLeague + stuckInhouse,
      },
      idleWindow: gate.run
        ? undefined
        : {
            nextWakeAtMs: Math.min(
              gate.snapshot.nextWakeAtMs,
              gate.snapshot.hardWakeAtMs,
            ),
            hardWakeAtMs: gate.snapshot.hardWakeAtMs,
          },
    };
  } catch {
    // `undefined` is intentionally distinct from a missing (never-run) row.
    return { now, state: undefined, backlog: undefined, idleWindow: undefined };
  }
});

async function loadAutomationAttention(): Promise<string[]> {
  const { now, state, backlog, idleWindow } = await loadAutomationSnapshot();
  return automationAttention(
    automationHealthView(state, now, idleWindow),
    backlog,
  );
}

/**
 * Production-wide runner health. This is separate from AutoSyncHealth below:
 * that card explains per-match scan/backoff state during playable phases,
 * while this one answers whether the single scheduled worker is alive and
 * safe to recover in every phase (including offseason and no season).
 *
 * Healthy, it folds to one line; the details stay one click away, and any
 * problem also raises a line in Needs attention.
 */
async function AutomationRunnerHealth() {
  const { now, state, backlog, idleWindow } = await loadAutomationSnapshot();
  const health = automationHealthView(state, now, idleWindow);
  const lastRun = state?.lastSuccessAt ?? state?.lastFinishedAt ?? null;
  if (automationQuiet(health, backlog)) {
    return (
      <AdminSection
        title="Automation runner"
        subtitle={
          <>
            {health.kind === "RUNNING" ? "Healthy · running now" : "Healthy"}
            {lastRun ? (
              <>
                {" · last run "}
                <AutomationTimestamp value={lastRun} emptyLabel="Never" />
              </>
            ) : null}
          </>
        }
      >
        <CardBody>
          <AutomationRunnerDetails
            health={health}
            state={state}
            backlog={backlog}
          />
        </CardBody>
      </AdminSection>
    );
  }
  const badgeTone =
    health.kind === "RUNNING"
      ? "accent"
      : health.kind === "DEGRADED" || health.kind === "UNAVAILABLE"
        ? "danger"
        : health.kind === "HEALTHY"
          ? "success"
          : "neutral";
  const calloutClass =
    health.kind === "RUNNING"
      ? "border-accent/30 bg-accent/10"
      : health.kind === "DEGRADED" || health.kind === "UNAVAILABLE"
        ? "border-danger/30 bg-danger/10"
        : health.kind === "HEALTHY"
          ? "border-success/30 bg-success/10"
          : "border-line bg-surface-2/40";

  return (
    <Card>
      <CardHeader
        title="Automation runner"
        subtitle="The scheduled worker behind result imports, reminders and Discord posts, in every league phase."
        action={<Badge tone={badgeTone}>{health.label}</Badge>}
      />
      <CardBody className="space-y-5">
        <div className={cn("rounded-lg border px-4 py-3", calloutClass)}>
          <div className="font-medium text-fg">{health.headline}</div>
          <p className="mt-1 text-sm text-muted">{health.description}</p>
        </div>
        <AutomationRunnerDetails
          health={health}
          state={state}
          backlog={backlog}
        />
      </CardBody>
    </Card>
  );
}

function AutomationRunnerDetails({
  health,
  state,
  backlog,
}: {
  health: AutomationHealthView;
  state: AutomationHealthRecord | null | undefined;
  backlog: AutomationBacklog | undefined;
}) {
  const emptyTime = state === undefined ? "Unavailable" : "Never";
  return (
    <div className="space-y-5">
      <StatStrip>
        <StatCell
          label="Last attempt"
          value={
            <AutomationTimestamp
              value={state?.lastAttemptAt}
              emptyLabel={emptyTime}
            />
          }
        />
        <StatCell
          label="Last success"
          value={
            <AutomationTimestamp
              value={state?.lastSuccessAt}
              emptyLabel={emptyTime}
            />
          }
        />
        <StatCell label="Source" value={health.sourceLabel} />
        <StatCell label="Duration" value={health.durationLabel} />
        <StatCell
          label="Failure streak"
          value={health.consecutiveFailures}
          tone={health.consecutiveFailures > 0 ? "accent" : "muted"}
        />
      </StatStrip>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface-2/30 p-4">
          <h4 className="font-medium text-fg">Latest run</h4>
          {health.signals.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {health.signals.map((signal) => (
                <li key={signal}>{signal}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">
              No failure or unfinished work is recorded.
            </p>
          )}
          {health.leaseExpiresAt ? (
            <p className="mt-2 text-xs text-muted">
              {health.leaseActive
                ? "The current run's lock expires "
                : "The last run's lock expired "}
              <AutomationTimestamp
                value={health.leaseExpiresAt}
                emptyLabel="Not recorded"
              />
              .
            </p>
          ) : null}
        </div>

        <div className="rounded-lg border border-line bg-surface-2/30 p-4">
          <h4 className="font-medium text-fg">How often it runs</h4>
          <p className="mt-2 text-sm text-muted">
            Production checks every minute. When work is due it runs a pass;
            when everything is caught up it can wait for the next known
            deadline, and it always reconciles about once an hour.
          </p>
          <p className="mt-2 text-xs text-muted">
            A manual run takes the same lock as the scheduled one: it can take
            over a run that stopped, but never one that is still going.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface-2/30 p-4">
        <h4 className="font-medium text-fg">Discord posts waiting to send</h4>
        {backlog ? (
          backlog.league + backlog.inhouse + backlog.markerRetries > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              <li>{backlog.league} league-channel post(s) queued</li>
              <li>{backlog.inhouse} inhouse post(s) queued</li>
              {backlog.stuck > 0 ? (
                <li className="text-danger">
                  {backlog.stuck} of those queued over{" "}
                  {AUTOMATION_BACKLOG_STUCK_MS / 60_000} minutes ago
                </li>
              ) : null}
              <li>
                {backlog.markerRetries} announcement(s) waiting to be sent
                again after a failed send or a result correction
              </li>
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">Nothing is waiting.</p>
          )
        ) : (
          <p className="mt-2 text-sm text-danger">
            Can&apos;t read the queue until the database is reachable again.
          </p>
        )}
        <p className="mt-2 text-xs text-muted">
          Queued posts survive a restart and go out in order, usually within a
          minute or two. Posts waiting longer than{" "}
          {AUTOMATION_BACKLOG_STUCK_MS / 60_000} minutes mean Discord or the
          scheduler needs attention.
        </p>
      </div>

      <div
        className="flex flex-wrap items-start justify-between gap-4 border-t border-line pt-4"
        role="group"
        aria-labelledby="automation-manual-run-title"
      >
        <div className="min-w-0 flex-1 basis-64">
          <div
            id="automation-manual-run-title"
            className="font-medium text-fg"
          >
            Manual recovery
          </div>
          <p className="mt-1 text-sm text-muted">
            {health.disabledReason ??
              "Run a bounded pass now. If the scheduled run starts first, this request stops without doing the work twice."}
          </p>
        </div>
        <ActionForm action={runMaintenanceNow}>
          <SubmitButton
            variant={health.kind === "DEGRADED" ? "accent" : "secondary"}
            disabled={!health.canRunNow}
          >
            Run maintenance now
          </SubmitButton>
        </ActionForm>
      </div>
    </div>
  );
}

/**
 * Auto-sync health: the automation trains everyone to stop pressing import
 * buttons, so its state must be visible — a match parked in exponential
 * backoff (private match data, forfeit) is otherwise indistinguishable from
 * "no games yet". Reads the same window/claim fields the service writes.
 */
async function AutoSyncHealth({ season }: { season: Season }) {
  if (season.status !== "REGULAR_SEASON" && season.status !== "PLAYOFFS") {
    return null;
  }
  // async SERVER component: it renders once per request, so there is no
  // re-render for Date.now() to be non-idempotent across. The rule is written
  // for client components.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const [inWindow, leagueSyncAt, cursor, setAside, privatePlayers] =
    await Promise.all([
      prisma.match.findMany({
        where: {
          seasonId: season.id,
          status: { not: "COMPLETED" },
          scheduledAt: {
            gte: new Date(now - AUTO_SYNC.WINDOW_HOURS * 3600_000),
            lte: new Date(now - AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF * 60_000),
          },
        },
        orderBy: { scheduledAt: "asc" },
        include: {
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
        },
      }),
      getSetting(SETTING_KEYS.LEAGUE_AUTO_SYNC_AT),
      getSetting(SETTING_KEYS.RESULT_CHANGED_AT),
      // League-feed games the last classification set aside: no fixture they
      // fit, or an extra game past a decided series. Only syncLeagueGames
      // records these reasons, and every pass reconsiders them. (The old
      // leagueSyncSkip Setting is read-only legacy; nothing writes it.)
      season.dotaLeagueId
        ? prisma.importCandidate.count({
            where: {
              seasonId: season.id,
              status: "IGNORED",
              reason: { startsWith: "NO_ELIGIBLE_FIXTURE" },
            },
          })
        : Promise.resolve(0),
      // WHO the roster scans can't see — OpenDota flagged their match data
      // private. This is the admin's only mid-season surface for it (the
      // signup-pool badge lives on a card that retires after the draft).
      prisma.user.findMany({
        where: {
          fhUnavailable: true,
          registrations: {
            some: { seasonId: season.id, status: "ACTIVE" },
          },
        },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);
  const ts = (iso: string | null) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const cursorTs = ts(cursor);
  const leagueTs = ts(leagueSyncAt);

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Automatic result sync"
        subtitle={
          season.dotaLeagueId
            ? `The league feed checks first about every ${Math.round(AUTO_SYNC.LEAGUE_INTERVAL_SECONDS / 60)} minutes; linked player accounts recover unfinished fixtures that used an old or incorrect ticket.`
            : "What the OpenDota watcher is doing right now — nobody should need the manual buttons unless something here looks stuck."
        }
      />
      <CardBody className="space-y-3">
        {inWindow.length === 0 ? (
          <p className="text-sm text-muted">
            No matches in their detection window — the sync sleeps until{" "}
            {AUTO_SYNC.MIN_MINUTES_AFTER_KICKOFF} minutes after the next
            kickoff.
          </p>
        ) : (
          <ul className="space-y-2">
            {inWindow.map((m) => {
              const check = autoCheckStatus(m, season, now);
              const backedOff =
                m.autoSyncAttempts >= AUTO_CHECK_BACKED_OFF_SCANS;
              return (
                <li
                  key={m.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-2/40 p-3 text-sm"
                >
                  <Link
                    href={`/matches/${m.id}`}
                    className="min-w-0 flex-1 basis-48 truncate font-medium hover:text-info"
                  >
                    {m.homeTeam.name} vs {m.awayTeam.name}
                  </Link>
                  {m.status === "LIVE" ? (
                    <Badge tone="accent">
                      Game {m.homeScore + m.awayScore} recorded · series{" "}
                      {m.homeScore}–{m.awayScore}
                    </Badge>
                  ) : null}
                  {m.autoSyncedAt ? (
                    <span className="text-xs text-muted">
                      player accounts scanned{" "}
                      <LocalTime
                        ts={m.autoSyncedAt.getTime()}
                        variant="short"
                        initial={formatLeagueMatchTime(m.autoSyncedAt, "short")}
                      />
                      {" · "}
                      {m.autoSyncAttempts} empty scan
                      {m.autoSyncAttempts === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {check ? (
                    <AutoCheckLine check={check} className="w-full" />
                  ) : null}
                  {backedOff ? (
                    <Badge tone="danger">
                      player recovery backed off — check account links or import
                      the Dota match id
                    </Badge>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {privatePlayers.length > 0 ? (
          <p className="text-xs text-danger">
            {season.dotaLeagueId
              ? "Player-account recovery is limited for these private profiles (league-ticket games are unaffected): "
              : "Private match data (roster scans can't see their games): "}
            {privatePlayers.map((p, i) => (
              <span key={p.id}>
                {i > 0 ? ", " : ""}
                <PlayerLink userId={p.id} className="underline">
                  {p.name}
                </PlayerLink>
              </span>
            ))}
          </p>
        ) : null}
        <p className="text-xs text-muted">
          Last result landed:{" "}
          {cursorTs ? (
            <LocalTime
              ts={cursorTs}
              variant="full"
              initial={formatLeagueMatchTime(new Date(cursorTs), "full")}
            />
          ) : (
            "never"
          )}
          {season.dotaLeagueId ? (
            <>
              {" · League feed last checked: "}
              {leagueTs ? (
                <LocalTime
                  ts={leagueTs}
                  variant="short"
                  initial={formatLeagueMatchTime(new Date(leagueTs), "short")}
                />
              ) : (
                "never"
              )}
              {` · ${setAside} league game${setAside === 1 ? "" : "s"} set aside (no matching fixture, or an extra game)`}
            </>
          ) : null}
        </p>
      </CardBody>
    </Card>
  );
}

function LeagueControls({ season }: { season: Season }) {
  return (
    <AdminSection
      id="adm-league"
      title="Dota league integration"
      subtitle="Link a Valve league id to auto-import every league game."
    >
      <CardBody className="space-y-3">
        {/* The manual sync used to hang off the card header. It can't ride the
            <summary> — a click on a button in there toggles the disclosure
            instead of submitting — so it leads the body. */}
        <div className="flex justify-end">
          <ActionForm action={syncLeagueAction}>
            <SubmitButton
              variant="secondary"
              size="sm"
              disabled={!season.dotaLeagueId}
            >
              Sync league games
            </SubmitButton>
          </ActionForm>
        </div>
        <ActionForm
          action={setLeagueId}
          hidden={{
            expectedActiveSeasonId: season.id,
            expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div>
            <label
              htmlFor="dotaLeagueId"
              className="mb-1 block text-xs text-muted"
            >
              Valve league id
            </label>
            <input
              id="dotaLeagueId"
              name="dotaLeagueId"
              defaultValue={season.dotaLeagueId ?? ""}
              placeholder="e.g. 17119"
              className="h-10 w-56 max-w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
            />
          </div>
          <SubmitButton variant="secondary" size="sm">
            Save league id
          </SubmitButton>
        </ActionForm>
        <div className="rounded-lg border border-line bg-surface-2/40 p-3 text-xs text-muted">
          <p className="mb-1 font-medium text-fg">
            Make league games show in the Dota client:
          </p>
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>
              Register the league at{" "}
              <a
                href="https://www.dota2.com/league"
                target="_blank"
                rel="noreferrer"
                className={textLink()}
              >
                dota2.com/league
              </a>{" "}
              to get a league id, then paste it above.
            </li>
            <li>
              Host each match in a <b>private lobby</b> and set its{" "}
              <b>League</b> field to your league id.
            </li>
            <li>
              Those games become spectatable via DotaTV in-client and are tagged
              with your league id.
            </li>
            <li>
              Results from those lobbies sync automatically, with no match IDs
              or public player data needed. Press <b>Sync league games</b> to
              check now.
            </li>
          </ol>
        </div>
        <p className="rounded-lg border border-line bg-surface-2/40 p-3 text-xs text-muted">
          <span className="font-medium text-fg">Player data refreshes itself:</span>{" "}
          about once an hour the automation worker updates Steam names and
          avatars, the medals and scouting stats of the few players checked
          longest ago, and adds report-card stats to a few games imported
          before report cards existed. It pauses when OpenDota refuses a
          request and while an auction is live. To refresh right away, use
          the Refresh player data now button in{" "}
          <a href="#adm-captains" className={textLink()}>
            Captains &amp; draft
          </a>
          .
        </p>
      </CardBody>
    </AdminSection>
  );
}

// Post-draft roster management: sign free agents onto short teams, release
// players who've left the league (they return to the free-agent pool).
function RosterMoves({ season, data }: { season: Season; data: AdminData }) {
  // Visibility lives in `rosterMovesVisible` so the jump bar can ask the same
  // question. All three actions refuse until the auction has FINISHED
  // (signFreeAgent and releasePlayer check `draftRow.status !== COMPLETE`;
  // promoteGateError blocks a LIVE/PAUSED draft), and the card used to be gated
  // on the season phase alone — so from the first sale of draft night it sat
  // there fully populated with three forms that could only produce errors, with
  // "Release player" listing every player just bought.
  if (!rosterMovesVisible(season, data)) return null;

  // Pre-start DRAFT (phase walked forward, auction not yet run): promotion is
  // the ONLY legal move — promoteGateError blesses it ("they'll be auctioned
  // normally") while signFreeAgent/releasePlayer refuse until the auction is
  // COMPLETE. Rendering their forms here would be the controls-that-only-error
  // class, and the short-team banner would cry wolf over rosters that are
  // legitimately just captains.
  const preStart =
    season.status === "DRAFT" &&
    (!data.draft || data.draft.status === DRAFT_STATUS.NOT_STARTED);

  const rosteredIds = new Set(
    data.teams.flatMap((t) => t.members.map((m) => m.userId)),
  );
  const freeAgents = data.players.filter((p) => !rosteredIds.has(p.userId));
  // Withdrawn teams are neither an alarm nor a signing target: their fixtures
  // are all forfeited, so "short" is their permanent state (usually WHY they
  // withdrew), and signFreeAgent refuses them — offering them here parks a
  // player on a dead roster one mis-click away. Releasing their players stays
  // available below; that's the legitimate post-withdrawal cleanup.
  const short = preStart
    ? []
    : shortTeams(data.teams, season.teamSize).map(({ team }) => team);
  const canSign = !preStart && freeAgents.length > 0 && short.length > 0;
  const releasable = preStart
    ? []
    : data.teams.flatMap((t) =>
        t.members
          .filter((m) => !m.isCaptain)
          .map((m) => ({ id: m.id, name: m.user.name, teamName: t.name })),
      );
  // Late joiners register as standins once signups close — promoting one is
  // the first step of the mid-season roster refill (promote → sign above).
  // `data.standins` deliberately unions registered STANDINs with undrafted full
  // PLAYERs (both are valid cover), but promoteStandinToPlayer only accepts a
  // STANDIN — promoteGateError refuses everyone else. Without this filter the
  // dropdown was mostly names whose promotion always errors.
  const promotableStandins = data.standins.filter(
    (s) => s.type === REGISTRATION_TYPE.STANDIN && !rosteredIds.has(s.userId),
  );
  // (The "nothing to move" early return that used to live here is part of
  // rosterMovesVisible now — one predicate, so the jump chip can't outlive the
  // card it points at.)

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Roster moves"
        subtitle={
          preStart
            ? "Promote late-joining standins to full players — before the auction runs, a promoted player simply joins the draft pool."
            : "Sign free agents onto short teams; release players who've left; promote late-joining standins to full players."
        }
      />
      <CardBody className="space-y-3">
        {/* A SHORT ROSTER stated outright. The only place /admin printed a
            team's size against teamSize was inside the sign form's own team
            select — which is gated on a free agent existing, so the single
            indicator that a team is a player down vanished in exactly the case
            where nobody is available to fix it. Everywhere else the league
            reports a 4-of-5 side as fully staffed, so this line is the admin's
            only warning before match night. */}
        {short.length > 0 ? (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-fg">
            <b>
              {short.length} team
              {short.length === 1 ? " is" : "s are"} short of{" "}
              {season.teamSize}:
            </b>{" "}
            {short
              .map((t) => `${t.name} (${t.members.length})`)
              .join(", ")}
            .{" "}
            {freeAgents.length === 0
              ? "No free agents are available — promote a standin below, or arrange cover per match in Standin assignments."
              : "Sign a free agent below to fill the seat."}
          </p>
        ) : null}
        {canSign ? (
          <ActionForm
            action={signFreeAgent}
            className="flex flex-wrap items-center gap-2"
          >
            <select
              name="userId"
              required
              defaultValue=""
              aria-label="Free agent to sign"
              className={selectCls}
            >
              <option value="" disabled>
                Free agent…
              </option>
              {freeAgents.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.user.name} ({p.mmr} MMR)
                </option>
              ))}
            </select>
            <span className="text-xs text-muted">joins</span>
            <select
              name="teamId"
              required
              defaultValue=""
              aria-label="Team with an open seat"
              className={selectCls}
            >
              <option value="" disabled>
                Team…
              </option>
              {short.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.members.length}/{season.teamSize})
                </option>
              ))}
            </select>
            {/* Additive and undoable by Release — but Release permanently
                erases the player's draft price, so the round trip is lossy. */}
            <SubmitButton
              variant="secondary"
              size="sm"
              confirm="Sign this player onto that team for the rest of the season? Releasing them again frees the seat but permanently erases their draft price."
            >
              Sign player
            </SubmitButton>
          </ActionForm>
        ) : null}

        {promotableStandins.length > 0 ? (
          <ActionForm
            action={promoteStandinToPlayer}
            className="flex flex-wrap items-center gap-2"
          >
            <select
              name="userId"
              required
              defaultValue=""
              aria-label="Standin to promote to full player"
              className={selectCls}
            >
              <option value="" disabled>
                Standin…
              </option>
              {promotableStandins.map((s) => (
                <option key={s.userId} value={s.userId}>
                  {s.user.name}
                  {s.mmr > 0 ? ` (${s.mmr} MMR)` : ""}
                </option>
              ))}
            </select>
            <SubmitButton
              variant="secondary"
              size="sm"
              confirm={
                preStart
                  ? "Promote to full player? They join the draft pool and will be auctioned normally on draft night."
                  : "Promote to full player? They leave the standin pool and can be signed onto a roster."
              }
            >
              Promote to player
            </SubmitButton>
            <span className="text-xs text-muted">
              {preStart
                ? "they join the draft pool and get auctioned normally"
                : "then sign them with the form above — it appears once a team is short and a free agent exists"}
            </span>
          </ActionForm>
        ) : null}
        {releasable.length > 0 ? (
          <ActionForm
            action={releasePlayer}
            className="flex flex-wrap items-center gap-2"
          >
            <select
              name="memberId"
              required
              defaultValue=""
              aria-label="Rostered player to release"
              className={selectCls}
            >
              <option value="" disabled>
                Rostered player…
              </option>
              {releasable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.teamName})
                </option>
              ))}
            </select>
            <SubmitButton
              variant="secondary"
              size="sm"
              className="text-danger-soft"
              confirm="Release this player from their roster? They go back to the free-agent pool, their fee is refunded to the team, and any standin booked to cover them on an unplayed match is cancelled (that standin is told to stand down in Discord)."
            >
              Release player
            </SubmitButton>
          </ActionForm>
        ) : null}
        {!preStart ? (
          <p className="text-xs text-muted">
            Signings and releases last the rest of the season (unlike standins,
            which cover a single match) and are announced in Discord. Both are
            reversible from this card — release undoes a signing and refunds it,
            and a released player goes back to the free-agent list. Captains
            can&apos;t be released; hand over captaincy first.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** signupFlags for one registration row (the chips and the review filter). */
function regSignupFlags(reg: AdminData["players"][number], maxMmr: number) {
  return signupFlags(
    {
      mmr: reg.mmr,
      roles: reg.roles,
      favoriteHeroes: reg.favoriteHeroes,
      statement: reg.statement,
      captainNote: reg.captainNote,
      rankTier: reg.user.rankTier,
    },
    { maxMmr },
  );
}

/** A signup row's chip line and medal editor on one line; the editor,
 *  opened, takes the full width under it. */
const ROW_META_LINE =
  "mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 [&>div]:mt-0 [&>details]:mt-0 [&>details[open]]:basis-full";

/**
 * The readiness line under each row of the signup-moderation lists — the
 * prune pass the panel exists for: is this signup reachable on Discord,
 * plausible on MMR, and filled in enough to draft? Every fact on it is
 * DB-only and renders inline on the blocking path; the ONE
 * Discord-dependent fact (live server membership) streams in behind a
 * row-level Suspense over the shared sweep, so the row's make-captain /
 * remove controls never swap component instances underneath a click — only
 * the chip does (which is why this doesn't inherit StartDraftControl's
 * accepted lost-pending-state trade-off). `sweep` is null when no bot+guild
 * is configured: membership is unknowable then, and the row renders exactly
 * what it always rendered (the funnel's `guild: null` rule).
 */
function SignupRowMeta({
  reg,
  sweep,
  maxMmr,
  leading,
}: {
  reg: AdminData["players"][number];
  sweep: Promise<Map<string, GuildMembership>> | null;
  /** Season.maxMmr: the soft limit the "over soft limit" flag reads. */
  maxMmr: number;
  /** Row-specific badges shown first in the chip line. */
  leading?: React.ReactNode;
}) {
  const flags = regSignupFlags(reg, maxMmr);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {leading}
      {reg.user.discordId ? (
        <>
          {/* Verified ✓ = proven OWNERSHIP of the handle (the OAuth link) —
              deliberately not membership; the chip beside it answers that. */}
          <DiscordTag
            name={reg.user.discordName}
            verified
            className="min-w-0"
          />
          {sweep ? (
            <Suspense
              fallback={
                <Badge
                  className="opacity-60"
                  title="Checking the league's Discord server for this account…"
                >
                  checking Discord…
                </Badge>
              }
            >
              <MembershipChip
                sweep={sweep}
                discordId={reg.user.discordId}
                handle={reg.user.discordName}
              />
            </Suspense>
          ) : null}
        </>
      ) : (
        <>
          <Badge
            tone="danger"
            title="Hasn't linked a Discord account — match-found mentions, week reminders and pings can't reach them. A typed handle beside this is unverified text, not a link."
          >
            no Discord link
          </Badge>
          {/* The hand-typed handle, when they left one: unverified (no ✓),
              but still the admin's best lead for chasing them. Renders
              nothing when blank. */}
          <DiscordTag name={reg.user.discordName} className="min-w-0" />
        </>
      )}
      <RoleBadges roles={reg.roles} />
      {flags.map((f) => (
        <Badge key={f.key} tone={f.tone} title={f.detail}>
          {f.label}
        </Badge>
      ))}
    </div>
  );
}

/**
 * One row's live membership verdict, resolved from the card-wide sweep. All
 * four states (member / pending / not-member / couldn't-check) and their
 * copy live in the tested membershipChipView — including the two rules the
 * words must keep: unknown is neutral, never a negative, and a not-member
 * verdict names the LINKED account.
 */
async function MembershipChip({
  sweep,
  discordId,
  handle,
}: {
  sweep: Promise<Map<string, GuildMembership>>;
  discordId: string;
  handle: string;
}) {
  const byId = await sweep;
  const chip = membershipChipView(byId.get(discordId) ?? null, handle);
  return (
    <Badge tone={chip.tone} title={chip.detail}>
      {chip.label}
    </Badge>
  );
}

/**
 * Who league announcements and pings can reach, who they can't, and one post
 * that chases the rest. Only the webhooks and bot setup stay in the collapsed
 * Discord notifications section.
 */
async function DiscordReachCard({
  seasonId,
  rosterUnlinked,
  signupsSeasonName,
}: {
  seasonId: string;
  /** Once rosters are set: who Needs attention counts (unlinkedRosterFor). */
  rosterUnlinked: string[] | null;
  /** The season's name while it takes signups: the returning-player line. */
  signupsSeasonName: string | null;
}) {
  const reach = await getDiscordReachFunnel(seasonId);
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Discord reach"
        subtitle="Who league mentions and pings reach, and who to chase."
      />
      <CardBody>
        {reach.registered > 0 ? (
          <DiscordReachLine reach={reach} rosterUnlinked={rosterUnlinked} />
        ) : rosterUnlinked && rosterUnlinked.length > 0 ? (
          // Rosters can exist with no active signup behind them (a hand-run
          // league, a fixture). Needs attention counts these same people and
          // links here, so the card must name them rather than say nobody
          // has signed up.
          <div>
            <p className="text-sm">
              <b>{rosterUnlinked.length}</b> rostered{" "}
              {rosterUnlinked.length === 1
                ? "player or standin hasn't"
                : "players and standins haven't"}{" "}
              linked Discord, so pings can&apos;t reach them:{" "}
              {cappedNames(rosterUnlinked)}
            </p>
            <p className="mt-1 text-xs text-muted">
              Nobody has an active signup for this season, so there&apos;s no
              signed-up count to compare against.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">
            Nobody has signed up for this season yet.
          </p>
        )}
        {signupsSeasonName ? (
          <Suspense fallback={null}>
            <ReturningPlayersLine
              seasonId={seasonId}
              seasonName={signupsSeasonName}
            />
          </Suspense>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * During signups: how many of last season's players are back, who isn't,
 * and a one-click reminder to paste into Discord. The one-tap rejoin card on
 * /me means the gap is reaching them, not the form. Database reads only; the
 * admin's paste is the send, so the site never mass-mentions anyone itself.
 */
async function ReturningPlayersLine({
  seasonId,
  seasonName,
}: {
  seasonId: string;
  seasonName: string;
}) {
  const [players, signedUp] = await Promise.all([
    loadReturningPlayers(seasonId),
    prisma.registration.count({
      where: {
        seasonId,
        status: REGISTRATION_STATUS.ACTIVE,
        type: REGISTRATION_TYPE.PLAYER,
      },
    }),
  ]);
  if (!players || players.previous === 0) return null;
  const linked = players.notBack.filter((player) => player.discordId).length;
  return (
    <div className="mt-4 border-t border-line-soft pt-3">
      <p className="text-sm">
        <b>
          {players.back} of {players.previous}
        </b>{" "}
        {players.previousSeasonName} players have signed up for {seasonName}.
      </p>
      {players.notBack.length > 0 ? (
        <>
          <p className="mt-1 text-xs text-muted">
            Not back yet ({players.notBack.length}, {linked} with Discord
            linked): {cappedNames(players.notBack.map((player) => player.name))}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ReturningCopy
              players={players}
              seasonName={seasonName}
              signedUp={signedUp}
            />
            <span className="text-xs text-muted">
              One Discord post: it mentions the {linked} with Discord linked
              (your paste pings them) and names the rest. Their answers carry
              over, so rejoining is one tap on My account.
            </span>
          </div>
        </>
      ) : (
        <p className="mt-1 text-xs text-success">
          Everyone from {players.previousSeasonName} is back.
        </p>
      )}
    </div>
  );
}

/** A name list the card caps at 12, so an unlinked league isn't a wall of names. */
function cappedNames(names: string[]): string {
  return (
    names.slice(0, 12).join(", ") +
    (names.length > 12 ? ` +${names.length - 12} more` : "")
  );
}

/**
 * The denominator under every notification the league sends. Personal
 * mentions, the un-RSVP'd ping and the opt-in role all silently skip anyone
 * who never linked Discord — so this is the number that says whether that
 * machinery reaches the league or a handful of people.
 *
 * With a bot configured it also renders the step linking cannot prove: who is
 * actually IN the server. A linked non-member is the deceptive cohort — they
 * wear the verified ✓ on every roster while every mention misses them — and
 * chasing them BEFORE the draft is the whole point of the funnel, because
 * after it they're on rosters that need to schedule with them.
 */
function DiscordReachLine({
  reach,
  rosterUnlinked,
}: {
  reach: DiscordReachFunnel;
  rosterUnlinked: string[] | null;
}) {
  const pct = Math.round((reach.linked / reach.registered) * 100);
  // Below half, the useful next move is chasing links rather than building
  // more notification machinery — so say so rather than just showing a number.
  const thin = pct < 50;
  const g = reach.linked > 0 ? reach.guild : null;
  // The funnel's lists are uncapped (the chase message names everyone); the
  // CARD caps them (cappedNames).
  const capped = cappedNames;
  // Guild lists render "name (@linked-handle)" — the membership check is
  // about the LINKED ACCOUNT, and the handle is what lets an admin verify a
  // "missing" verdict against the member list in seconds (an alt-account
  // link reads as "the site is wrong" without it).
  const cappedPlayers = (list: { name: string; handle: string }[]) =>
    list
      .slice(0, 12)
      .map((p) => (p.handle ? `${p.name} (@${p.handle})` : p.name))
      .join(", ") + (list.length > 12 ? ` +${list.length - 12} more` : "");
  const anyoneToChase =
    reach.registered - reach.linked > 0 ||
    (g !== null && (g.missing > 0 || g.pending > 0));
  return (
    <div>
      <p className="text-sm">
        <b>
          {reach.linked} of {reach.registered}
        </b>{" "}
        registered players have linked Discord{" "}
        <span className={thin ? "text-danger" : "text-success"}>({pct}%)</span>
      </p>
      <p className="mt-1 text-xs text-muted">
        {thin
          ? "Mentions and pings reach only these players — everyone else is named as plain text and never notified. Worth chasing links before adding more notifications."
          : "Everyone else is still named in announcements, just not notified."}
      </p>
      {/* After the draft, match-night pings go to rosters and booked cover.
          These are the people Needs attention counts; the full list below
          also holds idle standins and undrafted signups. */}
      {rosterUnlinked && rosterUnlinked.length > 0 ? (
        <p className="mt-1 text-xs">
          <span className="font-medium">
            On a roster or booked as cover, not linked ({rosterUnlinked.length}):
          </span>{" "}
          {capped(rosterUnlinked)}
        </p>
      ) : null}
      {reach.unlinkedNames.length > 0 ? (
        <p className="mt-1 text-xs text-muted">
          {rosterUnlinked ? "Everyone not linked" : "Not linked"}:{" "}
          {capped(reach.unlinkedNames)}
        </p>
      ) : null}
      {g ? (
        <>
          {/* When Discord answered for NOBODY, a bold "0 of 8 are in the
              server" is a membership claim the data doesn't support — render
              only the honest couldn't-check line below. With partial answers,
              the denominator is the players we could actually check.
              "Pingable" (not "in the server") is deliberate: pending members
              ARE in the server, which made the old headline contradict the
              rules-pending sub-line two rows down. */}
          {g.unknown < reach.linked ? (
            <p className="mt-2 border-t border-line-soft pt-2 text-sm">
              <b>
                {g.inServer} of {reach.linked - g.unknown}
              </b>{" "}
              {g.unknown > 0
                ? "linked players we could check are in the Discord server and pingable"
                : "linked players are in the Discord server and pingable"}
              {g.missing > 0 ? (
                <span className="text-danger"> — {g.missing} missing</span>
              ) : g.unknown === 0 && g.pending === 0 ? (
                <span className="text-success"> — all of them</span>
              ) : null}
            </p>
          ) : null}
          {g.missing > 0 ? (
            <p className="mt-1 text-xs text-danger">
              Linked account NOT in the server: {cappedPlayers(g.missingNames)}
              {/* Quoted string: JSX line-trimming eats a plain leading space
                  after an expression across a source-line break — the same
                  bug the couldn't-check line documents below. */}
              {
                " — pings to them land nowhere. If a player insists they're in the server, search the @handle in the member list: they likely linked a different account than the one they use, and the fix is re-linking from their My account page."
              }
            </p>
          ) : null}
          {g.pending > 0 ? (
            <p className="mt-1 text-xs text-muted">
              In the server but haven&apos;t accepted its rules (unpingable
              until they do): {cappedPlayers(g.pendingNames)}
            </p>
          ) : null}
          {g.unknown > 0 ? (
            <p className="mt-1 text-xs text-muted">
              {/* The quoted-string form matters twice over: JSX line-trimming
                  eats a plain leading space across a source-line break
                  (rendering "1— Discord"), and the copy must not promise a fix
                  it can't deliver — "reload" is a no-op inside the 30s memo
                  window, and a wrong guild id or kicked bot answers this way
                  FOREVER; the bot checklist is what names the broken piece. */}
              Couldn&apos;t check {g.unknown}
              {
                " — Discord didn't answer. A hiccup clears itself within a minute; if this persists, the bot checklist under Discord notifications says which piece is broken."
              }
            </p>
          ) : null}
        </>
      ) : null}
      {anyoneToChase ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ChaseCopy reach={reach} />
          <span className="text-xs text-muted">
            {/* Honest about the reach: a channel post lands with the linked
                members — the not-in-server names WON'T see it, so it asks
                teammates to relay and gives the admin the list to DM. */}
            Builds the lists above into one Discord post. Players not in the
            server won&apos;t see it — DM them the invite, or let teammates
            relay it.
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The opt-in has four independent ways to be half-configured and three are
 * invisible until a player clicks the button and gets an error. This says
 * which one, in the order they have to be fixed.
 */
function PingHealthLines({
  health,
  mutationsAllowed,
}: {
  health: PingHealth;
  mutationsAllowed: boolean;
}) {
  const rows: { ok: boolean | null; label: string; fix: string }[] = [
    {
      ok: health.hasToken,
      label: "Bot token",
      fix: "Set DISCORD_BOT_TOKEN in the host env, then redeploy — env changes only apply to NEW deployments.",
    },
    {
      ok: health.hasGuild,
      label: "Server id",
      fix: "Set DISCORD_GUILD_ID (right-click the server → Copy Server ID), then redeploy.",
    },
    {
      ok: health.hasRole,
      label: "Ping role chosen",
      fix: "Paste the role id into the field above.",
    },
    {
      ok: health.botInGuild,
      label: health.botName
        ? `Bot in server (${health.botName})`
        : "Bot in server",
      fix: "Invite the bot: Developer Portal → OAuth2 → URL Generator → scope bot + permission Manage Roles.",
    },
    {
      ok: health.roleExists,
      label: health.roleName ? `Role found (${health.roleName})` : "Role found",
      fix: "That role id doesn't exist in this server — re-copy it.",
    },
    {
      ok: health.hasManageRoles,
      label: "Bot has Manage Roles",
      fix: "Re-invite the bot with the Manage Roles permission (Developer Portal → OAuth2 → URL Generator).",
    },
    {
      ok: health.canGrant,
      label: "Bot can grant it",
      fix: "Server Settings → Roles: drag the bot's role ABOVE the ping role. Discord won't let a bot assign a role above its own.",
    },
  ];
  const firstBroken = rows.find((r) => r.ok === false);
  const allGood = rows.every((r) => r.ok === true);

  // The OAuth guild-join rides the same bot but fails for its OWN two reasons,
  // both of them silent: Discord 403s a join from a bot without
  // CREATE_INSTANT_INVITE, and it 403s a `guilds.join` token issued by a
  // different application. Kept as a separate verdict so a join problem can't
  // mask a ping-role problem (or be masked by one) in the single "Next:" line.
  const joinRows: { ok: boolean | null; label: string; fix: string }[] = [
    {
      ok: health.appMatchesOauth,
      label: "Bot is the OAuth app",
      fix: "DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID come from DIFFERENT Discord applications — Discord only honours a join token from the app that issued it. Use the bot token from the same application as the OAuth client.",
    },
    {
      ok: health.canInvite,
      label: "Bot can add members",
      fix: "Re-invite the bot with the Create Invite permission (Developer Portal → OAuth2 → URL Generator → bot + Create Instant Invite).",
    },
  ];
  const firstBrokenJoin = joinRows.find((r) => r.ok === false);

  return (
    <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {rows.map((r) => (
          <span
            key={r.label}
            className={
              r.ok === true
                ? "text-success"
                : r.ok === false
                  ? "text-danger"
                  : "text-muted"
            }
          >
            {r.ok === true ? "✓" : r.ok === false ? "✗" : "•"} {r.label}
          </span>
        ))}
      </div>
      {/* The raw numbers behind the verdict. A boolean on its own is how the
          first version of this check stayed wrong on every server it ran on —
          there was nothing visible to sanity-check it against. */}
      {health.botTopPosition !== null && health.rolePosition !== null ? (
        <p className="mt-1 text-xs text-muted">
          Bot&apos;s highest role sits at position {health.botTopPosition}; the
          ping role is at {health.rolePosition}.
          {health.canGrant ? " Higher, so it can assign it." : ""}
        </p>
      ) : null}
      {/* Only meaningful once a bot exists at all — without one the site never
          asks for guilds.join in the first place. */}
      {health.hasToken && health.hasGuild ? (
        <div className="mt-2 border-t border-line pt-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-muted">
              {mutationsAllowed
                ? "Auto-join on link:"
                : "Production auto-join readiness:"}
            </span>
            {joinRows.map((r) => (
              <span
                key={r.label}
                className={
                  r.ok === true
                    ? "text-success"
                    : r.ok === false
                      ? "text-danger"
                      : "text-muted"
                }
              >
                {r.ok === true ? "✓" : r.ok === false ? "✗" : "•"} {r.label}
              </span>
            ))}
          </div>
          {firstBrokenJoin ? (
            <p className="mt-1 text-xs text-danger">{firstBrokenJoin.fix}</p>
          ) : null}
          {!mutationsAllowed ? (
            <p className="mt-1 text-xs text-muted">
              Preview verifies these credentials with read-only checks but does
              not request guild-join permission or add members.
            </p>
          ) : null}
        </div>
      ) : null}
      {health.problem ? (
        <p className="mt-2 text-xs text-danger">{health.problem}</p>
      ) : firstBroken ? (
        <p className="mt-2 text-xs text-danger">
          <b>Next:</b> {firstBroken.fix}
        </p>
      ) : allGood ? (
        <p className="mt-2 text-xs text-success">
          Players who&apos;ve linked Discord can now opt in from their profile.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Loads everything the Discord card needs. Its own component so the page can
 * put it behind <Suspense> — see the render site for why that matters.
 */
async function DiscordSection() {
  // Never hand the raw webhook URL to the client — it's a bearer credential.
  // Resolve it server-side only to derive a boolean + a masked fingerprint.
  const dbWebhook = (await getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL)) ?? "";
  const activeWebhook = dbWebhook || process.env.DISCORD_WEBHOOK_URL || "";
  const [board, pingHealth, delivery] = await Promise.all([
    getInhouseBoardStatus(),
    getPingHealth(),
    loadLeagueDeliveryHealth().catch(() => null),
  ]);
  return (
    <DiscordControls
      delivery={delivery}
      status={{
        configured: !!activeWebhook,
        masked: maskWebhookUrl(activeWebhook),
        // Set only via env, not the DB — Remove (which clears the DB key)
        // can't touch it, so we hide that button and say where it lives.
        envManaged: !dbWebhook && !!process.env.DISCORD_WEBHOOK_URL,
      }}
      board={board}
      pingHealth={pingHealth}
      mutationsAllowed={discordMutationsAllowed()}
    />
  );
}

/**
 * Whether league posts are actually getting through. The badge above only
 * says a webhook URL is saved; this says what Discord did with the posts.
 * Error codes only — the webhook URL never reaches the page.
 */
function LeagueDeliveryLine({
  health,
  paused,
}: {
  health: LeagueDeliveryHealth;
  paused: boolean;
}) {
  const lastError =
    health.waiting > 0 ? deliveryErrorLabel(health.headErrorCode) : null;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted">
        {health.lastDeliveredAt ? (
          <>
            Last post delivered{" "}
            <AutomationTimestamp
              value={health.lastDeliveredAt}
              emptyLabel="never"
            />
          </>
        ) : (
          "No league post delivered yet"
        )}
        {" · "}
        {health.waiting > 0 ? `${health.waiting} waiting` : "nothing waiting"}
        {lastError ? ` · last error: ${lastError}` : null}
      </p>
      {paused ? (
        <p className="text-danger">
          Posting is paused: Discord refuses this webhook (it was deleted, its
          token changed, or it lost access to the channel). Paste a new webhook
          URL below and the waiting posts go out, oldest first.
        </p>
      ) : null}
      {health.refusedRecently > 0 ? (
        <p className="text-muted [overflow-wrap:anywhere]">
          {refusedPostsSentence(health)}
        </p>
      ) : null}
      {health.expiredRecently > 0 ? (
        <p className="text-muted">
          {health.expiredRecently} out-of-date post
          {health.expiredRecently === 1 ? " was" : "s were"} dropped in the
          last day instead of posting late (reminders after kickoff, draft
          posts after the draft).
        </p>
      ) : null}
      {health.waiting > 0 && health.newestWaitingAt ? (
        <ActionForm
          action={discardWaitingDiscordPosts}
          hidden={{ upTo: String(health.newestWaitingAt.getTime()) }}
        >
          <SubmitButton
            variant="ghost"
            size="sm"
            confirm={`Discard the ${health.waiting} league post${health.waiting === 1 ? "" : "s"} waiting to go to Discord? ${health.waiting === 1 ? "It" : "They"} will never be posted.`}
          >
            Discard {health.waiting} waiting post
            {health.waiting === 1 ? "" : "s"}
          </SubmitButton>
        </ActionForm>
      ) : null}
    </div>
  );
}

function DiscordControls({
  status,
  delivery,
  board,
  pingHealth,
  mutationsAllowed,
}: {
  status: { configured: boolean; masked: string; envManaged: boolean };
  delivery: LeagueDeliveryHealth | null;
  board: InhouseBoardStatus;
  pingHealth: PingHealth;
  mutationsAllowed: boolean;
}) {
  const { configured, masked, envManaged } = status;
  const paused = !!delivery && deliveryPaused(delivery);
  return (
    <AdminSection
      id="adm-discord"
      title="Discord notifications"
      subtitle="Configure league announcements plus the year-round inhouse queue board, alerts, and ping role."
      // Opens itself when league posts are stuck: in the offseason there is
      // no Needs attention card to say so. A post Discord refused does not
      // open it; the queue already dropped that post, and the card lists it
      // below for whoever looks.
      defaultOpen={!!delivery && leagueDeliveryAttention(delivery).length > 0}
    >
      <CardBody className="space-y-3">
        {!mutationsAllowed ? (
          <div
            role="status"
            className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm"
          >
            <b>Read-only Discord preview.</b> Identity, membership, bot, and
            permission checks are live. Posting messages, joining members, and
            changing or deleting live Discord roles/messages are disabled.
            Configuration edits below affect only the isolated preview database.
          </div>
        ) : null}
        {/* Moved out of the card header: a button inside a <summary> toggles
            the disclosure instead of submitting. */}
        <div className="flex justify-end">
          <ActionForm action={testDiscordWebhook}>
            <SubmitButton
              variant="secondary"
              size="sm"
              disabled={!configured || !mutationsAllowed}
            >
              Send test message
            </SubmitButton>
          </ActionForm>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {configured ? (
            <>
              <Badge tone={paused ? "danger" : "success"}>
                {paused ? "Refused by Discord" : "Configured"}
              </Badge>
              <span className="font-mono text-xs text-muted">{masked}</span>
              {envManaged ? (
                <span className="text-xs text-muted">
                  · via <code>DISCORD_WEBHOOK_URL</code> env var
                </span>
              ) : null}
            </>
          ) : (
            <Badge tone="neutral">Not configured</Badge>
          )}
        </div>
        {delivery && (configured || delivery.waiting > 0) ? (
          <LeagueDeliveryLine health={delivery} paused={paused} />
        ) : null}

        <ActionForm
          action={setDiscordWebhook}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1">
            <label
              htmlFor="discordWebhookUrl"
              className="mb-1 block text-xs text-muted"
            >
              {configured ? "Replace webhook URL" : "Webhook URL"}
            </label>
            <input
              id="discordWebhookUrl"
              name="discordWebhookUrl"
              type="url"
              autoComplete="off"
              placeholder="https://discord.com/api/webhooks/…"
              className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
            />
          </div>
          <SubmitButton variant="secondary" size="sm">
            Save webhook
          </SubmitButton>
        </ActionForm>

        {configured && !envManaged ? (
          <ActionForm action={clearDiscordWebhook}>
            <SubmitButton
              variant="ghost"
              size="sm"
              confirm="Turn off Discord announcements? This removes the saved webhook."
            >
              Remove webhook
            </SubmitButton>
          </ActionForm>
        ) : null}

        <p className="text-xs text-muted">
          In Discord:{" "}
          <b>Server Settings → Integrations → Webhooks → New Webhook</b>, pick
          the announcements channel, copy the URL and paste it here. For
          security the saved URL is never shown again — paste a new one to
          replace it, or Remove to turn announcements off.
        </p>
        <p className="text-xs text-muted">
          <b>Who gets pinged:</b> league posts mention only the people each
          post is for, such as a captain who needs cover, a booked standin,
          the captains when a fixture moves, players who haven&apos;t checked
          in, drafted and signed players, and the Player of the Week and the
          champions. League posts never ping a role or everyone, and only
          players who linked Discord on their profile can be pinged.
        </p>

        <div className="space-y-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Inhouse channel</span>
            {board.separateChannel ? (
              <Badge tone="success">Separate</Badge>
            ) : (
              <Badge tone="neutral">Same as above</Badge>
            )}
            {board.separateChannel ? (
              <span className="font-mono text-xs text-muted">
                {board.inhouseMasked}
              </span>
            ) : null}
            <ActionForm action={testInhouseWebhook}>
              <SubmitButton
                variant="ghost"
                size="sm"
                disabled={!mutationsAllowed}
              >
                Test
              </SubmitButton>
            </ActionForm>
          </div>

          <ActionForm
            action={setInhouseWebhook}
            className="flex flex-wrap items-end gap-2"
          >
            <div className="min-w-0 flex-1">
              <label
                htmlFor="inhouseWebhookUrl"
                className="mb-1 block text-xs text-muted"
              >
                {board.separateChannel
                  ? "Replace inhouse webhook URL"
                  : "Inhouse webhook URL (optional)"}
              </label>
              <input
                id="inhouseWebhookUrl"
                name="inhouseWebhookUrl"
                type="url"
                autoComplete="off"
                placeholder="https://discord.com/api/webhooks/…"
                className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
              />
            </div>
            <SubmitButton variant="secondary" size="sm">
              Save
            </SubmitButton>
          </ActionForm>

          {board.separateChannel ? (
            <ActionForm action={clearInhouseWebhook}>
              <SubmitButton
                variant="ghost"
                size="sm"
                confirm="Send inhouse posts back to the league channel? The queue board will be removed."
              >
                Use the league channel instead
              </SubmitButton>
            </ActionForm>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Alerts channel</span>
            {board.alertsSeparate ? (
              <Badge tone="success">Separate</Badge>
            ) : (
              <Badge tone="neutral">Same as the board</Badge>
            )}
            {board.alertsSeparate ? (
              <span className="font-mono text-xs text-muted">
                {board.alertsMasked}
              </span>
            ) : null}
          </div>

          <ActionForm
            action={setInhouseAlertWebhook}
            className="flex flex-wrap items-end gap-2"
          >
            <div className="min-w-0 flex-1">
              <label
                htmlFor="inhouseAlertWebhookUrl"
                className="mb-1 block text-xs text-muted"
              >
                {board.alertsSeparate
                  ? "Replace alerts webhook URL"
                  : "Alerts webhook URL (optional)"}
              </label>
              <input
                id="inhouseAlertWebhookUrl"
                name="inhouseAlertWebhookUrl"
                type="url"
                autoComplete="off"
                placeholder="https://discord.com/api/webhooks/…"
                className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
              />
            </div>
            <SubmitButton variant="secondary" size="sm">
              Save
            </SubmitButton>
          </ActionForm>

          {board.alertsSeparate ? (
            <ActionForm action={clearInhouseAlertWebhook}>
              <SubmitButton variant="ghost" size="sm">
                Send alerts to the board channel instead
              </SubmitButton>
            </ActionForm>
          ) : null}

          <p className="text-xs text-muted">
            {board.alertsSeparate ? (
              <>
                The board&apos;s channel now holds <b>only the board</b> — queue
                pings, &ldquo;match found&rdquo; and results post in the alerts
                channel instead.
              </>
            ) : (
              <>
                <b>Alerts currently share the board&apos;s channel.</b> The
                board is read at a glance from the bottom of its channel, so
                every ping and result pushes it out of view. Make a webhook in a
                separate channel (e.g. <b>#inhouse-chat</b>) and paste it here
                to keep the board channel board-only.
              </>
            )}
          </p>

          <ActionForm
            action={setInhousePingRole}
            className="flex flex-wrap items-end gap-2"
          >
            <div className="min-w-0 flex-1">
              <label
                htmlFor="inhousePingRoleId"
                className="mb-1 block text-xs text-muted"
              >
                Ping role {board.pingRoleId ? "" : "(optional)"}
              </label>
              <input
                id="inhousePingRoleId"
                name="inhousePingRoleId"
                type="text"
                autoComplete="off"
                defaultValue={board.pingRoleId ?? ""}
                placeholder="Role id, or paste @the-role"
                className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
              />
            </div>
            <SubmitButton variant="secondary" size="sm">
              Save role
            </SubmitButton>
          </ActionForm>

          <PingHealthLines
            health={pingHealth}
            mutationsAllowed={mutationsAllowed}
          />

          <p className="text-xs text-muted">
            {board.pingRoleId ? (
              <>
                <b>The ping role is on.</b> Two inhouse posts ping this role:
                the queue filling up, and a match being found. Nothing else
                pings it, and board edits never notify anyone.
              </>
            ) : (
              <>
                <b>No ping role set</b>, so the &ldquo;queue is
                filling&rdquo; post pings nobody. Set a role here and that post
                and &ldquo;match found&rdquo; will ping it. Board edits never
                notify anyone.
              </>
            )}{" "}
            Make the role <b>self-assignable</b> (Server Settings → Onboarding,
            or a Channels &amp; Roles picker) — a ping people can&apos;t opt out
            of gets the channel muted, which is worse than silence. With or
            without a role, the ten players are mentioned when their match is
            found, if they&apos;ve linked Discord on their profile.
          </p>

          <p className="text-xs text-muted">
            A Discord webhook only ever posts to the channel it was made in.
            Make one in <b>#inhouse</b> and paste it here to send the queue
            board, &ldquo;match found&rdquo;, the queue ping and inhouse results
            there — leaving signups, draft night and match results in the
            channel above. Leave this blank and everything shares one channel.
          </p>
        </div>

        <div className="space-y-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Live queue board</span>
            {board.posted ? (
              board.stranded ? (
                <Badge tone="danger">Stranded</Badge>
              ) : (
                <Badge tone="success">Posted</Badge>
              )
            ) : board.postingStuck ? (
              <Badge tone="danger">Post interrupted</Badge>
            ) : board.posting ? (
              <Badge tone="accent">Posting…</Badge>
            ) : (
              <Badge tone="neutral">Not posted</Badge>
            )}
            {board.posted ? (
              <span className="font-mono text-xs text-muted">
                msg {board.messageHint}
              </span>
            ) : null}
            {board.posted && board.failures > 0 ? (
              <Badge tone="danger">
                {board.failures} failed edit{board.failures === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {board.posted && board.lastEdit ? (
              <span className="text-xs text-muted">
                · last edit{" "}
                <LocalTime
                  ts={new Date(board.lastEdit).getTime()}
                  variant="full"
                  initial={formatLeagueMatchTime(new Date(board.lastEdit), "full")}
                />
              </span>
            ) : null}
          </div>

          {board.posted ? (
            <p className="text-xs text-muted">
              Queue right now: <b>{board.liveState}</b> —{" "}
              {board.inSync
                ? "the board is showing this."
                : "the board hasn't caught up yet. It updates within about a minute."}
            </p>
          ) : null}

          {board.stranded ? (
            <p className="text-xs text-danger">
              The board belongs to a different webhook than the one configured
              now — it can no longer be updated or deleted from here. Remove it
              here, delete the message by hand in the old channel, then post a
              new one.
            </p>
          ) : null}

          {board.postingStuck ? (
            <p className="text-xs text-danger">
              The server stopped while it was posting this board, so it never
              saved a Discord message id. Check the channel for an untracked
              board first; then clear this interrupted post below and delete any
              orphaned message by hand before posting again.
            </p>
          ) : board.posting ? (
            <p className="text-xs text-muted">
              Discord is creating the message. Reload in a moment; a second post
              is blocked while this short lease is active.
            </p>
          ) : null}

          {board.posted && board.failures > 0 ? (
            <p className="text-xs text-danger">
              Discord has rejected the last {board.failures} edit
              {board.failures === 1 ? "" : "s"} — the channel is showing a count
              the site already knows is out of date. Check the webhook.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {board.posted ? (
              <ActionForm action={deleteInhouseBoard}>
                <SubmitButton
                  variant="ghost"
                  size="sm"
                  disabled={!mutationsAllowed}
                  confirm="Delete the queue board message from Discord?"
                >
                  Remove board
                </SubmitButton>
              </ActionForm>
            ) : board.postingStuck ? (
              <ActionForm action={deleteInhouseBoard}>
                <SubmitButton
                  variant="ghost"
                  size="sm"
                  disabled={!mutationsAllowed}
                  confirm="Clear the interrupted board post? First check Discord and delete any board message that may have been created, because the site never received its message id."
                >
                  Clear interrupted post
                </SubmitButton>
              </ActionForm>
            ) : board.posting ? null : (
              <ActionForm action={postInhouseBoard}>
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  // Gated on the INHOUSE webhook, which is what the board
                  // actually posts through — a league that configured only the
                  // inhouse one had a working board behind a disabled button.
                  disabled={
                    !mutationsAllowed || (!configured && !board.separateChannel)
                  }
                >
                  Post queue board
                </SubmitButton>
              </ActionForm>
            )}
          </div>

          <p className="text-xs text-muted">
            Posts <b>one</b> message showing who&apos;s in the inhouse queue and
            rewrites it in place as players come and go — a live count with no
            new messages, ever. Editing a message doesn&apos;t notify anyone, so{" "}
            <b>pin it</b> (right-click → Pin Message) or it will scroll away.
            The separate queue ping (fired once the queue reaches 4 players) is
            what actually alerts people; this board just shows the state.
          </p>
        </div>
      </CardBody>
    </AdminSection>
  );
}

type NewsPostRow = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: Date;
  author: { name: string } | null;
  discord: NewsDiscordCopy;
};

/**
 * WHAT DID I PRESS? Until now nothing in the app could answer that: no model
 * carried an actor column, and Discord announces signups, sales and results but
 * is silent on every destructive action. Streamed behind Suspense like the
 * Discord card — it is a diagnostic, and must never delay the controls above it.
 */
async function AdminActivity() {
  // A preview only: the full log, with search, lives at /admin/activity, so
  // a 40-row copy here was the same list twice.
  const rows = await recentAdminActions(5);
  return (
    <AdminSection
      id="adm-activity"
      title="Recent admin activity"
      subtitle="The last five changes, newest first. The full log is searchable on its own page."
    >
      <CardBody className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing recorded yet. Season, draft, schedule, playoff and result
            changes are logged here from now on.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border border-line px-3 py-1.5 text-sm"
              >
                <span className="font-medium">{r.actorName}</span>
                <span className="min-w-0 flex-1 text-muted">{r.summary}</span>
                <LocalTime
                  ts={r.createdAt.getTime()}
                  variant="short"
                  initial={formatLeagueMatchTime(r.createdAt, "short")}
                  className="shrink-0 text-xs text-muted tabular-nums"
                />
              </li>
            ))}
          </ul>
        )}
        <Link href="/admin/activity" className={textLink()}>
          All admin activity →
        </Link>
      </CardBody>
    </AdminSection>
  );
}

/**
 * The league's stream channel (broadcast.ts). Playoff and final matches link
 * to it on Home, the match page and /schedule: where they will be streamed,
 * then a live link from WATCH_OPENS_BEFORE_KICKOFF_MS before kickoff until the
 * series should be over, longer once a game is in (matchWatchWindow). One
 * link for the whole league, kept across seasons.
 */
async function StreamControls() {
  const stream = parseStoredStream(
    await getSetting(SETTING_KEYS.LEAGUE_STREAM_URL),
  );
  return (
    <AdminSection
      title="Match stream"
      subtitle={
        stream
          ? `On: playoff and final matches link to ${stream.platform}.`
          : "Off: no match links to a stream."
      }
    >
      <CardBody className="space-y-3">
        <p className="text-sm text-muted">
          One Twitch, YouTube or Kick channel for the league. Every playoff and
          final match links to it on Home, its match page and the schedule:
          where it will be streamed before kickoff, then a live link from{" "}
          {WATCH_OPENS_BEFORE_KICKOFF_MS / 60_000} minutes before kickoff until
          the series should be over, or longer once a game is in. While it is
          live, the match page (and Home, when that match is the only one on)
          also plays it in place, in the streaming service&apos;s own player,
          which loads only when a visitor presses play. On YouTube that needs
          the live video&apos;s link or a youtube.com/channel/UC… link. The
          regular season shows nothing. Remove it on playoff nights nobody
          streams.
        </p>
        <ActionForm
          action={setLeagueStreamUrl}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1 basis-64">
            <label htmlFor="streamUrl" className="mb-1 block text-xs text-muted">
              Stream link
            </label>
            <input
              id="streamUrl"
              name="streamUrl"
              type="url"
              inputMode="url"
              defaultValue={stream?.url ?? ""}
              placeholder="https://www.twitch.tv/yourchannel"
              className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
            />
          </div>
          <SubmitButton variant="secondary" size="sm">
            Save stream link
          </SubmitButton>
        </ActionForm>
        {stream ? (
          <ActionForm action={setLeagueStreamUrl} hidden={{ streamUrl: "" }}>
            <SubmitButton variant="ghost" size="sm">
              Remove stream link
            </SubmitButton>
          </ActionForm>
        ) : null}
      </CardBody>
    </AdminSection>
  );
}

function SecurityControls() {
  return (
    <AdminSection
      id="adm-security"
      title="Security"
      subtitle="Break-glass session controls."
    >
      <CardBody>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 p-3">
          <p className="min-w-[14rem] flex-1 text-xs text-muted">
            <span className="font-medium text-fg">Sign out all users:</span>{" "}
            invalidates every active session at once — use if a login token may
            have leaked or an account is compromised. Everyone (including you)
            has to sign in with Steam again.
          </p>
          <ActionForm action={revokeAllSessions}>
            <SubmitButton
              variant="secondary"
              size="sm"
              confirm="Sign out ALL users, including yourself? Everyone must log in again."
            >
              Sign out all users
            </SubmitButton>
          </ActionForm>
        </div>
      </CardBody>
    </AdminSection>
  );
}

async function AdminMatchNightPoll({
  admin,
  season,
  fixturesNight,
}: {
  admin: { id: string; role: string };
  season: Season | null;
  fixturesNight: string | null;
}) {
  // Async server component: rendered once per request.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const poll = await loadLatestPoll(admin, nowMs);
  // Once voting closes, while the result is still on Home: who won, and
  // whether it is the season's match night yet and announced. The section
  // used to fold away under its generic subtitle the moment voting closed.
  const winner =
    poll && !poll.open && poll.results?.winner
      ? (poll.slots.find((slot) => slot.key === poll.results?.winner) ?? null)
      : null;
  const announced = winner
    ? (
        await prisma.setting.findUnique({
          where: { key: pollResultMarker(poll!.id, poll!.closesAt) },
          select: { value: true },
        })
      )?.value === "sent"
    : false;
  const closed =
    poll && !poll.open && pollOnHome({ closesAt: new Date(poll.closesAt) }, nowMs)
      ? closedPollStatus({
          winnerLabel: winner?.label ?? null,
          count: winner ? (poll.results?.counts[winner.key] ?? 0) : 0,
          ballots: poll.results?.ballots ?? poll.ballots,
          usedAsMatchNight: !!winner && season?.matchSchedule === winner.label,
          announced,
        })
      : null;
  return (
    <AdminSection
      id="adm-poll"
      title="Match night poll"
      subtitle={
        poll?.open
          ? `Voting is open: ${pollTurnoutLine(poll.ballots, poll.electorate, true)}. Signed-up players mark every time they could play on Home; the time the most can make wins.`
          : closed
            ? closed.line
            : "Let signed-up players mark every weekly time they could play. The grid fills itself, the poll shows on Home, and the time the most players can make wins."
      }
      defaultOpen={(poll?.open ?? false) || !!closed?.needsFollowUp}
    >
      <MatchNightPollControls
        poll={poll}
        season={
          season
            ? {
                id: season.id,
                updatedAt: season.updatedAt,
                matchSchedule: season.matchSchedule,
                fixturesNight,
              }
            : null
        }
        nowMs={nowMs}
        announced={announced}
      />
    </AdminSection>
  );
}

async function AdminNews({
  searchParams,
}: {
  searchParams: Promise<{ newsPage?: string | string[] }>;
}) {
  const page = listPage((await searchParams).newsPage);
  const results = await prisma.newsPost.findMany({
    include: { author: { select: { name: true } } },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * 20,
    take: 21,
  });
  // Async server component: rendered once per request, so Date.now() has no
  // re-render to disagree with.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  // The stored Discord message id never goes to the client; the card only
  // needs to know which state the copy is in.
  const posts: NewsPostRow[] = results
    .slice(0, 20)
    .map(({ discordMessageId, ...post }) => ({
      ...post,
      discord: newsDiscordCopy(discordMessageId, nowMs),
    }));
  return (
    <div className="space-y-3">
      <NewsControls posts={posts} />
      {/* Only with somewhere to go: an empty nav still took space-y's gap. */}
      {page > 1 || results.length > 20 ? (
        <nav aria-label="Admin news pages" className="flex gap-3 text-sm">
          {page > 1 ? (
            <Link
              href={`/admin?newsPage=${page - 1}#adm-news`}
              className={buttonClasses("secondary", "sm")}
            >
              ← Newer posts
            </Link>
          ) : null}
          {results.length > 20 ? (
            <Link
              href={`/admin?newsPage=${page + 1}#adm-news`}
              className={buttonClasses("secondary", "sm")}
            >
              Older posts →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function NewsControls({ posts }: { posts: NewsPostRow[] }) {
  return (
    <AdminSection
      id="adm-news"
      title="League news"
      subtitle="Announcements shown on the dashboard and /news, and in Discord when you tick it."
    >
      <CardBody className="space-y-4">
        <ActionForm action={createNewsPost} className="space-y-3">
          <input type="hidden" name="requestId" value={randomUUID()} />
          <Field label="Title" htmlFor="newsTitle">
            <input
              id="newsTitle"
              name="title"
              required
              maxLength={NEWS_LIMITS.TITLE_MAX}
              placeholder="Week 3 moved to Thursday"
              className={inputCls}
            />
          </Field>
          <Field label="Post" htmlFor="newsBody">
            <textarea
              id="newsBody"
              name="body"
              required
              rows={4}
              maxLength={NEWS_LIMITS.BODY_MAX}
              placeholder="What the league needs to know…"
              className="w-full rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-accent/60"
            />
            <p className="mt-1 text-xs text-muted">
              Drop a GIF link on its own line to embed it on the site and in
              Discord. Easiest: a <strong>Giphy</strong> or{" "}
              <strong>Tenor</strong> page link. Klipy page links don’t embed —
              right-click the GIF → “Copy image address” (a static.klipy.com/…​
              .gif URL) instead. Direct image/GIF/MP4 URLs also work.
            </p>
          </Field>
          <NewsDiscordChoices idSuffix="new" postByDefault />
          <SubmitButton variant="accent">Post announcement</SubmitButton>
        </ActionForm>

        {posts.length > 0 && (
          <ul className="divide-y divide-line/50 border-t border-line/70">
            {posts.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-2 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {p.pinned ? "📌 " : ""}
                    {p.title}
                  </span>
                  <span className="block text-xs text-muted">
                    <LocalTime
                      ts={p.createdAt.getTime()}
                      variant="short"
                      initial={formatLeagueMatchTime(p.createdAt, "short")}
                    />
                    {p.author ? ` · ${p.author.name}` : ""}
                    {` · ${newsDiscordLabel(p.discord)}`}
                  </span>
                </span>
                <ActionForm action={toggleNewsPin} className="inline">
                  <input type="hidden" name="postId" value={p.id} />
                  <input
                    type="hidden"
                    name="pinned"
                    value={p.pinned ? "false" : "true"}
                  />
                  <SubmitButton variant="secondary" size="sm">
                    {p.pinned ? "Unpin" : "Pin"}
                  </SubmitButton>
                </ActionForm>
                <ActionForm action={deleteNewsPost} className="inline">
                  <input type="hidden" name="postId" value={p.id} />
                  <SubmitButton
                    variant="secondary"
                    size="sm"
                    confirm={`Delete "${p.title}"? This can't be undone.${
                      p.discord.state === "posted"
                        ? " Its Discord copy is removed too."
                        : ""
                    }`}
                  >
                    Delete
                  </SubmitButton>
                </ActionForm>
                {/* Keyed on the text so a saved edit remounts the form with
                    the new text as its defaults (and folds it shut). */}
                <details
                  key={`${p.title}\u0000${p.body}`}
                  className="basis-full"
                >
                  <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                    ✎ Edit
                  </summary>
                  <ActionForm
                    action={updateNewsPost}
                    className="mt-2 space-y-3"
                    hidden={{ postId: p.id }}
                  >
                    <Field label="Title" htmlFor={`newsTitle-${p.id}`}>
                      <input
                        id={`newsTitle-${p.id}`}
                        name="title"
                        required
                        maxLength={NEWS_LIMITS.TITLE_MAX}
                        defaultValue={p.title}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Post" htmlFor={`newsBody-${p.id}`}>
                      <textarea
                        id={`newsBody-${p.id}`}
                        name="body"
                        required
                        rows={4}
                        maxLength={NEWS_LIMITS.BODY_MAX}
                        defaultValue={p.body}
                        className="w-full rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-accent/60"
                      />
                    </Field>
                    {p.discord.state === "posted" ? (
                      <p className="text-xs text-muted">
                        Saving also updates the Discord copy. Edits never ping
                        anyone.
                      </p>
                    ) : p.discord.state === "posting" &&
                      !p.discord.interrupted ? (
                      <p className="text-xs text-muted">
                        A post to Discord is in progress.
                      </p>
                    ) : (
                      <>
                        <p className="text-xs text-muted">
                          {p.discord.state === "posting"
                            ? "An earlier post to Discord was interrupted. Check the channel before posting it again."
                            : "This post has no Discord copy the site can update. Posts from before edits existed may still be in the channel."}
                        </p>
                        <NewsDiscordChoices idSuffix={p.id} />
                      </>
                    )}
                    <SubmitButton variant="secondary" size="sm">
                      Save changes
                    </SubmitButton>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </AdminSection>
  );
}

/** One line on each admin news row: where the post's Discord copy stands. */
function newsDiscordLabel(copy: NewsDiscordCopy): string {
  if (copy.state === "posted") return "on Discord";
  if (copy.state === "posting") {
    return copy.interrupted ? "Discord post interrupted" : "posting to Discord";
  }
  return "not on Discord";
}

/**
 * The two Discord choices on a news form. @everyone is never ticked for the
 * admin: it notifies every member of the server, so it has to be a choice.
 */
function NewsDiscordChoices({
  idSuffix,
  postByDefault = false,
}: {
  idSuffix: string;
  postByDefault?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <label
          htmlFor={`newsDiscord-${idSuffix}`}
          className="inline-flex items-center gap-2"
        >
          <input
            id={`newsDiscord-${idSuffix}`}
            type="checkbox"
            name="postToDiscord"
            defaultChecked={postByDefault}
            className="h-4 w-4 accent-[var(--color-brand)]"
          />
          Also post to Discord
        </label>
        <label
          htmlFor={`newsEveryone-${idSuffix}`}
          className="inline-flex items-center gap-2"
        >
          <input
            id={`newsEveryone-${idSuffix}`}
            type="checkbox"
            name="pingEveryone"
            className="h-4 w-4 accent-[var(--color-brand)]"
          />
          Ping @everyone
        </label>
      </div>
      <p className="text-xs text-muted">
        @everyone notifies every member of the server, so keep it for news
        everyone has to see. It only applies when the post goes to Discord.
      </p>
    </div>
  );
}

// ---------- small helpers ----------

const inputCls =
  "h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60";

// min-w-0 + max-w-full are load-bearing, not cosmetic: a <select> sizes itself
// to its widest <option>, and as a flex item its default min-width:auto refuses
// to shrink below that. Options here are "<player name> (<team>)", so one
// 32-char Steam name (Steam's own cap) pushed the whole admin page ~116px wider
// than a 375px phone. Keep these on any select whose options carry user text.
const selectCls =
  "h-9 min-w-0 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-sm outline-none focus:border-accent/60";

function SeriesField({
  label,
  name,
  value,
  options,
}: {
  label: string;
  name: string;
  value: number;
  options: number[];
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs text-muted">
        {label}
      </label>
      <select id={name} name={name} defaultValue={value} className={selectCls}>
        {options.map((n) => (
          <option key={n} value={n}>
            Best of {n}
          </option>
        ))}
      </select>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

// Open captain reschedule proposals — admins see the whole queue and can
// clear a stuck one (cancelReschedule allows admins as well as proposers).
async function PendingReschedules({
  seasonId,
  teams,
}: {
  seasonId: string;
  teams: { id: string; name: string }[];
}) {
  const pending = await prisma.rescheduleRequest.findMany({
    where: { match: { seasonId }, status: "PENDING" },
    include: {
      proposedBy: { select: { name: true } },
      match: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (pending.length === 0) return null;
  const name = (id: string) => teams.find((t) => t.id === id)?.name ?? "?";
  return (
    <div className="space-y-1.5 rounded-lg border border-accent/40 bg-accent/10 p-3 text-xs">
      <div className="font-medium">
        ⏳ {pending.length} reschedule proposal
        {pending.length === 1 ? "" : "s"} awaiting a captain
      </div>
      {pending.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1">
            <Link href={`/matches/${r.matchId}`} className={textLink()}>
              Wk {r.match.week}
            </Link>
            : {name(r.match.homeTeamId)} vs {name(r.match.awayTeamId)} —{" "}
            <strong>{r.proposedBy.name}</strong> proposes{" "}
            {parseRescheduleOptions(r.options, r.proposedTime).map((ts, i, all) => (
              <span key={ts}>
                {i > 0 ? (i === all.length - 1 ? " or " : ", ") : null}
                <LocalTime
                  ts={ts}
                  variant="full"
                  initial={formatLeagueMatchTime(new Date(ts), "full")}
                />
              </span>
            ))}
          </span>
          <ActionForm action={cancelReschedule} hidden={{ requestId: r.id }}>
            <SubmitButton variant="secondary" size="sm">
              Clear
            </SubmitButton>
          </ActionForm>
        </div>
      ))}
    </div>
  );
}
