import Link from "@/components/app-link";
import {
  answerRollCallAction,
  takeBackRollCallAction,
} from "@/app/actions/roll-call";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { SteamSignInButton, SteamSignInNote } from "@/components/steam-sign-in";
import { Avatar, Badge, PlayerLink, textLink } from "@/components/ui";
import type { SessionUser } from "@/lib/auth";
import { formatLeagueMatchTime } from "@/lib/match-time";
import {
  ROLL_CALL_ANCHOR,
  rollCallCountLine,
  type RollCallPlayer,
  type RollCallView,
} from "@/lib/roll-call";
import { loadHomeRollCall } from "@/lib/roll-call-service";
import { cn } from "@/lib/utils";
import { RollCallClock, RollCallYourTime } from "./roll-call-clock";

/**
 * The roll call on Home, during signups and the draft while an admin has it
 * open: what a player commits to (the season's match night on their own
 * clock, every week, for whichever team drafts them), one "I'm in" button,
 * and the whole list of who is in and who hasn't answered yet. Renders
 * nothing while it is closed, so it streams in with a null fallback.
 */
export async function RollCallCard({
  user,
  className,
}: {
  user: SessionUser | null;
  className?: string;
}) {
  // Async server component: rendered once per request.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const view = await loadHomeRollCall(user, nowMs);
  if (!view) return null;
  return <RollCallSection view={view} viewerId={user?.id ?? null} className={className} />;
}

