import { capacityInfo } from "@/lib/capacity";
import {
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_PHASE_ORDER,
  SEASON_STATUS,
  type SeasonStatus,
} from "@/lib/constants";
import { ADMIN_PHASE_LABEL as PHASE_LABEL } from "@/lib/season-copy";
import { setSeasonPhase } from "@/app/actions/admin-season";
import { adminHref } from "@/lib/admin-tabs";
import { phaseAdvance, type AdminNextStep } from "@/lib/admin-next-step";
import { cn } from "@/lib/utils";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import {
  recoverablePostseasonBracket,
  seasonPhasePolicy,
} from "@/lib/season-phase-policy";
import { draftSetupOpen } from "@/lib/draft-setup";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  StatCell,
  StatStrip,
  textLink,
} from "@/components/ui";
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

        <div className="rounded-lg border border-line">
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
        </div>
        <p className="text-xs text-muted">
          The season&apos;s name, match night, MMR limit, draft settings and
          series lengths are in{" "}
          <a href={adminHref("adm-settings")} className={textLink()}>
            Settings on the Season tab
          </a>
          .
        </p>
      </CardBody>
    </Card>
  );
}
