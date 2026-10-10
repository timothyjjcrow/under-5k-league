import Link from "next/link";
import { setInhouseTimeAction } from "@/app/actions/inhouse-times";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Countdown } from "@/components/countdown";
import { CopyInhouseTimeLink, InhouseTimePicker } from "@/components/inhouse-times-client";
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
  inhouseTimeGoogleCalendarUrl,
  inhouseTimeLinkPath,
  inhouseTimeParam,
  parseInhouseTimeParam,
  upcomingInhouseTimesFor,
  type InhouseTime,
  type InhouseTimePlayer,
} from "@/lib/inhouse-times";
import { readInhouseTimes } from "@/lib/inhouse-times-service";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { signInHref } from "@/lib/sign-in";
import { resolveSiteUrl } from "@/lib/site-url";
import { cn } from "@/lib/utils";

// Play later on /inhouse (rules: src/lib/inhouse-times.ts): the times players
// posted, who's in on each, "I'm in", and "Post a time". Nothing here posts
// to Discord or pings anyone; a time's link is the one way to share it.

/** Profile chips on a time before "and N more": a full lobby's worth. */
const PLAYERS_SHOWN = 10;

/** The anchor the card sits under, and the one its sign-in comes back to. */
export const PLAY_LATER_ANCHOR = "play-later";

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
  const mine = !!user && time.players.some((player) => player.id === user.id);
  const controls = inhouseTimeControls({ phase: time.phase, signedIn: !!user, mine, atCap });
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
        {controls.queue ? (
          // The room is on this page: the queue is a jump away, not a
          // reload (the inhouse night's ?join=1 is for links from elsewhere).
          <a href="#live-room" className={buttonClasses("primary", "sm")}>
            Join the queue <LinkArrow />
          </a>
        ) : null}
        {controls.rsvp === "none" ? null : (
          <RsvpControl kind={controls.rsvp} time={time} mine={mine} describedBy={whenId} />
        )}
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
  // eslint-disable-next-line react-hooks/purity -- async server component
  const nowMs = Date.now();
  const [user, times] = await Promise.all([getSessionUser(), readInhouseTimes(nowMs)]);
  const linkedMs = linked === undefined ? null : parseInhouseTimeParam(linked);
  const linkedGone =
    linked !== undefined &&
    (linkedMs === null || !times.some((time) => time.startsAtMs === linkedMs));
  const atCap =
    !!user && upcomingInhouseTimesFor(times, user.id) >= INHOUSE_TIME_MAX_PER_PLAYER;
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
