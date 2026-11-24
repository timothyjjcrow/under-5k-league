import { capacityInfo } from "@/lib/capacity";
import {
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_PHASE_ORDER,
  SEASON_STATUS,
  type SeasonStatus,
} from "@/lib/constants";
import { ADMIN_PHASE_LABEL as PHASE_LABEL } from "@/lib/season-copy";
import {
  setSeasonPhase,
  setMaxMmr,
  setMatchSchedule,
  renameSeason,
  setSeriesLengths,
  setDraftSettings,
} from "@/app/actions/admin-season";
import { phaseAdvance, type AdminNextStep } from "@/lib/admin-next-step";
import { cn } from "@/lib/utils";
import { fixturesMatchNightLabel } from "@/lib/match-night";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import {
  recoverablePostseasonBracket,
  seasonPhasePolicy,
} from "@/lib/season-phase-policy";
import { draftSetupLockedMessage, draftSetupOpen } from "@/lib/draft-setup";
import {
  MATCH_SCHEDULE,
  HARD_MMR_CEILING,
  DRAFT_CLOCK_LIMITS,
} from "@/lib/constants";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  StatCell,
  StatStrip,
} from "@/components/ui";
import { Field, SeriesField } from "@/components/admin/admin-fields";
import type { AdminData, Season } from "@/components/admin/season-admin-data";

export function SeasonControls({
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
              {/* The auction's clocks, fixed once it starts. The bounds are
                  the engine's (DRAFT_CLOCK_LIMITS), which the action clamps
                  to and its toast states. */}
              <Field label="Bid clock (s)" htmlFor="cfgBidSeconds">
                <input
                  id="cfgBidSeconds"
                  name="draftBidSeconds"
                  type="number"
                  min={DRAFT_CLOCK_LIMITS.bidSeconds.min}
                  max={DRAFT_CLOCK_LIMITS.bidSeconds.max}
                  defaultValue={season.draftBidSeconds}
                  className="h-9 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
                />
              </Field>
              <Field label="Uncontested lot (s)" htmlFor="cfgUncontestedSeconds">
                <input
                  id="cfgUncontestedSeconds"
                  name="draftUncontestedBidSeconds"
                  type="number"
                  min={DRAFT_CLOCK_LIMITS.uncontestedBidSeconds.min}
                  max={DRAFT_CLOCK_LIMITS.uncontestedBidSeconds.max}
                  defaultValue={season.draftUncontestedBidSeconds}
                  className="h-9 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
                />
              </Field>
              <Field label="Nomination clock (s)" htmlFor="cfgNominationSeconds">
                <input
                  id="cfgNominationSeconds"
                  name="draftNominationSeconds"
                  type="number"
                  min={DRAFT_CLOCK_LIMITS.nominationSeconds.min}
                  max={DRAFT_CLOCK_LIMITS.nominationSeconds.max}
                  defaultValue={season.draftNominationSeconds}
                  className="h-9 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
                />
              </Field>
              <SubmitButton variant="secondary" size="sm" disabled={configLocked}>
                Save draft settings
              </SubmitButton>
              <span className="text-xs text-muted">
                {configLocked
                  ? draftSetupLockedMessage(season.status, data.draft?.status)
                  : "applied when the draft starts · every bid resets the bid clock; a lot no other team can top gets the uncontested one"}
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
