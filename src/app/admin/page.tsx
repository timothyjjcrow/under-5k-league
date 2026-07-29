import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason, capacityInfo } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import {
  AUTO_SYNC,
  DRAFT_STATUS,
  MATCH_PHASE,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_PHASE_ORDER,
  SEASON_STATUS,
} from "@/lib/constants";
import { nextAutoSyncAt } from "@/lib/result-sync";
import {
  createSeason,
  setSeasonPhase,
  addCaptain,
  removeCaptain,
  randomizeDraftOrder,
  startDraft,
  generateSchedule,
  startPlayoffs,
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
  transferCaptaincy,
  reopenMatch,
  reinstateSignup,
  setDraftSettings,
} from "@/app/actions/admin";
import { cancelReschedule } from "@/app/actions/reschedule";
import {
  createNewsPost,
  deleteNewsPost,
  toggleNewsPin,
} from "@/app/actions/news";
import { sortNews, NEWS_LIMITS } from "@/lib/news";
import { formatMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { adminNextStep } from "@/lib/admin-next-step";
import { recentAdminActions } from "@/lib/admin-log";
import { DangerSubmit } from "@/components/danger-submit";
import { cn } from "@/lib/utils";
import { maskWebhookUrl } from "@/lib/discord";
import {
  getInhouseBoardStatus,
  type InhouseBoardStatus,
} from "@/lib/inhouse-board-service";
import {
  getDiscordReach,
  getPingHealth,
  type PingHealth,
} from "@/lib/discord-roles";
import {
  pickBracketSize,
  roundName,
  slotRound,
  groupPlayoffRounds,
} from "@/lib/schedule";
import { mmrWeightedBudgets } from "@/lib/draft";
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
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  PageTitle,
  PlayerLink,
  Stat,
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

const PHASE_LABEL: Record<string, string> = {
  SIGNUPS: "Signups",
  DRAFT: "Draft",
  REGULAR_SEASON: "Regular season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Complete",
};

export default async function AdminPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin");
  if (user.role !== "ADMIN") redirect("/");

  const season = await getActiveSeason();

  const data = season
    ? await loadSeasonAdminData(season.id)
    : null;
  const newsPosts = sortNews(
    await prisma.newsPost.findMany({
      include: { author: { select: { name: true } } },
    }),
  );

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
                { id: "adm-discord", label: "Discord" },
              ]
            : []),
          { id: "adm-activity", label: "Activity" },
          { id: "adm-news", label: "News" },
          { id: "adm-security", label: "Security" },
          { id: "adm-new-season", label: "New season" },
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
          {/* Streamed, because this card is the ONLY thing on the page that
              talks to Discord: getPingHealth alone is three sequential calls
              at a 4s timeout each, and getInhouseBoardStatus drags a
              full-history Elo scan behind it. Awaited inline they held up the
              whole admin page — Pause draft and Record result included — and
              did it worst exactly when Discord was broken, which is when an
              admin opens this page. */}
          <Suspense fallback={<CardSkeleton rows={6} />}>
            <DiscordSection seasonId={season.id} />
          </Suspense>
        </>
      ) : (
        <Card>
          <CardBody className="text-muted">
            No active season. Create one below to get started.
          </CardBody>
        </Card>
      )}

      <AdminAnchor id="adm-activity">
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <AdminActivity />
        </Suspense>
      </AdminAnchor>

      <NewsControls posts={newsPosts} />

      <SecurityControls />

      <AdminSection
        id="adm-new-season"
        title="Create a new season"
        subtitle="This archives the current season and opens fresh signups."
        // Open when there is nothing to run yet, AND once the season is over —
        // COMPLETE is the one phase where this IS the next action, and leaving
        // it collapsed at the bottom of the longest page in the app made the
        // end of a season a dead end. Otherwise it stays folded: a once-a-season
        // form should not sit open above everything an admin uses weekly.
        defaultOpen={!season || season.status === SEASON_STATUS.COMPLETE}
      >
        <CardBody>
          <ActionForm
            action={createSeason}
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
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
                defaultValue={5}
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
                defaultValue={4}
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
                defaultValue={100}
                min={10}
                className={inputCls}
              />
            </Field>
            <Field label="Soft MMR limit (0 = none)" htmlFor="maxMmr">
              <input
                id="maxMmr"
                name="maxMmr"
                type="number"
                defaultValue={SOFT_MMR_LIMIT}
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
                defaultValue={20}
                min={0}
                max={50}
                className={inputCls}
              />
            </Field>
            <div className="sm:col-span-2 lg:col-span-4">
              <SubmitButton
                variant="accent"
                confirm="This archives the current season and opens a new one. Continue?"
              >
                Create season
              </SubmitButton>
            </div>
          </ActionForm>
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
  // (reachable by clicking the Draft phase button before Start draft) the forms
  // must stay hidden, or the $0 free-agent path bypasses the auction entirely.
  if (
    season.status === "DRAFT" &&
    data.draft?.status !== DRAFT_STATUS.COMPLETE
  ) {
    return false;
  }
  const rosteredIds = new Set(
    data.teams.flatMap((t) => t.members.map((m) => m.userId)),
  );
  const canSign =
    data.players.some((p) => !rosteredIds.has(p.userId)) &&
    data.teams.some((t) => t.members.length < season.teamSize);
  const releasable = data.teams.some((t) =>
    t.members.some((m) => !m.isCaptain),
  );
  const promotable = data.standins.some(
    (s) => s.type === REGISTRATION_TYPE.STANDIN && !rosteredIds.has(s.userId),
  );
  // A SHORT team keeps the card open even when nothing can be done about it
  // yet: "this team is a player down" is the thing the admin most needs to
  // know, and it used to disappear precisely when no free agent existed.
  const short = data.teams.some((t) => t.members.length < season.teamSize);
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
            { type: "PLAYER", user: { teamMemberships: { none: { seasonId } } } },
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
        include: { games: true },
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
  const playoffArchive = await getSetting(`playoffGamesArchive:${seasonId}`);
  // What a schedule REGENERATE would destroy. These rows hang off a fixture id
  // and cascade with it, and none of them is archived anywhere — so the confirm
  // has to be able to state them BEFORE the click, not just the toast after.
  const regularWhere = { match: { seasonId, phase: MATCH_PHASE.REGULAR } };
  const [rsvps, picks, covers, proposals] = await Promise.all([
    prisma.matchAvailability.count({ where: regularWhere }),
    prisma.prediction.count({ where: regularWhere }),
    prisma.standinAssignment.count({ where: regularWhere }),
    prisma.rescheduleRequest.count({
      where: { ...regularWhere, status: "PENDING" },
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
  };
}

type AdminData = Awaited<ReturnType<typeof loadSeasonAdminData>>;
type Season = NonNullable<Awaited<ReturnType<typeof getActiveSeason>>>;

function SeasonControls({
  season,
  data,
}: {
  season: Season;
  data: AdminData;
}) {
  const configLocked =
    !!data.draft && data.draft.status !== DRAFT_STATUS.NOT_STARTED;
  const cap = capacityInfo(season, data.players.length);
  const regular = data.matches.filter((m) => m.phase === "REGULAR");
  const playoff = data.matches.filter((m) => m.phase !== "REGULAR");
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
    hasChampion: !!season.championTeamId,
  });
  return (
    <Card>
      <CardHeader
        title={`${season.name} — phase control`}
        subtitle="Move the season through its phases. Each phase reveals its tools."
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

        <div className="flex flex-wrap items-center gap-2">
          {SEASON_PHASE_ORDER.map((phase) => (
            <ActionForm key={phase} action={setSeasonPhase}>
              <input type="hidden" name="phase" value={phase} />
              <SubmitButton
                variant={season.status === phase ? "primary" : "secondary"}
                size="sm"
                confirm={
                  season.status === phase
                    ? undefined
                    : `Move the season to ${PHASE_LABEL[phase]}? Nav links and tools change immediately for everyone.`
                }
              >
                {PHASE_LABEL[phase]}
              </SubmitButton>
            </ActionForm>
          ))}
        </div>
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
        <form
          action={renameSeason}
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
        </form>
        <form
          action={setMaxMmr}
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
        </form>
        {/* Editable until the auction starts. These used to be write-once at
            Create season, so changing your mind about team size or budget meant
            creating a NEW season and orphaning every signup so far. */}
        <ActionForm
          action={setDraftSettings}
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
              ? "locked — the auction has started"
              : "applied when the draft starts"}
          </span>
        </ActionForm>
        <form
          action={setMatchSchedule}
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
        </form>
        <form
          action={setSeriesLengths}
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
        </form>
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
  const captainUserIds = new Set(data.teams.map((t) => t.captainId));
  const nonCaptains = data.players.filter(
    (p) => !captainUserIds.has(p.userId),
  );
  // Captains are ACTIVE PLAYER registrations too (addCaptain requires it), so
  // their row is in `data.players` — it is only filtered out of the list above.
  const captainReg = new Map(data.players.map((p) => [p.userId, p]));
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
  const poolCount = data.players.filter((p) => !rosteredIds.has(p.userId)).length;
  const openSeats = captainCount * (season.teamSize - 1);
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
    " is refused once any result has been recorded.";

  return (
    <Card>
      <CardHeader
        title="Captains & draft"
        subtitle="Designate captains, set the order, then start the auction."
        action={
          /* flex-wrap like every other row in this file: this header holds up to
             six controls (sync ranks/avatars, randomize, start, pause/resume,
             undo, abort) and without wrapping they pushed /admin past a phone —
             caught by the mobile tripwire on CI, whose fonts are a few px wider
             than macOS's, so it read as a 7px page scroll. */
          <div className="flex flex-wrap justify-end gap-2">
            <ActionForm action={syncPlayerRanks}>
              <SubmitButton variant="secondary" size="sm">
                Sync ranks
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
            {!draftStarted ? (
              <>
                <ActionForm action={randomizeDraftOrder}>
                  <SubmitButton variant="secondary" size="sm">
                    Randomize order
                  </SubmitButton>
                </ActionForm>
                <ActionForm action={startDraft}>
                  <SubmitButton
                    variant="accent"
                    size="sm"
                    disabled={
                      data.teams.length < 2 ||
                      (season.status !== SEASON_STATUS.SIGNUPS &&
                        season.status !== SEASON_STATUS.DRAFT)
                    }
                    confirm={startConfirm}
                  >
                    Start draft
                  </SubmitButton>
                </ActionForm>
              </>
            ) : null}
            {draftLive ? (
              <ActionForm action={pauseDraftAction}>
                <SubmitButton variant="secondary" size="sm">
                  Pause auction
                </SubmitButton>
              </ActionForm>
            ) : null}
            {data.draft?.status === "PAUSED" ? (
              <ActionForm action={resumeDraftAction}>
                <SubmitButton variant="accent" size="sm">
                  Resume auction
                </SubmitButton>
              </ActionForm>
            ) : null}
            {/* Draft phase only — after that the newest non-captain roster row
                is a free-agent signing, not an auction sale, and re-opening the
                auction mid-season lets the stalled-nomination resolver
                auto-draft someone onto that team. The action refuses too. */}
            {draftStarted && season.status === SEASON_STATUS.DRAFT ? (
              <ActionForm action={undoLastSaleAction}>
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
              <ActionForm action={abortDraftAction}>
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
                      ? `All ${boughtCount} drafted player(s) go back to the pool and every team is refunded — the rosters and prices from this auction are not recorded anywhere and cannot be restored.`
                      : "The auction is reset to not-started.",
                    "The season drops back to Signups, so players can register again.",
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
        {!draftStarted ? (
          <ActionForm
            action={setDraftNight}
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
        {season.status === "SIGNUPS" && data.teams.length >= 2 ? (
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
          <h4 className="mb-2 text-sm font-medium text-muted">
            Captains ({data.teams.length})
          </h4>
          <div className="space-y-2">
            {data.teams.length === 0 ? (
              <p className="text-sm text-muted">No captains yet.</p>
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
                  (season.teamSize - 1),
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
                        <Link
                          href={`/teams/${t.id}`}
                          className="min-w-0 truncate hover:text-info hover:underline"
                        >
                          {t.name}
                        </Link>
                        <Badge tone="accent" className="shrink-0">
                          ${draftStarted ? t.budget : projected.get(t.id)}
                        </Badge>
                      </span>
                      {!draftStarted ? (
                        <ActionForm action={removeCaptain}>
                          <input type="hidden" name="teamId" value={t.id} />
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
                                ? [`${collateral.rsvps} check-in(s) go with them.`]
                                : []),
                              ...(regularCount > 0 && collateral.picks
                                ? [`${collateral.picks} pick'em pick(s) go with them.`]
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
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                        ✎ Rename team
                      </summary>
                      <ActionForm
                        action={renameTeam}
                        className="mt-1.5 flex flex-wrap items-center gap-2"
                        hidden={{ teamId: t.id }}
                      >
                        <input
                          name="name"
                          type="text"
                          maxLength={60}
                          defaultValue={t.name}
                          aria-label={`New name for ${t.name}`}
                          className="h-8 w-52 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-sm"
                        />
                        <SubmitButton variant="secondary" size="sm">
                          Save name
                        </SubmitButton>
                      </ActionForm>
                    </details>
                    {/* A captain's MMR is the ONE number that has to be right
                        before the auction: mmrWeightedBudgets interpolates
                        across the whole captain pool, so a single typo moves the
                        pool's min/max and skews EVERY team's budget, not just
                        this one's. This control lived only in the non-captain
                        list below, so designating someone captain — the natural
                        FIRST step — put their MMR permanently out of reach, and
                        setRegistrationMmr never refused captains: it was a
                        missing render, not a rule. */}
                    {season.status === "SIGNUPS" && captainReg.get(t.captainId) ? (
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
                    {draftStarted &&
                    t.members.some((m) => m.userId !== t.captainId) ? (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                          ⇄ Hand over captaincy
                        </summary>
                        <ActionForm
                          action={transferCaptaincy}
                          className="mt-1.5 flex flex-wrap items-center gap-2"
                          hidden={{ teamId: t.id }}
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
                          keeps its own reschedule, standin and
                          result-reporting controls.
                        </p>
                      </details>
                    ) : null}
                  </div>
                ));
              })()
            )}
          </div>
          {!draftStarted &&
          data.teams.length >= 2 &&
          season.budgetMmrWeight > 0 ? (
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
          <h4 className="mb-2 text-sm font-medium text-muted">
            Eligible players
          </h4>
          <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
            {nonCaptains.length === 0 ? (
              <p className="text-sm text-muted">No other players.</p>
            ) : (
              nonCaptains.map((p) => (
                <div
                  key={p.id}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <Avatar name={p.user.name} src={p.user.avatar} size={22} />
                      <PlayerLink
                        userId={p.userId}
                        className="min-w-0 truncate"
                      >
                        {p.user.name}
                      </PlayerLink>
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
                      {!draftStarted ? (
                        <ActionForm action={addCaptain}>
                          <input type="hidden" name="userId" value={p.userId} />
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
                    </span>
                  </div>
                  {season.status === "SIGNUPS" ? (
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
          {/* Removal is sticky (the player can't re-add themselves from /me),
              so it has to be undoable from here. */}
          {data.removed.length > 0 ? (
            <div className="mt-4 border-t border-line/60 pt-3">
              <h5 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                Removed signups ({data.removed.length})
              </h5>
              <div className="space-y-1.5">
                {data.removed.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5 text-sm"
                  >
                    <span className="min-w-0 truncate text-muted">
                      {r.user.name}
                    </span>
                    <ActionForm
                      action={reinstateSignup}
                      hidden={{ registrationId: r.id }}
                    >
                      <SubmitButton variant="ghost" size="sm">
                        reinstate
                      </SubmitButton>
                    </ActionForm>
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
  return (
    <Card>
      <CardHeader
        title="Schedule & results"
        subtitle="Generate the round-robin and enter weekly scores."
        action={
          <ActionForm
            action={generateSchedule}
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
                disabled={data.teams.length < 2}
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
                    ? [`${collateral.proposals} open reschedule proposal(s) are cancelled.`]
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
                disabled={data.teams.length < 2}
                confirm="Generate the regular-season schedule?"
              >
                Generate schedule
              </SubmitButton>
            )}
          </ActionForm>
        }
      />
      <CardBody>
        {data.matches.length === 0 ? (
          <p className="text-sm text-muted">
            No matches yet. Generate the schedule after the draft.
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
              Enter scores manually, or fetch the real games from Dota (OpenDota).
              Auto-fetch needs players to have &ldquo;Expose Public Match
              Data&rdquo; enabled.
            </p>
            <PendingReschedules seasonId={season.id} teams={data.teams} />
            {(() => {
              const openWeeks = [
                ...new Set(
                  data.matches
                    .filter((m) => m.status !== "COMPLETED")
                    .map((m) => m.week),
                ),
              ].sort((a, b) => a - b);
              return openWeeks.length > 0 ? (
                <ActionForm
                  action={setWeekNight}
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
                    confirm={`Move this week's match night?\n\nEvery unplayed match in the week is retimed and its check-ins are cleared — players will have to check in again. If "shift later weeks too" is ticked, every later scheduled week moves by the same amount and loses its check-ins as well.`}
                  >
                    Move night
                  </SubmitButton>
                  <span className="w-full text-muted">
                    Retimes every unplayed match in the week and clears their
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
              const playoff = data.matches.filter(
                (m) => m.phase !== "REGULAR",
              );
              if (playoff.length === 0) return null;
              const { totalRounds } = groupPlayoffRounds(playoff);
              const pending = playoff.filter(
                (m) => m.status !== "COMPLETED",
              ).length;
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
}: {
  m: AdminData["matches"][number];
  teams: AdminData["teams"];
  label: React.ReactNode;
}) {
  const home = teams.find((t) => t.id === m.homeTeamId);
  const away = teams.find((t) => t.id === m.awayTeamId);
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <ActionForm
        action={recordResult}
        className="flex flex-wrap items-center gap-2 text-sm"
        hidden={{ matchId: m.id }}
      >
        {label}
        <span className="flex-1 text-right">{home?.name ?? "?"}</span>
        <input
          name="homeScore"
          type="number"
          min={0}
          max={99}
          defaultValue={m.homeScore}
          className="h-8 w-14 rounded-md border border-line bg-surface-2/50 px-2 text-center"
        />
        <span className="text-muted">–</span>
        <input
          name="awayScore"
          type="number"
          min={0}
          max={99}
          defaultValue={m.awayScore}
          className="h-8 w-14 rounded-md border border-line bg-surface-2/50 px-2 text-center"
        />
        <span className="flex-1">{away?.name ?? "?"}</span>
        {m.status === "COMPLETED" ? (
          <Badge tone="success">final</Badge>
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
          confirm={`Record the score in the boxes as the FINAL result for ${home?.name ?? "home"} v ${away?.name ?? "away"}?\n\nCheck the two score boxes first. Marking a match final stops automatic result import for it${
            m.phase !== "REGULAR" ? " and advances the playoff bracket" : ""
          }, and "Reopen for import" only undoes it while no games are attached.`}
        >
          Save as final
        </SubmitButton>
      </ActionForm>

      {/* A hand-entered score marks the match COMPLETED with zero games, and
          every import path then refuses it forever — so a stray Save (these
          boxes default to 0 and Enter submits) used to cost the series its box
          score permanently. This is the way back. */}
      {m.status === "COMPLETED" && m.games.length === 0 ? (
        <ActionForm
          action={reopenMatch}
          className="flex flex-wrap items-center gap-2 text-xs text-muted"
          hidden={{ matchId: m.id }}
        >
          <span>
            Recorded by hand — no games imported.
          </span>
          <SubmitButton
            variant="ghost"
            size="sm"
            confirm="Reopen this match so its real games can be imported? The hand-entered score is cleared."
          >
            Reopen for import
          </SubmitButton>
        </ActionForm>
      ) : null}

      <ActionForm
        action={setMatchTime}
        className="flex flex-wrap items-center gap-2 text-xs text-muted"
      >
        <input type="hidden" name="matchId" value={m.id} />
        <span>Scheduled</span>
        <LocalDatetimeField
          name="scheduledAt"
          tsName="scheduledAtTs"
          defaultTs={m.scheduledAt?.getTime()}
          className="h-8 rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg"
        />
        <SubmitButton variant="secondary" size="sm">
          Set time
        </SubmitButton>
      </ActionForm>

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
                  Game {g.dotaMatchId} ·{" "}
                  {winner ? `${winner.name} won` : "tie"} ·{" "}
                  {Math.floor(g.durationSecs / 60)}m
                </a>
                <ActionForm action={removeGame}>
                  <input type="hidden" name="gameId" value={g.id} />
                  <SubmitButton
                    variant="ghost"
                    size="sm"
                    className="text-danger hover:underline"
                    confirm="Remove this imported game and recompute the series?"
                  >
                    remove
                  </SubmitButton>
                </ActionForm>
              </li>
            );
          })}
        </ul>
      ) : null}

      <MatchImportControls
        matchId={m.id}
        importAction={importGameAction}
        detectAction={autoDetectAction}
      />
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
  const bracketSize = pickBracketSize(data.teams.length);
  const status = regularSeasonStatus(data.matches);
  const champion = season.championTeamId
    ? data.teams.find((t) => t.id === season.championTeamId)
    : null;
  // Reset is the only correction path once a round has advanced, and Game
  // cascades with Match — so name what it actually costs rather than the old
  // "Existing playoff games are removed", which reads like housekeeping.
  const playoffGameCount = playoffMatches.reduce(
    (n, m) => n + m.games.length,
    0,
  );

  return (
    <Card>
      <CardHeader
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
            <ActionForm action={startPlayoffs}>
              <DangerSubmit
                token={season.name}
                disabled={data.teams.length < 2}
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
                    ? ["The champion is un-crowned and the season reopens into Playoffs."]
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
          ) : (
            <ActionForm action={startPlayoffs}>
              <SubmitButton
                variant="secondary"
                size="sm"
                disabled={data.teams.length < 2}
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
        {status.pending > 0 && playoffMatches.length === 0 ? (
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
            ⚠ {status.pending} regular-season result
            {status.pending === 1 ? "" : "s"} still needed — the playoffs are
            locked until every match is entered (weeks{" "}
            {status.pendingWeeks.join(", ")}).
          </div>
        ) : null}
        {playoffMatches.length > 0 ? (
          <p className="text-muted">
            {playoffMatches.length} playoff match(es) created. Enter scores in
            &ldquo;Schedule &amp; results&rdquo; above — the bracket advances and
            crowns the champion automatically.
          </p>
        ) : (
          <p className="text-muted">
            {data.teams.length < 2
              ? "Add at least two captains before a bracket can be seeded."
              : `Will seed the top ${bracketSize} of ${data.teams.length} team(s) by standings. Start this after the regular season is finished.`}
          </p>
        )}
        {data.playoffArchive.length > 0 ? (
          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted hover:text-fg">
              {data.playoffArchive.length} playoff game(s) removed by a bracket
              reset — OpenDota IDs kept for re-import
            </summary>
            <p className="mt-2 text-xs text-muted">
              Paste these into the &ldquo;Match ID or URL&rdquo; box on the matching
              fixture in Schedule &amp; results and press &ldquo;Add game&rdquo; to
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
          Series lengths (regular / playoffs / final) are set in the phase-control
          panel above.
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
        title="Standin assignments"
        subtitle="Slot a standin in for a player who can't make a match."
      />
      <CardBody className="space-y-3">
        {/* The "no standins registered" branch used to swallow the WHOLE card,
            which hid the uncovered-OUT alerts inside it — the diagnostic was
            behind the cure. An admin with players declaring OUT and nobody
            registered as cover saw a blank card saying nothing was wrong, which
            is exactly the night they most needed the list. The note now rides
            ABOVE the match blocks instead of replacing them. */}
        {data.standins.length === 0 && upcoming.length > 0 ? (
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
                      label={
                        <Link
                          href={`/matches/${m.id}`}
                          className={textLink()}
                        >
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
}: {
  m: AdminData["matches"][number];
  data: AdminData;
  assignments: AdminData["assignments"];
  teamName: Map<string, string>;
  label: React.ReactNode;
  teamSize: number;
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
          [home, away].flatMap(
            (t) => t?.members.map((mm) => mm.userId) ?? [],
          ),
        );
        const out = data.outRsvps.filter(
          (r) => r.matchId === m.id && rosterIds.has(r.userId),
        );
        const covered = new Set(
          asg.map((a) => a.replacingUserId).filter(Boolean),
        );
        const needing = out.filter((r) => !covered.has(r.userId));
        return needing.length > 0 ? (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs">
            ✗ Can&apos;t make it:{" "}
            <b>{needing.map((r) => r.user.name).join(", ")}</b> — assign a
            standin below.
          </div>
        ) : null;
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
          {data.standins.map((s) => (
            <option key={s.userId} value={s.userId}>
              {s.user.name}
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
                <option key={`seat-${team.id}`} value={`seat:${team.id}`}>
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
  if (
    season.status !== "REGULAR_SEASON" &&
    season.status !== "PLAYOFFS"
  ) {
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
      getSetting(`leagueSyncSkip:${season.id}`),
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
        title="Automatic result sync"
        subtitle="What the OpenDota watcher is doing right now — nobody should need the manual buttons unless something here looks stuck."
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
                    <Badge tone="accent">LIVE {m.homeScore}–{m.awayScore}</Badge>
                  ) : null}
                  <span className="text-xs text-muted">
                    {m.autoSyncedAt ? (
                      <>
                        scanned{" "}
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
                    ) : (
                      "not scanned yet — next ping picks it up"
                    )}
                  </span>
                  {backedOff ? (
                    <Badge tone="danger">
                      backed off — check players&apos; public match data or
                      import manually
                    </Badge>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {privatePlayers.length > 0 ? (
          <p className="text-xs text-danger">
            Private match data (roster scans can&apos;t see their games):{" "}
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
            <span className="font-medium text-fg">Medal backfill:</span>{" "}
            fetch ranked medals for every account that doesn&apos;t have one yet
            — including people who signed in but never joined a season. Skips
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

  const rosteredIds = new Set(
    data.teams.flatMap((t) => t.members.map((m) => m.userId)),
  );
  const freeAgents = data.players.filter((p) => !rosteredIds.has(p.userId));
  const shortTeams = data.teams.filter(
    (t) => t.members.length < season.teamSize,
  );
  const canSign = freeAgents.length > 0 && shortTeams.length > 0;
  const releasable = data.teams.flatMap((t) =>
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
        title="Roster moves"
        subtitle="Sign free agents onto short teams; release players who've left; promote late-joining standins to full players."
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
            <select name="userId" required defaultValue="" aria-label="Free agent to sign" className={selectCls}>
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
            <select name="teamId" required defaultValue="" aria-label="Team with an open seat" className={selectCls}>
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
              confirm="Promote to full player? They leave the standin pool and can be signed onto a roster."
            >
              Promote to player
            </SubmitButton>
            <span className="text-xs text-muted">
              then sign them with the form above — it appears once a team is
              short and a free agent exists
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
        <p className="text-xs text-muted">
          Signings and releases last the rest of the season (unlike standins,
          which cover a single match) and are announced in Discord. Both are
          reversible from this card — release undoes a signing and refunds it,
          and a released player goes back to the free-agent list. Captains
          can&apos;t be released; hand over captaincy first.
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * The denominator under every notification the league sends. Personal
 * mentions, the un-RSVP'd ping and the opt-in role all silently skip anyone
 * who never linked Discord — so this is the number that says whether that
 * machinery reaches the league or a handful of people.
 */
function DiscordReachLine({
  reach,
}: {
  reach: { registered: number; linked: number; unlinkedNames: string[] };
}) {
  if (reach.registered === 0) return null;
  const pct = Math.round((reach.linked / reach.registered) * 100);
  // Below half, the useful next move is chasing links rather than building
  // more notification machinery — so say so rather than just showing a number.
  const thin = pct < 50;
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
          Not linked: {reach.unlinkedNames.join(", ")}
          {reach.registered - reach.linked > reach.unlinkedNames.length
            ? ` +${reach.registered - reach.linked - reach.unlinkedNames.length} more`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The opt-in has four independent ways to be half-configured and three are
 * invisible until a player clicks the button and gets an error. This says
 * which one, in the order they have to be fixed.
 */
function PingHealthLines({ health }: { health: PingHealth }) {
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
      label: health.botName ? `Bot in server (${health.botName})` : "Bot in server",
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
            <span className="text-muted">Auto-join on link:</span>
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
async function DiscordSection({ seasonId }: { seasonId: string }) {
  // Never hand the raw webhook URL to the client — it's a bearer credential.
  // Resolve it server-side only to derive a boolean + a masked fingerprint.
  const dbWebhook = (await getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL)) ?? "";
  const activeWebhook = dbWebhook || process.env.DISCORD_WEBHOOK_URL || "";
  const [board, pingHealth, discordReach] = await Promise.all([
    getInhouseBoardStatus(),
    getPingHealth(),
    getDiscordReach(seasonId),
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
    />
  );
}

function DiscordControls({
  status,
  board,
  pingHealth,
  discordReach,
}: {
  status: { configured: boolean; masked: string; envManaged: boolean };
  board: InhouseBoardStatus;
  pingHealth: PingHealth;
  discordReach: { registered: number; linked: number; unlinkedNames: string[] };
}) {
  const { configured, masked, envManaged } = status;
  return (
    <AdminSection
      id="adm-discord"
      title="Discord notifications"
      subtitle="Announce signups, the draft, results, playoffs, and the champion in your Discord."
    >
      <CardBody className="space-y-3">
        {/* Moved out of the card header: a button inside a <summary> toggles
            the disclosure instead of submitting. */}
        <div className="flex justify-end">
          <ActionForm action={testDiscordWebhook}>
            <SubmitButton variant="secondary" size="sm" disabled={!configured}>
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
          In Discord: <b>Server Settings → Integrations → Webhooks → New
          Webhook</b>, pick the announcements channel, copy the URL and paste it
          here. For security the saved URL is never shown again — paste a new one
          to replace it, or Remove to turn announcements off.
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
              <SubmitButton variant="ghost" size="sm">
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
                <b>Alerts currently share the board&apos;s channel.</b> The board
                is read at a glance from the bottom of its channel, so every
                ping and result pushes it out of view. Make a webhook in a
                separate channel (e.g. <b>#inhouse-chat</b>) and paste it here to
                keep the board channel board-only.
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

          <PingHealthLines health={pingHealth} />
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
            A Discord webhook only ever posts to the channel it was made in. Make
            one in <b>#inhouse</b> and paste it here to send the queue board,
            &ldquo;match found&rdquo;, the queue ping and inhouse results there —
            leaving signups, draft night and match results in the channel above.
            Leave this blank and everything shares one channel.
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
                  confirm="Delete the queue board message from Discord?"
                >
                  Remove board
                </SubmitButton>
              </ActionForm>
            ) : (
              <ActionForm action={postInhouseBoard}>
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  // Gated on the INHOUSE webhook, which is what the board
                  // actually posts through — a league that configured only the
                  // inhouse one had a working board behind a disabled button.
                  disabled={!configured && !board.separateChannel}
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
            The separate queue ping (fired once the queue reaches 4 players)
            is what actually alerts people; this board just shows the state.
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
            <Link
              href={`/matches/${r.matchId}`}
              className={textLink()}
            >
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
          <ActionForm
            action={cancelReschedule}
            hidden={{ requestId: r.id }}
          >
            <SubmitButton variant="secondary" size="sm">
              Clear
            </SubmitButton>
          </ActionForm>
        </div>
      ))}
    </div>
  );
}
