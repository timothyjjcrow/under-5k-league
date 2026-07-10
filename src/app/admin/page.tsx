import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason, capacityInfo } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { SEASON_PHASE_ORDER } from "@/lib/constants";
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
  syncPlayerRanks,
  syncSteamProfiles,
  setMaxMmr,
  setMatchSchedule,
  renameSeason,
  setSeriesLengths,
  setLeagueId,
  syncLeagueAction,
  setDiscordWebhook,
  testDiscordWebhook,
  signFreeAgent,
  releasePlayer,
} from "@/app/actions/admin";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { pickBracketSize } from "@/lib/schedule";
import { mmrWeightedBudgets } from "@/lib/draft";
import { MATCH_SCHEDULE } from "@/lib/constants";
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
  Stat,
  buttonClasses,
} from "@/components/ui";

function fmtDateTimeLocal(d: Date | null): string {
  if (!d) return "";
  // to yyyy-MM-ddThh:mm in local time for <input type="datetime-local">
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/");

  const season = await getActiveSeason();

  const data = season
    ? await loadSeasonAdminData(season.id)
    : null;
  const discordWebhookUrl =
    (await getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL)) ?? "";

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
          <DiscordControls webhookUrl={discordWebhookUrl} />
        </>
      ) : (
        <Card>
          <CardBody className="text-muted">
            No active season. Create one below to get started.
          </CardBody>
        </Card>
      )}

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
            <Field label="Max MMR (0 = none)" htmlFor="maxMmr">
              <input
                id="maxMmr"
                name="maxMmr"
                type="number"
                defaultValue={4500}
                min={0}
                max={20000}
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
            <form key={phase} action={setSeasonPhase}>
              <input type="hidden" name="phase" value={phase} />
              <button
                type="submit"
                className={
                  season.status === phase
                    ? buttonClasses("primary", "sm")
                    : buttonClasses("secondary", "sm")
                }
              >
                {PHASE_LABEL[phase]}
              </button>
            </form>
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
            Signup MMR cap
          </label>
          <input
            id="seasonMaxMmr"
            name="maxMmr"
            type="number"
            min={0}
            max={20000}
            defaultValue={season.maxMmr}
            className="h-9 w-28 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
          />
          <SubmitButton variant="secondary" size="sm">
            Save cap
          </SubmitButton>
          <span className="text-xs text-muted">
            {season.maxMmr > 0
              ? `players over ${season.maxMmr} MMR can't join`
              : "no cap — anyone can join"}
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
  const draftStarted = data.draft?.status === "IN_PROGRESS";
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
            <form action={randomizeDraftOrder}>
              <SubmitButton variant="secondary" size="sm">
                Randomize order
              </SubmitButton>
            </form>
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
          </div>
        }
      />
      <CardBody className="grid gap-6 md:grid-cols-2">
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
                    mmr: mmrByUser.get(t.captainId) ?? null,
                  })),
                  (season.teamSize - 1),
                );
                return data.teams.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between rounded-lg border border-line px-3 py-2"
                  >
                    <span className="flex items-center gap-2 text-sm">
                      <span className="w-5 text-center text-xs text-muted">
                        {t.draftOrder + 1}
                      </span>
                      <Avatar
                        name={t.captain.name}
                        src={t.captain.avatar}
                        size={24}
                      />
                      {t.name}
                      <Badge tone="accent">
                        ${draftStarted ? t.budget : projected.get(t.id)}
                      </Badge>
                    </span>
                    {!draftStarted ? (
                      <form action={removeCaptain}>
                        <input type="hidden" name="teamId" value={t.id} />
                        <button
                          type="submit"
                          className="text-xs text-danger hover:underline"
                        >
                          remove
                        </button>
                      </form>
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
          {draftStarted ? (
            <Link
              href="/draft"
              className={buttonClasses("accent", "sm", "mt-3")}
            >
              Go to draft room →
            </Link>
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
                  className="flex items-center justify-between rounded-lg border border-line px-3 py-1.5"
                >
                  <span className="flex items-center gap-2 text-sm">
                    <Avatar name={p.user.name} src={p.user.avatar} size={22} />
                    {p.user.name}
                    <span className="text-xs text-muted">{p.mmr}</span>
                    {p.wantsCaptain ? (
                      <Badge tone="brand">wants C</Badge>
                    ) : null}
                  </span>
                  {!draftStarted ? (
                    <form action={addCaptain}>
                      <input type="hidden" name="userId" value={p.userId} />
                      <button
                        type="submit"
                        className="text-xs text-accent hover:underline"
                      >
                        make captain
                      </button>
                    </form>
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
            <input
              id="firstNight"
              type="datetime-local"
              name="firstNight"
              defaultValue={fmtDateTimeLocal(season.firstMatchNight)}
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
            {data.matches.map((m) => {
              const home = data.teams.find((t) => t.id === m.homeTeamId);
              const away = data.teams.find((t) => t.id === m.awayTeamId);
              return (
                <div
                  key={m.id}
                  className="space-y-2 rounded-lg border border-line p-3"
                >
                  <ActionForm
                    action={recordResult}
                    className="flex flex-wrap items-center gap-2 text-sm"
                    hidden={{ matchId: m.id }}
                  >
                    <span className="w-14 text-xs text-muted">Wk {m.week}</span>
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
                    <input
                      type="datetime-local"
                      name="scheduledAt"
                      defaultValue={fmtDateTimeLocal(m.scheduledAt)}
                      className="h-8 rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg"
                    />
                    <SubmitButton variant="secondary" size="sm">
                      Set time
                    </SubmitButton>
                  </form>

                  {m.games.length > 0 ? (
                    <ul className="space-y-1 border-t border-line/60 pt-2 text-xs">
                      {m.games.map((g) => {
                        const winner = data.teams.find(
                          (t) => t.id === g.winnerTeamId,
                        );
                        return (
                          <li
                            key={g.id}
                            className="flex items-center justify-between"
                          >
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
                            <form action={removeGame}>
                              <input type="hidden" name="gameId" value={g.id} />
                              <button
                                type="submit"
                                className="text-danger hover:underline"
                              >
                                remove
                              </button>
                            </form>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}

                  <MatchImportControls matchId={m.id} />
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
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
          upcoming.map((m) => {
            const home = data.teams.find((t) => t.id === m.homeTeamId);
            const away = data.teams.find((t) => t.id === m.awayTeamId);
            const asg = byMatch.get(m.id) ?? [];
            return (
              <div
                key={m.id}
                className="space-y-2 rounded-lg border border-line p-3"
              >
                <div className="text-sm font-medium">
                  Wk {m.week}: {home?.name ?? "?"} vs {away?.name ?? "?"}
                </div>
                {(() => {
                  const out = data.outRsvps.filter((r) => r.matchId === m.id);
                  const covered = new Set(
                    asg.map((a) => a.replacingUserId).filter(Boolean),
                  );
                  const needing = out.filter((r) => !covered.has(r.userId));
                  return needing.length > 0 ? (
                    <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs">
                      ✗ Can&apos;t make it:{" "}
                      <b>{needing.map((r) => r.user.name).join(", ")}</b> —
                      assign a standin below.
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
                        <form action={removeStandin}>
                          <input type="hidden" name="assignmentId" value={a.id} />
                          <button
                            type="submit"
                            className="text-danger hover:underline"
                          >
                            remove
                          </button>
                        </form>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <form
                  action={assignStandin}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="matchId" value={m.id} />
                  <select
                    name="standinUserId"
                    required
                    defaultValue=""
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
                </form>
              </div>
            );
          })
        )}
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
  if (!canSign && releasable.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Roster moves"
        subtitle="Sign free agents onto short teams; release players who've left."
      />
      <CardBody className="space-y-3">
        {canSign ? (
          <ActionForm
            action={signFreeAgent}
            className="flex flex-wrap items-center gap-2"
          >
            <select name="userId" required defaultValue="" className={selectCls}>
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
            <select name="teamId" required defaultValue="" className={selectCls}>
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
        {releasable.length > 0 ? (
          <ActionForm
            action={releasePlayer}
            className="flex flex-wrap items-center gap-2"
          >
            <select
              name="memberId"
              required
              defaultValue=""
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

function DiscordControls({ webhookUrl }: { webhookUrl: string }) {
  return (
    <Card>
      <CardHeader
        title="Discord notifications"
        subtitle="Announce signups, the draft, results, playoffs, and the champion in your Discord."
        action={
          <ActionForm action={testDiscordWebhook}>
            <SubmitButton variant="secondary" size="sm" disabled={!webhookUrl}>
              Send test message
            </SubmitButton>
          </ActionForm>
        }
      />
      <CardBody className="space-y-3">
        <ActionForm
          action={setDiscordWebhook}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1">
            <label
              htmlFor="discordWebhookUrl"
              className="mb-1 block text-xs text-muted"
            >
              Webhook URL
            </label>
            <input
              id="discordWebhookUrl"
              name="discordWebhookUrl"
              type="url"
              defaultValue={webhookUrl}
              placeholder="https://discord.com/api/webhooks/…"
              className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
            />
          </div>
          <SubmitButton variant="secondary" size="sm">
            Save webhook
          </SubmitButton>
        </ActionForm>
        <p className="text-xs text-muted">
          In Discord: <b>Server Settings → Integrations → Webhooks → New
          Webhook</b>, pick the announcements channel, copy the URL and paste it
          here. Clear the field to turn announcements off.
        </p>
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
