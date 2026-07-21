import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason, capacityInfo } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { AUTO_SYNC, SEASON_PHASE_ORDER } from "@/lib/constants";
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
  revokeAllSessions,
  signFreeAgent,
  releasePlayer,
  importGameAction,
  autoDetectAction,
  setDraftNight,
  promoteStandinToPlayer,
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
import { maskWebhookUrl } from "@/lib/discord";
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
  PageTitle,
  PlayerLink,
  Stat,
  buttonClasses,
} from "@/components/ui";

export const metadata = { title: "Admin" };

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
  // Never hand the raw webhook URL to the client — it's a bearer credential.
  // Resolve it server-side only to derive a boolean + a masked fingerprint.
  const dbWebhook = (await getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL)) ?? "";
  const activeWebhook = dbWebhook || process.env.DISCORD_WEBHOOK_URL || "";
  const discordStatus = {
    configured: !!activeWebhook,
    masked: maskWebhookUrl(activeWebhook),
    // Set only via env, not the DB — Remove (which clears the DB key) can't
    // touch it, so we hide that button and say where it lives.
    envManaged: !dbWebhook && !!process.env.DISCORD_WEBHOOK_URL,
  };
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

      {season && data ? (
        <>
          <SeasonControls season={season} data={data} />
          <CaptainControls season={season} data={data} />
          <ScheduleControls season={season} data={data} />
          <PlayoffControls season={season} data={data} />
          <RosterMoves season={season} data={data} />
          <StandinControls data={data} />
          <LeagueControls season={season} />
          <AutoSyncHealth season={season} />
          <DiscordControls status={discordStatus} />
        </>
      ) : (
        <Card>
          <CardBody className="text-muted">
            No active season. Create one below to get started.
          </CardBody>
        </Card>
      )}

      <NewsControls posts={newsPosts} />

      <SecurityControls />

      <Card>
        <CardHeader
          title="Create a new season"
          subtitle="This archives the current season and opens fresh signups."
        />
        <CardBody>
          <ActionForm
            action={createSeason}
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
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
      </Card>
    </div>
  );
}

