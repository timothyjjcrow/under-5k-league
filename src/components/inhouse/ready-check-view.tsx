"use client";

import { Avatar, buttonClasses } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useBannerOffscreen } from "@/components/room-clock";
import type { InhouseState } from "@/lib/inhouse-service";
import { SecondsClock } from "@/components/inhouse/clocks";
import { scrollToRoomTop, type RoomLobby } from "@/components/inhouse/shared";

export function ReadyCheckView({
  lobby,
  me,
  offset,
  pending,
  act,
}: {
  lobby: RoomLobby;
  me: InhouseState["me"];
  offset: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  const check = lobby.readyCheck;
  // The accept clock must stay visible if the player scrolls — same
  // compact-bar treatment as the vote and pick clocks.
  const { ref: bannerRef, offscreen } = useBannerOffscreen(true);
  if (!check) return null;

  const waitingOn = check.total - check.acceptedCount;

  return (
    <div className="space-y-5">
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

      <div
        ref={bannerRef}
        className="rounded-2xl border border-accent/40 bg-gradient-to-br from-accent/15 via-surface to-surface px-5 py-5 sm:p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
              Ready check
            </p>
            <h2 className="font-display text-2xl font-semibold">
              {me.canAccept ? "Match found. You in?" : "A match is filling up"}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {check.acceptedCount}/{check.total} accepted
              {waitingOn > 0
                ? ` · waiting on ${waitingOn}`
                : " · everyone’s ready"}
            </p>
            <p className="mt-1 text-xs text-muted">
              {me.canAccept
                ? me.hasAccepted
                  ? "Your spot is confirmed."
                  : "Accept before the timer ends to keep your spot."
                : me.inQueue
                  ? "You’re in line for the next game."
                  : "Spectating · join the next-game queue above."}
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

        <div aria-hidden className="mt-4 flex gap-1.5">
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
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {me.hasAccepted ? (
              <span className="inline-flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-4 py-2.5 text-sm font-semibold text-success">
                <span aria-hidden>✓</span> Accepted — waiting for the others
              </span>
            ) : (
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
            )}
            {!me.hasAccepted ? (
              <button
                disabled={pending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Decline this match? The lobby is scrapped and you leave the queue. Everyone who accepted keeps their spot at the front of the queue.",
                    )
                  ) {
                    act({ action: "decline" });
                  }
                }}
                className="rounded text-xs text-muted hover:text-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
              >
                Decline
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Who's in — pending players sort first (they're the holdup). */}
      <ul className="grid grid-cols-2 gap-2">
        {check.players.map((p) => (
          <li
            key={p.userId}
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-3",
              p.accepted
                ? "border-success/40 bg-success/5"
                : "border-line bg-surface-2/40",
            )}
          >
            <Avatar name={p.name} src={p.avatar} size={28} />
            <span className="min-w-0 flex-1 truncate text-xs font-medium sm:text-sm">
              {p.name}
            </span>
            {p.accepted ? (
              <span
                role="img"
                aria-label={`${p.name} accepted`}
                className="text-sm text-success"
              >
                <span aria-hidden>✓</span>
              </span>
            ) : (
              <span
                role="img"
                aria-label={`${p.name} hasn't accepted yet`}
                className="animate-pulse text-sm text-muted motion-reduce:animate-none"
              >
                <span aria-hidden>…</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
