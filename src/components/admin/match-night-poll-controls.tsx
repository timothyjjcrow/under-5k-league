import {
  announceMatchNightPollResult,
  closeMatchNightPoll,
  createMatchNightPoll,
  deleteMatchNightPoll,
  setMatchNightPollClosing,
} from "@/app/actions/admin-match-night-poll";
import { setMatchSchedule } from "@/app/actions/admin-season";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { DangerSubmit } from "@/components/danger-submit";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { LocalTime } from "@/components/local-time";
import { AvailabilityHeatmap } from "@/components/match-night-poll/availability-heatmap";
import {
  ClockNote,
  PollClockProvider,
} from "@/components/match-night-poll/poll-clock";
import { CardBody } from "@/components/ui";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  DEFAULT_POLL_QUESTION,
  POLL_DAYS,
  POLL_DEFAULT_FROM_HOUR,
  POLL_DEFAULT_TO_HOUR,
  POLL_QUESTION_MAX,
  POLL_RESULT_DAYS,
  pollOnHome,
  pollTurnoutLine,
  slotDayName,
  slotHour,
  type PollView,
} from "@/lib/match-night-poll";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { zoneLabel } from "@/lib/zone-label";
import { LEAGUE_LOCALE } from "@/lib/zoned-time";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIELD =
  "h-9 rounded-md border border-line bg-surface-2/50 px-2 text-sm text-fg";

/** The season the winner can be written to, as the stale-form claim needs it. */
export type PollSeason = {
  id: string;
  updatedAt: Date;
  matchSchedule: string | null;
  /** The night the fixtures already use, when they have kickoffs. */
  fixturesNight: string | null;
};

/**
 * The Match night poll section on /admin: the newest poll with its live
 * count and controls, and the form for a new poll whenever none is open.
 */
export function MatchNightPollControls({
  poll,
  season,
  nowMs,
  announced = false,
}: {
  poll: PollView | null;
  season: PollSeason | null;
  nowMs: number;
  /** This result's Discord post went out (its pollResultMarker is "sent"). */
  announced?: boolean;
}) {
  return (
    <CardBody className="space-y-6">
      {poll ? (
        <CurrentPoll
          poll={poll}
          season={season}
          nowMs={nowMs}
          announced={announced}
        />
      ) : (
        <p className="text-sm text-muted">
          No poll yet. Open one to let signed-up players mark every
          match-night time they can make. It appears on Home for everyone;
          only players signed up for the season (or on a roster) can vote.
        </p>
      )}
      {poll?.open ? null : <NewPollForm nowMs={nowMs} hasPoll={!!poll} />}
    </CardBody>
  );
}

