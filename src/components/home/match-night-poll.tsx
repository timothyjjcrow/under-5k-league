import Link from "next/link";
import type { ReactNode } from "react";
import { Countdown } from "@/components/countdown";
import { LocalTime } from "@/components/local-time";
import { PollBallot } from "@/components/match-night-poll/poll-ballot";
import { PollRunoff } from "@/components/match-night-poll/poll-runoff";
import { SlotFace } from "@/components/match-night-poll/slot-face";
import { SteamSignInButton, SteamSignInNote } from "@/components/steam-sign-in";
import { Badge, textLink } from "@/components/ui";
import type { SessionUser } from "@/lib/auth";
import { POLL_ANCHOR, type PollView } from "@/lib/match-night-poll";
import { loadHomePoll } from "@/lib/match-night-poll-service";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { cn } from "@/lib/utils";

/**
 * The match-night poll on Home, in every phase (and in the offseason view):
 * the open poll, or the last one for a week after it closes. Renders nothing
 * when there is neither, so it streams in with a null fallback.
 *
 * What it shows depends on the viewer: a signed-out visitor sees the slots
 * and a Steam sign-in; a signed-in player who hasn't voted gets the ballot
 * first; once they've voted, their ranking folds to one line and the live
 * count takes the space. After voting closes everyone gets the result.
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
  const voted = poll.myRanking !== null;
  const winner = !poll.open && poll.results?.winner
    ? poll.slots.find((slot) => slot.key === poll.results?.winner) ?? null
    : null;
  const electorate = poll.electorate
    ? `players signed up for ${poll.electorate.seasonName}`
    : "players signed up for the league";
  const subtitle = poll.open
    ? voted
      ? "Thanks for voting. Here's how the count stands right now."
      : `Open to ${electorate}: rank every slot you can make, favourite first, and leave out any you can't. If your top pick is knocked out, your vote moves to your next one.`
    : winner
      ? "Voting has closed. Here's how the ranked-choice count played out."
      : "Voting has closed.";

  // Voters see the count under their own ballot; before voting, the ballot
  // has the card to itself.
  const ballot = !poll.open ? null : !user ? (
    <SlotsWithAsk poll={poll}>
      <SignInAsk electorate={electorate} />
    </SlotsWithAsk>
  ) : poll.canVote ? (
    <PollBallot
      key={poll.myBallotAt ?? "new"}
      pollId={poll.id}
      slots={poll.slots}
      savedRanking={poll.myRanking}
    />
  ) : (
    <SlotsWithAsk poll={poll}>
      <SignUpAsk poll={poll} electorate={electorate} />
    </SlotsWithAsk>
  );
  const runoff = poll.results ? (
    <PollRunoff
      slots={poll.slots}
      result={poll.results}
      open={poll.open}
      noneOfThese={poll.noneOfThese}
      myFirst={poll.myRanking?.[0] ?? null}
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
      <div className="relative">
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-line-soft px-4 py-4 sm:px-5">
          <div className="min-w-0 flex-1 basis-64">
            <p className="text-xs font-semibold uppercase tracking-wider text-accent">
              <span aria-hidden>🗳️ </span>Match night poll · ranked choice
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
              {poll.open ? (
                <>
                  Closes{" "}
                  <LocalTime
                    ts={poll.closesAt}
                    variant="full"
                    initial={formatLeagueMatchTime(new Date(poll.closesAt), "full")}
                  />
                  <Countdown
                    targetMs={poll.closesAt}
                    eventLabel="Voting"
                    futureVerb="closes"
                    passesAtTarget
                  />
                </>
              ) : (
                <>
                  Closed{" "}
                  <LocalTime
                    ts={poll.closesAt}
                    variant="full"
                    initial={formatLeagueMatchTime(new Date(poll.closesAt), "full")}
                  />
                </>
              )}
            </span>
            <span className="tabular-nums">
              {poll.ballots} vote{poll.ballots === 1 ? "" : "s"}
              {poll.open ? " so far" : ""}
            </span>
          </div>
        </header>

        <div className="space-y-6 p-4 sm:p-5">
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
              </div>
            </div>
          ) : null}

          {/* Stacked, never side by side: a voter's folded ballot is one
              short strip, and beside the count it left a hole. */}
          {ballot}
          {runoff ? (
            <div className="min-w-0">
              {poll.open ? (
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
                  Live count
                </h3>
              ) : null}
              {runoff}
            </div>
          ) : null}

          {poll.open && !voted && poll.canVote && !poll.results ? (
            <p className="text-xs text-muted">
              The live count opens to you once you&apos;ve voted, so everyone
              ranks what they can actually make.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** The slots as a read-only list, above whatever the viewer must do to vote. */
function SlotsWithAsk({
  poll,
  children,
}: {
  poll: PollView;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <ul
        aria-label="Slots on the ballot"
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {poll.slots.map((slot) => (
          <li
            key={slot.key}
            className="min-w-0 rounded-lg border border-line bg-surface-2/40 p-2 pl-2.5"
          >
            <SlotFace slot={slot} />
          </li>
        ))}
      </ul>
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
