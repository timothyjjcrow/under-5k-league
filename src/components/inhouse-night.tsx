import { Suspense } from "react";
import { Countdown } from "@/components/countdown";
import { LocalTime } from "@/components/local-time";
import { Card, CardBody, CardHeader, LinkArrow, textLink } from "@/components/ui";
import { guildEventInterest } from "@/lib/discord-roles";
import {
  currentInhouseNight,
  inhouseNightGoogleCalendarUrl,
  inhouseNightPhase,
  type InhouseNight,
} from "@/lib/inhouse-night";
import { inhouseNightEventUrl, readInhouseNight } from "@/lib/inhouse-night-service";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { resolveSiteUrl } from "@/lib/site-url";

// The inhouse night on the site (rules: src/lib/inhouse-night.ts): the card at
// the top of /inhouse and the line in Home's inhouse strip. Both read one
// Setting row; the Discord interested count streams in on its own, so a slow
// Discord never holds up the page.

/** The night to show, or null: nothing set, or the last one is over. */
export async function loadCurrentInhouseNight(
  nowMs = Date.now(),
): Promise<InhouseNight | null> {
  const { night } = await readInhouseNight();
  return currentInhouseNight(night, nowMs);
}

/** The night's start on the viewer's clock, with a countdown chip. */
export function InhouseNightWhen({ night }: { night: InhouseNight }) {
  const start = new Date(night.startsAtMs);
  return (
    <>
      <LocalTime
        ts={night.startsAtMs}
        variant="full"
        initial={formatLeagueMatchTime(start, "full")}
      />
      <Countdown
        targetMs={night.startsAtMs}
        eventLabel="Inhouse night"
        passedLabel="Over"
      />
    </>
  );
}

/**
 * "12 interested on Discord": the server event's live count, reused for a
 * couple of minutes. Nothing when the count is unknown or zero.
 */
async function InterestCount({
  eventId,
  prefix,
  className,
}: {
  eventId: string;
  prefix: string;
  className?: string;
}) {
  const count = await guildEventInterest(eventId);
  if (!count) return null;
  return <span className={className}>{`${prefix}${count} interested on Discord`}</span>;
}

/** The interested count, streamed; renders nothing without an event. */
export function InhouseNightInterest({
  night,
  prefix = "",
  className,
}: {
  night: InhouseNight;
  /** Text before the count, such as a separator. */
  prefix?: string;
  className?: string;
}) {
  if (!night.discordEventId) return null;
  return (
    <Suspense fallback={null}>
      <InterestCount eventId={night.discordEventId} prefix={prefix} className={className} />
    </Suspense>
  );
}

/** The card at the top of /inhouse while a night is set; nothing otherwise. */
export async function InhouseNightCard() {
  // eslint-disable-next-line react-hooks/purity -- async server component
  const nowMs = Date.now();
  const night = await loadCurrentInhouseNight(nowMs);
  if (!night) return null;
  const on = inhouseNightPhase(night, nowMs) === "on";
  const eventUrl = inhouseNightEventUrl(night);
  const google = inhouseNightGoogleCalendarUrl(night, resolveSiteUrl(), LEAGUE_CONFIG.name);
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title={on ? "Inhouse night is on" : "Inhouse night"}
        subtitle={
          on
            ? "Join the queue below: the lobby fires at ten players."
            : "Queue up here when it starts: the lobby fires at ten players, and captains draft the teams."
        }
      />
      <CardBody className="space-y-3">
        <p className="text-base font-medium text-fg">
          <InhouseNightWhen night={night} />
        </p>
        {night.note ? (
          <p className="text-sm text-muted [overflow-wrap:anywhere]">{night.note}</p>
        ) : null}
        <InhouseNightInterest night={night} className="block text-sm text-muted" />
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {eventUrl ? (
            <a href={eventUrl} target="_blank" rel="noreferrer" className={textLink()}>
              Mark yourself interested on Discord <LinkArrow out />
            </a>
          ) : null}
          {on ? null : (
            <>
              <a href={google} target="_blank" rel="noreferrer" className={textLink()}>
                Add to Google Calendar <LinkArrow out />
              </a>
              <a href="/api/calendar/inhouse-night" className={textLink()}>
                Add to Apple or Outlook calendar (.ics)
              </a>
            </>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
