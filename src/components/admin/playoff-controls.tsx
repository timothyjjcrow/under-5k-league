import Link from "@/components/app-link";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  startPlayoffs,
  returnToRegularSeasonAction,
} from "@/app/actions/admin-schedule-results";
import {
  scheduleTiebreakerWeek,
  resetTiebreakerWeek,
} from "@/app/actions/tiebreakers";
import { TIEBREAKER_RULES, TIEBREAKER_SUMMARY } from "@/lib/tiebreaker-format";
import { schedulableAdminTiebreakerGroups } from "@/components/admin-tiebreaker-view";
import { playoffPlacesPhrase } from "@/lib/season-groups";
import { DangerSubmit } from "@/components/danger-submit";
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
  matchCorrectionContext,
  matchResultsOpen,
} from "@/lib/league-lifecycle";
import {
  regularResultsDue,
  regularSeasonStatus,
  weekList,
} from "@/lib/schedule-status";
import {
  LATER_ROUND_NOTE,
  MatchResultRow,
  MatchRowsHelp,
  resultsLockNote,
} from "@/components/admin-match-tools";
import { adminMatchRowId } from "@/lib/match-anchors";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardBody, CardHeader, textLink } from "@/components/ui";
import type { AdminData, Season } from "@/components/admin/season-admin-data";

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

export function PlayoffControls({
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
  const playoffField = projectPlayoffField(data.teams, data.matches, season);
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
              : `${
                  playoffField.groups && bracketSize === 2
                    ? `Will put the group winners into the grand final (${playoffField.pairings
                        .map((pairing) => `${playoffField.seedLabelByTeam.get(pairing.home) ?? "?"}–${playoffField.seedLabelByTeam.get(pairing.away) ?? "?"}`)
                        .join(", ")}), from ${playoffField.eligibleTeamIds.length} eligible team(s)`
                    : playoffField.groups
                    ? `Will seed ${playoffPlacesPhrase(playoffField)}, crosswise (${playoffField.pairings
                        .map((pairing) => `${playoffField.seedLabelByTeam.get(pairing.home) ?? "?"}–${playoffField.seedLabelByTeam.get(pairing.away) ?? "?"}`)
                        .join(", ")}), from ${playoffField.eligibleTeamIds.length} eligible team(s)`
                    : `Will seed the top ${bracketSize} of ${playoffField.eligibleTeamIds.length} eligible team(s) by standings`
                }${data.teams.length !== playoffField.eligibleTeamIds.length ? `; ${data.teams.length - playoffField.eligibleTeamIds.length} withdrawn team(s) keep their results but cannot take a seed` : ""}. Start this after the regular season is finished; round one plays the week after the tiebreaker week.`}
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
