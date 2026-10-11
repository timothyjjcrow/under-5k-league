import Link from "@/components/app-link";
import { Suspense, cache } from "react";
import { setInhouseNightRsvpAction } from "@/app/actions/inhouse-night-rsvp";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  CopyInhouseNightInvite,
  InhouseNightInviteRsvp,
} from "@/components/inhouse-night-invite";
import { Countdown } from "@/components/countdown";
import { InhouseTimeWhen } from "@/components/inhouse-times-client";
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
import { INHOUSE } from "@/lib/constants";
import { queuePresentCutoff } from "@/lib/inhouse";
import {
  INHOUSE_NIGHT_INVITE_PATH,
  INHOUSE_NIGHT_LINK_DISCORD_PATH,
  currentInhouseNight,
  inhouseNightGoogleCalendarUrl,
  inhouseNightHeadcountSources,
  inhouseNightHeadcountText,
  inhouseNightInviteAction,
  inhouseNightPhase,
  inhouseNightRsvpControlKind,
  inhouseNightRsvpOpen,
  type InhouseNight,
} from "@/lib/inhouse-night";
import {
  inhouseNightHeadcountFor,
  inhouseNightNeedsDiscordFor,
  readInhouseNightRsvps,
  type InhouseNightRsvpPlayer,
} from "@/lib/inhouse-night-rsvp-service";
import { inhouseNightEventUrl, readInhouseNight } from "@/lib/inhouse-night-service";
import { inhouseTimeDayWord } from "@/lib/inhouse-times";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { formatLeagueMatchTime, leagueMatchTimeParts } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";
import { signInHref } from "@/lib/sign-in";
import { resolveSiteUrl } from "@/lib/site-url";

// The inhouse night on the site (rules: src/lib/inhouse-night.ts): the thin
// bar at the top of Home, the chip in /inhouse's top bar (beside the Play
// later times) with the card under Play later, and the count on /admin's
// card. They read one Setting row and the night's "I'm in" list;
// the Discord half of the headcount streams in on its own, so a slow Discord
// never holds up a page. Linked Discord ids stay on the server: they only
// feed the count.

/** "Said I'm in" chips on /inhouse before "and N more". */
const WHO_IS_IN_SHOWN = 24;

/** The night's card on /inhouse, which the top bar's chip links down to. */
export const INHOUSE_NIGHT_ANCHOR = "inhouse-night";

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
 * "12 coming": the site's "I'm in"s plus the Discord event's Interested
 * members, a player on both counted once (inhouseNightHeadcount). Nothing
 * while nobody has said so.
 */
async function Headcount({
  night,
  siteDiscordIds,
  sources,
  className,
}: {
  night: InhouseNight;
  siteDiscordIds: (string | null)[];
  sources: boolean;
  className?: string;
}) {
  const count = await inhouseNightHeadcountFor(night, siteDiscordIds);
  const text = inhouseNightHeadcountText(count);
  if (!text) return null;
  const from = sources ? inhouseNightHeadcountSources(count) : null;
  return <span className={className}>{from ? `${text} (${from})` : text}</span>;
}

/** The headcount, streamed: Discord's half never holds up the page. */
export function InhouseNightHeadcount({
  night,
  siteDiscordIds,
  sources = false,
  className,
}: {
  night: InhouseNight;
  /** From readInhouseNightRsvps: server-side only. */
  siteDiscordIds: (string | null)[];
  /** Say where the count comes from when both places add to it. */
  sources?: boolean;
  className?: string;
}) {
  return (
    <Suspense fallback={null}>
      <Headcount
        night={night}
        siteDiscordIds={siteDiscordIds}
        sources={sources}
        className={className}
      />
    </Suspense>
  );
}

/**
 * The viewer's "I'm in": one toggle, the way Discord's Interested button
 * works. Pressed once they're in, and pressing it again takes them off the
 * list. Offered while the night is ahead; once it's on, only someone already
 * in still sees it, so taking it back is never hidden. Signed out, it's a
 * sign-in that comes back to the invite link, which says "I'm in" for them.
 * Signed in without a linked Discord (`needsDiscord`), it's the account link,
 * which comes back to the invite link the same way.
 */
