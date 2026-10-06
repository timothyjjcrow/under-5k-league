import Link from "next/link";
import type { ReactNode } from "react";
import { Countdown } from "@/components/countdown";
import { LocalTime } from "@/components/local-time";
import { AvailabilityGrid } from "@/components/match-night-poll/availability-grid";
import { AvailabilityHeatmap } from "@/components/match-night-poll/availability-heatmap";
import {
  ClockNote,
  ClockToggle,
  PollClockProvider,
  YourTimeNote,
} from "@/components/match-night-poll/poll-clock";
import { SteamSignInButton, SteamSignInNote } from "@/components/steam-sign-in";
import { Badge, textLink } from "@/components/ui";
import type { SessionUser } from "@/lib/auth";
import {
  POLL_ANCHOR,
  pollTurnoutLine,
  type PollView,
} from "@/lib/match-night-poll";
import { loadHomePoll } from "@/lib/match-night-poll-service";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { cn } from "@/lib/utils";
import { zoneLabel } from "@/lib/zone-label";

/**
 * The match-night poll on Home, in every phase (and in the offseason view):
 * the open poll, or the last one for a week after it closes. Renders nothing
 * when there is neither, so it streams in with a null fallback.
 *
 * What it shows depends on the viewer: a signed-out visitor sees which times
 * are on offer and a Steam sign-in; a signed-in player who isn't signed up
 * for the season sees who votes and where to sign up; a signed-up player gets
 * the availability grid first, and once they've voted it folds to one line
 * and the count takes the space. After voting closes everyone gets the
 * result. Every time is on the viewer's own clock (PollClockProvider).
 */
export async function MatchNightPollCard({
  user,
  className,
}: {
  user: SessionUser | null;
  className?: string;
}) {
  // Async server component: rendered once per request.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const poll = await loadHomePoll(user, nowMs);
  if (!poll) return null;
  return <PollCard poll={poll} user={user} className={className} />;
}

