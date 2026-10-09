import { cancelInhouseNight, setInhouseNight } from "@/app/actions/admin-inhouse-night";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { InhouseNightHeadcount } from "@/components/inhouse-night";
import { CopyInhouseNightInvite } from "@/components/inhouse-night-invite";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { LocalTime } from "@/components/local-time";
import { CardBody } from "@/components/ui";
import {
  INHOUSE_NIGHT_NOTE_MAX,
  inhouseNightPhase,
  type InhouseNight,
} from "@/lib/inhouse-night";
import type { InhouseNightRsvps } from "@/lib/inhouse-night-rsvp-service";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { nextSlotOccurrence } from "@/lib/match-night-poll";
import { formatLeagueMatchTime } from "@/lib/match-time";

const FIELD =
  "h-10 rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60";

/** A new night's suggested start: the coming Friday, 8 PM on the league's clock. */
const SUGGESTED_SLOT = { day: 5, minute: 20 * 60 };

/**
 * The body of /admin's Inhouse night card (the page wraps it in its
 * AdminSection). One night at a time: the form plans a night, moves the
 * planned one, or (once a night has started) plans the next; Cancel takes a
 * planned night down. Rules: src/lib/inhouse-night.ts.
 */
export function InhouseNightControls({
  night,
  rsvps,
  nowMs,
}: {
  /** The stored night, over or not. */
  night: InhouseNight | null;
  /** Its "I'm in" list (readInhouseNightRsvps); null with no night. */
  rsvps: InhouseNightRsvps | null;
  nowMs: number;
}) {
  const saidIn = rsvps?.players.length ?? 0;
  const phase = night ? inhouseNightPhase(night, nowMs) : null;
  const upcoming = phase === "upcoming" ? night : null;
  // Every save names the night this page showed, so one made from a stale
  // page is refused instead of overwriting another admin's change.
  const hidden = {
    expectedNightId: night?.id ?? "",
    expectedNightRevision: night ? String(night.revision) : "",
  };
  const when = (at: InhouseNight) => (
    <LocalTime
      ts={at.startsAtMs}
      variant="full"
      initial={formatLeagueMatchTime(new Date(at.startsAtMs), "full")}
    />
  );
  return (
    <CardBody className="space-y-4">
      <p className="text-sm text-muted">
        Pick an evening for inhouses. Home shows it in a bar at the top and
        the inhouse page in a card, with a countdown, calendar links and an
        &ldquo;I&apos;m in&rdquo; button. Planning a night posts in the inhouse
        channel, pinging the inhouse role, and the bot adds it to the
        server&apos;s Discord events, where players can mark themselves
        interested instead. At the start the inhouse channel is pinged again
        with the queue so far, and so is everyone who said they&apos;re in on
        the site with a linked Discord account. A new time moves the planned
        night (the channel hears about it, without a ping) and keeps its
        list; once a night has started, saving plans the next one.
      </p>

      {night && phase !== "over" ? (
        <div className="space-y-1 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-sm">
          <p className="font-medium text-fg">
            {phase === "on" ? "On now, since " : "Planned: "}
            {when(night)}
          </p>
          {night.note ? <p className="text-muted">{night.note}</p> : null}
          <p className="text-xs text-muted">
            {night.discordEventId
              ? "In the server's Discord events."
              : "No Discord event: the bot checklist under Discord notifications says what the bot needs."}
          </p>
          {rsvps ? (
            <p className="text-xs text-muted">
              {saidIn === 0
                ? "Nobody has said they're in on the site yet. "
                : `${saidIn} said they're in on the site. `}
              <InhouseNightHeadcount
                night={night}
                siteDiscordIds={rsvps.discordIds}
                sources
              />
            </p>
          ) : null}
          {/* The link to paste in Discord: it unfurls as the night, and
              opening it says "I'm in" (the queue once the night is on). */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
            <CopyInhouseNightInvite />
            <span className="text-xs text-muted">
              Paste it in Discord: it shows the night, and one tap says they&apos;re in.
            </span>
          </div>
        </div>
      ) : night ? (
        <p className="text-sm text-muted">Last inhouse night: {when(night)}</p>
      ) : null}

      <ActionForm
        action={setInhouseNight}
        hidden={hidden}
        className="flex flex-wrap items-end gap-3"
      >
        {/* Labels sit beside their fields, never around them: the datetime
            field's "your time" hint would join its accessible name. */}
        <div className="flex flex-col gap-1">
          <label htmlFor="inhouseNightStartsAt" className="text-xs text-muted">
            Starts
          </label>
          <LocalDatetimeField
            id="inhouseNightStartsAt"
            name="startsAt"
            tsName="startsAtTs"
            required
            defaultTs={
              upcoming?.startsAtMs ??
              nextSlotOccurrence(SUGGESTED_SLOT, nowMs, LEAGUE_CONFIG.timeZone)
            }
            timeZone={LEAGUE_CONFIG.timeZone}
            className={FIELD}
          />
        </div>
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <label htmlFor="inhouseNightNote" className="text-xs text-muted">
            Note (optional)
          </label>
          <input
            id="inhouseNightNote"
            name="note"
            maxLength={INHOUSE_NIGHT_NOTE_MAX}
            defaultValue={upcoming?.note ?? ""}
            placeholder="First one: come try it, all ranks welcome"
            className={`${FIELD} w-full`}
          />
        </div>
        <SubmitButton variant="secondary" size="sm">
          {upcoming ? "Save inhouse night" : "Plan inhouse night"}
        </SubmitButton>
      </ActionForm>

      {upcoming ? (
        <ActionForm action={cancelInhouseNight} hidden={hidden}>
          <SubmitButton
            variant="ghost"
            size="sm"
            confirm={`Cancel the inhouse night on ${formatLeagueMatchTime(new Date(upcoming.startsAtMs), "full")}? It comes off Home and the inhouse page, its Discord event is deleted, and the inhouse channel is told it's off.${saidIn > 0 ? ` ${saidIn} ${saidIn === 1 ? "player said they're" : "players said they're"} in on the site; their list goes with it.` : ""}`}
          >
            Cancel inhouse night
          </SubmitButton>
        </ActionForm>
      ) : null}
    </CardBody>
  );
}
