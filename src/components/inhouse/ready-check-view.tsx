"use client";

import { Avatar, buttonClasses } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useBannerOffscreen } from "@/components/room-clock";
import type { InhouseState } from "@/lib/inhouse-service";
import { readyCheckHeading } from "@/lib/inhouse-room-view";
import { SecondsClock } from "@/components/inhouse/clocks";
import { ConfirmButton } from "@/components/inhouse/confirm-button";
import { scrollToRoomTop, type RoomLobby } from "@/components/inhouse/shared";

export function ReadyCheckView({
  lobby,
  me,
  offset,
  pending,
  act,
  clockBar = true,
}: {
  lobby: RoomLobby;
  me: InhouseState["me"];
  offset: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
  /**
   * Pin a compact clock bar under the header when the banner scrolls away.
   * Off for a game the viewer only watches beside their own (or beside the
   * other live game), where a second pinned bar would cover the first.
   */
  clockBar?: boolean;
}) {
  const check = lobby.readyCheck;
  // The accept clock must stay visible if the player scrolls — same
  // compact-bar treatment as the vote and pick clocks.
  const { ref: bannerRef, offscreen } = useBannerOffscreen(clockBar);
  if (!check) return null;

  const waitingOn = check.total - check.acceptedCount;
  const heading = readyCheckHeading({
    canAccept: me.canAccept,
    hasAccepted: me.hasAccepted,
    waitingOn,
  });
  // One line under the controls, only where it adds something: the heading
  // and the accepted chip already say it once the viewer has accepted.
  const note = me.canAccept
    ? me.hasAccepted
      ? null
      : "Accept before the timer ends to keep your spot."
    : me.inQueue
      ? "You’re in line for the next game."
      : "Spectating · join the next-game queue above.";

  return (
    <div className="space-y-3">
      {/* Compact fixed bar while the accept clock is scrolled away. top-16
          matches the 64px header (see useBannerOffscreen). */}
      {offscreen ? (
        <button
          type="button"
          onClick={scrollToRoomTop}
          aria-label="Back to the match accept"
          className="fixed inset-x-0 top-16 z-20 border-b border-line bg-bg/90 text-left backdrop-blur"
        >
          <div className="mx-auto flex h-11 w-full max-w-7xl items-center justify-between gap-3 px-4 text-sm sm:px-6 lg:px-8">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden>🎮</span>
              <span className="truncate font-medium">Match found</span>
              <span className="shrink-0 text-xs text-muted tabular-nums">
                {check.acceptedCount}/{check.total} accepted
              </span>
            </span>
            <SecondsClock
              endsAtMs={lobby.acceptEndsAt}
              offsetMs={offset}
              urgentAt={10}
              label={(s) => `${s} seconds left to accept`}
            />
          </div>
        </button>
      ) : null}

      {/* One card: the question, its clock and the answer on the left; who
          has accepted on the right from lg (under it on a phone). */}
      <section
        ref={bannerRef}
        aria-label="Ready check"
        className="grid gap-4 rounded-2xl border border-accent/40 bg-gradient-to-br from-accent/15 via-surface to-surface p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-6"
      >
        <div className="min-w-0">
          {/* The clock stays beside the heading at every width, so the
              phone's first screen keeps the button high. */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
                Ready check
              </p>
              <h2 className="font-display text-xl font-semibold sm:text-2xl">
                {heading}
              </h2>
              <p className="mt-1 text-sm text-muted tabular-nums">
                {check.acceptedCount}/{check.total} accepted
                {waitingOn > 0
                  ? ` · waiting on ${waitingOn}`
                  : " · everyone’s ready"}
              </p>
            </div>
            <SecondsClock
              prominent
              endsAtMs={lobby.acceptEndsAt}
              offsetMs={offset}
              urgentAt={10}
              label={(s) => `${s} seconds left to accept`}
            />
          </div>

          <div aria-hidden className="mt-3 flex gap-1.5">
            {Array.from({ length: check.total }, (_, i) => (
              <span
                key={i}
                className={cn(
                  "h-2 flex-1 rounded-full transition-colors",
                  i < check.acceptedCount ? "bg-success" : "bg-line",
                )}
              />
            ))}
          </div>

          {me.canAccept ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {me.hasAccepted ? (
                <span className="inline-flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-4 py-2.5 text-sm font-semibold text-success">
                  <span aria-hidden>✓</span> Accepted — waiting for the others
                </span>
              ) : (
                <>
                  <button
                    disabled={pending}
                    onClick={() => act({ action: "accept" })}
                    className={cn(
                      buttonClasses("accent", "lg"),
                      "min-h-14 w-full font-bold sm:w-auto sm:px-12",
                    )}
                  >
                    ACCEPT MATCH
                  </button>
                  <ConfirmButton
                    label="Decline"
                    disabled={pending}
                    className={buttonClasses(
                      "ghost",
                      "sm",
                      "hover:text-danger-soft",
                    )}
                    prompt="Decline this match? The lobby is scrapped and you leave the queue. Everyone who accepted keeps their spot at the front of the queue."
                    confirmLabel="Yes, decline"
                    cancelLabel="Keep my spot"
                    danger
                    onConfirm={() => act({ action: "decline" })}
                  />
                </>
              )}
            </div>
          ) : null}
          {note ? <p className="mt-2 text-xs text-muted">{note}</p> : null}
        </div>

        {/* Who's in — pending players sort first (they're the holdup). */}
        <ul
          aria-label="Who has accepted"
          className="grid grid-cols-2 content-start gap-1.5"
        >
          {check.players.map((p) => {
            const you = p.userId === me.userId;
            return (
              <li
                key={p.userId}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5",
                  p.accepted
                    ? "border-success/40 bg-success/5"
                    : "border-line bg-surface-2/40",
                  you && "ring-1 ring-accent/50",
                )}
              >
                <Avatar name={p.name} src={p.avatar} size={22} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium sm:text-sm">
                  {p.name}
                </span>
                {you ? (
                  <span className="shrink-0 text-[11px] text-muted">you</span>
                ) : null}
                {p.accepted ? (
                  <span
                    role="img"
                    aria-label={`${p.name} accepted`}
                    className="shrink-0 text-sm text-success"
                  >
                    <span aria-hidden>✓</span>
                  </span>
                ) : (
                  <span
                    role="img"
                    aria-label={`${p.name} hasn't accepted yet`}
                    className="shrink-0 animate-pulse text-sm text-muted motion-reduce:animate-none"
                  >
                    <span aria-hidden>…</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