function CurrentPoll({
  poll,
  season,
  nowMs,
  announced,
}: {
  announced: boolean;
  poll: PollView;
  season: PollSeason | null;
  nowMs: number;
}) {
  const winner = poll.results?.winner
    ? (poll.slots.find((slot) => slot.key === poll.results?.winner) ?? null)
    : null;
  const onHome = pollOnHome({ closesAt: new Date(poll.closesAt) }, nowMs);
  const votes = `${poll.ballots} vote${poll.ballots === 1 ? "" : "s"}`;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            {poll.open ? "Open poll" : "Latest poll"}
          </p>
          <h4 className="mt-0.5 font-semibold text-fg [overflow-wrap:anywhere]">
            {poll.question}
          </h4>
        </div>
        <p className="text-xs text-muted">
          {poll.open ? "Closes " : "Closed "}
          <LocalTime
            ts={poll.closesAt}
            variant="full"
            initial={formatLeagueMatchTime(new Date(poll.closesAt), "full")}
          />{" "}
          · {pollTurnoutLine(poll.ballots, poll.electorate, poll.open)}
          {onHome ? " · on Home" : " · no longer on Home"}
        </p>
      </div>

      <p className="text-xs text-muted">
        Times on offer: {poll.summary}, {zoneLabel(poll.timeZone)} (
        {poll.slots.length} start times).
      </p>

      {poll.results ? (
        <PollClockProvider
          leagueZone={poll.timeZone}
          clockAt={poll.clockAt}
          viewedAt={poll.viewedAt}
        >
          <ClockNote className="mb-3" />
          <AvailabilityHeatmap
            slots={poll.slots}
            result={poll.results}
            open={poll.open}
            noneOfThese={poll.noneOfThese}
            mine={null}
          />
        </PollClockProvider>
      ) : null}

      {poll.open ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-4">
          <ActionForm action={closeMatchNightPoll} hidden={{ pollId: poll.id }}>
            <SubmitButton
              variant="secondary"
              size="sm"
              confirm={`Close voting now? ${votes} so far. The result shows on Home for ${POLL_RESULT_DAYS} days, and you can reopen voting from this card.`}
            >
              Close voting now
            </SubmitButton>
          </ActionForm>
          <ActionForm
            action={setMatchNightPollClosing}
            hidden={{ pollId: poll.id }}
            className="flex flex-wrap items-center gap-2"
          >
            <label htmlFor="pollClosesAt" className="text-xs text-muted">
              Voting closes
            </label>
            <LocalDatetimeField
              id="pollClosesAt"
              name="closesAt"
              tsName="closesAtTs"
              required
              defaultTs={poll.closesAt}
              timeZone={LEAGUE_CONFIG.timeZone}
              className={FIELD}
            />
            <SubmitButton variant="secondary" size="sm">
              Save closing time
            </SubmitButton>
          </ActionForm>
        </div>
      ) : (
        <div className="space-y-4 border-t border-line pt-4">
          {winner ? (
            <div className="space-y-3 rounded-lg border border-accent/40 bg-accent/10 p-4">
              <p className="text-sm text-fg">
                <span aria-hidden>🏆 </span>Winner:{" "}
                <span className="font-semibold">{winner.label}</span>
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {season && season.matchSchedule !== winner.label ? (
                  <ActionForm
                    action={setMatchSchedule}
                    hidden={{
                      expectedActiveSeasonId: season.id,
                      expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
                      matchSchedule: winner.label,
                    }}
                  >
                    <SubmitButton
                      variant="secondary"
                      size="sm"
                      confirm={`Set the season's Match night text to "${winner.label}"? Fixtures already on the calendar keep their kickoff times.`}
                    >
                      Use as the season&apos;s match night
                    </SubmitButton>
                  </ActionForm>
                ) : null}
                {/* The button used to stay after the post went out, and a
                    second press was refused ("already announced"). */}
                {announced ? (
                  <span className="text-sm text-success">
                    Announced on Discord ✓
                  </span>
                ) : (
                  <ActionForm
                    action={announceMatchNightPollResult}
                    hidden={{ pollId: poll.id }}
                  >
                    <SubmitButton variant="secondary" size="sm">
                      Announce the result on Discord
                    </SubmitButton>
                  </ActionForm>
                )}
              </div>
              <p className="text-xs text-muted">
                {season
                  ? season.matchSchedule === winner.label
                    ? "It's already the season's Match night text. "
                    : "Use as the season's match night fills the Match night box under Season settings. "
                  : "Once a season is active, its Match night box under Season settings can carry the winner. "}
                {season?.fixturesNight
                  ? `This season's fixtures already kick off on ${season.fixturesNight}, and pages show that night while they do; to retime them, use Move a match night under Schedule & results.`
                  : "Fixtures generated later kick off on the first match night you pick when you generate the schedule."}
              </p>
            </div>
          ) : null}
          <ActionForm
            action={setMatchNightPollClosing}
            hidden={{ pollId: poll.id }}
            className="flex flex-wrap items-center gap-2"
          >
            <label htmlFor="pollReopenAt" className="text-xs text-muted">
              Reopen voting until
            </label>
            <LocalDatetimeField
              id="pollReopenAt"
              name="closesAt"
              tsName="closesAtTs"
              required
              defaultTs={Math.ceil((nowMs + 3 * DAY_MS) / HOUR_MS) * HOUR_MS}
              timeZone={LEAGUE_CONFIG.timeZone}
              className={FIELD}
            />
            <SubmitButton variant="secondary" size="sm">
              Reopen voting
            </SubmitButton>
            <span className="basis-full text-xs text-muted">
              Every vote already cast still counts, and voters can change
              theirs.
            </span>
          </ActionForm>
        </div>
      )}

      <ActionForm action={deleteMatchNightPoll} hidden={{ pollId: poll.id }}>
        <DangerSubmit
          token={poll.question}
          title="Delete this poll and every vote in it?"
          consequences={[
            `${votes} ${poll.ballots === 1 ? "is" : "are"} deleted for good.`,
            poll.open
              ? "Voting stops and the poll leaves Home."
              : "Its result leaves Home and this card.",
          ]}
          recovery="Nothing else changes: the season's match night and its fixtures stay as they are."
        >
          Delete poll
        </DangerSubmit>
      </ActionForm>
    </div>
  );
}

