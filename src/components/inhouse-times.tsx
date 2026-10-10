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
  inhouseTimeWhoText,
  parseInhouseTimeParam,
  upcomingInhouseTimesFor,
  type InhouseTime,
  type InhouseTimePlayer,
} from "@/lib/inhouse-times";
import { readInhouseTimes } from "@/lib/inhouse-times-service";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { formatLeagueMatchTime, leagueMatchTimeParts } from "@/lib/match-time";
import { signInHref } from "@/lib/sign-in";
import { resolveSiteUrl } from "@/lib/site-url";
import { cn } from "@/lib/utils";

// Play later on /inhouse (rules: src/lib/inhouse-times.ts): the card with
// the times players posted, who's in on each, "I'm in", and "Post a time",
// and the strip above the live room with the soonest few. Nothing here posts
// to Discord or pings anyone; a time's link is the one way to share it.

/** Profile chips on a time before "and N more": a full lobby's worth. */
const PLAYERS_SHOWN = 10;

/** Faces in a strip tile's avatar stack before "+N". */
const STRIP_FACES_SHOWN = 5;

/** The anchor the card sits under, and the one its sign-in comes back to. */
export const PLAY_LATER_ANCHOR = "play-later";

/**
 * The page's one read of Play later: the clock it judged the times by, the
 * viewer, the times, and whether the viewer is at the cap. Request-cached,
 * so the strip at the top and the card under the room show the same times
 * from one query and never disagree.
 */
const loadPlayLater = cache(async () => {
  const nowMs = Date.now();
  const [user, times] = await Promise.all([getSessionUser(), readInhouseTimes(nowMs)]);
  const atCap =
    !!user && upcomingInhouseTimesFor(times, user.id) >= INHOUSE_TIME_MAX_PER_PLAYER;
  return { nowMs, user, times, atCap };
});

/** What one time offers the viewer, by the one rule both the card and the strip use. */
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
}: {
  kind: "sign-in" | "toggle";
  time: InhouseTime;
  mine: boolean;
  describedBy: string;
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
 * is for links from elsewhere), and "I'm in" as the rule says.
 */