export function InhouseNightRsvpControl({
  night,
  user,
  mine,
  needsDiscord,
  nowMs,
  signedOutLabel = "I'm in",
  needsDiscordLabel = "I'm in",
  compact = false,
}: {
  night: InhouseNight;
  user: SessionUser | null;
  mine: boolean;
  /** inhouseNightNeedsDiscordFor: link Discord before saying "I'm in". */
  needsDiscord: boolean;
  nowMs: number;
  signedOutLabel?: string;
  needsDiscordLabel?: string;
  /** /inhouse's top bar: a refusal stays in its toast, so the bar never grows. */
  compact?: boolean;
}) {
  const kind = inhouseNightRsvpControlKind({
    open: inhouseNightRsvpOpen(night, nowMs),
    signedIn: !!user,
    mine,
    needsDiscord,
  });
  if (kind === "none") return null;
  if (kind === "sign-in") {
    return (
      <Link
        href={signInHref(INHOUSE_NIGHT_INVITE_PATH)}
        className={buttonClasses("primary", "sm")}
      >
        {signedOutLabel}
      </Link>
    );
  }
  if (kind === "link") {
    // A full-page trip through Discord's consent, so a plain anchor: a Link
    // would prefetch the route that starts it (account-discord-card's rule).
    return (
      <a href={INHOUSE_NIGHT_LINK_DISCORD_PATH} className={buttonClasses("primary", "sm")}>
        {needsDiscordLabel}
      </a>
    );
  }
  return (
    <ActionForm
      action={setInhouseNightRsvpAction}
      hidden={{ nightId: night.id, going: mine ? "0" : "1" }}
      inlineError={!compact}
    >
      <SubmitButton
        size="sm"
        variant={mine ? "secondary" : "primary"}
        className={mine ? "border-success/50 text-success" : undefined}
        aria-pressed={mine}
      >
        {mine ? <span aria-hidden>✓</span> : null}
        I&apos;m in
      </SubmitButton>
    </ActionForm>
  );
}

/**
 * Home's thin bar while a night is planned or on, above everything else:
 * when it is, how many are coming, and "I'm in" (or, once it's on, the queue
 * count and a one-tap join). Home passes the current night
 * (loadCurrentInhouseNight) and renders nothing without one.
 */
export async function InhouseNightBar({
  user,
  night,
  nowMs,
}: {
  user: SessionUser | null;
  night: InhouseNight;
  nowMs: number;
}) {
  const on = inhouseNightPhase(night, nowMs) === "on";
  const [rsvps, queued, needsDiscord] = await Promise.all([
    readInhouseNightRsvps(night.id),
    // Same presence rule as /inhouse: only recently seen players count.
    on
      ? prisma.inhouseQueueEntry.count({
          where: { lastSeenAt: { gte: queuePresentCutoff(nowMs) } },
        })
      : Promise.resolve(0),
    on ? Promise.resolve(false) : inhouseNightNeedsDiscordFor(user?.id),
  ]);
  const mine = !!user && rsvps.players.some((player) => player.id === user.id);
  // One wrapping row of single items, not a text block beside a button
  // group, so a phone packs it into two lines; the spacer keeps the button
  // at the right end of whichever line it lands on. The title links to the
  // night's card on /inhouse, which has the rest: it sits under the room
  // now, below the first screen, so the link names its anchor.
  return (
    <section
      aria-label="Inhouse night"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--radius)] border border-accent/40 bg-surface-2/70 px-3 py-2 text-sm text-fg"
    >
      <Link
        href={`/inhouse#${INHOUSE_NIGHT_ANCHOR}`}
        className={textLink("inline-flex items-center gap-2 font-semibold text-accent")}
      >
        <span aria-hidden>🎮</span>
        {on ? "Inhouse night is on" : "Inhouse night"} <LinkArrow />
      </Link>
      {on ? (
        <span>{`${queued}/${INHOUSE.LOBBY_SIZE} in the queue`}</span>
      ) : (
        <InhouseNightWhen night={night} />
      )}
      <InhouseNightHeadcount
        night={night}
        siteDiscordIds={rsvps.discordIds}
        className="text-muted"
      />
      <span aria-hidden className="ml-auto" />
      {on ? (
        // The Discord start post's one-tap join (?join=1): the label says
        // it joins, so the tap does.
        <Link href="/inhouse?join=1" className={buttonClasses("primary", "sm")}>
          Join the queue <LinkArrow />
        </Link>
      ) : (
        <InhouseNightRsvpControl
          night={night}
          user={user}
          mine={mine}
          needsDiscord={needsDiscord}
          nowMs={nowMs}
        />
      )}
    </section>
  );
}