function NewPollForm({ nowMs, hasPoll }: { nowMs: number; hasPoll: boolean }) {
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  return (
    <ActionForm
      action={createMatchNightPoll}
      hidden={{ daysPosted: "1" }}
      className="space-y-4 border-t border-line pt-4 first:border-t-0 first:pt-0"
    >
      <h4 className="text-sm font-semibold text-fg">
        {hasPoll ? "Open a new poll" : "Open a poll"}
      </h4>
      <div className="space-y-1">
        <label htmlFor="pollQuestion" className="text-xs text-muted">
          Question
        </label>
        <input
          id="pollQuestion"
          name="question"
          type="text"
          maxLength={POLL_QUESTION_MAX}
          defaultValue={DEFAULT_POLL_QUESTION}
          className={`${FIELD} block w-full max-w-lg`}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs text-muted">
          The grid fills itself: every ticked day, every hour between the two
          times, on the league&apos;s clock ({zoneLabel(LEAGUE_CONFIG.timeZone)}).
          Players see it on their own clock.
        </legend>
        <div className="flex flex-wrap gap-2">
          {POLL_DAYS.map((day) => (
            <label
              key={day}
              className="flex items-center gap-1.5 rounded-md border border-line bg-surface-2/50 px-2.5 py-1.5 text-sm text-fg"
            >
              <input type="checkbox" name="day" value={day} defaultChecked />
              {slotDayName({ day }).slice(0, 3)}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="pollFromHour" className="text-xs text-muted">
            From
          </label>
          <select
            id="pollFromHour"
            name="fromHour"
            defaultValue={POLL_DEFAULT_FROM_HOUR}
            className={FIELD}
          >
            {hours.map((hour) => (
              <option key={hour} value={hour}>
                {slotHour(hour * 60, LEAGUE_LOCALE)}
              </option>
            ))}
          </select>
          <label htmlFor="pollToHour" className="text-xs text-muted">
            to
          </label>
          <select
            id="pollToHour"
            name="toHour"
            defaultValue={POLL_DEFAULT_TO_HOUR}
            className={FIELD}
          >
            {hours.map((hour) => (
              <option key={hour} value={hour}>
                {slotHour(hour * 60, LEAGUE_LOCALE)}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">
            start times, on the hour (both ends included)
          </span>
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="pollNewClosesAt" className="text-xs text-muted">
          Voting closes
        </label>
        <LocalDatetimeField
          id="pollNewClosesAt"
          name="closesAt"
          tsName="closesAtTs"
          required
          defaultTs={Math.ceil((nowMs + 7 * DAY_MS) / HOUR_MS) * HOUR_MS}
          timeZone={LEAGUE_CONFIG.timeZone}
          className={FIELD}
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" name="announce" defaultChecked />
        Announce it on Discord (the league channel, no pings)
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm">Open the poll</SubmitButton>
        <span className="text-xs text-muted">
          Every day from noon to 6 PM is 49 start times. They can&apos;t be
          edited once voting starts; delete the poll and open a new one
          instead.
        </span>
      </div>
    </ActionForm>
  );
}