function TimeActions({
  time,
  mine,
  controls,
  describedBy,
}: {
  time: InhouseTime;
  mine: boolean;
  controls: ReturnType<typeof viewOf>["controls"];
  describedBy: string;
}) {
  return (
    <>
      {controls.queue ? (
        <a href="#live-room" className={buttonClasses("primary", "sm")}>
          Join the queue <LinkArrow />
        </a>
      ) : null}
      {controls.rsvp === "none" ? null : (
        <RsvpControl kind={controls.rsvp} time={time} mine={mine} describedBy={describedBy} />
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
 * The Play later card. Below the live room normally; the page puts it first
 * when it was opened from a time's link (`linked`, the link's `at`, "" for
 * one that names nothing), with that time picked out, or a line saying it's
 * gone.
 */
export async function InhouseTimesCard({ linked }: { linked?: string } = {}) {
  const { user, times, atCap } = await loadPlayLater();
  const linkedMs = linked === undefined ? null : parseInhouseTimeParam(linked);
  const linkedGone =
    linked !== undefined &&
    (linkedMs === null || !times.some((time) => time.startsAtMs === linkedMs));
  const site = resolveSiteUrl();
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Play later"
        subtitle="Can't play right now? Post when you can, or say you're in on someone's time, so everyone can see when a lobby will fill. When it comes round, join the queue here."
      />
      <CardBody className="space-y-4">
        {linkedGone ? (
          <p className="rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-sm text-muted">
            The time in that link is over, or everyone on it has dropped out. Post a new one
            below.
          </p>
        ) : null}
        {times.length > 0 ? (
          <ul className="space-y-3">
            {times.map((time) => (
              <TimeRow
                key={time.startsAtMs}
                time={time}
                user={user}
                atCap={atCap}
                linked={time.startsAtMs === linkedMs}
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
 * Who's in on a time as a row of faces, the first STRIP_FACES_SHOWN and a
 * "+N". A picture, so it carries the names as its label (and a tooltip);
 * the card under the room has everyone's profile links.
 */
function FaceStack({ players }: { players: InhouseTimePlayer[] }) {
  const shown = players.slice(0, STRIP_FACES_SHOWN);
  const rest = players.length - shown.length;
  const label = inhouseTimeWhoText(
    players.map((player) => player.name),
    STRIP_FACES_SHOWN,
  );
  return (
    <span role="img" aria-label={label} title={label} className="flex shrink-0 items-center">
      {/* bg and size reach only the initials a player without a picture gets. */}
      {shown.map((player, i) => (
        <Avatar
          key={player.id}
          name={player.name}
          src={player.avatar}
          size={24}
          className={cn("bg-surface-3 text-[10px] ring-2 ring-surface", i > 0 && "-ml-1")}
        />
      ))}
      {rest > 0 ? (
        <span className="-ml-1 grid h-6 min-w-6 place-items-center rounded-full bg-surface-3 px-1 text-[10px] font-semibold tabular-nums text-muted ring-2 ring-surface">
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

/** One time in the strip: when, who's in, and the same buttons as its row in the card. */
function StripTile({
  time,
  user,
  atCap,
  nowMs,
  single,
}: {
  time: InhouseTime;
  user: SessionUser | null;
  atCap: boolean;
  nowMs: number;
  /** The strip's only tile: a phone's full width, no row to swipe. */
  single: boolean;
}) {
  const { mine, controls } = viewOf(time, user, atCap);
  const acts = controls.queue || controls.rsvp !== "none";
  // Two buttons ("Join the queue" and the pressed "I'm in" of a player in on
  // a time that's on) never fit beside the time on a phone: they take the
  // tile's foot instead, so the time and its countdown keep their width.
  const twoActions = controls.queue && controls.rsvp !== "none";
  // Not the card row's id: both show the same time, and each button names its own.
  const whenId = `inhouse-time-next-${time.startsAtMs}`;
  const start = new Date(time.startsAtMs);
  // The browser's words ("Today, 8:00 PM") on the league's clock, zone
  // named, so the text keeps its shape when the viewer's clock takes over.
  const day = inhouseTimeDayWord(time.startsAtMs, nowMs, LEAGUE_CONFIG.timeZone);
  const initial = day
    ? `${day}, ${leagueMatchTimeParts(start).time}`
    : formatLeagueMatchTime(start, "full");
  // An @container: a tile wide enough (a phone's tile, or one of three on a
  // desktop) keeps one button beside the time, so it is two lines high; a
  // narrow one (three across a tablet), or one with two buttons, puts them at
  // its foot. On a phone the tiles are a swipeable row (the strip's list).
  return (
    <li
      className={cn(
        "@container flex min-w-0 shrink-0 snap-start flex-col rounded-lg border bg-surface-2/50 px-3 py-2.5 sm:basis-auto",
        single ? "basis-full" : "basis-[85%]",
        time.phase === "on" ? "border-success/40" : "border-line",
      )}
    >
      <div
        className={cn(
          "grid flex-1 grid-cols-1 grid-rows-[auto_auto_1fr] gap-2",
          !twoActions &&
            "@2xs:grid-cols-[minmax(0,1fr)_auto] @2xs:grid-rows-[auto_auto] @2xs:content-center @2xs:gap-x-3",
        )}
      >
        <p id={whenId} className="min-w-0 text-sm font-semibold text-fg">
          <InhouseTimeWhen ts={time.startsAtMs} initial={initial} />
          <Countdown targetMs={time.startsAtMs} eventLabel="Inhouse" />
        </p>
        <div className="flex min-w-0 items-center gap-2.5 @2xs:col-span-2">
          <FaceStack players={time.players} />
          <span className="min-w-0 text-xs text-muted">
            {inhouseTimeCountText(time.players.length)}
          </span>
        </div>
        {acts ? (
          <div
            className={cn(
              "flex flex-wrap items-center gap-2 self-end",
              !twoActions && "@2xs:col-start-2 @2xs:row-start-1 @2xs:self-center @2xs:justify-end",
            )}
          >
            <TimeActions time={time} mine={mine} controls={controls} describedBy={whenId} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The Play later strip, above the live room (Tim, 2026-10-10): the soonest
 * open times at a glance, each with its "I'm in", so a visitor sees them
 * without scrolling past the queue. Nothing at all while no time is open, or
 * when the page was opened from a time's link (`linked`), which puts the
 * whole card first instead (inhouseTimesStrip decides both). Posting, the
 * links and everyone's names stay on the card under the room.
 */
export async function InhouseTimesStrip({ linked }: { linked: boolean }) {
  const { nowMs, user, times, atCap } = await loadPlayLater();
  const strip = inhouseTimesStrip(times, { linked });
  if (!strip) return null;
  return (
    <section id="play-later-next" aria-label="Play later times">
      {/* overflow-hidden: the phone row below scrolls inside the card, never the page. */}
      <Card className="space-y-3 overflow-hidden p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            aria-hidden
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-info/15 text-base"
          >
            🕗
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[0.9375rem] font-semibold leading-snug text-fg">Play later</h2>
            <p className="text-xs text-muted">Times players posted</p>
          </div>
          <a href={`#${PLAY_LATER_ANCHOR}`} className={textLink("shrink-0 text-sm")}>
            {inhouseTimesStripLinkText({ more: strip.more, atCap })}{" "}
            <span aria-hidden>↓</span>
          </a>
        </div>
        {/* A phone swipes one row of tiles, the next peeking in, so the strip
            stays one tile high and the queue stays on the first screen; from
            sm up they sit side by side. */}
        <ul className="-mx-3 flex snap-x snap-mandatory gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:thin] sm:mx-0 sm:grid sm:overflow-visible sm:px-0 sm:pb-0 sm:[grid-template-columns:repeat(auto-fit,minmax(min(14rem,100%),1fr))]">
          {strip.shown.map((time) => (
            <StripTile
              key={time.startsAtMs}
              time={time}
              user={user}
              atCap={atCap}
              nowMs={nowMs}
              single={strip.shown.length === 1}
            />
          ))}
        </ul>
      </Card>
    </section>
  );
}
