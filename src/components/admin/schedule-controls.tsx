import Link from "@/components/app-link";
import { prisma } from "@/lib/prisma";
import { parseRescheduleOptions } from "@/lib/reschedule-ready-check";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { setWeekNight } from "@/app/actions/admin-schedule-results";
import { cancelReschedule } from "@/app/actions/reschedule";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { formatLeagueTime } from "@/lib/zoned-time";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { LocalTime } from "@/components/local-time";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { SeasonFormatBuilder } from "@/components/admin/season-format-builder";
import { SeasonFormatControls } from "@/components/admin/season-format-controls";
import { parseBreakDates } from "@/lib/season-breaks";
import { projectPlayoffField } from "@/lib/playoff-field";
import { regularScheduleRevision } from "@/lib/schedule-revision";
import {
  matchCorrectionContext,
  matchResultsOpen,
  postAuctionWorkOpen,
} from "@/lib/league-lifecycle";
import {
  nextRegularKickoff,
  regularResultsDue,
  regularSeasonStatus,
  pendingResultsMessage,
} from "@/lib/schedule-status";
import {
  MatchResultRow,
  MatchRowsHelp,
  resultsLockNote,
} from "@/components/admin-match-tools";
import { adminMatchRowId } from "@/lib/match-anchors";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardBody, CardHeader, textLink } from "@/components/ui";
import type { AdminData, Season } from "@/components/admin/season-admin-data";
import { seasonFormatEditState } from "@/components/admin/season-admin-rules";
import { SeasonBreaks } from "@/components/admin/season-breaks-section";

export function ScheduleControls({
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
  const playoffField = projectPlayoffField(data.teams, data.matches, season);
  // The fixtures these forms show: a rebuild refuses if another admin's
  // generate or rebuild replaced them since (regularScheduleRevision).
  const scheduleRevision = regularScheduleRevision(regularMatches.map((match) => match.id));
  const collateral = data.collateral;
  // What a regenerate destroys, for every confirm that rebuilds fixtures.
  const regenerateConsequences = [
    ...(collateral.rsvps ? [`${collateral.rsvps} player check-in(s) are cleared.`] : []),
    ...(collateral.picks ? [`${collateral.picks} pick'em pick(s) are deleted.`] : []),
    ...(collateral.covers
      ? [
          `${collateral.covers} standin booking(s) are cancelled — captains will have to arrange that cover again.`,
        ]
      : []),
    ...(collateral.requests
      ? [
          `${collateral.requests} waiting standin request(s) are cancelled — captains will have to ask again.`,
        ]
      : []),
    ...(collateral.proposals
      ? [`${collateral.proposals} open reschedule proposal(s) are cancelled.`]
      : []),
  ];
  const lastRegularWeek = regularMatches.reduce(
    (max, match) => Math.max(max, match.week),
    0,
  );
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
  // The same predicate saveSeasonFormat runs in its transaction.
  const formatState = seasonFormatEditState(season, data);
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Schedule & results"
        subtitle="Choose the season's layout, generate the schedule and enter weekly scores."
        action={
          // The lock reason sits where the control would be, not in a banner
          // over the card: once any result exists it is true all season.
          // Until then the season builder below holds Generate.
          formatState.mode === "LOCKED" ? (
            <p className="max-w-sm text-xs text-muted">
              {regularCount > 0 ? "Regenerate schedule" : "Generate schedule"}{" "}
              is unavailable:{" "}
              {scheduleGenerationLockedReason ?? formatState.lockReason}
            </p>
          ) : null
        }
      />
      <CardBody>
        {formatState.mode !== "LOCKED" ? (
          <div className="mb-3">
            <SeasonFormatBuilder
              // Not keyed: a save or rebuild resets the picks inside the
              // card, which keeps a typed First match night.
              placement="schedule"
              season={{
                id: season.id,
                name: season.name,
                formatConfig: season.formatConfig,
                updatedAt: season.updatedAt.toISOString(),
              }}
              teamGroupKeys={data.teams.map((team) => team.groupKey)}
              mode={formatState.mode}
              countFinal={formatState.countFinal}
              regularCount={regularCount}
              scheduleRevision={scheduleRevision}
              generateLockedReason={scheduleGenerationLockedReason}
              firstMatchNightTs={season.firstMatchNight?.getTime() ?? null}
              breakDates={parseBreakDates(season.breakDates)}
              nowMs={nowMs}
              regenerateConsequences={regenerateConsequences}
            />
          </div>
        ) : null}
        <SeasonFormatControls
          season={season}
          teams={data.teams}
          firstMatchNight={season.firstMatchNight}
          lastRegularWeek={lastRegularWeek}
          scheduleRevision={scheduleRevision}
          regenerateOpen={!scheduleGenerationLockedReason && regularCount > 0}
          regenerateConsequences={regenerateConsequences}
        />
        <div className="mt-3">
          <SeasonBreaks season={season} data={data} nowMs={nowMs} />
        </div>
        {data.matches.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            No fixtures have been generated for this season.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
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