async function loadSeasonAdminData(seasonId: string) {
  const [players, standins, teams, matches, draft, assignments] =
    await Promise.all([
      prisma.registration.findMany({
        where: { seasonId, status: "ACTIVE", type: "PLAYER" },
        include: { user: true },
        orderBy: [{ wantsCaptain: "desc" }, { mmr: "desc" }],
      }),
      prisma.registration.findMany({
        where: { seasonId, status: "ACTIVE", type: "STANDIN" },
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
  return { players, standins, teams, matches, draft, assignments, outRsvps };
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
  const cap = capacityInfo(season, data.players.length);
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
        <p className="text-xs text-muted">
          Tip: gather players in <b>Signups</b>, assign captains, then{" "}
          <b>Start draft</b> below. After the draft, generate the schedule and
          enter results each week.
        </p>
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
              ? `players over ${season.maxMmr} are reviewed before joining · hard ceiling ${HARD_MMR_CEILING} (no Immortals)`
              : `no soft limit · hard ceiling ${HARD_MMR_CEILING} (no Immortals)`}
          </span>
        </form>
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
          <span className="text-xs text-muted">
            games per match; set before generating the schedule / bracket
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

  return (
    <Card>
      <CardHeader
        title="Captains & draft"
        subtitle="Designate captains, set the order, then start the auction."
        action={
          <div className="flex gap-2">
            <ActionForm action={syncPlayerRanks}>
              <SubmitButton variant="secondary" size="sm">
                Sync ranks
              </SubmitButton>
            </ActionForm>
            <ActionForm action={syncSteamProfiles}>
              <SubmitButton variant="secondary" size="sm">
                Sync avatars
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
                    disabled={data.teams.length < 2}
                    confirm="Start the draft now? Rosters lock to the current captains."
                  >
                    Start draft
                  </SubmitButton>
                </ActionForm>
              </>
            ) : null}
          </div>
        }
      />
      <CardBody className="grid gap-6 md:grid-cols-2">
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
                          <button
                            type="submit"
                            className="shrink-0 text-xs text-danger hover:underline"
                          >
                            remove
                          </button>
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
              <Link href="/teams" className="text-info hover:underline">
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
                          <button
                            type="submit"
                            className="text-xs text-accent hover:underline"
                          >
                            make captain
                          </button>
                        </ActionForm>
                      ) : null}
                      {season.status === "SIGNUPS" ? (
                        <ActionForm
                          action={withdrawSignup}
                          hidden={{ registrationId: p.id }}
                        >
                          <SubmitButton
                            variant="ghost"
                            size="sm"
                            className="text-danger hover:underline"
                            confirm={`Withdraw ${p.user.name}'s signup? They leave the player pool.`}
                          >
                            withdraw
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
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
            <SubmitButton
              variant="secondary"
              size="sm"
              disabled={data.teams.length < 2}
              confirm="Regenerate the schedule? Existing regular-season matches are replaced."
            >
              Generate schedule
            </SubmitButton>
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
                {status.pending > 0
                  ? `⏳ ${pendingResultsMessage(status)} Enter them to keep standings & seeding correct.`
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
                  <SubmitButton variant="secondary" size="sm">
                    Move night
                  </SubmitButton>
                  <span className="w-full text-muted">
                    Retimes every unplayed match in the week; the cascade keeps
                    the weekly rhythm by moving later scheduled weeks by the
                    same amount.
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
                            className="w-14 shrink-0 text-xs text-info hover:underline"
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
                            className="shrink-0 text-xs text-info hover:underline"
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
        <SubmitButton variant="secondary" size="sm">
          Save
        </SubmitButton>
      </ActionForm>

      <form
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
      </form>

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
                  className="text-info hover:underline"
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

  return (
    <Card>
      <CardHeader
        title="Playoffs"
        subtitle="Seed the top teams into a single-elimination bracket."
        action={
          <ActionForm action={startPlayoffs}>
            <SubmitButton
              variant="secondary"
              size="sm"
              disabled={data.teams.length < 2}
              confirm={
                playoffMatches.length > 0
                  ? "Reset the playoff bracket? Existing playoff games are removed."
                  : "Seed and start the playoff bracket?"
              }
            >
              {playoffMatches.length > 0 ? "Reset playoffs" : "Start playoffs"}
            </SubmitButton>
          </ActionForm>
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
            Will seed the top {bracketSize} of {data.teams.length} team(s) by
            standings. Start this after the regular season is finished.
          </p>
        )}
        <p className="text-xs text-muted">
          Series lengths (regular / playoffs / final) are set in the phase-control
          panel above.
        </p>
      </CardBody>
    </Card>
  );
}

function StandinControls({ data }: { data: AdminData }) {
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
        {data.standins.length === 0 ? (
          <p className="text-sm text-muted">No standins have registered yet.</p>
        ) : upcoming.length === 0 ? (
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
                        label={
                          <Link
                            href={`/matches/${m.id}`}
                            className="text-info hover:underline"
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
                      label={
                        <Link
                          href={`/matches/${m.id}`}
                          className="text-info hover:underline"
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
}: {
  m: AdminData["matches"][number];
  data: AdminData;
  assignments: AdminData["assignments"];
  teamName: Map<string, string>;
  label: React.ReactNode;
}) {
  const home = data.teams.find((t) => t.id === m.homeTeamId);
  const away = data.teams.find((t) => t.id === m.awayTeamId);
  const asg = assignments;
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
                {a.standin.name} in for {a.replaced?.name ?? "?"} ·{" "}
                {teamName.get(a.teamId)}
              </span>
              <ActionForm action={removeStandin}>
                <input type="hidden" name="assignmentId" value={a.id} />
                <button
                  type="submit"
                  className="text-danger hover:underline"
                >
                  remove
                </button>
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
          <optgroup label={home?.name ?? "Home"}>
            {home?.members.map((mm) => (
              <option key={mm.userId} value={mm.userId}>
                {mm.user.name}
              </option>
            ))}
          </optgroup>
          <optgroup label={away?.name ?? "Away"}>
            {away?.members.map((mm) => (
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
    <Card>
      <CardHeader
        title="Dota league integration"
        subtitle="Link a Valve league id to auto-import every league game."
        action={
          <ActionForm action={syncLeagueAction}>
            <SubmitButton
              variant="secondary"
              size="sm"
              disabled={!season.dotaLeagueId}
            >
              Sync league games
            </SubmitButton>
          </ActionForm>
        }
      />
      <CardBody className="space-y-3">
        <form action={setLeagueId} className="flex flex-wrap items-end gap-2">
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
        </form>
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
                className="text-info hover:underline"
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
    </Card>
  );
}

// Post-draft roster management: sign free agents onto short teams, release
// players who've left the league (they return to the free-agent pool).
function RosterMoves({ season, data }: { season: Season; data: AdminData }) {
  if (season.status === "SIGNUPS" || season.status === "COMPLETE") return null;

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
  const promotableStandins = data.standins.filter(
    (s) => !rosteredIds.has(s.userId),
  );
  if (!canSign && releasable.length === 0 && promotableStandins.length === 0)
    return null;

  return (
    <Card>
      <CardHeader
        title="Roster moves"
        subtitle="Sign free agents onto short teams; release players who've left; promote late-joining standins to full players."
      />
      <CardBody className="space-y-3">
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
            <SubmitButton variant="secondary" size="sm">
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
              then sign them above — the refill path for late joiners
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
              confirm="Release this player from their roster? They go back to the free-agent pool."
            >
              Release player
            </SubmitButton>
          </ActionForm>
        ) : null}
        <p className="text-xs text-muted">
          Signings and releases are permanent for the season (unlike standins,
          which cover a single match) and are announced in Discord. Captains
          can&apos;t be released.
        </p>
      </CardBody>
    </Card>
  );
}

function DiscordControls({
  status,
}: {
  status: { configured: boolean; masked: string; envManaged: boolean };
}) {
  const { configured, masked, envManaged } = status;
  return (
    <Card>
      <CardHeader
        title="Discord notifications"
        subtitle="Announce signups, the draft, results, playoffs, and the champion in your Discord."
        action={
          <ActionForm action={testDiscordWebhook}>
            <SubmitButton variant="secondary" size="sm" disabled={!configured}>
              Send test message
            </SubmitButton>
          </ActionForm>
        }
      />
      <CardBody className="space-y-3">
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
      </CardBody>
    </Card>
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

function SecurityControls() {
  return (
    <Card>
      <CardHeader
        title="Security"
        subtitle="Break-glass session controls."
      />
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
    </Card>
  );
}

function NewsControls({ posts }: { posts: NewsPostRow[] }) {
  return (
    <Card>
      <CardHeader
        title="League news"
        subtitle="Announcements shown on the dashboard and /news — also posted to Discord."
      />
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
    </Card>
  );
}

// ---------- small helpers ----------

const inputCls =
  "h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60";

const selectCls =
  "h-9 rounded-md border border-line bg-surface-2/50 px-2 text-sm outline-none focus:border-accent/60";

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
              className="text-info hover:underline"
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
