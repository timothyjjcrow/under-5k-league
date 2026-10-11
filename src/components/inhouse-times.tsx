import Link from "next/link";
import { cache } from "react";
import { setInhouseTimeAction } from "@/app/actions/inhouse-times";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Countdown } from "@/components/countdown";
import {
  CopyInhouseTimeLink,
  InhouseTimePicker,
  InhouseTimeWhen,
} from "@/components/inhouse-times-client";
import { LocalTime } from "@/components/local-time";
import {
  Avatar,
  Card,
  CardBody,
  CardHeader,
  LinkArrow,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import {
  INHOUSE_TIME_AT_CAP,
  INHOUSE_TIME_MAX_PER_PLAYER,
  inhouseTimeCanPost,
  inhouseTimeControls,
  inhouseTimeCountText,
  inhouseTimeDayWord,
  inhouseTimeGoogleCalendarUrl,
  inhouseTimeLinkPath,
  inhouseTimeParam,
  inhouseTimesStrip,
  inhouseTimesStripLinkText,
  upcomingInhouseTimesFor,
  type InhouseTime,
  type InhouseTimeLinked,
  type InhouseTimePlayer,
} from "@/lib/inhouse-times";
import { readInhouseTimes } from "@/lib/inhouse-times-service";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { formatLeagueMatchTime, leagueMatchTimeParts } from "@/lib/match-time";
import { signInHref } from "@/lib/sign-in";
import { resolveSiteUrl } from "@/lib/site-url";
import { cn } from "@/lib/utils";

// Play later on /inhouse (rules: src/lib/inhouse-times.ts): the card under
// the live room with the times players posted, who's in on each, "I'm in",
// and "Post a time", and the thin banner above the room with the soonest few
// and their "I'm in". Nothing here posts to Discord or pings anyone; a time's
// link is the one way to share it.

/** Profile chips on a time before "and N more": a full lobby's worth. */
const PLAYERS_SHOWN = 10;

/** The anchor the card sits under, the one its sign-in comes back to, and the banner's link down. */
export const PLAY_LATER_ANCHOR = "play-later";

/**
 * The page's one read of Play later: the clock it judged the times by, the
 * viewer, the times, and whether the viewer is at the cap. Request-cached,
 * so the banner at the top and the card under the room show the same times
 * from one query and never disagree.
 */
const loadPlayLater = cache(async () => {
  const nowMs = Date.now();
  const [user, times] = await Promise.all([getSessionUser(), readInhouseTimes(nowMs)]);
  const atCap =
    !!user && upcomingInhouseTimesFor(times, user.id) >= INHOUSE_TIME_MAX_PER_PLAYER;
  return { nowMs, user, times, atCap };
});

/** What one time offers the viewer, by the one rule both the card and the banner use. */
function viewOf(time: InhouseTime, user: SessionUser | null, atCap: boolean) {
  const mine = !!user && time.players.some((player) => player.id === user.id);
  const controls = inhouseTimeControls({ phase: time.phase, signedIn: !!user, mine, atCap });
  return { mine, controls };
}

/** Who's in on a time, first in first, as profile chips. */
function Players({ players }: { players: InhouseTimePlayer[] }) {
  const shown = players.slice(0, PLAYERS_SHOWN);
  const rest = players.length - shown.length;
  return (
    <ul className="flex flex-wrap gap-2">
      {shown.map((player) => (
        <li key={player.id} className="min-w-0 max-w-full">
          <Link
            href={`/players/${player.id}`}
            className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-2/60 py-1 pl-1 pr-2.5 text-xs text-fg hover:border-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {/* The name beside it is the link's name. */}
            <span aria-hidden className="shrink-0">
              <Avatar name={player.name} src={player.avatar} size={20} />
            </span>
            <span className="min-w-0 truncate">{player.name}</span>
          </Link>
        </li>
      ))}
      {rest > 0 ? <li className="self-center text-xs text-muted">and {rest} more</li> : null}
    </ul>
  );
}

/**
 * One time's "I'm in": one toggle like the inhouse night's, pressed once
 * you're in, and pressing it again takes you off. Signed out, a sign-in that
 * comes back to this time's link. `describedBy` names the time, since every
 * row's button says "I'm in".
 */
function RsvpControl({
  kind,
  time,
  mine,
  describedBy,
  compact = false,
}: {
  kind: "sign-in" | "toggle";
  time: InhouseTime;
  mine: boolean;
  describedBy: string;
  /** The banner: a refusal stays in its toast, so the row never grows. */
  compact?: boolean;
}) {
  if (kind === "sign-in") {
    return (
      <Link
        href={signInHref(inhouseTimeLinkPath(time.startsAtMs))}
        aria-describedby={describedBy}
        className={buttonClasses("primary", "sm")}
      >
        I&apos;m in
      </Link>
    );
  }
  return (
    <ActionForm
      action={setInhouseTimeAction}
      hidden={{ at: inhouseTimeParam(time.startsAtMs), going: mine ? "0" : "1" }}
      inlineError={!compact}
    >
      <SubmitButton
        size="sm"
        variant={mine ? "secondary" : "primary"}
        className={mine ? "border-success/50 text-success" : undefined}
        aria-pressed={mine}
        aria-describedby={describedBy}
      >
        {mine ? <span aria-hidden>✓</span> : null}
        I&apos;m in
      </SubmitButton>
    </ActionForm>
  );
}

/**
 * A time's buttons, wherever it shows: "Join the queue" once it's on (the
 * room is on this page, so a jump, not a reload; the inhouse night's ?join=1
 * is for links from elsewhere), and "I'm in" as the rule says. `compact`
 * (the banner, where the room is just below) makes the jump a short link,
 * "Join ↓", still named "Join the queue".
 */
function TimeActions({
  time,
  mine,
  controls,
  describedBy,
  compact = false,
}: {
  time: InhouseTime;
  mine: boolean;
  controls: ReturnType<typeof viewOf>["controls"];
  describedBy: string;
  compact?: boolean;
}) {
  return (
    <>
      {controls.queue ? (
        compact ? (
          <a href="#live-room" className={textLink("whitespace-nowrap px-1 text-sm font-medium")}>
            Join<span className="sr-only"> the queue</span> <span aria-hidden>↓</span>
          </a>
        ) : (
          <a href="#live-room" className={buttonClasses("primary", "sm")}>
            Join the queue <LinkArrow />
          </a>
        )
      ) : null}
      {controls.rsvp === "none" ? null : (
        <RsvpControl
          kind={controls.rsvp}
          time={time}
          mine={mine}
          describedBy={describedBy}
          compact={compact}
        />
      )}
    </>
  );
}

function TimeRow({
  time,
  user,
  atCap,
  linked,
  site,
}: {
  time: InhouseTime;
  user: SessionUser | null;
  atCap: boolean;
  /** The time the page was opened for (its link). */
  linked: boolean;
  site: string;
}) {
  const at = inhouseTimeParam(time.startsAtMs);
  const { mine, controls } = viewOf(time, user, atCap);
  const whenId = `inhouse-time-${time.startsAtMs}`;
  return (
    <li
      className={cn(
        "min-w-0 space-y-2.5 rounded-lg border bg-surface-2/40 p-3",
        linked ? "border-accent/60" : "border-line",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p id={whenId} className="min-w-0 font-medium text-fg">
          <LocalTime
            ts={time.startsAtMs}
            variant="full"
            initial={formatLeagueMatchTime(new Date(time.startsAtMs), "full")}
          />
          <Countdown targetMs={time.startsAtMs} eventLabel="Inhouse" />
        </p>
        <span className="text-sm text-muted">{inhouseTimeCountText(time.players.length)}</span>
        <span aria-hidden className="ml-auto" />
        <TimeActions time={time} mine={mine} controls={controls} describedBy={whenId} />
      </div>
      <Players players={time.players} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <CopyInhouseTimeLink at={at} />
        {controls.calendar ? (
          <>
            <a
              href={inhouseTimeGoogleCalendarUrl(time.startsAtMs, site, LEAGUE_CONFIG.name)}
              target="_blank"
              rel="noreferrer"
              className={textLink()}
            >
              Add to Google Calendar <LinkArrow out />
            </a>
            <a href={`/api/calendar/inhouse-time?at=${at}`} className={textLink()}>
              Apple or Outlook (.ics)
            </a>
          </>
        ) : null}
      </div>
    </li>
  );
}

/** "Post a time": a box on the player's own clock, and the button. */
function PostTimeForm({ taken, mine }: { taken: string[]; mine: string[] }) {
  return (
    <ActionForm
      action={setInhouseTimeAction}
      hidden={{ posting: "1" }}
      className="space-y-2 border-t border-line pt-4"
    >
      <label htmlFor="inhouse-time-clock" className="block text-sm font-medium text-fg">
        Post a time
      </label>
      <InhouseTimePicker
        id="inhouse-time-clock"
        taken={taken}
        mine={mine}
        describedBy="inhouse-time-hint"
      >
        <SubmitButton size="sm">Post time</SubmitButton>
      </InhouseTimePicker>
      <p id="inhouse-time-hint" className="text-xs text-muted">
        Your clock, on the quarter hour: today, or tomorrow once it&apos;s passed. Posting it
        puts you in on it.
      </p>
    </ActionForm>
  );
}

/**
 * The Play later card, always under the live room. Opened from a time's link
 * (`linked`) it outlines that time's row; the banner above the room says
 * when the link's time is over, so the card doesn't say it again.
 */
export async function InhouseTimesCard({ linked }: { linked: InhouseTimeLinked }) {
  const { user, times, atCap } = await loadPlayLater();
  const site = resolveSiteUrl();
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Play later"
        subtitle="Can't play right now? Post when you can, or say you're in on someone's time, so everyone can see when a lobby will fill. When it comes round, join the queue here."
      />
      <CardBody className="space-y-4">
        {times.length > 0 ? (
          <ul className="space-y-3">
            {times.map((time) => (
              <TimeRow
                key={time.startsAtMs}
                time={time}
                user={user}
                atCap={atCap}
                linked={time.startsAtMs === linked}
                site={site}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            Nobody has posted a time yet. Post one, and anyone can say they&apos;re in on it.
          </p>
        )}
        {inhouseTimeCanPost({ signedIn: !!user, atCap }) ? (
          <PostTimeForm
            taken={times.map((time) => inhouseTimeParam(time.startsAtMs))}
            mine={times
              .filter((time) => time.players.some((player) => player.id === user?.id))
              .map((time) => inhouseTimeParam(time.startsAtMs))}
          />
        ) : user ? (
          <p className="text-sm text-muted">{INHOUSE_TIME_AT_CAP}</p>
        ) : (
          <Link
            href={signInHref(`/inhouse#${PLAY_LATER_ANCHOR}`)}
            className={buttonClasses("primary", "sm")}
          >
            Sign in to post a time
          </Link>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * One time in the banner, as a chip one button high: when (on the viewer's
 * clock), how many are in, and the same buttons as its row in the card,
 * compact. The time a link opened the page for is picked out.
 */
function StripChip({
  time,
  user,
  atCap,
  nowMs,
  linked,
}: {
  time: InhouseTime;
  user: SessionUser | null;
  atCap: boolean;
  nowMs: number;
  /** The time the page was opened for (its link). */
  linked: boolean;
}) {
  const { mine, controls } = viewOf(time, user, atCap);
  const acts = controls.queue || controls.rsvp !== "none";
  // Not the card row's id: both show the same time, and each button names its own.
  const whenId = `inhouse-time-next-${time.startsAtMs}`;
  const start = new Date(time.startsAtMs);
  // The browser's words ("Today, 8:00 PM") on the league's clock, zone
  // named, so the text keeps its shape when the viewer's clock takes over.
  const day = inhouseTimeDayWord(time.startsAtMs, nowMs, LEAGUE_CONFIG.timeZone);
  const initial = day
    ? `${day}, ${leagueMatchTimeParts(start).time}`
    : formatLeagueMatchTime(start, "full");
  return (
    <li
      aria-current={linked ? "true" : undefined}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-lg border bg-surface-2/50 py-0.5 pl-2.5",
        acts ? "pr-0.5" : "min-h-8 pr-2.5",
        linked
          ? "border-accent ring-1 ring-accent/60"
          : time.phase === "on"
            ? "border-success/40"
            : "border-line",
      )}
    >
      <span id={whenId} className="whitespace-nowrap text-sm font-semibold text-fg">
        <InhouseTimeWhen ts={time.startsAtMs} initial={initial} />
      </span>
      <span className="whitespace-nowrap text-xs text-muted">{time.players.length} in</span>
      {acts ? (
        <TimeActions time={time} mine={mine} controls={controls} describedBy={whenId} compact />
      ) : null}
    </li>
  );
}

/**
 * The Play later banner, above the live room (Tim, 2026-10-10): a thin
 * sliver, one button high, with the soonest open times and each one's "I'm
 * in", so a visitor sees them and still has the queue on the first screen.
 * The chips swipe in one row inside it when they don't fit; it never grows a
 * second. A time's link changes only what this shows (its time leads,
 * picked out, or a line saying it's over); the card stays under the room
 * either way. inhouseTimesStrip decides it all, nothing while no time is
 * open and no link needs answering. Posting, the links and everyone's names
 * stay on the card.
 */
export async function InhouseTimesStrip({ linked }: { linked: InhouseTimeLinked }) {
  const { nowMs, user, times, atCap } = await loadPlayLater();
  const strip = inhouseTimesStrip(times, { linked });
  if (!strip) return null;
  return (
    <section id="play-later-next" aria-label="Play later times">
      {/* overflow-hidden: the chips' row scrolls inside the banner, never the page. */}
      <Card className="flex items-center gap-2 overflow-hidden py-1 pl-2 pr-1 sm:pl-3 sm:pr-2">
        <p className="flex shrink-0 items-center gap-2 text-sm font-semibold text-fg">
          <span
            aria-hidden
            className="grid h-7 w-7 place-items-center rounded-md bg-info/15 text-sm"
          >
            🕗
          </span>
          {/* A phone keeps its width for the times: the clock says it. */}
          <span className="sr-only sm:not-sr-only">Play later</span>
        </p>
        {/* p-0.5 leaves room for the focus rings the scroller clips; it
            never scrolls up and down (a link's tap padding can poke out). */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto overflow-y-hidden p-0.5 [scrollbar-width:thin]">
          {strip.gone ? (
            <p className="min-w-44 flex-1 text-xs leading-4 text-muted sm:flex-none sm:whitespace-nowrap">
              The time in that link is over, or everyone on it dropped out.{" "}
              <a href={`#${PLAY_LATER_ANCHOR}`} className={textLink()}>
                See Play later below
              </a>
              .
            </p>
          ) : null}
          {strip.shown.length > 0 ? (
            <>
              <ul className="flex shrink-0 items-center gap-2">
                {strip.shown.map((time) => (
                  <StripChip
                    key={time.startsAtMs}
                    time={time}
                    user={user}
                    atCap={atCap}
                    nowMs={nowMs}
                    linked={time.startsAtMs === strip.linkedMs}
                  />
                ))}
              </ul>
              <a
                href={`#${PLAY_LATER_ANCHOR}`}
                className={textLink("ml-auto shrink-0 whitespace-nowrap px-1 text-sm")}
              >
                {inhouseTimesStripLinkText({ more: strip.more, atCap })}
                {/* The short "N more" names what it counts for a screen reader. */}
                {strip.more > 0 ? (
                  <span className="sr-only">{strip.more === 1 ? " time" : " times"}</span>
                ) : null}{" "}
                <span aria-hidden>↓</span>
              </a>
            </>
          ) : null}
        </div>
      </Card>
    </section>
  );
}
