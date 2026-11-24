import {
  carriedSeasonSettings,
  carriedSettingsLine,
  nextSeasonName,
  type CarriedSeasonSettings,
} from "@/lib/season-handoff";
import {
  createSeason,
  archiveCompletedSeasonAction,
  setNextSeasonDate,
  clearNextSeasonDate,
} from "@/app/actions/admin-season";
import { formatLeagueTime } from "@/lib/zoned-time";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { cn } from "@/lib/utils";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { Field, inputCls } from "@/components/admin/admin-fields";
import type { Season } from "@/components/admin/season-admin-data";

/**
 * The season handoff once a champion is crowned, and the new-season form in
 * the offseason: the first card on the page in both states. One titled form
 * with the one button. Archiving without opening the next season is no longer
 * a peer choice: staying in Season complete keeps the champion and bracket on
 * the home page, while the offseason turns them into empty pages. It stays
 * reachable, folded, because reactivating an older season needs no active
 * season.
 */
export function OpenNextSeason({
  season,
  previous,
  championName,
  nextSignupsAtMs,
}: {
  /** The crowned active season; null in the offseason. */
  season: Season | null;
  /** The season the new one follows (carried settings); null for the first. */
  previous: CarriedSeasonSettings & { name: string } | null;
  championName: string | null;
  /** The next season's planned signup date Home shows; null for none. */
  nextSignupsAtMs: number | null;
}) {
  const nextName = nextSeasonName(previous?.name ?? null);
  return (
    <Card id="adm-new-season" tone="feature" className="scroll-mt-40 lg:scroll-mt-56">
      <CardHeader
        headingLevel={2}
        title={season ? "Season handoff" : "Open a new season"}
        subtitle={
          season
            ? `${championName ? `${championName} won ${season.name}. ` : ""}The league stays in Complete, with the champion on the home page, until you open the next season.`
            : previous
              ? "The league is in the offseason. Archived seasons remain public; open the next season when signups should begin."
              : "No active season yet. Open the first one to start signups."
        }
      />
      <CardBody className="space-y-5">
        <ActionForm
          action={createSeason}
          className="space-y-3 [overflow-wrap:anywhere]"
          hidden={{ expectedActiveSeasonId: season?.id ?? "" }}
        >
          <h3 className="text-base font-semibold text-fg">
            {nextName ? `Open ${nextName} signups` : "Open the next season's signups"}
          </h3>
          <p className="text-sm text-muted">
            {season
              ? `Players see the new season on the home page with signups open. ${season.name} moves to Season history with its champion, results and rosters.`
              : "Players see the new season on the home page with signups open."}
          </p>
          <Field label="New season name" htmlFor="newSeasonName">
            <input
              id="newSeasonName"
              name="name"
              required
              maxLength={60}
              defaultValue={nextName}
              placeholder="Season 1"
              className={cn(inputCls, "sm:max-w-sm")}
            />
          </Field>
          <p className="text-sm text-muted">
            {previous ? `Carried over from ${previous.name}: ` : "Starts with: "}
            <span className="text-fg">
              {carriedSettingsLine(carriedSeasonSettings(previous))}
            </span>
            . You can change any of them once the season is open.
          </p>
          <SubmitButton
            variant="accent"
            confirm={
              season
                ? `Archive completed ${season.name} and open a new signup season? All history remains available.`
                : "Open this season's signup window now?"
            }
          >
            Open signups
          </SubmitButton>
        </ActionForm>
        {season ? (
          <div className="space-y-3 border-t border-line-soft pt-4">
            <h3 className="text-base font-semibold text-fg">
              Next season&rsquo;s date
            </h3>
            <p className="text-sm text-muted">
              Until you open signups, the home page tells players the next
              season is coming soon. Set the date its signups will open and
              Home shows that date with a countdown instead. It only informs
              players: signups still open when you press Open signups above.
            </p>
            <ActionForm
              action={setNextSeasonDate}
              hidden={{ expectedActiveSeasonId: season.id }}
              className="flex flex-wrap items-end gap-2"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor="nextSignupsAt" className="text-xs text-muted">
                  Signups open
                </label>
                <LocalDatetimeField
                  id="nextSignupsAt"
                  name="nextSignupsAt"
                  tsName="nextSignupsAtTs"
                  required
                  defaultTs={nextSignupsAtMs}
                  timeZone={LEAGUE_CONFIG.timeZone}
                  className="h-8 rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg"
                />
              </div>
              <SubmitButton variant="secondary" size="sm">
                {nextSignupsAtMs != null ? "Update date" : "Set date"}
              </SubmitButton>
            </ActionForm>
            {nextSignupsAtMs != null ? (
              <ActionForm
                action={clearNextSeasonDate}
                className="flex flex-wrap items-center gap-2 text-xs text-muted"
              >
                <span>
                  Home shows {formatLeagueTime(new Date(nextSignupsAtMs))}.
                </span>
                <SubmitButton variant="ghost" size="sm">
                  Clear date
                </SubmitButton>
              </ActionForm>
            ) : null}
          </div>
        ) : null}
        {season ? (
          <details className="rounded-lg border border-line bg-surface-2/40 px-4 py-2 text-sm">
            <summary className="flex min-h-11 cursor-pointer items-center font-medium text-fg">
              Archive without opening the next season
            </summary>
            <div className="space-y-3 pb-2">
              <p className="text-muted">
                Use this only to reactivate an older season from Season
                history, which needs the league to have no active season.
                Archiving takes the league out of Complete: the home page
                swaps the champion card and bracket for an offseason notice
                that still names the champion as the defending champion, and
                nobody can sign up until you open the next season here. Results, the champion,
                rosters and records stay public under Season history. For a
                long break, stay in Complete and pin a League news post
                instead.
              </p>
              <ActionForm
                action={archiveCompletedSeasonAction}
                hidden={{ expectedActiveSeasonId: season.id }}
              >
                <SubmitButton
                  variant="secondary"
                  confirm={`Archive ${season.name} and enter the offseason? No league history is deleted, but active-season signup and match tools will close until another season is opened.`}
                >
                  Archive and enter offseason
                </SubmitButton>
              </ActionForm>
            </div>
          </details>
        ) : null}
      </CardBody>
    </Card>
  );
}