/** Who said "I'm in" on the site, first to say so first, as profile chips. */
function WhoIsIn({ players }: { players: InhouseNightRsvpPlayer[] }) {
  const shown = players.slice(0, WHO_IS_IN_SHOWN);
  const rest = players.length - shown.length;
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted">Said I&apos;m in on the site:</p>
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
        {rest > 0 ? (
          <li className="self-center text-xs text-muted">and {rest} more</li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * /inhouse's one read of the night: the clock it was judged by, the night,
 * its phase, the viewer, the "I'm in" list, whether the viewer must link
 * Discord first, and whether they're in. Request-cached, so the chip in the
 * top bar and the card under Play later show the same night from one read.
 * Null while no night is set (or the last one is over).
 */
export const loadInhouseNightView = cache(async () => {
  const nowMs = Date.now();
  const night = await loadCurrentInhouseNight(nowMs);
  if (!night) return null;
  const [user, rsvps] = await Promise.all([
    getSessionUser(),
    readInhouseNightRsvps(night.id),
  ]);
  const needsDiscord = await inhouseNightNeedsDiscordFor(user?.id);
  const phase = inhouseNightPhase(night, nowMs);
  const mine = !!user && rsvps.players.some((player) => player.id === user.id);
  return { nowMs, night, phase, user, rsvps, needsDiscord, mine };
});

/**
 * The night in /inhouse's top bar, beside the Play later times (Tim,
 * 2026-10-10: the whole queue on the first screen, so the night rides the
 * one bar instead of a card above the room). One chip, one button high and
 * one row: a link down to the night's card, its start on the viewer's clock
 * (with its date past tomorrow: a night can be weeks off), the headcount,
 * and "I'm in" by the night's rule, or once it's on a jump to the queue. For
 * a player who must link Discord first it is "Link Discord", the words the
 * invite link's note tells them to press. No countdown, no faces, no note:
 * those are the card's.
 */
export function InhouseNightChip({
  view,
}: {
  view: NonNullable<Awaited<ReturnType<typeof loadInhouseNightView>>>;
}) {
  const { nowMs, night, phase, user, rsvps, needsDiscord, mine } = view;
  const on = phase === "on";
  const start = new Date(night.startsAtMs);
  // The browser's words ("Today, 8:00 PM", else the date) on the league's
  // clock, zone named, as the time chips do, so the text keeps its shape.
  const day = inhouseTimeDayWord(night.startsAtMs, nowMs, LEAGUE_CONFIG.timeZone);
  const initial = day
    ? `${day}, ${leagueMatchTimeParts(start).time}`
    : formatLeagueMatchTime(start, "full");
  return (
    <section
      aria-label="Inhouse night"
      className="flex shrink-0 items-center gap-2 rounded-lg border border-accent/40 bg-surface-2/50 py-0.5 pl-1 pr-0.5"
    >
      <a
        href={`#${INHOUSE_NIGHT_ANCHOR}`}
        className={textLink("inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-accent")}
      >
        <span
          aria-hidden
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent/15 text-sm"
        >
          🎮
        </span>
        <span className="sr-only whitespace-nowrap sm:not-sr-only">
          {on ? "Inhouse night is on" : "Inhouse night"}
        </span>
      </a>
      <span className="whitespace-nowrap text-sm font-semibold text-fg">
        <InhouseTimeWhen ts={night.startsAtMs} initial={initial} dated />
      </span>
      {/* The count is on the card below; on a phone the chip keeps its
          date and its button whole inside the bar. */}
      <InhouseNightHeadcount
        night={night}
        siteDiscordIds={rsvps.discordIds}
        className="hidden whitespace-nowrap text-xs text-muted sm:inline"
      />
      {on ? (
        <a href="#live-room" className={textLink("whitespace-nowrap px-1 text-sm font-medium")}>
          Join<span className="sr-only"> the queue</span> <span aria-hidden>↓</span>
        </a>
      ) : null}
      <InhouseNightRsvpControl
        night={night}
        user={user}
        mine={mine}
        needsDiscord={needsDiscord}
        nowMs={nowMs}
        needsDiscordLabel="Link Discord"
        compact
      />
    </section>
  );
}

/**
 * The night's card on /inhouse while a night is set, under Play later (the
 * top bar's chip links down to it); nothing otherwise. Opened from the
 * invite link (`invite`), it answers the invite once.
 */
export async function InhouseNightCard({ invite = false }: { invite?: boolean } = {}) {
  const view = await loadInhouseNightView();
  if (!view) return null;
  const { nowMs, night, phase, user, rsvps, needsDiscord, mine } = view;
  const on = phase === "on";
  const inviteAction = inhouseNightInviteAction({
    param: invite ? "1" : null,
    phase,
    signedIn: !!user,
    mine,
    needsDiscord,
  });
  const eventUrl = inhouseNightEventUrl(night);
  const google = inhouseNightGoogleCalendarUrl(night, resolveSiteUrl(), LEAGUE_CONFIG.name);
  return (
    // The top bar's chip and Home's bar link here (the browser, or Next's
    // router from Home, scrolls to it once it streams in; zz-inhouse-night
    // lands on it from Home). Inside the card, so no night leaves no empty
    // region behind.
    <section id={INHOUSE_NIGHT_ANCHOR} aria-label="Inhouse night details" className="scroll-mt-28">
      <Card>
        <CardHeader
          headingLevel={2}
          title={on ? "Inhouse night is on" : "Inhouse night"}
          subtitle={
            on
              ? "Join the queue above: the lobby fires at ten players."
              : "Coming? Say you're in so everyone can see the lobby will fill. Queue up here when it starts: the lobby fires at ten players, and captains draft the teams."
          }
        />
        <CardBody className="space-y-3">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-medium text-fg">
            <InhouseNightWhen night={night} />
          </p>
          {night.note ? (
            <p className="text-sm text-muted [overflow-wrap:anywhere]">{night.note}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <InhouseNightRsvpControl
              night={night}
              user={user}
              mine={mine}
              needsDiscord={needsDiscord}
              nowMs={nowMs}
              signedOutLabel="Sign in to say you're in"
              needsDiscordLabel="Link Discord to say you're in"
            />
            {mine ? (
              <span className="text-muted">
                You&apos;re on the list. Press it again if you can&apos;t make it.
                {/* In from before "I'm in" needed Discord: one link counts them
                    once beside Discord's Interested and gets them the ping. */}
                {needsDiscord ? (
                  <>
                    {" "}
                    <a href={INHOUSE_NIGHT_LINK_DISCORD_PATH} className={textLink()}>
                      Link Discord
                    </a>
                    {" so you're counted once and get a ping when it starts."}
                  </>
                ) : null}
              </span>
            ) : null}
            <InhouseNightHeadcount
              night={night}
              siteDiscordIds={rsvps.discordIds}
              sources
              className="text-muted"
            />
          </div>
          {rsvps.players.length > 0 ? <WhoIsIn players={rsvps.players} /> : null}
          {invite ? <InhouseNightInviteRsvp nightId={night.id} action={inviteAction} /> : null}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <CopyInhouseNightInvite />
            {eventUrl ? (
              <a href={eventUrl} target="_blank" rel="noreferrer" className={textLink()}>
                Or mark yourself interested on Discord <LinkArrow out />
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
    </section>
  );
}
