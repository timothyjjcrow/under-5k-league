// /admin's Breaks box: the season's league nights with no games (holidays),
// a Remove for each one still to come, and Add break. Server-rendered: every
// option and confirm counts the matches it moves from the page's fixtures,
// with the same decision the action makes (`breakShift`).

import { addSeasonBreak, removeSeasonBreak } from "@/app/actions/admin-schedule-results";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { leagueDateKey } from "@/lib/schedule";
import {
  breakNightOptions,
  breakShift,
  formatBreakDate,
  parseBreakDates,
  seasonBreakViews,
  seasonBreaksEditable,
  seasonBreaksToken,
  type BreakFixture,
} from "@/lib/season-breaks";
import type { SeasonPlanStep } from "@/lib/season-format";

const FIELD =
  "h-8 min-w-0 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg";

/** "Week 4", "Tiebreakers", "Semifinals": what plays on a round's night. */
function roundLabeller(plan: readonly SeasonPlanStep[]) {
  return (round: number): string => {
    const step = plan.find(
      (candidate) =>
        candidate.kind !== "BREAK" && candidate.fromWeek <= round && round <= candidate.toWeek,
    );
    if (!step || step.kind === "REGULAR") return `Week ${round}`;
    return step.label;
  };
}

function matchCount(n: number): string {
  return `${n} scheduled match${n === 1 ? "" : "es"}`;
}

export function SeasonBreaksControls({
  season,
  plan,
  fixtures,
  nowMs,
}: {
  season: {
    id: string;
    status: string;
    firstMatchNight: Date | null;
    breakDates: string | null;
  };
  /** The season plan as /schedule prints it (`seasonPlan`, breaks included). */
  plan: readonly SeasonPlanStep[];
  /** Every fixture of the season, for the counts. */
  fixtures: readonly BreakFixture[];
  nowMs: number;
}) {
  const breaks = parseBreakDates(season.breakDates);
  const editable = seasonBreaksEditable(season.status);
  const lastRound = plan.reduce(
    (max, step) => (step.kind === "BREAK" ? max : Math.max(max, step.toWeek)),
    0,
  );
  const label = roundLabeller(plan);
  const views = seasonBreakViews({
    firstMatchNight: season.firstMatchNight,
    breaks,
    lastRound,
    nowMs,
  });
  const moves = (after: readonly string[]) =>
    season.firstMatchNight
      ? breakShift({ firstMatchNight: season.firstMatchNight, before: breaks, after, fixtures })
          .moves.length
      : 0;
  const options = season.firstMatchNight
    ? breakNightOptions({
        firstMatchNight: season.firstMatchNight,
        breaks,
        lastRound: Math.max(lastRound, 1),
        nowMs,
      })
    : [];
  const hidden = {
    expectedActiveSeasonId: season.id,
    expectedBreaks: seasonBreaksToken(season.breakDates),
  };
  const tomorrow = leagueDateKey(new Date(nowMs + 24 * 60 * 60 * 1000));
  return (
    <section
      aria-label="Breaks"
      id="adm-breaks"
      className="scroll-mt-40 rounded-lg border border-line bg-surface-2/40 px-4 py-3 lg:scroll-mt-56"
    >
      <h3 className="text-sm font-medium text-fg">Breaks · nights with no games</h3>
      <p className="mt-0.5 text-xs text-muted">
        Skip a league night for a holiday. Every round from that night on plays one league night
        later and keeps its week number; the matches on those nights move with it, and a match
        moved off the league night (by its captains or by hand) keeps its time. Players see the
        break in the season plan, on Home the week before, and in one Discord post that pings
        only standins whose booked match moved.
      </p>
      {views.length > 0 ? (
        <ul className="mt-2 space-y-1.5 text-xs" aria-label="The season's breaks">
          {views.map((view) => {
            const night = view.night
              ? formatLeagueMatchTime(view.night, "date")
              : `the week of ${formatBreakDate(view.date)}`;
            const what = !view.night
              ? "skips the match night nearest it once week 1's night is set"
              : view.delays
                ? `${label(view.delays)} and later play a night later`
                : "after the season's last round";
            const back = moves(breaks.filter((other) => other !== view.date));
            return (
              <li key={view.date} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-fg">{night}</span>
                <span className="min-w-0 text-muted">· {what}</span>
                {view.past ? (
                  <span className="text-muted">· passed</span>
                ) : editable ? (
                  <ActionForm action={removeSeasonBreak} hidden={{ ...hidden, date: view.date }}>
                    <SubmitButton
                      variant="secondary"
                      size="sm"
                      confirm={`Remove the break on ${night}?\n\n${
                        back > 0
                          ? `${matchCount(back)} after it move one league night earlier, and their check-ins are cleared.`
                          : "No scheduled match moves; the rounds after it are dated a night earlier."
                      }`}
                    >
                      Remove
                    </SubmitButton>
                  </ActionForm>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted">No breaks: the league plays every week.</p>
      )}
      {editable ? (
        season.firstMatchNight ? (
          options.length > 0 ? (
            <ActionForm
              action={addSeasonBreak}
              hidden={hidden}
              className="mt-2 flex flex-wrap items-center gap-2 text-xs"
            >
              <select name="date" aria-label="Night to skip" className={FIELD}>
                {options.map((option) => {
                  const count = moves([...breaks, option.date]);
                  return (
                    <option key={option.date} value={option.date}>
                      {formatLeagueMatchTime(option.night, "date")}
                      {option.round ? ` · ${label(option.round)}` : " · after the last round"}
                      {count > 0 ? ` · moves ${matchCount(count)}` : ""}
                    </option>
                  );
                })}
              </select>
              <SubmitButton
                variant="secondary"
                size="sm"
                confirm={
                  "Add a break on the night you picked?\n\nEvery scheduled match on that night and on each later round's night moves one league night later (the count is beside the night), and their check-ins are cleared. A match moved off the league night keeps its time. One Discord post tells the league."
                }
              >
                Add break
              </SubmitButton>
            </ActionForm>
          ) : (
            <p className="mt-2 text-xs text-muted">
              Every night on the season&apos;s weekly rhythm has passed, so there is no night
              left to skip. To move games that are still to come, use Move a match night.
            </p>
          )
        ) : (
          <ActionForm
            action={addSeasonBreak}
            hidden={hidden}
            className="mt-2 flex flex-wrap items-center gap-2 text-xs"
          >
            <input
              type="date"
              name="date"
              aria-label="Date to skip"
              min={tomorrow}
              required
              className={FIELD}
            />
            <SubmitButton variant="secondary" size="sm">
              Add break
            </SubmitButton>
            <span className="w-full text-muted">
              Week 1&apos;s night isn&apos;t set yet, so a break covers the match night nearest the
              date once it is (within three days).
            </span>
          </ActionForm>
        )
      ) : null}
    </section>
  );
}
