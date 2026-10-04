"use client";

// The league stream's link on a playoff or final match (broadcast.ts):
// "Streamed on Twitch" before the window, "Live now · Watch on Twitch" from
// 15 minutes before kickoff until the series should be over (longer once a
// game is in, matchWatchWindow), then nothing.
//
// Which of the three depends on the viewer's clock, so the server renders
// nothing and the browser decides (no hydration mismatch), like <Countdown>.
// One shared ticker serves every link and player on the page
// (useWatchState), and a tab left open crosses both edges of the window on
// its own.

import { useSyncExternalStore } from "react";
import {
  watchState,
  type LeagueStream,
  type WatchWindow,
} from "@/lib/broadcast";
import { cn } from "@/lib/utils";
import { LinkArrow, buttonClasses, textLink } from "./ui";

const TICK_MS = 15_000;
let nowMs: number | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!ticker) {
    nowMs = Date.now();
    ticker = setInterval(() => {
      nowMs = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

function getSnapshot(): number {
  if (nowMs === null) nowMs = Date.now();
  return nowMs;
}

function getServerSnapshot(): number | null {
  return null;
}

/** watchState at the shared ticker's time: null on the server, before
 *  hydration and once the window has closed. */
export function useWatchState(watch: WatchWindow): "soon" | "live" | null {
  const now = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return now === null ? null : watchState(watch, now);
}

/**
 * `button` stands on its own (the match scoreboard, Home's This week card);
 * `row` is the compact text link in a /schedule fixture card, above the
 * card's stretched match-page link.
 */
export function WatchLink({
  stream,
  watch,
  matchLabel,
  variant = "button",
  className,
  wrapperClassName,
}: {
  stream: LeagueStream;
  /** matchWatchWindow's result for the match. */
  watch: WatchWindow;
  /** Names the match for screen readers where the link sits in a list. */
  matchLabel?: string;
  variant?: "button" | "row";
  className?: string;
  /** Wraps the link in a div with these classes (a card's divider strip),
   *  so the wrapper goes when the link does. */
  wrapperClassName?: string;
}) {
  const state = useWatchState(watch);
  if (!state) return null;
  const live = state === "live";
  const words =
    variant === "row"
      ? live
        ? "Watch live"
        : `On ${stream.platform}`
      : live
        ? `Live now · Watch on ${stream.platform}`
        : `Streamed on ${stream.platform}`;
  const link = (
    <a
      href={stream.url}
      target="_blank"
      rel="noreferrer"
      className={
        variant === "row"
          ? // The kit's link, kept on its own 44px row: my-0 drops
            // TAP_SAFE's negative margin, which would overhang the strip.
            textLink(
              cn(
                "relative z-10 my-0 inline-flex min-h-11 shrink-0 items-center gap-1.5 px-1 text-xs font-semibold",
                live && "text-danger-soft",
                className,
              ),
            )
          : buttonClasses(live ? "danger" : "secondary", "sm", className)
      }
    >
      {live ? (
        <span aria-hidden className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
        </span>
      ) : (
        <span aria-hidden>📺</span>
      )}
      {words}
      {matchLabel ? <span className="sr-only">: {matchLabel}</span> : null}
      <span className="sr-only"> (opens in a new tab)</span>
      <LinkArrow out />
    </a>
  );
  return wrapperClassName ? (
    <div className={wrapperClassName}>{link}</div>
  ) : (
    link
  );
}