function PollCard({
  poll,
  user,
  className,
}: {
  poll: PollView;
  user: SessionUser | null;
  className?: string;
}) {
  const voted = poll.myAvailability !== null;
  const winner =
    !poll.open && poll.results?.winner
      ? (poll.slots.find((slot) => slot.key === poll.results?.winner) ?? null)
      : null;
  const electorate = poll.electorate
    ? `players signed up for ${poll.electorate.seasonName}`
    : "players signed up for the league";
  const subtitle = poll.open
    ? voted
      ? "Thanks for voting. Here's who can play when, so far."
      : `Open to ${electorate}: tap every time you could play, as many as you like. The time the most players can make wins.`
    : winner
      ? "Voting has closed. Here's who could play when."
      : "Voting has closed.";

  const ballot = !poll.open ? null : !user ? (
    <TimesWithAsk poll={poll}>
      <SignInAsk electorate={electorate} />
    </TimesWithAsk>
  ) : poll.canVote ? (
    <AvailabilityGrid
      key={poll.myBallotAt ?? "new"}
      pollId={poll.id}
      slots={poll.slots}
      saved={poll.myAvailability}
    />
  ) : (
    <TimesWithAsk poll={poll}>
      <SignUpAsk poll={poll} electorate={electorate} />
    </TimesWithAsk>
  );
  const heatmap = poll.results ? (
    <AvailabilityHeatmap
      slots={poll.slots}
      result={poll.results}
      open={poll.open}
      noneOfThese={poll.noneOfThese}
      mine={poll.myAvailability}
    />
  ) : null;

  return (
    <section
      id={POLL_ANCHOR}
      aria-labelledby={`${POLL_ANCHOR}-title`}
      className={cn(
        "relative scroll-mt-24 overflow-hidden rounded-[var(--radius)] border bg-surface shadow-sm shadow-black/10",
        poll.open ? "border-accent/35" : "border-line",
        className,
      )}
    >
      {/* Decorative wash: a faint gold-to-blue tint and one soft glow. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-linear-to-br from-accent/[0.07] via-transparent to-info/[0.05]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-accent/10 blur-3xl"
      />
      <PollClockProvider
        leagueZone={poll.timeZone}
        clockAt={poll.clockAt}
        viewedAt={poll.viewedAt}
      >
        <div className="relative">
          <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-line-soft px-4 py-4 sm:px-5">
            <div className="min-w-0 flex-1 basis-64">
              <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                <span aria-hidden>🗳️ </span>Match night poll
              </p>
              <h2
                id={`${POLL_ANCHOR}-title`}
                className="mt-1.5 text-lg font-semibold leading-snug text-fg [overflow-wrap:anywhere]"
              >
                {poll.question}
              </h2>
              <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted">
                {subtitle}
              </p>
            </div>
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted sm:flex-col sm:items-end sm:text-right">
              {poll.open ? (
                <Badge tone="success">
                  <span
                    aria-hidden
                    className="animate-live-pulse inline-block h-1.5 w-1.5 rounded-full bg-success"
                  />
                  Voting open
                </Badge>
              ) : (
                <Badge>Voting closed</Badge>
              )}
              <span>
                {poll.open ? "Closes " : "Closed "}
                <LocalTime
                  ts={poll.closesAt}
                  variant="full"
                  initial={formatLeagueMatchTime(new Date(poll.closesAt), "full")}
                />
                {poll.open ? (
                  <Countdown
                    targetMs={poll.closesAt}
                    eventLabel="Voting"
                    futureVerb="closes"
                    passesAtTarget
                  />
                ) : null}
              </span>
              <span className="tabular-nums">
                {pollTurnoutLine(poll.ballots, poll.electorate, poll.open)}
              </span>
            </div>
          </header>

          <div className="space-y-6 p-4 sm:p-5">
            {/* Whose clock the grid and heatmap use, said up front: every
                time on them converts to the viewer's own zone. */}
            {heatmap || (poll.open && poll.canVote) ? (
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <ClockNote />
                <ClockToggle />
              </div>
            ) : null}

            {winner ? (
              <div className="flex min-w-0 flex-wrap items-center gap-4 rounded-lg border border-accent/40 bg-accent/10 p-4">
                <span aria-hidden className="text-3xl">
                  🏆
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                    The league picked
                  </p>
                  <p className="mt-0.5 text-xl font-bold text-fg [overflow-wrap:anywhere]">
                    {winner.label}
                  </p>
                  <p className="mt-0.5 text-sm text-muted">
                    {poll.results?.counts[winner.key]} of {poll.results?.ballots} voters
                    can play then. <YourTimeNote slot={winner} />
                  </p>
                </div>
              </div>
            ) : null}

            {/* Stacked, never side by side: a voter's folded grid is one
                short strip, and beside the count it left a hole. */}
            {ballot}
            {heatmap ? (
              <div className="min-w-0">
                {poll.open ? (
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
                    Who can play when
                  </h3>
                ) : null}
                {heatmap}
              </div>
            ) : null}

            {poll.open && !voted && poll.canVote && !poll.results ? (
              <p className="text-xs text-muted">
                The count opens to you once you&apos;ve voted, so everyone marks
                the times they can actually make.
              </p>
            ) : null}
          </div>
        </div>
      </PollClockProvider>
    </section>
  );
}

/** Which times are on offer, in a line, above what the viewer must do to vote. */
function TimesWithAsk({
  poll,
  children,
}: {
  poll: PollView;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm text-fg">
        <span className="font-semibold">Times on offer:</span> {poll.summary},{" "}
        {zoneLabel(poll.timeZone)} ({poll.slots.length} start times). The
        ballot shows every time converted to your local time.
      </p>
      {children}
    </div>
  );
}

/** Signed out: one way in, Steam sign-in, back to this card. */
function SignInAsk({ electorate }: { electorate: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <SteamSignInButton next={`/#${POLL_ANCHOR}`} size="md">
          Sign in with Steam to vote
        </SteamSignInButton>
        <span className="text-xs text-muted">
          Voting is for {electorate}. The count is shown once you vote, and
          to everyone when voting closes.
        </span>
      </div>
      <SteamSignInNote className="max-w-prose" />
    </div>
  );
}

/**
 * Signed in but not signed up: say who votes, and point at My account while
 * the season still takes a signup (a player one in SIGNUPS, a standin one
 * after the draft).
 */
function SignUpAsk({ poll, electorate }: { poll: PollView; electorate: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm">
      <p className="text-fg">
        Voting is for {electorate}, and you aren&apos;t signed up.
      </p>
      {poll.electorate?.signupsOpen ? (
        <p className="mt-1 text-muted">
          Sign up on{" "}
          <Link href="/me" className={textLink()}>
            My account
          </Link>{" "}
          and your ballot opens here.
        </p>
      ) : null}
    </div>
  );
}