function RollCallSection({
  view,
  viewerId,
  className,
}: {
  view: RollCallView;
  viewerId: string | null;
  className?: string;
}) {
  const total = view.locked.length + view.waiting.length;
  const percent = total > 0 ? Math.round((view.locked.length / total) * 100) : 0;
  const owes = view.viewer === "owed" || view.viewer === "renew";
  return (
    <section
      id={ROLL_CALL_ANCHOR}
      aria-labelledby={`${ROLL_CALL_ANCHOR}-title`}
      className={cn(
        "relative scroll-mt-24 overflow-hidden rounded-[var(--radius)] border bg-surface shadow-sm shadow-black/10",
        owes ? "border-accent/45" : "border-line",
        className,
      )}
    >
      {/* Decorative wash: a faint green-to-gold tint and one soft glow. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-linear-to-br from-success/[0.06] via-transparent to-accent/[0.06]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-success/10 blur-3xl"
      />
      <div className="relative">
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-line-soft px-4 py-4 sm:px-5">
          <div className="min-w-0 flex-1 basis-64">
            <p className="text-xs font-semibold uppercase tracking-wider text-success">
              <span aria-hidden>✋ </span>Roll call
            </p>
            <h2
              id={`${ROLL_CALL_ANCHOR}-title`}
              className="mt-1.5 text-lg font-semibold leading-snug text-fg [overflow-wrap:anywhere]"
            >
              Are you in for {view.seasonName}?
            </h2>
            <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted">
              Every player signed up for the draft locks in here, so captains
              draft people who will show up from the first match night. It
              takes one tap.
            </p>
          </div>
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted sm:flex-col sm:items-end sm:text-right">
            <Badge tone="success">
              <span
                aria-hidden
                className="animate-live-pulse inline-block h-1.5 w-1.5 rounded-full bg-success"
              />
              Open
            </Badge>
            <span className="tabular-nums">
              {rollCallCountLine(view.locked.length, total)}
            </span>
          </div>
        </header>

        <div className="space-y-5 p-4 sm:p-5">
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
            <Commitment view={view} />
            <div className="min-w-0">
              <Answer view={view} />
            </div>
          </div>

          <div
            role="progressbar"
            aria-label="Players in"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={view.locked.length}
            aria-valuetext={rollCallCountLine(view.locked.length, total)}
            className="h-2 overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full rounded-full bg-success transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </div>

          <PlayerList
            title="Locked in"
            players={view.locked}
            viewerId={viewerId}
            done
            empty="Nobody yet. Be the first."
          />
          <PlayerList
            title="Not yet"
            players={view.waiting}
            viewerId={viewerId}
            empty="Everyone signed up is in."
          />
        </div>
      </div>
    </section>
  );
}

/** What "I'm in" promises, in three lines, with the night on the viewer's clock. */
function Commitment({ view }: { view: RollCallView }) {
  return (
    <RollCallClock timeZone={view.timeZone} clockAt={view.clockAt} viewedAt={view.viewedAt}>
      <ul className="min-w-0 space-y-3 rounded-lg border border-line bg-surface-2/40 p-4 text-sm">
        <li className="flex gap-3">
          <span aria-hidden className="text-lg leading-6">
            🗓️
          </span>
          <div className="min-w-0">
            <p className="text-fg">
              Match night is{" "}
              <span className="font-semibold [overflow-wrap:anywhere]">{view.night}</span>.
            </p>
            {view.slot ? (
              <p className="mt-0.5 text-muted">
                <RollCallYourTime slot={view.slot} />
              </p>
            ) : null}
          </div>
        </li>
        <li className="flex gap-3">
          <span aria-hidden className="text-lg leading-6">
            📅
          </span>
          <p className="min-w-0 text-fg">
            You can play it <span className="font-semibold">every week</span>{" "}
            for the whole season: the regular season and the playoffs, a few
            months.
          </p>
        </li>
        <li className="flex gap-3">
          <span aria-hidden className="text-lg leading-6">
            🤝
          </span>
          <p className="min-w-0 text-fg">
            You&apos;ll play for <span className="font-semibold">whichever team drafts you</span>,
            and show up from the first match night.
          </p>
        </li>
      </ul>
    </RollCallClock>
  );
}

/** The viewer's part: sign in, sign up, "I'm in", or "You're in". */
function Answer({ view }: { view: RollCallView }) {
  switch (view.viewer) {
    case "signed-out":
      return (
        <div className="space-y-2">
          <SteamSignInButton next={`/#${ROLL_CALL_ANCHOR}`} size="md" className="w-full">
            Sign in with Steam to answer
          </SteamSignInButton>
          <p className="text-xs text-muted">
            The roll call is for players signed up for the draft.
          </p>
          <SteamSignInNote />
        </div>
      );
    case "not-listed":
      return (
        <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm">
          <p className="text-fg">
            The roll call is for players signed up for the draft. Standins and
            visitors can follow along here.
          </p>
          {view.signupsOpen ? (
            <p className="mt-1 text-muted">
              Want to play?{" "}
              <Link href="/me" className={textLink()}>
                Sign up on My account
              </Link>{" "}
              and answer here.
            </p>
          ) : null}
        </div>
      );
    case "in":
      return (
        <div className="space-y-3 rounded-lg border border-success/40 bg-success/10 p-4">
          <p className="flex items-center gap-2 text-base font-semibold text-fg">
            <span
              aria-hidden
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success text-sm text-black"
            >
              ✓
            </span>
            You&apos;re locked in
          </p>
          {view.answeredAtMs ? (
            <p className="text-xs text-muted">
              Since{" "}
              <LocalTime
                ts={view.answeredAtMs}
                variant="full"
                initial={formatLeagueMatchTime(new Date(view.answeredAtMs), "full")}
              />
              . See you on match night.
            </p>
          ) : null}
          <ActionForm action={takeBackRollCallAction}>
            <SubmitButton variant="ghost" size="sm" className="-ml-3">
              Take it back
            </SubmitButton>
          </ActionForm>
        </div>
      );
    case "owed":
    case "renew":
      return (
        <div className="space-y-3">
          {view.viewer === "renew" ? (
            <p className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-fg">
              Match night has changed since you answered. Check the new night
              and lock in again.
            </p>
          ) : null}
          <ActionForm action={answerRollCallAction} hidden={{ night: view.night }}>
            <SubmitButton variant="accent" size="lg" className="w-full">
              <span aria-hidden>✋</span> I&apos;m in, lock me in
            </SubmitButton>
          </ActionForm>
          <p className="text-xs leading-relaxed text-muted">
            Can&apos;t commit to that? Withdraw your signup on{" "}
            <Link href="/me" className={textLink()}>
              My account
            </Link>{" "}
            so a captain doesn&apos;t draft you.
          </p>
        </div>
      );
  }
}

/** One side of the list: chips by name, the viewer's own ringed. */
function PlayerList({
  title,
  players,
  viewerId,
  done = false,
  empty,
}: {
  title: string;
  players: RollCallPlayer[];
  viewerId: string | null;
  done?: boolean;
  empty: string;
}) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
        {title}
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] tabular-nums",
            done ? "bg-success/15 text-success" : "bg-surface-2 text-muted",
          )}
        >
          {players.length}
        </span>
      </h3>
      {players.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {players.map((player) => (
            <li key={player.id} className="min-w-0 max-w-full">
              <PlayerLink
                userId={player.id}
                className={cn(
                  "flex min-w-6 max-w-full items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 hover:no-underline",
                  done
                    ? "border-success/30 bg-success/10 text-fg hover:border-success/60"
                    : "border-line bg-surface-2/40 text-muted hover:border-muted/60",
                  player.id === viewerId && "ring-2 ring-accent/70",
                )}
              >
                <Avatar name={player.name} src={player.avatar} size={22} />
                <span className="min-w-0 truncate text-sm">{player.name}</span>
                {done ? (
                  <span aria-hidden className="shrink-0 text-xs text-success">
                    ✓
                  </span>
                ) : null}
              </PlayerLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
