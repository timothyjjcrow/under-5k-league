import { Suspense } from "react";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { completedSeasonArchiveReadiness, getActiveSeason } from "@/lib/season";
import { capacityInfo } from "@/lib/capacity";
import { prisma } from "@/lib/prisma";
import {
  AUTO_SYNC,
  DRAFT_STATUS,
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_BETS,
  INHOUSE_BET_STATUS,
  INHOUSE_CRED_REASON,
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_PHASE_ORDER,
  SEASON_STATUS,
} from "@/lib/constants";
import { leagueFallbackOpensAt, nextAutoSyncAt } from "@/lib/result-sync";
import { seatValue, standinConflict } from "@/lib/standin";
import { ADMIN_PHASE_LABEL as PHASE_LABEL } from "@/lib/season-copy";
import {
  createSeason,
  archiveCompletedSeasonAction,
  archiveIncompleteSeasonAction,
  setSeasonPhase,
  addCaptain,
  removeCaptain,
  randomizeDraftOrder,
  startDraft,
  generateSchedule,
  startPlayoffs,
  returnToRegularSeasonAction,
  recordResult,
  assignStandin,
  removeStandin,
  removeGame,
  setMatchTime,
  setWeekNight,
  syncPlayerRanks,
  syncAllRanks,
  syncSteamProfiles,
  setMaxMmr,
  setMatchSchedule,
  renameSeason,
  renameTeam,
  withdrawSignup,
  setRegistrationMmr,
  setSeriesLengths,
  setLeagueId,
  syncLeagueAction,
  enrichGamesAction,
  setDiscordWebhook,
  clearDiscordWebhook,
  testDiscordWebhook,
  setInhouseWebhook,
  clearInhouseWebhook,
  setInhouseAlertWebhook,
  clearInhouseAlertWebhook,
  setInhousePingRole,
  testInhouseWebhook,
  postInhouseBoard,
  deleteInhouseBoard,
  revokeAllSessions,
  signFreeAgent,
  releasePlayer,
  importGameAction,
  autoDetectAction,
  setDraftNight,
  promoteStandinToPlayer,
  undoLastSaleAction,
  abortDraftAction,
  pauseDraftAction,
  resumeDraftAction,
  voidCurrentLotAction,
  transferCaptaincy,
  withdrawTeam,
  reinstateTeam,
  reopenMatch,
  reinstateSignup,
  setDraftSettings,
} from "@/app/actions/admin";
import { runMaintenanceNow } from "@/app/actions/automation";
import { cancelReschedule } from "@/app/actions/reschedule";
import { adjustCredAction } from "@/app/actions/inhouse-bets";
import {
  createNewsPost,
  deleteNewsPost,
  toggleNewsPin,
} from "@/app/actions/news";
import { NEWS_LIMITS } from "@/lib/news";
import { formatMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import {
  ANNOUNCE_FAILED_PREFIX,
  getSetting,
  HONORS_ANNOUNCED_PREFIX,
  leagueSyncSkipKey,
  playoffGamesArchiveKey,
  SETTING_KEYS,
} from "@/lib/settings";
import { adminNextStep } from "@/lib/admin-next-step";
import { recentAdminActions } from "@/lib/admin-log";
import { AUTOMATION_RUN_KEY } from "@/lib/automation-service";
import {
  automationHealthView,
  type AutomationHealthRecord,
} from "@/lib/automation-health";
import { LEAGUE_ANNOUNCEMENT_STATUS } from "@/lib/league-announcement-outbox";
import { INHOUSE_ANNOUNCEMENT_STATUS } from "@/lib/inhouse-announcement-outbox";
import { DangerSubmit } from "@/components/danger-submit";
import { ChaseCopy } from "@/components/chase-copy";
import { cn } from "@/lib/utils";
import { maskWebhookUrl } from "@/lib/discord";
import { discordMutationsAllowed } from "@/lib/discord-mutation-policy";
import {
  getInhouseBoardStatus,
  type InhouseBoardStatus,
} from "@/lib/inhouse-board-service";
import { credProfitBoard } from "@/lib/inhouse-bet-service";
import { potView } from "@/lib/inhouse-bets";
import {
  discordReachWarning,
  getDiscordReachFunnel,
  getGuildConfig,
  getPingHealth,
  sweepGuildMemberships,
  type DiscordReachFunnel,
  type GuildMembership,
  type PingHealth,
} from "@/lib/discord-roles";
import { membershipChipView, signupFlags } from "@/lib/signup-readiness";
import {
  DRAFT_READINESS,
  draftReadiness,
  draftReadinessCounts,
} from "@/lib/draft-readiness";
import { DiscordTag } from "@/components/discord-tag";
import {
  roundName,
  slotRound,
  groupPlayoffRounds,
  hasLaterBracketRound,
} from "@/lib/schedule";
import { projectPlayoffField } from "@/lib/playoff-field";
import { playoffSetupRevision } from "@/lib/playoff-command";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import {
  matchLogisticsOpen,
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
  captainTransferOpen,
  draftSeatPlan,
  draftSetupLockedMessage,
  draftSetupOpen,
} from "@/lib/draft-setup";
import {
  MATCH_SCHEDULE,
  SOFT_MMR_LIMIT,
  HARD_MMR_CEILING,
} from "@/lib/constants";
import {
  regularSeasonStatus,
  pendingResultsMessage,
} from "@/lib/schedule-status";
import { MatchImportControls } from "@/components/match-import-controls";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { TEAM_LOGO_URL_MAX_LENGTH } from "@/lib/team-logo";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  EmptyState,
  PageTitle,
  PlayerLink,
  RankMedal,
  RoleBadges,
  Stat,
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

export default async function AdminPage() {
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

  const data = season ? await loadSeasonAdminData(season.id) : null;
  const handoffReadiness =
    season && data
      ? completedSeasonArchiveReadiness(
          season,
          data.matches,
          data.teams.map((team) => team.id),
        )
      : null;
  const newsPosts = await prisma.newsPost.findMany({
    include: { author: { select: { name: true } } },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  const newSeasonDefaults =
    season ??
    (await prisma.season.findFirst({
      where: { isActive: false },
      orderBy: { createdAt: "desc" },
    }));

  return (
    <div className="space-y-8">
      <PageTitle
        title="Admin"
        subtitle="Run the league — create seasons, pick captains, run the draft, enter results."
      />

      <AdminJump
        items={[
          ...(season && data
            ? [
                { id: "adm-season", label: "Phase" },
                { id: "adm-captains", label: "Captains & draft" },
                { id: "adm-schedule", label: "Schedule & results" },
                { id: "adm-playoffs", label: "Playoffs" },
                ...(rosterMovesVisible(season, data)
                  ? [{ id: "adm-roster", label: "Roster moves" }]
                  : []),
                { id: "adm-standins", label: "Standins" },
                ...(autoSyncVisible(season)
                  ? [{ id: "adm-sync", label: "Auto-sync" }]
                  : []),
                { id: "adm-league", label: "League id" },
              ]
            : []),
          { id: "adm-automation", label: "Automation" },
          // Season-independent: inhouse alerts/board and the Cred economy are
          // most important in the offseason, when inhouse is the live mode.
          { id: "adm-discord", label: "Discord" },
          { id: "adm-bets", label: "Betting" },
          { id: "adm-activity", label: "Activity" },
          { id: "adm-news", label: "News" },
          { id: "adm-security", label: "Security" },
          { id: "adm-new-season", label: "Season handoff" },
        ]}
      />

      {season && data ? (
        <>
          <AdminAnchor id="adm-season">
            <SeasonControls season={season} data={data} />
          </AdminAnchor>
          <AdminAnchor id="adm-captains">
            <CaptainControls season={season} data={data} />
          </AdminAnchor>
          <AdminAnchor id="adm-schedule">
            <ScheduleControls season={season} data={data} />
          </AdminAnchor>
          <AdminAnchor id="adm-playoffs">
            <PlayoffControls season={season} data={data} />
          </AdminAnchor>
          <AdminAnchor id="adm-roster">
            <RosterMoves season={season} data={data} />
          </AdminAnchor>
          <AdminAnchor id="adm-standins">
            <StandinControls season={season} data={data} />
          </AdminAnchor>
          <AdminAnchor id="adm-sync">
            <AutoSyncHealth season={season} />
          </AdminAnchor>
          <LeagueControls season={season} />
        </>
      ) : (
        <Card>
          <CardBody className="text-muted">
            {newSeasonDefaults
              ? "The league is in the offseason. Archived seasons remain public; open the next season below when signups should begin."
              : "No active season yet. Configure the first one below to open signups."}
          </CardBody>
        </Card>
      )}

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
          not belong to a season. With no active season the reach funnel is
          simply empty, while every inhouse control remains usable. Streamed:
          Discord health has bounded network calls and must never hold up the
          rest of the admin page. */}
      <Suspense fallback={<CardSkeleton rows={6} />}>
        <DiscordSection seasonId={season?.id ?? null} />
      </Suspense>

      {/* Streamed for the reason the Discord card is: `credProfitBoard` is an
          unwindowed scan of the whole Cred ledger, and a set-up-and-check card
          must never hold up Pause draft or Record result. Its <AdminSection>
          carries the `adm-bets` anchor itself, same as DiscordSection. */}
      <Suspense fallback={<CardSkeleton rows={5} />}>
        <InhouseBetting />
      </Suspense>

      <AdminAnchor id="adm-activity">
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <AdminActivity />
        </Suspense>
      </AdminAnchor>

      <NewsControls posts={newsPosts} />

      <SecurityControls />

      <AdminSection
        id="adm-new-season"
        title={season ? "Season handoff" : "Open a new season"}
        subtitle={
          !season
            ? "Configure the league and open signups."
            : handoffReadiness?.ready
              ? "Preserve the completed season, then choose an offseason or open fresh signups."
              : "The normal handoff unlocks after an authoritative champion is crowned."
        }
        defaultOpen={!season || handoffReadiness?.ready === true}
      >
        <CardBody className="space-y-5">
          {season && handoffReadiness?.ready ? (
            <div className="rounded-lg border border-line bg-surface-2/40 p-4">
              <div className="font-medium text-fg">Enter the offseason</div>
              <p className="mt-1 text-sm text-muted">
                Archive {season.name} without opening the next signup window.
                Results, champion, rosters, recaps, and records stay public
                under Season history. You can open the next season here later.
              </p>
              <ActionForm
                action={archiveCompletedSeasonAction}
                hidden={{ expectedActiveSeasonId: season.id }}
                className="mt-3"
              >
                <SubmitButton
                  variant="secondary"
                  confirm={`Archive ${season.name} and enter the offseason? No league history is deleted, but active-season signup and match tools will close until another season is opened.`}
                >
                  Archive and enter offseason
                </SubmitButton>
              </ActionForm>
            </div>
          ) : season && handoffReadiness && !handoffReadiness.ready ? (
            <div className="space-y-3">
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
            </div>
          ) : null}

          {!season || handoffReadiness?.ready ? (
            <ActionForm
              action={createSeason}
              className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
              hidden={{ expectedActiveSeasonId: season?.id ?? "" }}
            >
              <Field label="Season name" htmlFor="name">
                <input
                  id="name"
                  name="name"
                  required
                  maxLength={60}
                  placeholder="Season 1"
                  className={inputCls}
                />
              </Field>
              <Field label="Team size" htmlFor="teamSize">
                <input
                  id="teamSize"
                  name="teamSize"
                  type="number"
                  defaultValue={newSeasonDefaults?.teamSize ?? 5}
                  min={2}
                  max={10}
                  className={inputCls}
                />
              </Field>
              <Field label="Min teams to start" htmlFor="minTeams">
                <input
                  id="minTeams"
                  name="minTeams"
                  type="number"
                  defaultValue={newSeasonDefaults?.minTeams ?? 4}
                  min={2}
                  max={32}
                  className={inputCls}
                />
              </Field>
              <Field label="Draft budget ($)" htmlFor="draftBudget">
                <input
                  id="draftBudget"
                  name="draftBudget"
                  type="number"
                  defaultValue={newSeasonDefaults?.draftBudget ?? 100}
                  min={10}
                  className={inputCls}
                />
              </Field>
              <Field label="Soft MMR limit (0 = none)" htmlFor="maxMmr">
                <input
                  id="maxMmr"
                  name="maxMmr"
                  type="number"
                  defaultValue={newSeasonDefaults?.maxMmr ?? SOFT_MMR_LIMIT}
                  min={0}
                  max={HARD_MMR_CEILING}
                  className={inputCls}
                />
              </Field>
              <Field
                label="Budget MMR weighting % (0 = flat)"
                htmlFor="budgetMmrWeight"
              >
                <input
                  id="budgetMmrWeight"
                  name="budgetMmrWeight"
                  type="number"
                  defaultValue={newSeasonDefaults?.budgetMmrWeight ?? 20}
                  min={0}
                  max={50}
                  className={inputCls}
                />
              </Field>
              <div className="sm:col-span-2 lg:col-span-4">
                <p className="mb-3 text-sm text-muted">
                  {season
                    ? `This archives ${season.name} and immediately opens signups for the new season.`
                    : newSeasonDefaults
                      ? `There is no active season. Values are prefilled from ${newSeasonDefaults.name}; review them before opening signups.`
                      : "There is no active season. Creating one immediately opens its signup phase."}
                </p>
                <SubmitButton
                  variant="accent"
                  confirm={
                    season
                      ? `Archive completed ${season.name} and open a new signup season? All history remains available.`
                      : "Open this season's signup window now?"
                  }
                >
                  {season ? "Create next season" : "Create season"}
                </SubmitButton>
              </div>
            </ActionForm>
          ) : null}
        </CardBody>
      </AdminSection>
    </div>
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
}: {
  id: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      id={id}
      open={defaultOpen}
      className="group scroll-mt-24 rounded-[var(--radius)] border border-line bg-surface/80 shadow-sm backdrop-blur"
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold text-fg [overflow-wrap:anywhere]">
            {title}
          </h3>
          {subtitle ? (
            <p className="mt-0.5 text-sm text-muted [overflow-wrap:anywhere]">
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
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="scroll-mt-24">
      {children}
    </div>
  );
}

/**
 * The jump bar. Sticky under the 80px header (`top-20`, the same offset the
 * draft room's clock bar uses) so it stays reachable however far down the page
 * an admin has scrolled — which on match night is the whole point.
 */
function AdminJump({ items }: { items: { id: string; label: string }[] }) {
  return (
    <nav
      aria-label="Admin sections"
      className="sticky top-20 z-20 -mx-4 border-b border-line bg-bg/90 px-4 py-2 backdrop-blur sm:mx-0 sm:rounded-[var(--radius)] sm:border sm:px-3"
    >
      <ul className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((i) => (
          <li key={i.id}>
            <a
              href={`#${i.id}`}
              className="inline-block whitespace-nowrap rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-muted/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
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
      // Registered standins PLUS undrafted full players. A pool-dry draft
      // leaves ACTIVE PLAYER signups unrostered, and assignStandinGuarded
      // accepts them — but the panel only listed type=STANDIN and hid itself
      // when there were none, so an admin with two undrafted players and an
      // OUT on match night had no cover to offer. Rostered players are
      // filtered out below (they play for their own team).
      prisma.registration.findMany({
        where: {
          seasonId,
          status: "ACTIVE",
          OR: [
            { type: "STANDIN" },
            {
              type: "PLAYER",
              user: { teamMemberships: { none: { seasonId } } },
            },
          ],
        },
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
        orderBy: [{ week: "asc" }, { createdAt: "asc" }],
        include: {
          games: true,
          availability: { select: { id: true, userId: true, status: true } },
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
  // OpenDota ids of playoff games a bracket reset deleted. Archived by
  // createPlayoffBracket so the postseason can be re-imported by hand — without
  // them the ids were simply gone, which is what made "recreate the bracket"
  // (the only correction path past an advanced round) irreversible.
  const playoffArchive = await getSetting(playoffGamesArchiveKey(seasonId));
  // What a schedule REGENERATE would destroy. These rows hang off a fixture id
  // and cascade with it, and none of them is archived anywhere — so the confirm
  // has to be able to state them BEFORE the click, not just the toast after.
  const regularWhere = { match: { seasonId, phase: MATCH_PHASE.REGULAR } };
  // ALL ACTIVE registrations, standins included — deliberately the same
  // population as getDiscordReachFunnel's, because the next-step banner quotes
  // this number and then points at that card ("names them"); counting only
  // data.players (type PLAYER) made the two disagree whenever an unlinked
  // standin existed. DB-only, so the blocking path stays Discord-free.
  const [rsvps, picks, covers, proposals, unlinkedDiscord] = await Promise.all([
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
  ]);
  return {
    players,
    standins,
    removed,
    teams,
    matches,
    draft,
    assignments,
    outRsvps,
    playoffArchive: parsePlayoffArchive(playoffArchive),
    collateral: { rsvps, picks, covers, proposals },
    unlinkedDiscord,
  };
}

type AdminData = Awaited<ReturnType<typeof loadSeasonAdminData>>;
type Season = NonNullable<Awaited<ReturnType<typeof getActiveSeason>>>;

function SeasonControls({ season, data }: { season: Season; data: AdminData }) {
  const configLocked = !draftSetupOpen(season.status, data.draft?.status);
  const cap = capacityInfo(season, data.players.length);
  const regular = data.matches.filter((m) => m.phase === "REGULAR");
  const playoff = data.matches.filter((m) => m.phase !== "REGULAR");
  const championPresentation = resolveChampionPresentation(
    season,
    data.matches,
  );
  const nextStep = adminNextStep({
    seasonStatus: season.status,
    draftStatus: data.draft?.status ?? null,
    playerCount: data.players.length,
    minPlayers: cap.minPlayers,
    teamCount: data.teams.length,
    regularMatchCount: regular.length,
    scheduledRegularCount: regular.filter((m) => m.scheduledAt).length,
    pendingRegularResults: regular.filter((m) => m.status !== "COMPLETED")
      .length,
    playoffMatchCount: playoff.length,
    unfinishedPlayoffCount: playoff.filter((m) => m.status !== "COMPLETED")
      .length,
    hasChampion: championPresentation.championTeamId != null,
    unlinkedDiscordCount: data.unlinkedDiscord,
  });
  const hasPlayedResult = data.matches.some(
    (match) => match.status === MATCH_STATUS.COMPLETED,
  );
  const hasImportedGame = data.matches.some((match) => match.games.length > 0);
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title={`${season.name} — phase control`}
        subtitle="Advance one safe stage at a time. Data-changing transitions use the dedicated controls in their section."
        action={<Badge tone="accent">{PHASE_LABEL[season.status]}</Badge>}
      />
      <CardBody className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Players" value={data.players.length} />
          <Stat
            label="To start"
            value={cap.minPlayers}
            hint={cap.canDraft ? "reached" : `${cap.needed} more`}
          />
          <Stat label="Teams" value={data.teams.length} />
          <Stat label="Matches" value={data.matches.length} />
        </div>

        <div className="flex flex-wrap items-start gap-3">
          {SEASON_PHASE_ORDER.map((phase) => {
            const state = seasonPhasePolicy({
              current: season.status,
              target: phase,
              draftStatus: data.draft?.status,
              matchCount: data.matches.length,
              hasPlayedResult,
              hasImportedGame,
              postseasonMatchCount: playoff.length,
              postseasonBracketReady: recoverablePostseasonBracket(playoff),
              hasChampion: season.championTeamId != null,
            });
            const reasonId = `phase-${phase.toLowerCase()}-reason`;
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
                      {state.recovery ? "Recover " : ""}
                      {PHASE_LABEL[phase]}
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  <span title={state.reason}>
                    <Button
                      type="button"
                      variant={
                        season.status === phase ? "primary" : "secondary"
                      }
                      size="sm"
                      disabled
                      aria-describedby={reasonId}
                    >
                      {PHASE_LABEL[phase]}
                    </Button>
                  </span>
                )}
                {!state.available ? (
                  <span
                    id={reasonId}
                    className="mt-1 block text-[11px] leading-snug text-muted"
                  >
                    {state.reason}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted">
          These buttons never start or abort an auction, seed or remove a
          playoff bracket, or crown a champion. Use Start draft, Abort draft,
          Start playoffs, Return to regular season, and the result controls for
          those operations so related league data changes together.
        </p>
        {season.status === SEASON_STATUS.COMPLETE &&
        championPresentation.championTeamId ? (
          <p className="text-xs text-muted">
            A crowned season is locked against generic phase reversal. Correct
            the grand final in Schedule &amp; results, reset the bracket, or use
            Return to regular season in the Playoffs card; each recovery clears
            the champion and affected postseason state atomically.
          </p>
        ) : season.status === SEASON_STATUS.COMPLETE &&
          season.championTeamId ? (
          <p className="text-xs text-danger">
            The stored champion does not agree with one authoritative completed
            grand final. Generic phase reversal remains locked; use the targeted
            final correction when that team is a finalist, or the dedicated
            playoff recovery controls below.
          </p>
        ) : season.status === SEASON_STATUS.PLAYOFFS ? (
          <p className="text-xs text-muted">
            Complete is automatic when the grand final crowns a champion. To
            edit regular-season results, use Return to regular season below so
            stale seeds cannot survive the phase change.
          </p>
        ) : null}
        {/* THE ROADMAP. Several league transitions are silent and fail quietly
            — the auction finishing does NOT advance the phase, a schedule with
            no kickoff times disables auto-sync/reminders/pick'em locks for the
            season, nothing prompts "start the playoffs" or "record the final",
            and COMPLETE used to be a dead end whose only exit was inside a
            collapsed section at the bottom of the page. This banner is the
            page's answer to "what do I do next?" in EVERY phase; the logic is
            pure and tested in src/lib/admin-next-step.ts. */}
        <div
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
        </div>
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
            className="h-9 w-64 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-sm"
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
            {season.maxMmr > 0
              ? `soft limit — signups over ${season.maxMmr} MMR still join the pool; review them here before the draft · only the hard ceiling ${HARD_MMR_CEILING} refuses (no Immortals)`
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
            className="h-9 w-64 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-sm"
          />
          <SubmitButton variant="secondary" size="sm">
            Save schedule
          </SubmitButton>
          <span className="text-xs text-muted">
            shown before signup{season.matchSchedule ? "" : " · using default"}
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
          {/* These are copied onto each Match row when it is CREATED, so they
              are read-once per phase, not live. Saving after the fact still
              writes the Season and re-renders with the new value — a perfect
              false confirmation — while every existing fixture keeps its old
              length. Say which ones are already locked in rather than letting
              an admin "fix" a Bo1 into a Bo3 that never happens. */}
          <span className="text-xs text-muted">
            games per match — copied onto each fixture when it is created, so
            these only affect matches made from now on.
            {data.matches.some((m) => m.phase === "REGULAR")
              ? " The regular-season schedule already exists: change its length per match, or regenerate."
              : ""}
          </span>
        </ActionForm>
      </CardBody>
    </Card>
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
  const teamWithdrawalLocked = teamWithdrawalLockedReason(season.status);
  const captainUserIds = new Set(data.teams.map((t) => t.captainId));
  const nonCaptains = data.players.filter((p) => !captainUserIds.has(p.userId));
  // Real STANDIN registrations, for the moderation list below (data.standins
  // also carries undrafted PLAYERs for the cover dropdowns — those rows are
  // already in the eligible list above).
  const standinRegs = data.standins.filter(
    (s) => s.type === REGISTRATION_TYPE.STANDIN,
  );
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
  const awaitingConfirmation = data.players.filter(
    (p) => draftReadiness(p, season.draftRevision) === DRAFT_READINESS.AWAITING,
  );
  const staleConfirmation = data.players.filter(
    (p) => draftReadiness(p, season.draftRevision) === DRAFT_READINESS.STALE,
  );
  const regularCount = data.matches.filter((m) => m.phase === "REGULAR").length;
  const collateral = data.collateral;

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
  const boughtCount = data.teams.reduce(
    (n, t) => n + t.members.filter((m) => !m.isCaptain).length,
    0,
  );
  const captainCount = data.teams.length;
  // Seat math, mirroring startDraft's own (pool = ACTIVE PLAYER signups not
  // already rostered; seats = one team per CAPTAIN, captain's own seat taken).
  // Signups are uncapped by design — minTeams is a floor — so the pool is
  // routinely not a multiple of teamSize, and the count is settled HERE by
  // choosing how many captains to start with. startDraft accepts both a short
  // pool (standins fill in) and a long one, silently: an overflow leaves those
  // players undrafted as free agents with no warning anywhere, which is a thing
  // to learn before pressing the button, not after.
  const rosteredIds = new Set(
    data.teams.flatMap((t) => t.members.map((m) => m.userId)),
  );
  const poolCount = data.players.filter(
    (p) => !rosteredIds.has(p.userId),
  ).length;
  const seats = draftSeatPlan(captainCount, season.teamSize, poolCount);
  const rosterAlreadyBuilt = boughtCount > 0;
  const canStart = seats.canStart && !rosterAlreadyBuilt;
  const startBlocker = rosterAlreadyBuilt
    ? `${boughtCount} non-captain roster member${boughtCount === 1 ? " is" : "s are"} already assigned. Return to the appropriate season phase and use roster tools; Start only accepts captain-only teams.`
    : seats.blocker;
  const openSeats = seats.openSeats;
  const seatNote =
    openSeats === poolCount
      ? ` The pool fits exactly: ${poolCount} players for ${openSeats} open seats.`
      : openSeats > poolCount
        ? ` ${poolCount} players for ${openSeats} open seats — ${openSeats - poolCount} seat${openSeats - poolCount === 1 ? "" : "s"} will go unfilled (standins cover them). Removing a captain would tighten it.`
        : ` ${poolCount} players for only ${openSeats} open seats — ${poolCount - openSeats} player${poolCount - openSeats === 1 ? "" : "s"} will go undrafted. Adding a captain opens ${season.teamSize - 1} more seats.`;
  const startConfirm =
    `Start the draft with ${captainCount} captain${captainCount === 1 ? "" : "s"}?` +
    (captainCount < season.minTeams
      ? ` That is fewer than this season's ${season.minTeams}-team target.`
      : "") +
    seatNote +
    " Captains are locked once the auction begins — the way back is Abort draft," +
    " which returns every drafted player and refund and keeps the captains, but" +
    " is refused once any result has been recorded." +
    (season.draftAt
      ? ` Draft confirmations: ${confirmationCounts.ready} of ${confirmationCounts.total} ready; ${confirmationCounts.awaiting} awaiting${confirmationCounts.stale ? `; ${confirmationCounts.stale} must reconfirm` : ""}. This is a warning only and does not block the draft.`
      : " No draft night is scheduled, so players have not been asked to confirm one.");
  const startDisabled = !setupOpen || !canStart;

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
             six controls (sync ranks/avatars, randomize, start, pause/resume,
             undo, abort) and without wrapping they pushed /admin past a phone —
             caught by the mobile tripwire on CI, whose fonts are a few px wider
             than macOS's, so it read as a 7px page scroll. */
          <div className="flex flex-wrap justify-end gap-2">
            <ActionForm action={syncPlayerRanks}>
              {/* Pulls medals AND the pub-scouting snapshots the player pool
                  renders (recent W/L, games, last-played) — one button, one
                  OpenDota pass. */}
              <SubmitButton variant="secondary" size="sm">
                Sync ranks &amp; stats
              </SubmitButton>
            </ActionForm>
            <ActionForm action={syncSteamProfiles}>
              <SubmitButton
                variant="secondary"
                size="sm"
                /* It refreshes the Steam persona too, not just the picture —
                   a rename shows up across the whole site after this. */
                confirm="Refresh every player's Steam name and avatar?"
              >
                Sync names &amp; avatars
              </SubmitButton>
            </ActionForm>
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
                  confirm="Void the paused live lot? Every bid on this lot is discarded, no sale is recorded, and the same team keeps the nomination turn."
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
                     player on the next poll from any visitor. Say so. */
                  confirm={
                    data.draft?.status === DRAFT_STATUS.COMPLETE
                      ? "Undo the most recent sale? This REOPENS the finished auction as a live draft with a fresh nomination clock — the player returns to the pool and the buyer gets the money back and the next nomination. Finish or re-complete the draft afterwards."
                      : "Undo the most recent auction sale? The player returns to the pool and the buyer gets the money back and the next nomination."
                  }
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
          name sizes the column past the viewport and widens the whole page. */}
      <CardBody className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {setupOpen ? (
          <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 md:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-fg">Draft preflight</h3>
                <p className="mt-0.5 text-xs text-muted">
                  Required items block Start; schedule, target size, seat fit
                  and confirmations are explicit operator warnings.
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
                  ? " — at least 2 are required"
                  : captainCount < season.minTeams
                    ? ` — below the ${season.minTeams}-team target (allowed with confirmation)`
                    : ` — ${season.minTeams}-team target met`}
              </li>
              <li className="rounded-md border border-line/70 px-3 py-2 text-muted">
                <b className="text-fg">Player pool:</b> {poolCount} draftable
                for {openSeats} open seats
                {poolCount === 0
                  ? " — at least 1 is required"
                  : seats.shortfall > 0
                    ? ` — ${seats.shortfall} will stay unfilled`
                    : seats.overflow > 0
                      ? ` — ${seats.overflow} will remain free agents`
                      : " — exact fit"}
              </li>
              <li className="rounded-md border border-line/70 px-3 py-2 text-muted">
                <b className="text-fg">Draft night:</b>{" "}
                {season.draftAt
                  ? "scheduled — players can review and confirm it"
                  : "not scheduled — allowed, but players cannot confirm a time"}
              </li>
              <li className="rounded-md border border-line/70 px-3 py-2 text-muted">
                <b className="text-fg">Commitments:</b>{" "}
                {season.draftAt
                  ? `${confirmationCounts.ready}/${confirmationCounts.total} ready · ${confirmationCounts.awaiting} awaiting${confirmationCounts.stale ? ` · ${confirmationCounts.stale} need reconfirmation` : ""}`
                  : "available after a draft night is scheduled"}
                {" — advisory"}
              </li>
              <li className="rounded-md border border-line/70 px-3 py-2 text-muted sm:col-span-2">
                <b className="text-fg">Existing roster:</b>{" "}
                {rosterAlreadyBuilt
                  ? `${boughtCount} non-captain member${boughtCount === 1 ? " is" : "s are"} already assigned — Start is blocked to protect later-season roster data`
                  : "captain-only teams — ready for a fresh auction"}
              </li>
            </ul>
            {!canStart && startBlocker ? (
              <p className="mt-2 text-xs font-medium text-accent">
                Start unavailable: {startBlocker}
              </p>
            ) : null}
          </div>
        ) : null}
        {setupOpen ? (
          <ActionForm
            action={setDraftNight}
            hidden={{ expectedActiveSeasonId: season.id }}
            className="flex flex-wrap items-end gap-2 md:col-span-2"
          >
            <div className="flex flex-col gap-1">
              <label htmlFor="draftAt" className="text-xs text-muted">
                Draft night — shown with countdowns on the dashboard, /me and
                the draft room; announced to Discord
              </label>
              <LocalDatetimeField
                id="draftAt"
                name="draftAt"
                tsName="draftAtTs"
                defaultTs={season.draftAt?.getTime()}
                className="h-8 rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg"
              />
            </div>
            <SubmitButton variant="secondary" size="sm">
              {season.draftAt ? "Update draft night" : "Set draft night"}
            </SubmitButton>
            {season.draftAt ? (
              <span className="text-xs text-muted">
                Currently{" "}
                <LocalTime
                  ts={season.draftAt.getTime()}
                  variant="full"
                  initial={formatMatchTime(season.draftAt, "full")}
                />
              </span>
            ) : null}
          </ActionForm>
        ) : null}
        {season.draftAt && setupOpen ? (
          <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 md:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-fg">
                  Draft confirmations
                </h3>
                <p className="mt-0.5 text-xs text-muted">
                  Player acknowledgements are advisory—the draft can still be
                  started if someone has not responded.
                </p>
              </div>
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
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <Badge tone="success">{confirmationCounts.ready} ready</Badge>
              <Badge>{confirmationCounts.awaiting} awaiting</Badge>
              {confirmationCounts.stale > 0 ? (
                <Badge tone="accent">
                  {confirmationCounts.stale} need reconfirmation
                </Badge>
              ) : null}
            </div>
            {awaitingConfirmation.length > 0 ? (
              <p className="mt-2 text-xs text-muted">
                <span className="font-medium text-fg">Waiting on:</span>{" "}
                {awaitingConfirmation.map((p) => p.user.name).join(", ")}
              </p>
            ) : null}
            {staleConfirmation.length > 0 ? (
              <p className="mt-1 text-xs text-muted">
                <span className="font-medium text-accent">Must reconfirm:</span>{" "}
                {staleConfirmation.map((p) => p.user.name).join(", ")}
              </p>
            ) : null}
          </div>
        ) : null}
        {setupOpen && data.teams.length >= 2 ? (
          <p className="text-xs text-muted md:col-span-2">
            {(() => {
              const seats = data.teams.length * (season.teamSize - 1);
              const pool = nonCaptains.length;
              return pool >= seats
                ? `${pool} undrafted players for ${seats} roster seats — the pool covers every team.`
                : `⚠️ Only ${pool} undrafted players for ${seats} roster seats — ${seats - pool} seat(s) will go unfilled (standins can cover match nights).`;
            })()}
          </p>
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
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="w-5 shrink-0 text-center text-xs text-muted">
                          {t.draftOrder + 1}
                        </span>
                        <PlayerLink userId={t.captainId} className="shrink-0">
                          <Avatar
                            name={t.captain.name}
                            src={t.captain.avatar}
                            size={24}
                          />
                        </PlayerLink>
                        <TeamCrest
                          name={t.name}
                          seed={t.id}
                          logoUrl={t.logoUrl}
                          size={28}
                        />
                        <Link
                          href={`/teams/${t.id}`}
                          className="min-w-0 truncate hover:text-info hover:underline"
                        >
                          {t.name}
                        </Link>
                        <Badge tone="accent" className="shrink-0">
                          $
                          {setupOpen
                            ? (projected.get(t.id) ?? t.budget)
                            : t.budget}
                          {setupOpen ? " projected" : null}
                        </Badge>
                      </span>
                      {setupOpen ? (
                        <ActionForm
                          action={removeCaptain}
                          hidden={{
                            teamId: t.id,
                            expectedActiveSeasonId: season.id,
                          }}
                        >
                          {/* This deletes the team AND, if any fixture exists,
                              every match in the SEASON — taking all check-ins,
                              pick'em picks, standin bookings and open proposals
                              with it by cascade. It is the twin of Regenerate
                              schedule and needs the same barrier; it was a bare
                              `remove` link 12px from "✎ Rename team". */}
                          <DangerSubmit
                            token={t.name}
                            className="shrink-0"
                            title={`Remove ${t.captain.name} as captain and delete ${t.name}?`}
                            consequences={[
                              `${t.name} and its ${t.members.length} roster place(s) are deleted.`,
                              ...(regularCount > 0
                                ? [
                                    `All ${regularCount} fixture(s) in the season are cleared — not just this team's — because the round robin no longer fits.`,
                                  ]
                                : []),
                              ...(regularCount > 0 && collateral.rsvps
                                ? [
                                    `${collateral.rsvps} check-in(s) go with them.`,
                                  ]
                                : []),
                              ...(regularCount > 0 && collateral.picks
                                ? [
                                    `${collateral.picks} pick'em pick(s) go with them.`,
                                  ]
                                : []),
                              ...(regularCount > 0 && collateral.covers
                                ? [
                                    `${collateral.covers} standin booking(s) go with them.`,
                                  ]
                                : []),
                            ]}
                            recovery={
                              regularCount > 0
                                ? "Regenerate the schedule once the captains are final. The check-ins, picks and bookings cannot be restored."
                                : "No schedule exists yet, so nothing else is affected."
                            }
                          >
                            remove
                          </DangerSubmit>
                        </ActionForm>
                      ) : null}
                    </div>
                    {captainReg.get(t.captainId) && setupOpen ? (
                      <div className="mt-1.5">
                        <DraftReadinessBadge
                          reg={captainReg.get(t.captainId)!}
                          season={season}
                        />
                      </div>
                    ) : null}
                    {season.status !== SEASON_STATUS.COMPLETE ? (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                          ✎ Edit team
                        </summary>
                        <ActionForm
                          action={renameTeam}
                          className="mt-1.5 grid max-w-md grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]"
                          hidden={{
                            teamId: t.id,
                            expectedActiveSeasonId: season.id,
                          }}
                        >
                          <input
                            name="name"
                            type="text"
                            maxLength={60}
                            defaultValue={t.name}
                            aria-label={`Name for ${t.name}`}
                            className="h-8 min-w-0 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
                          />
                          <input
                            name="logoUrl"
                            type="text"
                            inputMode="url"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            maxLength={TEAM_LOGO_URL_MAX_LENGTH}
                            defaultValue={t.logoUrl ?? ""}
                            placeholder="https://…/logo.png"
                            aria-label={`Logo URL for ${t.name}`}
                            className="h-8 min-w-0 rounded-md border border-line bg-surface-2/50 px-2 text-sm sm:col-span-2"
                          />
                          <p className="text-xs text-muted sm:col-span-2">
                            Paste an HTTPS image URL. Leave it blank to use the
                            generated initials crest.
                          </p>
                          <SubmitButton variant="secondary" size="sm">
                            Save team
                          </SubmitButton>
                        </ActionForm>
                      </details>
                    ) : null}
                    {/* A captain's MMR is the ONE number that has to be right
                        before the auction: mmrWeightedBudgets interpolates
                        across the whole captain pool, so a single typo moves the
                        pool's min/max and skews EVERY team's budget, not just
                        this one's. This control lived only in the non-captain
                        list below, so designating someone captain — the natural
                        FIRST step — put their MMR permanently out of reach, and
                        setRegistrationMmr never refused captains: it was a
                        missing render, not a rule. Gated on the draft not
                        having STARTED, not on SIGNUPS: an admin who walks the
                        phase to DRAFT before pressing Start draft is in
                        exactly the window where a typo still skews every
                        budget, and the SIGNUPS-only gate hid the fix there. */}
                    {setupOpen && captainReg.get(t.captainId) ? (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                          ✎ Edit captain MMR
                        </summary>
                        <ActionForm
                          action={setRegistrationMmr}
                          className="mt-1.5 flex flex-wrap items-center gap-2"
                          hidden={{
                            registrationId: captainReg.get(t.captainId)!.id,
                          }}
                        >
                          <input
                            name="mmr"
                            type="number"
                            min={0}
                            max={12000}
                            defaultValue={captainReg.get(t.captainId)!.mmr}
                            aria-label={`MMR for ${t.captain.name}`}
                            className="h-8 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
                          />
                          <SubmitButton variant="secondary" size="sm">
                            Save MMR
                          </SubmitButton>
                          <span className="text-xs text-muted">
                            sets every team&rsquo;s starting budget
                          </span>
                        </ActionForm>
                      </details>
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
          {season.status === "REGULAR_SEASON" &&
          data.teams.some((t) => !t.withdrawn) ? (
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
                    "Every unplayed regular fixture of the selected team is forfeited 0-N to the opponent (marked forfeit, so the ruled scores stay out of the game-diff tiebreaks).",
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
          {setupOpen && data.teams.length >= 2 && season.budgetMmrWeight > 0 ? (
            <p className="mt-2 text-xs text-muted">
              Budgets are MMR-weighted (±{season.budgetMmrWeight}%): lower-MMR
              captains get more to spend.
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
          <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
            {nonCaptains.length === 0 ? (
              <p className="text-sm text-muted">
                {setupOpen
                  ? "No other active full-player signups. At least one undrafted player is required to start."
                  : "No other active full-player signups."}
              </p>
            ) : (
              nonCaptains.map((p) => (
                <div
                  key={p.id}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <Avatar
                        name={p.user.name}
                        src={p.user.avatar}
                        size={22}
                      />
                      <PlayerLink
                        userId={p.userId}
                        className="min-w-0 truncate"
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
                      {p.wantsCaptain ? (
                        <Badge tone="brand" className="shrink-0">
                          wants C
                        </Badge>
                      ) : null}
                      {p.user.fhUnavailable === true ? (
                        <Badge
                          tone="danger"
                          className="shrink-0"
                          title="OpenDota reports their match data as private — automatic result import can't see this player's games"
                        >
                          private data
                        </Badge>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      {setupOpen ? (
                        <ActionForm
                          action={addCaptain}
                          hidden={{
                            userId: p.userId,
                            expectedActiveSeasonId: season.id,
                          }}
                        >
                          {/* Confirmed because the UNDO is expensive, not the
                              action: removing a captain again deletes the
                              team and, once fixtures exist, the season's whole
                              schedule. Also a real SubmitButton now, so it has
                              a pending state and can't be double-submitted. */}
                          <SubmitButton
                            variant="ghost"
                            size="sm"
                            className="text-xs text-accent hover:underline"
                            confirm={`Make ${p.user.name} a captain? They get a team, and the only way back is removing that team — which also clears the schedule once one exists.`}
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
                          standin who still owes cover, and a non-ACTIVE row. */}
                      {season.status !== SEASON_STATUS.COMPLETE ? (
                        <ActionForm
                          action={withdrawSignup}
                          hidden={{ registrationId: p.id }}
                        >
                          <SubmitButton
                            variant="ghost"
                            size="sm"
                            className="text-danger hover:underline"
                            confirm={
                              season.status === "SIGNUPS"
                                ? `Remove ${p.user.name}'s signup? They leave the player pool and can't re-add themselves — you can reinstate them below.`
                                : `Remove ${p.user.name}'s signup? They leave the draft pool and the free-agent and standin lists. Rostered players must be released first — you can reinstate them below.`
                            }
                          >
                            remove
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
                    </span>
                  </div>
                  <SignupRowMeta
                    reg={p}
                    sweep={membershipSweep}
                    season={season}
                    showDraftReadiness={setupOpen}
                  />
                  {/* Same window as the captain edit above: the number only
                      feeds budgets until Start draft, so the gate is the
                      draft, not the SIGNUPS phase. */}
                  {setupOpen ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                        ✎ Edit MMR
                      </summary>
                      <ActionForm
                        action={setRegistrationMmr}
                        className="mt-1 flex items-center gap-2"
                        hidden={{ registrationId: p.id }}
                      >
                        <input
                          name="mmr"
                          type="number"
                          min={0}
                          max={12000}
                          defaultValue={p.mmr}
                          aria-label={`MMR for ${p.user.name}`}
                          className="h-8 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
                        />
                        <SubmitButton variant="secondary" size="sm">
                          Save MMR
                        </SubmitButton>
                      </ActionForm>
                    </details>
                  ) : null}
                </div>
              ))
            )}
          </div>
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
                <div className="max-h-60 space-y-1.5 overflow-y-auto pr-1">
                  {standinRegs.map((s) => (
                    <div
                      key={s.id}
                      className="rounded-lg border border-line px-3 py-1.5 text-sm"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <Avatar
                            name={s.user.name}
                            src={s.user.avatar}
                            size={22}
                          />
                          <PlayerLink
                            userId={s.userId}
                            className="min-w-0 truncate"
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
                          <ActionForm
                            action={withdrawSignup}
                            hidden={{ registrationId: s.id }}
                          >
                            <SubmitButton
                              variant="ghost"
                              size="sm"
                              className="text-danger hover:underline"
                              confirm={`Remove ${s.user.name}'s standin signup? They leave the standin lists and can't re-add themselves — you can reinstate them below. Standins still owing cover on an unplayed match are refused (remove the assignment first).`}
                            >
                              remove
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                      </div>
                      <SignupRowMeta
                        reg={s}
                        sweep={membershipSweep}
                        season={season}
                      />
                      {/* Standins stay open through PLAYOFFS, so their MMR edit
                          remains available after the player auction — it
                          informs captains choosing cover all season. */}
                      {season.status !== SEASON_STATUS.COMPLETE ? (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                            ✎ Edit MMR
                          </summary>
                          <ActionForm
                            action={setRegistrationMmr}
                            className="mt-1 flex items-center gap-2"
                            hidden={{ registrationId: s.id }}
                          >
                            <input
                              name="mmr"
                              type="number"
                              min={0}
                              max={12000}
                              defaultValue={s.mmr}
                              aria-label={`MMR for ${s.user.name}`}
                              className="h-8 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
                            />
                            <SubmitButton variant="secondary" size="sm">
                              Save MMR
                            </SubmitButton>
                          </ActionForm>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </div>
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
                    {season.status !== SEASON_STATUS.COMPLETE ? (
                      <ActionForm
                        action={reinstateSignup}
                        hidden={{ registrationId: r.id }}
                      >
                        <SubmitButton variant="ghost" size="sm">
                          reinstate
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
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

function ScheduleControls({
  season,
  data,
}: {
  season: Season;
  data: AdminData;
}) {
  const status = regularSeasonStatus(data.matches);
  const regularCount = data.matches.filter((m) => m.phase === "REGULAR").length;
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
          scheduleGenerationLockedReason ? null : (
            <ActionForm
              action={generateSchedule}
              hidden={{ expectedActiveSeasonId: season.id }}
              className="flex flex-wrap items-center gap-2"
            >
              <label
                htmlFor="firstNight"
                className="text-xs text-muted"
                title="Week 1 plays at this time; each later week (and playoff round) is +7 days. Leave empty for no times."
              >
                First match night
              </label>
              <LocalDatetimeField
                id="firstNight"
                name="firstNight"
                tsName="firstNightTs"
                defaultTs={season.firstMatchNight?.getTime()}
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
        {scheduleGenerationLockedReason ? (
          <p className="mb-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-fg">
            <strong>Schedule generation unavailable.</strong>{" "}
            {scheduleGenerationLockedReason}
          </p>
        ) : null}
        {data.matches.length === 0 ? (
          <p className="text-sm text-muted">
            No fixtures have been generated for this season.
          </p>
        ) : (
          <div className="space-y-2">
            {status.total > 0 ? (
              <div
                className={`rounded-lg border px-3 py-2 text-sm ${
                  status.pending > 0
                    ? "border-accent/40 bg-accent/10"
                    : "border-success/40 bg-success/10 text-success"
                }`}
              >
                {/* `status` counts REGULAR matches only, so once the last one
                    is in this line was true forever — it kept telling the admin
                    to "start the playoffs" all through the postseason and next
                    to a crowned champion, pointing at a button that by then says
                    RESET and deletes the whole bracket. Branch on the phase. */}
                {status.pending > 0
                  ? `⏳ ${pendingResultsMessage(status)} Enter them to keep standings & seeding correct.`
                  : season.status === SEASON_STATUS.PLAYOFFS
                    ? `✓ All ${status.total} regular-season results in — the bracket is running. Enter playoff scores below.`
                    : season.status === SEASON_STATUS.COMPLETE
                      ? `✓ Season complete — all ${status.total} regular-season results recorded.`
                      : `✓ All ${status.total} results in — ready to start the playoffs.`}
              </div>
            ) : null}
            <p className="text-xs text-muted">
              Enter scores manually, or fetch the real games from Dota
              (OpenDota). Auto-fetch needs players to have &ldquo;Expose Public
              Match Data&rdquo; enabled.
            </p>
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
                the enter-scores workflow starts at the week that needs it. */}
            {status.weeks.map((w) => {
              const weekMatches = data.matches.filter(
                (m) => m.phase === "REGULAR" && m.week === w.week,
              );
              return (
                <details
                  key={`w${w.week}`}
                  open={w.pending > 0}
                  className="rounded-lg border border-line"
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
                        m={m}
                        teams={data.teams}
                        expectedActiveSeasonId={season.id}
                        seasonStatus={season.status}
                        draftStatus={data.draft?.status ?? null}
                        championTeamId={season.championTeamId}
                        correctionBlockedByLaterRound={false}
                        isSoleLatestPlayoffSeries={false}
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
            {/* Playoffs in their own section, labeled by round so the admin
                entering a bracket-advancing result can tell the final from a
                semifinal. */}
            {(() => {
              const playoff = data.matches.filter((m) => m.phase !== "REGULAR");
              if (playoff.length === 0) return null;
              const { totalRounds } = groupPlayoffRounds(playoff);
              const pending = playoff.filter(
                (m) => m.status !== "COMPLETED",
              ).length;
              const latestRound = Math.max(
                ...playoff.map((match) => slotRound(match.bracketSlot)),
              );
              const latestRoundMatches = playoff.filter(
                (match) => slotRound(match.bracketSlot) === latestRound,
              );
              const soleLatestPlayoffId =
                latestRoundMatches.length === 1
                  ? latestRoundMatches[0].id
                  : null;
              return (
                <details
                  open={pending > 0}
                  className="rounded-lg border border-accent/40"
                >
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                    Playoffs
                    <span className="ml-2 text-xs font-normal text-muted">
                      {playoff.length - pending}/{playoff.length} entered
                    </span>
                  </summary>
                  <div className="space-y-2 px-3 pb-3">
                    {playoff.map((m) => (
                      <MatchResultRow
                        key={m.id}
                        m={m}
                        teams={data.teams}
                        expectedActiveSeasonId={season.id}
                        seasonStatus={season.status}
                        draftStatus={data.draft?.status ?? null}
                        championTeamId={season.championTeamId}
                        correctionBlockedByLaterRound={hasLaterBracketRound(
                          playoff,
                          m.bracketSlot,
                        )}
                        isSoleLatestPlayoffSeries={soleLatestPlayoffId === m.id}
                        label={
                          <Link
                            href={`/matches/${m.id}`}
                            className={textLink("shrink-0 text-xs")}
                          >
                            {roundName(slotRound(m.bracketSlot), totalRounds)}
                          </Link>
                        }
                      />
                    ))}
                  </div>
                </details>
              );
            })()}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// One match's result + scheduling + imported-games controls. Used by the
// week-grouped and playoff sections of ScheduleControls.
function MatchResultRow({
  m,
  teams,
  label,
  expectedActiveSeasonId,
  seasonStatus,
  draftStatus,
  championTeamId,
  correctionBlockedByLaterRound,
  isSoleLatestPlayoffSeries,
}: {
  m: AdminData["matches"][number];
  teams: AdminData["teams"];
  label: React.ReactNode;
  expectedActiveSeasonId: string;
  seasonStatus: string;
  draftStatus: string | null;
  championTeamId: string | null;
  correctionBlockedByLaterRound: boolean;
  isSoleLatestPlayoffSeries: boolean;
}) {
  const home = teams.find((t) => t.id === m.homeTeamId);
  const away = teams.find((t) => t.id === m.awayTeamId);
  const resultOpen = matchResultsOpen(seasonStatus, m.phase);
  const resultCorrectionOpen = resultOpen && !correctionBlockedByLaterRound;
  const importedFinal =
    m.games.length > 0 && m.status === MATCH_STATUS.COMPLETED && !m.forfeit;
  const championIsFinalParticipant =
    seasonStatus === SEASON_STATUS.COMPLETE &&
    m.phase === MATCH_PHASE.FINAL &&
    m.status === MATCH_STATUS.COMPLETED &&
    championTeamId != null &&
    (championTeamId === m.homeTeamId || championTeamId === m.awayTeamId);
  const championshipFinalCorrection =
    championIsFinalParticipant && isSoleLatestPlayoffSeries;
  const crownedGrandFinal =
    championshipFinalCorrection && m.winnerTeamId === championTeamId;
  const conflictingChampionFinal =
    championshipFinalCorrection && m.winnerTeamId !== championTeamId;
  const unresolvedCompletedFinal =
    seasonStatus === SEASON_STATUS.COMPLETE &&
    m.phase === MATCH_PHASE.FINAL &&
    m.status === MATCH_STATUS.COMPLETED &&
    !championshipFinalCorrection;
  const canReopenManual =
    m.games.length === 0 &&
    (resultCorrectionOpen || championshipFinalCorrection);
  const canCorrectImported =
    resultCorrectionOpen || championshipFinalCorrection;
  const logisticsOpen = matchLogisticsOpen(seasonStatus, draftStatus, m.status);
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      {!resultCorrectionOpen || importedFinal ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {label}
          <span className="min-w-0 flex-1 text-right">{home?.name ?? "?"}</span>
          <strong className="tabular-nums">
            {m.homeScore}–{m.awayScore}
          </strong>
          <span className="min-w-0 flex-1">{away?.name ?? "?"}</span>
          {m.status === MATCH_STATUS.COMPLETED ? (
            <Badge tone="success">
              {m.forfeit ? "final · forfeit" : "final"}
            </Badge>
          ) : null}
          <span className="w-full text-xs text-muted">
            {correctionBlockedByLaterRound
              ? "This series already advanced a later playoff round. It is read-only because changing its winner would strand downstream teams; use Reset playoffs to reseed the full bracket before correcting it."
              : !resultOpen
                ? m.phase === MATCH_PHASE.REGULAR
                  ? "Regular-season results are read-only outside the active Regular season phase. Move the phase back and reseed before correcting one."
                  : crownedGrandFinal
                    ? "This result crowned the champion. Use the grand-final correction below to retract the title and reopen only this series."
                    : conflictingChampionFinal
                      ? "The stored champion conflicts with this completed final. Use the correction below to retract the inconsistent title and reconcile only this series."
                      : unresolvedCompletedFinal
                        ? championTeamId == null
                          ? "This completed grand final has no authoritative champion. Move the season back to Playoffs with the phase control, then reconcile this result; title-retraction controls stay hidden because no title exists."
                          : !championIsFinalParticipant
                            ? "The recorded champion is not a participant in this completed grand final. Use the dedicated playoff recovery controls to restore a consistent bracket and title; targeted title-retraction controls stay hidden because this final cannot safely retract that team."
                            : "The bracket does not have one sole authoritative latest final. Use the dedicated playoff recovery controls to restore a single consistent final before targeted title correction is available."
                        : "Playoff results are read-only unless the active season is in Playoffs."
                : `Score derived from ${m.games.length} imported game${m.games.length === 1 ? "" : "s"}. Remove the incorrect game below; the series recomputes automatically.`}
          </span>
        </div>
      ) : (
        <ActionForm
          action={recordResult}
          className="flex flex-wrap items-center gap-2 text-sm"
          hidden={{ matchId: m.id, expectedActiveSeasonId }}
        >
          {label}
          {/* Keep each team name with its input. Letting two independent
              flex-1 labels absorb the whole phone-width shortfall squeezed
              them to 9px; a single long word then widened /admin itself. */}
          <div className="grid min-w-0 basis-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 sm:basis-auto sm:flex-1">
            <label className="min-w-0 text-right">
              <span className="mb-1 block break-words leading-tight [overflow-wrap:anywhere]">
                {home?.name ?? "?"}
              </span>
              <input
                id={`home-score-${m.id}`}
                aria-label={`${home?.name ?? "Home team"} series score`}
                name="homeScore"
                type="number"
                min={0}
                max={m.bestOf}
                required
                defaultValue={m.homeScore}
                className="ml-auto block h-8 w-14 rounded-md border border-line bg-surface-2/50 px-2 text-center"
              />
            </label>
            <span className="pb-2 text-muted">–</span>
            <label className="min-w-0">
              <span className="mb-1 block break-words leading-tight [overflow-wrap:anywhere]">
                {away?.name ?? "?"}
              </span>
              <input
                id={`away-score-${m.id}`}
                aria-label={`${away?.name ?? "Away team"} series score`}
                name="awayScore"
                type="number"
                min={0}
                max={m.bestOf}
                required
                defaultValue={m.awayScore}
                className="block h-8 w-14 rounded-md border border-line bg-surface-2/50 px-2 text-center"
              />
            </label>
          </div>
          {/* Ruled, not played: the flag is what keeps a defaulted 2-0 out of
            the gameDiff tiebreak and the power rankings, and what badges the
            result everywhere. Re-saving with the box unchecked un-rules it. */}
          <label className="flex items-center gap-1 text-xs text-muted">
            <input
              type="checkbox"
              name="forfeit"
              required={m.games.length > 0}
              defaultChecked={m.forfeit}
              className="h-3.5 w-3.5 accent-[var(--color-brand)]"
            />
            forfeit / ruling
          </label>
          {m.status === "COMPLETED" ? (
            <Badge tone="success">
              {m.forfeit ? "final · forfeit" : "final"}
            </Badge>
          ) : null}
          {/* This button had NO confirm, and the score boxes default to the
            current score — 0–0 on an unplayed match — with Enter submitting
            from either field. Every match row on the page carries one, so a
            stray Enter while reading marked a series FINAL at 0–0: it stops
            auto-sync for that fixture, posts the wrong score to Discord, and
            on a PLAYOFF row feeds advancePlayoffBracket, which is how a wrong
            team reaches the next round. Name the teams and the score so the
            dialog is about THIS row, and say what marking it final does. */}
          <SubmitButton
            variant="secondary"
            size="sm"
            /* Deliberately does NOT quote the score: these inputs are
             uncontrolled, so a server-rendered string would state the STORED
             score while the admin has typed a different one — a confirm that
             lies about its own effect is worse than none. Name the fixture,
             point at the boxes, and state what "final" costs. */
            confirm={`Record the score in the boxes as the FINAL result for ${home?.name ?? "home"} v ${away?.name ?? "away"}?\n\nCheck the two score boxes first. A played series must reach its real finish; use the forfeit / ruling box only when an admin is ending it early. Marking a match final stops automatic result import for it${
              m.phase !== "REGULAR" ? " and advances the playoff bracket" : ""
            }, and "Reopen for import" only undoes it while no games are attached.`}
          >
            {m.games.length > 0 ? "Save ruling" : "Save as final"}
          </SubmitButton>
          {m.games.length > 0 ? (
            <span className="w-full text-xs text-muted">
              The imported games currently account for {m.homeScore}–
              {m.awayScore}. A ruling may add awarded wins, but cannot erase a
              played win.
            </span>
          ) : null}
        </ActionForm>
      )}

      {/* A hand-entered score marks the match COMPLETED with zero games, and
          every import path then refuses it forever — so a stray Save (these
          boxes default to 0 and Enter submits) used to cost the series its box
          score permanently. This is the way back. */}
      {canReopenManual && m.status === "COMPLETED" ? (
        <ActionForm
          action={reopenMatch}
          className="flex flex-wrap items-center gap-2 text-xs text-muted"
          hidden={{ matchId: m.id, expectedActiveSeasonId }}
        >
          <span>
            {championshipFinalCorrection
              ? conflictingChampionFinal
                ? "Recorded by hand — the stored champion conflicts with this winner."
                : "Recorded by hand — this result crowned the champion."
              : "Recorded by hand — no games imported."}
          </span>
          <SubmitButton
            variant="ghost"
            size="sm"
            confirm={
              championshipFinalCorrection
                ? `${conflictingChampionFinal ? "Retract the inconsistent champion" : "Retract the champion"} and reopen only the grand final? The hand-entered score is cleared; earlier playoff rounds stay intact.`
                : "Reopen this match so its real games can be imported? The hand-entered score is cleared."
            }
          >
            {championshipFinalCorrection
              ? conflictingChampionFinal
                ? "Reopen final & retract title"
                : "Reopen grand final"
              : "Reopen for import"}
          </SubmitButton>
        </ActionForm>
      ) : null}

      {logisticsOpen ? (
        <ActionForm
          action={setMatchTime}
          className="flex flex-wrap items-end gap-2 text-xs text-muted"
          hidden={{ matchId: m.id, expectedActiveSeasonId }}
        >
          <label
            htmlFor={`scheduledAt-${m.id}`}
            className="flex flex-col gap-1"
          >
            <span>Kickoff time</span>
            <LocalDatetimeField
              id={`scheduledAt-${m.id}`}
              name="scheduledAt"
              tsName="scheduledAtTs"
              defaultTs={m.scheduledAt?.getTime()}
              className="h-8 rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg"
            />
          </label>
          <SubmitButton variant="secondary" size="sm">
            {m.scheduledAt ? "Update time" : "Set time"}
          </SubmitButton>
          <span className="w-full">
            Changing or clearing kickoff resets player check-ins, cancels open
            reschedule proposals, and reopens this week&rsquo;s Discord
            reminder.
          </span>
        </ActionForm>
      ) : (
        <p className="text-xs text-muted">
          Kickoff:{" "}
          {m.scheduledAt ? (
            <LocalTime
              ts={m.scheduledAt.getTime()}
              variant="full"
              initial={formatMatchTime(m.scheduledAt, "full")}
            />
          ) : (
            "not set"
          )}{" "}
          ·{" "}
          {m.status !== MATCH_STATUS.SCHEDULED
            ? `time editing is unavailable while this match is ${m.status.toLowerCase()}.`
            : seasonStatus === SEASON_STATUS.COMPLETE
              ? "kickoff editing is locked because the completed season is read-only."
              : seasonStatus === SEASON_STATUS.SIGNUPS
                ? "kickoff editing opens after the auction is complete."
                : seasonStatus === SEASON_STATUS.DRAFT &&
                    draftStatus !== DRAFT_STATUS.COMPLETE
                  ? "kickoff editing opens when the auction is complete."
                  : "kickoff editing is locked in the current league phase."}
        </p>
      )}

      {m.games.length > 0 ? (
        <ul className="space-y-1 border-t border-line/60 pt-2 text-xs">
          {m.games.map((g) => {
            const winner = teams.find((t) => t.id === g.winnerTeamId);
            return (
              <li key={g.id} className="flex items-center justify-between">
                <a
                  href={`https://www.opendota.com/matches/${g.dotaMatchId}`}
                  target="_blank"
                  rel="noreferrer"
                  className={textLink()}
                >
                  Game {g.dotaMatchId} · {winner ? `${winner.name} won` : "tie"}{" "}
                  · {Math.floor(g.durationSecs / 60)}m
                </a>
                {canCorrectImported ? (
                  <ActionForm action={removeGame}>
                    <input type="hidden" name="gameId" value={g.id} />
                    <SubmitButton
                      variant="ghost"
                      size="sm"
                      className="text-danger hover:underline"
                      confirm={
                        championshipFinalCorrection
                          ? `${conflictingChampionFinal ? "Retract the inconsistent champion" : "Retract the champion"}, remove this imported game, and recompute only the grand final? Earlier rounds stay intact.`
                          : "Remove this imported game and recompute the series?"
                      }
                    >
                      remove
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  <span className="text-muted">read-only</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {resultCorrectionOpen && m.status !== MATCH_STATUS.COMPLETED ? (
        <MatchImportControls
          matchId={m.id}
          importAction={importGameAction}
          detectAction={autoDetectAction}
        />
      ) : m.status === MATCH_STATUS.COMPLETED &&
        (resultCorrectionOpen || championshipFinalCorrection) ? (
        <p className="text-xs text-muted">
          This series is final. Reopen a hand-entered result or remove an
          incorrect imported game before adding another.
        </p>
      ) : null}
    </div>
  );
}

function PlayoffControls({
  season,
  data,
}: {
  season: Season;
  data: AdminData;
}) {
  const playoffMatches = data.matches.filter((m) => m.phase !== "REGULAR");
  const championPresentation = resolveChampionPresentation(
    season,
    data.matches,
  );
  const playoffField = projectPlayoffField(data.teams, data.matches);
  const bracketSize = playoffField.bracketSize;
  const status = regularSeasonStatus(data.matches);
  // A fully-tied pair (points, game diff, series wins AND head-to-head all
  // level) is ordered by nothing but the team-id fallback — deterministic,
  // but a coin flip. When such a pair touches the seeded slice, the seeding
  // (possibly WHO makes the bracket) is arbitrary, and the admin should hear
  // it BEFORE the click, not from a captain afterwards. The only levers today
  // are correcting a result or accepting the flip; the confirm says so.
  const teamNameById = new Map(data.teams.map((t) => [t.id, t.name]));
  const coinFlipSeeding = playoffField.seedingDeadHeatTeamIds.map(
    (teamId) => teamNameById.get(teamId) ?? teamId,
  );
  const coinFlipNote =
    coinFlipSeeding.length > 0
      ? `Dead heat in the seeding: ${coinFlipSeeding.join(" and ")} are fully tied (points, game diff, series wins, head-to-head) — their order is arbitrary. Correct a result first, or accept the coin flip.`
      : null;
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
            : null;
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
            : null;

  return (
    <Card id="playoffs" className="scroll-mt-20">
      <CardHeader
        headingLevel={2}
        title="Playoffs"
        subtitle="Seed the top teams into a single-elimination bracket."
        action={
          /* START and RESET are the same action, and used to be the same
             button in the same pixel of the card header — so muscle memory
             aimed at "Start playoffs" hits "Reset playoffs" once a bracket
             exists. They are now different controls: Start stays an ordinary
             button, Reset is type-to-confirm, because it deletes the whole
             postseason and the playoff RSVPs, standin bookings and pick'em
             picks are not archived by anything. */
          playoffMatches.length > 0 ? (
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
                  ...(coinFlipNote ? [coinFlipNote] : []),
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
          ) : (
            <ActionForm
              action={startPlayoffs}
              hidden={{ ...commandClaim, intent: "start" }}
            >
              <SubmitButton
                variant="secondary"
                size="sm"
                disabled={startPlayoffsLockedReason != null}
                confirm={
                  coinFlipNote
                    ? `Seed and start the playoff bracket?\n\n⚖️ ${coinFlipNote}`
                    : "Seed and start the playoff bracket?"
                }
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
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
            <b>Champion state needs review.</b>{" "}
            {storedChampion
              ? `${storedChampion.name} is stored as champion, but that record does not match one authoritative completed grand-final winner.`
              : "No authoritative champion is stored for this completed season."}{" "}
            Reconcile the final with the targeted result controls above, or use
            the bracket recovery controls here; public pages do not attribute
            the title while this conflict exists.
          </div>
        ) : null}
        {playoffMatches.length > 0 && resetPlayoffsLockedReason ? (
          <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-xs text-muted">
            Reset playoffs is unavailable: {resetPlayoffsLockedReason}
          </div>
        ) : null}
        {playoffMatches.length === 0 && startPlayoffsLockedReason ? (
          <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-xs text-muted">
            Start playoffs is unavailable: {startPlayoffsLockedReason}
          </div>
        ) : null}
        {status.pending > 0 && playoffMatches.length === 0 ? (
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
            ⚠ {status.pending} regular-season result
            {status.pending === 1 ? "" : "s"} still needed — the playoffs are
            locked until every match is entered (weeks{" "}
            {status.pendingWeeks.join(", ")}).
          </div>
        ) : null}
        {coinFlipNote && playoffMatches.length === 0 ? (
          <div className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2">
            ⚖️ {coinFlipNote}
          </div>
        ) : null}
        {playoffMatches.length > 0 ? (
          <div className="space-y-3">
            <p className="text-muted">
              {season.status === SEASON_STATUS.COMPLETE
                ? champion
                  ? `Postseason complete. The bracket and ${champion.name}'s title are preserved here; use the targeted grand-final correction above for a final-series error, or the destructive recovery controls below for an earlier-round or seeding error.`
                  : "The season is marked Complete, but no authoritative champion is available. Use the phase or playoff recovery controls to reconcile the final before publishing a title."
                : `${playoffMatches.length} playoff match(es) created. Enter scores in “Schedule & results” above — the bracket advances and crowns the champion automatically.`}
            </p>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/30 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium">Need to correct the table?</div>
                <p className="text-xs text-muted">
                  Return to Regular season removes this postseason first, so a
                  corrected result can never coexist with stale seeds or a stale
                  champion.
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
        ) : (
          <p className="text-muted">
            {playoffField.eligibleTeamIds.length < 2
              ? "At least two non-withdrawn teams are needed before a bracket can be seeded."
              : `Will seed the top ${bracketSize} of ${playoffField.eligibleTeamIds.length} eligible team(s) by standings${data.teams.length !== playoffField.eligibleTeamIds.length ? `; ${data.teams.length - playoffField.eligibleTeamIds.length} withdrawn team(s) keep their results but cannot take a seed` : ""}. Start this after the regular season is finished.`}
          </p>
        )}
        {data.playoffArchive.length > 0 ? (
          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted hover:text-fg">
              {data.playoffArchive.length} playoff game(s) removed by a bracket
              reset — OpenDota IDs kept for re-import
            </summary>
            <p className="mt-2 text-xs text-muted">
              Paste these into the &ldquo;Match ID or URL&rdquo; box on the
              matching fixture in Schedule &amp; results and press &ldquo;Add
              game&rdquo; to restore its box score.
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
          Series lengths (regular / playoffs / final) are set in the
          phase-control panel above.
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
  const upcomingById = new Map(upcoming.map((m) => [m.id, m]));
  const coverByStandin = new Map<
    string,
    { name: string; matches: (typeof upcoming)[number][] }
  >();
  for (const a of data.assignments) {
    const m = upcomingById.get(a.matchId);
    if (!m) continue;
    const cur = coverByStandin.get(a.standinUserId) ?? {
      name: a.standin.name,
      matches: [],
    };
    cur.matches.push(m);
    coverByStandin.set(a.standinUserId, cur);
  }
  const clashLines: string[] = [];
  for (const {
    name: standinName,
    matches: covered,
  } of coverByStandin.values()) {
    for (let i = 0; i < covered.length; i++) {
      for (let j = i + 1; j < covered.length; j++) {
        if (standinConflict(covered[i], covered[j])) {
          const label = (m: (typeof covered)[number]) =>
            `${teamName.get(m.homeTeamId) ?? "?"} vs ${teamName.get(m.awayTeamId) ?? "?"} (wk ${m.week})`;
          clashLines.push(
            `${standinName} covers both ${label(covered[i])} and ${label(covered[j])} the same night — remove one below`,
          );
        }
      }
    }
  }
  // Standins are assigned for the imminent night — group by week and only
  // expand the earliest open one so the current night isn't a scroll away.
  const regularUpcoming = upcoming.filter((m) => m.phase === "REGULAR");
  const playoffUpcoming = upcoming.filter((m) => m.phase !== "REGULAR");
  const weeks = [...new Set(regularUpcoming.map((m) => m.week))].sort(
    (a, b) => a - b,
  );
  // Round names need the full bracket depth — deriving it from only the
  // upcoming (not-yet-played) rounds would drop the first-round count and
  // mislabel a lone remaining semifinal/final.
  const { totalRounds } = groupPlayoffRounds(
    data.matches.filter((m) => m.phase !== "REGULAR"),
  );

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Standin assignments"
        subtitle="Slot a standin in for a player who can't make a match."
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
            {weeks.map((wk) => {
              const wkMatches = regularUpcoming.filter((m) => m.week === wk);
              return (
                <details
                  key={`w${wk}`}
                  open={wk === weeks[0]}
                  className="rounded-lg border border-line"
                >
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                    Week {wk}
                    <span className="ml-2 text-xs font-normal text-muted">
                      {wkMatches.length} match
                      {wkMatches.length === 1 ? "" : "es"}
                    </span>
                  </summary>
                  <div className="space-y-3 px-3 pb-3">
                    {wkMatches.map((m) => (
                      <StandinMatchBlock
                        key={m.id}
                        m={m}
                        data={data}
                        assignments={byMatch.get(m.id) ?? []}
                        teamName={teamName}
                        teamSize={season.teamSize}
                        assignOpen={assignOpen}
                        label={
                          <Link
                            href={`/matches/${m.id}`}
                            className={textLink()}
                          >
                            Week {m.week}
                          </Link>
                        }
                      />
                    ))}
                  </div>
                </details>
              );
            })}
            {playoffUpcoming.length > 0 ? (
              <details
                open={weeks.length === 0}
                className="rounded-lg border border-accent/40"
              >
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                  Playoffs
                  <span className="ml-2 text-xs font-normal text-muted">
                    {playoffUpcoming.length} match
                    {playoffUpcoming.length === 1 ? "" : "es"}
                  </span>
                </summary>
                <div className="space-y-3 px-3 pb-3">
                  {playoffUpcoming.map((m) => (
                    <StandinMatchBlock
                      key={m.id}
                      m={m}
                      data={data}
                      assignments={byMatch.get(m.id) ?? []}
                      teamName={teamName}
                      teamSize={season.teamSize}
                      assignOpen={assignOpen}
                      label={
                        <Link href={`/matches/${m.id}`} className={textLink()}>
                          {roundName(slotRound(m.bracketSlot), totalRounds)}
                        </Link>
                      }
                    />
                  ))}
                </div>
              </details>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}

// One match's standin controls: an OUT-players alert, current assignments,
// and the assign form. Shared by the week-grouped and playoff sections above.
function StandinMatchBlock({
  m,
  data,
  assignments,
  teamName,
  label,
  teamSize,
  assignOpen,
}: {
  m: AdminData["matches"][number];
  data: AdminData;
  assignments: AdminData["assignments"];
  teamName: Map<string, string>;
  label: React.ReactNode;
  teamSize: number;
  /** The card-level phase gate — the assign form hides where the service
   *  would refuse; removal stays rendered (cleanup is legal everywhere). */
  assignOpen: boolean;
}) {
  const home = data.teams.find((t) => t.id === m.homeTeamId);
  const away = data.teams.find((t) => t.id === m.awayTeamId);
  const asg = assignments;
  // A player already covered can't be covered again (the service refuses a
  // second cover for one seat), so don't offer them — the captain-facing card
  // has always filtered these and the admin one didn't.
  const coveredIds = new Set(
    asg.map((a) => a.replacingUserId).filter(Boolean) as string[],
  );
  // OPEN SEATS. A short roster is filled by a standin who replaces NOBODY, so
  // it needs its own option — this is the case that had no UI at all, which is
  // why a 4-of-5 team simply could not be covered. One entry per still-open
  // seat, already-filled ones subtracted.
  const openSeats = [home, away].flatMap((t) => {
    if (!t) return [];
    const filled = asg.filter(
      (a) => a.teamId === t.id && a.replacingUserId == null,
    ).length;
    const open = teamSize - t.members.length - filled;
    return open > 0 ? [{ team: t, open }] : [];
  });
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="text-sm font-medium">
        {label}: {home?.name ?? "?"} vs {away?.name ?? "?"}
      </div>
      {(() => {
        // Only current roster members can need cover — a released
        // player's (or unassigned standin's) stale OUT row would
        // otherwise raise an alert no assignment can ever clear.
        const rosterIds = new Set(
          [home, away].flatMap((t) => t?.members.map((mm) => mm.userId) ?? []),
        );
        const out = data.outRsvps.filter(
          (r) => r.matchId === m.id && rosterIds.has(r.userId),
        );
        const covered = new Set(
          asg.map((a) => a.replacingUserId).filter(Boolean),
        );
        const needing = out.filter((r) => !covered.has(r.userId));
        // The OTHER direction: an assigned STANDIN who has declared OUT. The
        // roster filter above deliberately excludes them, so the seat read as
        // covered while the cover had quit — the one state this card exists
        // to catch that it couldn't see. Distinct copy because the fix path
        // differs (remove/replace, not add).
        const assignedIds = new Set(asg.map((a) => a.standinUserId));
        const standinOut = data.outRsvps.filter(
          (r) => r.matchId === m.id && assignedIds.has(r.userId),
        );
        return (
          <>
            {needing.length > 0 ? (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs">
                ✗ Can&apos;t make it:{" "}
                <b>{needing.map((r) => r.user.name).join(", ")}</b> — assign a
                standin below.
              </div>
            ) : null}
            {standinOut.length > 0 ? (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs">
                ✗ Assigned standin{" "}
                <b>{standinOut.map((r) => r.user.name).join(", ")}</b> has
                declared OUT — remove that assignment and arrange other cover.
              </div>
            ) : null}
          </>
        );
      })()}
      {asg.length > 0 ? (
        <ul className="space-y-1">
          {asg.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between text-xs text-muted"
            >
              <span>
                {/* A null `replaced` is an EMPTY-SEAT cover, not missing data —
                    it used to render as "in for ?". */}
                {a.replaced
                  ? `${a.standin.name} in for ${a.replaced.name}`
                  : `${a.standin.name} filling an open seat`}{" "}
                · {teamName.get(a.teamId)}
              </span>
              <ActionForm action={removeStandin}>
                <input type="hidden" name="assignmentId" value={a.id} />
                <SubmitButton
                  variant="ghost"
                  size="sm"
                  className="text-xs text-danger hover:underline"
                  confirm={`Remove ${a.standin.name} from this match? They are told to stand down in Discord — if this was a mis-click they will have been pinged twice for nothing.`}
                >
                  remove
                </SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      ) : null}
      {!assignOpen ? null : (
        <ActionForm
          action={assignStandin}
          className="flex flex-wrap items-center gap-2"
        >
          <input type="hidden" name="matchId" value={m.id} />
          <select
            name="standinUserId"
            required
            defaultValue=""
            aria-label="Standin"
            className={selectCls}
          >
            <option value="" disabled>
              Standin…
            </option>
            {/* MMR rides in the option text — the captain picker has always
              shown it, and the any-team admin override was choosing blind. */}
            {data.standins.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.user.name} ({s.mmr} MMR)
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">replaces</span>
          <select
            name="replacingUserId"
            required
            defaultValue=""
            aria-label="Player being replaced"
            className={selectCls}
          >
            <option value="" disabled>
              Player…
            </option>
            {/* Open seats first: on a short roster this is the thing the admin
              came here to do, and it used to be impossible. The `seat:` prefix
              is unpacked by the action into a null replacingUserId + teamId. */}
            {openSeats.length > 0 ? (
              <optgroup label="Open roster seat">
                {openSeats.map(({ team, open }) => (
                  <option key={`seat-${team.id}`} value={seatValue(team.id)}>
                    {team.name} — empty seat ({open} of {teamSize} unfilled)
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label={home?.name ?? "Home"}>
              {home?.members
                .filter((mm) => !coveredIds.has(mm.userId))
                .map((mm) => (
                  <option key={mm.userId} value={mm.userId}>
                    {mm.user.name}
                  </option>
                ))}
            </optgroup>
            <optgroup label={away?.name ?? "Away"}>
              {away?.members
                .filter((mm) => !coveredIds.has(mm.userId))
                .map((mm) => (
                  <option key={mm.userId} value={mm.userId}>
                    {mm.user.name}
                  </option>
                ))}
            </optgroup>
          </select>
          <Button type="submit" variant="secondary" size="sm">
            Assign
          </Button>
        </ActionForm>
      )}
    </div>
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
      initial={formatMatchTime(value, "short")}
    />
  ) : (
    emptyLabel
  );
}

/**
 * Production-wide runner health. This is separate from AutoSyncHealth below:
 * that card explains per-match scan/backoff state during playable phases,
 * while this one answers whether the single scheduled worker is alive and
 * safe to recover in every phase (including offseason and no season).
 */
async function AutomationRunnerHealth() {
  let state: AutomationHealthRecord | null | undefined;
  let backlog:
    | {
        league: number;
        inhouse: number;
        markerRetries: number;
      }
    | undefined;
  try {
    const [runner, league, inhouse, markerRetries] = await Promise.all([
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
      prisma.leagueAnnouncement.count({
        where: {
          status: {
            in: [
              LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
              LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
            ],
          },
        },
      }),
      prisma.inhouseAnnouncement.count({
        where: {
          status: {
            in: [
              INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
              INHOUSE_ANNOUNCEMENT_STATUS.SENDING,
            ],
          },
        },
      }),
      prisma.setting.count({
        where: {
          OR: [
            { value: { startsWith: ANNOUNCE_FAILED_PREFIX } },
            {
              key: { startsWith: HONORS_ANNOUNCED_PREFIX },
              value: { startsWith: "stale:" },
            },
          ],
        },
      }),
    ]);
    state = runner;
    backlog = { league, inhouse, markerRetries };
  } catch {
    // The admin panel remains usable during a migration/readiness incident.
    // `undefined` is intentionally distinct from a missing (never-run) row.
    state = undefined;
    backlog = undefined;
  }

  // Async SERVER component: one value per request. The React purity rule is
  // aimed at client re-renders, not a server health snapshot.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const health = automationHealthView(state, now);
  const emptyTime = state === undefined ? "Unavailable" : "Never";
  const badgeTone =
    health.kind === "HEALTHY"
      ? "success"
      : health.kind === "RUNNING"
        ? "accent"
        : health.kind === "DEGRADED" || health.kind === "UNAVAILABLE"
          ? "danger"
          : "neutral";
  const calloutClass =
    health.kind === "HEALTHY"
      ? "border-success/30 bg-success/10"
      : health.kind === "RUNNING"
        ? "border-accent/30 bg-accent/10"
        : health.kind === "DEGRADED" || health.kind === "UNAVAILABLE"
          ? "border-danger/30 bg-danger/10"
          : "border-line bg-surface-2/40";

  return (
    <Card>
      <CardHeader
        title="Automation runner"
        subtitle="Database-owned maintenance for result imports and league background work, available in every league phase."
        action={<Badge tone={badgeTone}>{health.label}</Badge>}
      />
      <CardBody className="space-y-5">
        <div className={cn("rounded-lg border px-4 py-3", calloutClass)}>
          <div className="font-medium text-fg">{health.headline}</div>
          <p className="mt-1 text-sm text-muted">{health.description}</p>
        </div>

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

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface-2/30 p-4">
            <h4 className="font-medium text-fg">Lease and work signals</h4>
            {health.signals.length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                {health.signals.map((signal) => (
                  <li key={signal}>{signal}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">
                No persisted lease, deferred-work, or failure signal is
                recorded.
              </p>
            )}
            {health.leaseExpiresAt ? (
              <p className="mt-2 text-xs text-muted">
                Lease {health.leaseActive ? "expires" : "expired"} at{" "}
                <AutomationTimestamp
                  value={health.leaseExpiresAt}
                  emptyLabel="Not recorded"
                />
                .
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-line bg-surface-2/30 p-4">
            <h4 className="font-medium text-fg">Expected cadence</h4>
            <p className="mt-2 text-sm text-muted">
              Production should invoke one maintenance pass every minute. The
              health state becomes degraded after four minutes without a
              completed pass, allowing for deploy and scheduler jitter.
            </p>
            <p className="mt-2 text-xs text-muted">
              A manual pass uses the same owner-and-token lease as cron. It can
              recover an expired run, but it cannot force, overlap, or clear an
              active owner.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface-2/30 p-4">
          <h4 className="font-medium text-fg">Durable delivery backlog</h4>
          {backlog ? (
            backlog.league + backlog.inhouse + backlog.markerRetries > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                <li>{backlog.league} league-channel message(s) pending</li>
                <li>{backlog.inhouse} inhouse message(s) pending</li>
                <li>
                  {backlog.markerRetries} result, champion, reminder, or honors
                  marker(s) awaiting retry
                </li>
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">
                No league, inhouse, or marker retry is waiting for delivery.
              </p>
            )
          ) : (
            <p className="mt-2 text-sm text-danger">
              Backlog state is unavailable until database readiness is restored.
            </p>
          )}
          <p className="mt-2 text-xs text-muted">
            Pending work survives a process restart and drains in order. A
            growing count means Discord or the scheduled runner needs attention.
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
                "Run a bounded pass now. If cron acquires the lease first, this request exits without starting duplicate work."}
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
      </CardBody>
    </Card>
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
  const [inWindow, leagueSyncAt, cursor, skipRaw, privatePlayers] =
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
      getSetting(leagueSyncSkipKey(season.id)),
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
  let skippedIds = 0;
  try {
    const parsed = JSON.parse(skipRaw ?? "[]");
    if (Array.isArray(parsed)) skippedIds = parsed.length;
  } catch {
    // unreadable skip memory — just report 0
  }
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
              const next = nextAutoSyncAt(m.autoSyncedAt, m.autoSyncAttempts);
              const backedOff = m.autoSyncAttempts >= 3;
              const fallbackAt = m.scheduledAt
                ? new Date(leagueFallbackOpensAt(m.scheduledAt.getTime()))
                : null;
              const waitingForFallback =
                season.dotaLeagueId &&
                m.status !== "LIVE" &&
                !m.autoSyncedAt &&
                fallbackAt != null &&
                fallbackAt.getTime() > now;
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
                  <span className="text-xs text-muted">
                    {m.autoSyncedAt ? (
                      <>
                        player accounts scanned{" "}
                        <LocalTime
                          ts={m.autoSyncedAt.getTime()}
                          variant="short"
                          initial={formatMatchTime(m.autoSyncedAt, "short")}
                        />
                        {" · "}
                        {m.autoSyncAttempts} empty scan
                        {m.autoSyncAttempts === 1 ? "" : "s"}
                        {" · next "}
                        {next && next.getTime() > now ? (
                          <LocalTime
                            ts={next.getTime()}
                            variant="short"
                            initial={formatMatchTime(next, "short")}
                          />
                        ) : (
                          "on the next ping"
                        )}
                      </>
                    ) : waitingForFallback ? (
                      <>
                        waiting for league feed · player-account recovery starts{" "}
                        <LocalTime
                          ts={fallbackAt!.getTime()}
                          variant="short"
                          initial={formatMatchTime(fallbackAt!, "short")}
                        />
                      </>
                    ) : season.dotaLeagueId ? (
                      m.status === "LIVE" ? (
                        "waiting for the next lobby · player-account recovery is ready"
                      ) : (
                        "waiting for league feed · player-account recovery is ready"
                      )
                    ) : (
                      "not scanned yet — next ping picks it up"
                    )}
                  </span>
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
              initial={formatMatchTime(new Date(cursorTs), "full")}
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
                  initial={formatMatchTime(new Date(leagueTs), "short")}
                />
              ) : (
                "never"
              )}
              {` · ${skippedIds} league game${skippedIds === 1 ? "" : "s"} skipped as not ours`}
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
              Click <b>Sync league games</b> to pull results automatically — no
              manual match ids or players&apos; public data needed.
            </li>
          </ol>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 p-3">
          <p className="min-w-[14rem] flex-1 text-xs text-muted">
            <span className="font-medium text-fg">Report-card backfill:</span>{" "}
            games imported before hero report cards existed are missing their
            percentile benchmarks — re-fetch them from OpenDota in small
            batches.
          </p>
          <ActionForm action={enrichGamesAction}>
            <SubmitButton variant="secondary" size="sm">
              Enrich stored games
            </SubmitButton>
          </ActionForm>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 p-3">
          <p className="min-w-[14rem] flex-1 text-xs text-muted">
            <span className="font-medium text-fg">Medal backfill:</span> fetch
            ranked medals for every account that doesn&apos;t have one yet —
            including people who signed in but never joined a season. Skips
            accounts that already have a medal; safe to run again.
          </p>
          <ActionForm action={syncAllRanks}>
            <SubmitButton variant="secondary" size="sm">
              Sync all medals
            </SubmitButton>
          </ActionForm>
        </div>
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
  const shortTeams = preStart
    ? []
    : data.teams.filter(
        (t) => !t.withdrawn && t.members.length < season.teamSize,
      );
  const canSign = !preStart && freeAgents.length > 0 && shortTeams.length > 0;
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
        {shortTeams.length > 0 ? (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-fg">
            <b>
              {shortTeams.length} team
              {shortTeams.length === 1 ? " is" : "s are"} short of{" "}
              {season.teamSize}:
            </b>{" "}
            {shortTeams
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
              {shortTeams.map((t) => (
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
              className="text-danger"
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

function DraftReadinessBadge({
  reg,
  season,
}: {
  reg: AdminData["players"][number];
  season: Season;
}) {
  if (!season.draftAt || reg.type !== REGISTRATION_TYPE.PLAYER) return null;
  const state = draftReadiness(reg, season.draftRevision);
  if (state === DRAFT_READINESS.READY) {
    return (
      <Badge
        tone="success"
        title={
          reg.draftConfirmedAt
            ? `Confirmed ${formatMatchTime(reg.draftConfirmedAt, "full")} for the current draft schedule.`
            : "Confirmed for the current draft schedule."
        }
      >
        ready ✓
      </Badge>
    );
  }
  if (state === DRAFT_READINESS.STALE) {
    return (
      <Badge
        tone="accent"
        title={
          reg.draftConfirmedFor
            ? `They confirmed ${formatMatchTime(reg.draftConfirmedFor, "full")}, but the draft schedule changed.`
            : "They confirmed an earlier draft schedule and need to review the new time."
        }
      >
        reconfirm
      </Badge>
    );
  }
  return (
    <Badge title="They have not yet acknowledged the current draft time.">
      awaiting draft confirmation
    </Badge>
  );
}

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
  season,
  showDraftReadiness = false,
}: {
  reg: AdminData["players"][number];
  sweep: Promise<Map<string, GuildMembership>> | null;
  season: Season;
  showDraftReadiness?: boolean;
}) {
  const flags = signupFlags({
    mmr: reg.mmr,
    roles: reg.roles,
    favoriteHeroes: reg.favoriteHeroes,
    statement: reg.statement,
    captainNote: reg.captainNote,
    rankTier: reg.user.rankTier,
  });
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {showDraftReadiness ? (
        <DraftReadinessBadge reg={reg} season={season} />
      ) : null}
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
 * The Start-draft form itself, rendered twice: as the Suspense fallback with
 * the base confirm (the button must exist the moment the panel paints), and
 * by StartDraftControl with the Discord reachability line appended.
 */
function StartDraftForm({
  seasonId,
  confirm,
  disabled,
}: {
  seasonId: string;
  confirm: string;
  disabled: boolean;
}) {
  return (
    <ActionForm
      action={startDraft}
      hidden={{ expectedActiveSeasonId: seasonId }}
    >
      <SubmitButton
        variant="accent"
        size="sm"
        disabled={disabled}
        confirm={confirm}
      >
        Start draft
      </SubmitButton>
    </ActionForm>
  );
}

/**
 * House rule: a consequential confirm states the real numbers BEFORE the
 * click. This one appends who the league cannot reach on Discord — missing
 * from the server, stuck behind its rules screen, or never linked — because
 * the moment before the draft is the last cheap chance to chase a join:
 * afterwards these players are locked onto rosters that need to schedule
 * with them every week.
 */
async function StartDraftControl({
  seasonId,
  confirmBase,
  disabled,
}: {
  seasonId: string;
  confirmBase: string;
  disabled: boolean;
}) {
  const reach = await getDiscordReachFunnel(seasonId);
  return (
    <StartDraftForm
      seasonId={seasonId}
      confirm={confirmBase + discordReachWarning(reach)}
      disabled={disabled}
    />
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
function DiscordReachLine({ reach }: { reach: DiscordReachFunnel }) {
  if (reach.registered === 0) return null;
  const pct = Math.round((reach.linked / reach.registered) * 100);
  // Below half, the useful next move is chasing links rather than building
  // more notification machinery — so say so rather than just showing a number.
  const thin = pct < 50;
  const g = reach.linked > 0 ? reach.guild : null;
  // The funnel's lists are uncapped (the chase message names everyone); the
  // CARD caps at 12 so an unlinked league isn't a wall of names.
  const capped = (names: string[]) =>
    names.slice(0, 12).join(", ") +
    (names.length > 12 ? ` +${names.length - 12} more` : "");
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
    <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2">
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
      {reach.unlinkedNames.length > 0 ? (
        <p className="mt-1 text-xs text-muted">
          Not linked: {capped(reach.unlinkedNames)}
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
                " — pings to them land nowhere. If a player insists they're in the server, search the @handle in the member list: they likely linked a different account than the one they use, and the fix is re-linking on their profile."
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
                  FOREVER; the checklist above is what names the broken piece. */}
              Couldn&apos;t check {g.unknown}
              {
                " — Discord didn't answer. A hiccup clears itself within a minute; if this persists, the bot checklist above says which piece is broken."
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
async function DiscordSection({ seasonId }: { seasonId: string | null }) {
  // Never hand the raw webhook URL to the client — it's a bearer credential.
  // Resolve it server-side only to derive a boolean + a masked fingerprint.
  const dbWebhook = (await getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL)) ?? "";
  const activeWebhook = dbWebhook || process.env.DISCORD_WEBHOOK_URL || "";
  const [board, pingHealth, discordReach] = await Promise.all([
    getInhouseBoardStatus(),
    getPingHealth(),
    getDiscordReachFunnel(seasonId),
  ]);
  return (
    <DiscordControls
      status={{
        configured: !!activeWebhook,
        masked: maskWebhookUrl(activeWebhook),
        // Set only via env, not the DB — Remove (which clears the DB key)
        // can't touch it, so we hide that button and say where it lives.
        envManaged: !dbWebhook && !!process.env.DISCORD_WEBHOOK_URL,
      }}
      board={board}
      pingHealth={pingHealth}
      discordReach={discordReach}
      mutationsAllowed={discordMutationsAllowed()}
    />
  );
}

function DiscordControls({
  status,
  board,
  pingHealth,
  discordReach,
  mutationsAllowed,
}: {
  status: { configured: boolean; masked: string; envManaged: boolean };
  board: InhouseBoardStatus;
  pingHealth: PingHealth;
  discordReach: DiscordReachFunnel;
  mutationsAllowed: boolean;
}) {
  const { configured, masked, envManaged } = status;
  return (
    <AdminSection
      id="adm-discord"
      title="Discord notifications"
      subtitle="Configure league announcements plus the year-round inhouse queue board, alerts, and ping role."
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
              <Badge tone="success">Configured</Badge>
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
          <DiscordReachLine reach={discordReach} />

          <p className="text-xs text-muted">
            {board.pingRoleId ? (
              <>
                <b>Notifications are on.</b> Two messages ping this role — the
                queue filling up, and a match being found. Nothing else does,
                and board edits never notify anyone.
              </>
            ) : (
              <>
                <b>Nothing currently notifies anyone.</b> Board edits are silent
                by design, and every message suppresses mentions. Set a role
                here and the &ldquo;queue is filling&rdquo; and &ldquo;match
                found&rdquo; messages will ping it.
              </>
            )}{" "}
            Make the role <b>self-assignable</b> (Server Settings → Onboarding,
            or a Channels &amp; Roles picker) — a ping people can&apos;t opt out
            of gets the channel muted, which is worse than silence. Players who
            queued are also mentioned directly when their match is found, if
            they&apos;ve linked Discord on their profile.
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
                  initial={formatMatchTime(new Date(board.lastEdit), "full")}
                />
              </span>
            ) : null}
          </div>

          {board.posted ? (
            <p className="text-xs text-muted">
              Queue right now: <b>{board.liveState}</b> —{" "}
              {board.inSync
                ? "the board is showing this."
                : "the board hasn't caught up yet (an edit is due on the next page view)."}
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
};

/**
 * How long a pot may sit in a state it could be settled from before that is an
 * alarm rather than a delay.
 *
 * `resolveUnsettledBets` runs from BOTH inhouse resolver chains and from
 * `syncInhouse`, which `/api/sync` executes on every page view of the entire
 * site — so a COMPLETED or CANCELLED lobby still at `betSettlement = PENDING`
 * is settled by the next visitor to load ANY page, /inhouse or not. Past a
 * minute the benign reading has run out, and this card is its own proof:
 * loading /admin fires that ping too, so a reload clears a stranded pot if the
 * sweeper is alive at all.
 *
 * Local to this card on purpose: it is a display threshold for a human, not a
 * mechanism anything keys off, and `constants.ts` is the file for the latter.
 */
const POT_STRANDED_MS = 60_000;

/** "4m" / "2h 10m" / "3d 4h" — an elapsed duration, never a wall-clock time. */
function ageLabel(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A signed Cred figure — the sign IS the story, as on the /inhouse board. */
function CredDelta({ n }: { n: number }) {
  return (
    <span
      className={cn(
        "font-semibold tabular-nums",
        n > 0 ? "text-success" : n < 0 ? "text-danger" : "text-muted",
      )}
    >
      {n > 0 ? `+${n}` : n}
    </span>
  );
}

/**
 * Inhouse betting — the books, the pots still on the table, and the one control
 * that can move a balance.
 *
 * It exists for the reason `AutoSyncHealth` does. A process that runs lazily off
 * page views is invisible the moment it stops: a match parked in auto-sync
 * backoff is indistinguishable from "no games yet", and a pot stranded at
 * `betSettlement = PENDING` is indistinguishable from a quiet night — except
 * this one is holding ten people's money, and nothing else in the app would
 * ever mention it.
 *
 * And `adjustCred` shipped guarded, integration-tested and in the mutation
 * baseline with NO caller anywhere in the app. Until this card the only way to
 * repair a balance was psql against production.
 *
 * Streamed like the Discord card: `credProfitBoard` is an unwindowed scan of
 * the whole Cred ledger, and this is set-up-and-check work that must never hold
 * up Pause draft or Record result. Collapsed for the same reason.
 */
async function InhouseBetting() {
  // async SERVER component: renders once per request, so there is no re-render
  // for Date.now() to be non-idempotent across (the purity rule is written for
  // client components) — the same note AutoSyncHealth carries.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const [pots, accounts, ledger, profit, adjustments] = await Promise.all([
    // Every pot still on the table. `betSettlement` is indexed and null on
    // every lobby in a league that has never bet, so a league that doesn't use
    // this feature pays one index probe for the whole card.
    prisma.inhouseLobby.findMany({
      where: { betSettlement: INHOUSE_BET_STATUS.PENDING },
      orderBy: { updatedAt: "asc" },
      select: {
        id: true,
        status: true,
        // The lobby's last transition — for a PENDING pot that is the write
        // that made it settleable (the COMPLETED claim, or the cancel), because
        // settling is the only thing left that would touch the row again.
        updatedAt: true,
        bets: {
          where: { confirmedAt: { not: null } },
          select: { userId: true, team: true, stake: true, placedAt: true },
        },
      },
    }),
    // One query doing three jobs: the funded count, the circulation total, and
    // the correction form's options. Rows are one per player who has ever bet
    // — tens, not thousands.
    prisma.inhouseCredit.findMany({
      select: { userId: true, balance: true, user: { select: { name: true } } },
      orderBy: { user: { name: "asc" } },
    }),
    prisma.inhouseCreditEntry.aggregate({ _sum: { delta: true } }),
    credProfitBoard(),
    prisma.inhouseCreditEntry.findMany({
      // `reason` is LEFTMOST in @@unique([reason, refId]), so this needs no
      // index of its own — the repo's rule for when to skip an @@index.
      where: { reason: INHOUSE_CRED_REASON.ADJUST },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  ]);

  const nameOf = new Map(accounts.map((a) => [a.userId, a.user.name]));
  const circulation = accounts.reduce((s, a) => s + a.balance, 0);
  const ledgerTotal = ledger._sum.delta ?? 0;
  const boardSum = [...profit.values()].reduce((s, n) => s + n, 0);
  const onTheTable = pots.reduce(
    (s, l) => s + l.bets.reduce((t, b) => t + b.stake, 0),
    0,
  );

  // THE TWO CHECKS, and they fail on different things — which is why both are
  // here rather than whichever one looked tidier.
  //
  // `booksDrift` is the zero-sum one. Betting mints nothing: every Cred a
  // winner takes came off an opposing stake, and STAKE/RETURN cancel exactly
  // (that is why the RETURN leg carries the WHOLE stake), so the profit board
  // sums to 0 — MINUS whatever is currently staked on a pot that hasn't paid
  // its RETURN legs yet. Adding `onTheTable` back is not a fudge: without it
  // this alarm would fire for the entire length of every live pot, and a
  // health surface that cries wolf on the normal case is one nobody reads.
  //
  // `ledgerDrift` is the receipts one: `balance === Σ ledger deltas` per user
  // (GRANT records the opening balance), so it holds in aggregate at every
  // instant, live pots included. It is what catches a movement written without
  // its receipt or a lost update over `applyFloor`'s compare-and-swap — a class
  // the zero-sum check cannot see, because ADJUST, GRANT and FLOOR are all
  // deliberately excluded from the profit reasons.
  const booksDrift = boardSum + onTheTable;
  const ledgerDrift = circulation - ledgerTotal;
  const balanced = booksDrift === 0 && ledgerDrift === 0;
  const negative = accounts.filter((a) => a.balance < 0);

  const rows = pots.map((p) => {
    // The same pure function the room and the pinned Discord board price a
    // live pot with — one arithmetic, three surfaces.
    const view = potView(
      p.bets.map((b) => ({
        userId: b.userId,
        team: b.team,
        stake: b.stake,
        placedAtMs: b.placedAt.getTime(),
      })),
    );
    // An ACTIVE lobby's pot is not late — it IS the live pot, and there is
    // nothing to settle it against until the game produces a result.
    const live = (INHOUSE_ACTIVE_STATUSES as string[]).includes(p.status);
    const age = now - p.updatedAt.getTime();
    return {
      id: p.id,
      status: p.status,
      view,
      age,
      live,
      stranded: !live && age > POT_STRANDED_MS,
      total: view.pool1 + view.pool2,
      bettors: p.bets.length,
    };
  });
  const strandedCount = rows.filter((r) => r.stranded).length;

  return (
    <AdminSection
      id="adm-bets"
      title="Inhouse betting"
      subtitle="Cred is play money — it buys nothing and can't be transferred. Check the books, watch for a pot nobody settled, and correct a balance."
    >
      <CardBody className="space-y-4">
        <StatStrip>
          <StatCell label="Accounts funded" value={accounts.length} />
          <StatCell label="Cred in circulation" value={circulation} />
          {/* Deliberately NOT <CredDelta>: green-for-positive is the right
              convention for a player's net profit, and the wrong one here.
              A negative board sum is normal (it is exactly the Cred currently
              staked); the only thing this figure can be good or bad about is
              whether it balances. */}
          <StatCell
            label="Profit board sum"
            value={
              <span className={balanced ? "text-success" : "text-danger"}>
                {boardSum > 0 ? `+${boardSum}` : boardSum}
              </span>
            }
            hint={
              !balanced
                ? "must be 0 — see below"
                : onTheTable > 0
                  ? `${onTheTable} on the table`
                  : "balanced"
            }
          />
        </StatStrip>

        {/* The most valuable number on this card, so it gets a sentence rather
            than a figure alone: a non-zero result is not "someone is winning",
            it is Cred that came from nowhere or went nowhere. */}
        {balanced ? (
          <p className="text-xs text-muted">
            <b className="text-success">The books balance.</b> Betting is
            zero-sum — every Cred a winner takes came off an opposing stake — so
            the profit board sums to exactly 0 once nothing is on the table
            {onTheTable > 0
              ? `, and to −${onTheTable} while that much is staked on a pot that hasn't settled`
              : ""}
            . Balances add up to {circulation} against {ledgerTotal} of recorded
            movement, so every Cred that moved left a receipt.
          </p>
        ) : (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-fg">
            <b>The books do not balance.</b>{" "}
            {booksDrift !== 0 ? (
              <>
                The profit board sums to {boardSum} with {onTheTable} Cred on
                the table, so {booksDrift > 0 ? "+" : ""}
                {booksDrift} Cred has been minted or destroyed — betting is
                zero-sum and this figure can only be 0.{" "}
              </>
            ) : null}
            {ledgerDrift !== 0 ? (
              <>
                Balances add up to {circulation} against {ledgerTotal} of
                recorded movement, a drift of {ledgerDrift > 0 ? "+" : ""}
                {ledgerDrift} — a Cred movement was written without its receipt,
                or a receipt without its movement.{" "}
              </>
            ) : null}
            Don&apos;t correct it away here until you know which path did it: an
            adjustment moves a balance without touching the profit board, so it
            hides this alarm rather than fixing it.
          </p>
        )}

        {negative.length > 0 ? (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-fg">
            <b>
              {negative.length} account
              {negative.length === 1 ? " is" : "s are"} below zero:
            </b>{" "}
            {negative.map((a) => `${a.user.name} (${a.balance})`).join(", ")}.
            Nothing lets a player spend past zero, so this comes from a void
            clawing back winnings they had already re-staked. They can&apos;t
            bet again until it&apos;s repaired — use Adjust Cred below.
          </p>
        ) : null}

        <div>
          <h4 className="mb-2 text-sm font-medium text-muted">
            Pots on the table
          </h4>
          {rows.length === 0 ? (
            <p className="text-sm text-muted">
              Every pot is settled — nothing is outstanding. A pot appears here
              from the first bet of a game until its Cred is paid out, refunded
              or reversed.
            </p>
          ) : (
            <ul className="space-y-2">
              {rows.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-2/40 p-3 text-sm"
                >
                  <Badge
                    tone={r.stranded ? "danger" : r.live ? "info" : "neutral"}
                  >
                    {r.status}
                  </Badge>
                  <span className="min-w-0 flex-1 basis-48 tabular-nums">
                    <b>{r.total} Cred</b> from {r.bettors} bettor
                    {r.bettors === 1 ? "" : "s"}
                    {/* Sides are "team 1/2", never Radiant/Dire: which side
                        plays Radiant isn't known until the game imports, and
                        the pinned board holds the same line. */}
                    {" · "}team 1 {r.view.pool1} · team 2 {r.view.pool2} ·{" "}
                    {r.view.matched} matched
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {ageLabel(r.age)} in this state
                  </span>
                  {r.stranded ? <Badge tone="danger">not settled</Badge> : null}
                </li>
              ))}
            </ul>
          )}
          {strandedCount > 0 ? (
            <p className="mt-2 text-xs text-danger">
              Reload this page before doing anything else:{" "}
              <code>/api/sync</code> fires from every page view, this one
              included, so a working sweeper clears these faster than you can
              read them. Still here after a reload means{" "}
              <code>resolveUnsettledBets</code> is failing — the stakes stay
              debited and nothing is paid out until it lands, so check the
              server logs rather than adjusting balances by hand.
            </p>
          ) : null}
        </div>

        <div>
          <h4 className="mb-2 text-sm font-medium text-muted">
            Correct a balance
          </h4>
          {accounts.length === 0 ? (
            <p className="text-sm text-muted">
              Nobody has bet yet. A Cred account is written by a player&apos;s
              first wager — until then everyone is on the opening{" "}
              {INHOUSE_BETS.START_BALANCE} Cred and there is nothing to correct.
            </p>
          ) : (
            <>
              <ActionForm
                action={adjustCredAction}
                className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              >
                <Field label="Player" htmlFor="credUserId">
                  <select
                    id="credUserId"
                    name="userId"
                    required
                    defaultValue=""
                    className={cn(selectCls, "h-10 w-full")}
                  >
                    <option value="" disabled>
                      Player…
                    </option>
                    {accounts.map((a) => (
                      <option key={a.userId} value={a.userId}>
                        {a.user.name} — {a.balance} Cred
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Cred to add or take away" htmlFor="credDelta">
                  <input
                    id="credDelta"
                    name="delta"
                    type="number"
                    step={1}
                    required
                    placeholder="e.g. 50, or -50"
                    className={cn(inputCls, "min-w-0")}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Why (goes in the ledger)" htmlFor="credNote">
                    <input
                      id="credNote"
                      name="note"
                      required
                      maxLength={200}
                      placeholder="Refunding the pot voided on Tuesday"
                      className={cn(inputCls, "min-w-0")}
                    />
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  {/* SubmitButton, not DangerSubmit. The typed-name barrier is
                      for the five actions with no in-app undo; an adjustment is
                      undone by an equal one in the other direction, and
                      spending the strong barrier here would rebuild exactly the
                      fatigue it exists to break. */}
                  <SubmitButton
                    variant="secondary"
                    size="sm"
                    confirm="Move this player's Cred? It writes a ledger receipt and an admin activity line, and it's reversed by an equal adjustment the other way."
                  >
                    Adjust Cred
                  </SubmitButton>
                </div>
              </ActionForm>
              <p className="mt-2 text-xs text-muted">
                Negative takes Cred away and can&apos;t push anyone below zero;
                a positive amount always lands, which is what repairs a negative
                balance. Adjustments never touch the profit board — the ladder
                ranks what a player took off other players, never what an admin
                handed them.
              </p>
            </>
          )}
        </div>

        {adjustments.length > 0 ? (
          <div>
            <h4 className="mb-2 text-sm font-medium text-muted">
              Recent corrections
            </h4>
            {/* Read from the LEDGER rather than AdminAction: `logAdminAction`
                has no name in hand, so its summary identifies the player by
                cuid, while the ledger row carries userId, the amount and the
                note as real columns. The actor is one card down in Recent
                admin activity, which logs every adjustment too. */}
            <ul className="space-y-1.5">
              {adjustments.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border border-line px-3 py-1.5 text-sm"
                >
                  <span className="font-medium">
                    {nameOf.get(a.userId) ?? a.userId}
                  </span>
                  <CredDelta n={a.delta} />
                  <span className="min-w-0 flex-1 text-muted">
                    {a.note || "(no reason recorded)"}
                  </span>
                  <LocalTime
                    ts={a.createdAt.getTime()}
                    variant="short"
                    initial={formatMatchTime(a.createdAt, "short")}
                    className="shrink-0 text-xs text-muted tabular-nums"
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </AdminSection>
  );
}

/**
 * WHAT DID I PRESS? Until now nothing in the app could answer that: no model
 * carried an actor column, and Discord announces signups, sales and results but
 * is silent on every destructive action. Streamed behind Suspense like the
 * Discord card — it is a diagnostic, and must never delay the controls above it.
 */
async function AdminActivity() {
  const rows = await recentAdminActions(40);
  return (
    <AdminSection
      id="adm-activity"
      title="Recent admin activity"
      subtitle="Who changed what, newest first — the record of destructive actions."
    >
      <CardBody>
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
                  initial={formatMatchTime(r.createdAt, "short")}
                  className="shrink-0 text-xs text-muted tabular-nums"
                />
              </li>
            ))}
          </ul>
        )}
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

function NewsControls({ posts }: { posts: NewsPostRow[] }) {
  return (
    <AdminSection
      id="adm-news"
      title="League news"
      subtitle="Announcements shown on the dashboard and /news — also posted to Discord."
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
                      initial={formatMatchTime(p.createdAt, "short")}
                    />
                    {p.author ? ` · ${p.author.name}` : ""}
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
                    confirm={`Delete "${p.title}"? This can't be undone.`}
                  >
                    Delete
                  </SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </AdminSection>
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
            <LocalTime
              ts={r.proposedTime.getTime()}
              variant="full"
              initial={formatMatchTime(r.proposedTime, "full")}
            />
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
