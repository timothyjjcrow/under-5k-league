"use client";

// The league stream playing in place, in the streaming site's own player
// (broadcast.ts: streamEmbed, streamEmbedSrc), while a playoff or final
// match's watch window is live. The page ships only our button: pressing it
// creates the iframe, so a visitor who never plays it never contacts Twitch,
// YouTube or Kick. Once playing, it stays until the visitor leaves, past the
// window's end: the window is an estimate, and a long series mustn't lose its
// picture mid-game.

import { useState } from "react";
import {
  streamEmbedSrc,
  type StreamEmbed,
  type StreamPlatform,
  type WatchWindow,
} from "@/lib/broadcast";
import { cn } from "@/lib/utils";
import { buttonClasses } from "./ui";
import { useWatchState } from "./watch-link";

export function StreamPlayer({
  embed,
  platform,
  watch,
  matchLabel,
  className,
}: {
  /** streamEmbed's result for the league's link. */
  embed: StreamEmbed;
  platform: StreamPlatform;
  /** matchWatchWindow's result for the match. */
  watch: WatchWindow;
  /** Names the match in the player's title, for screen readers. */
  matchLabel: string;
  /** Classes on the block (a card's divider). */
  className?: string;
}) {
  const state = useWatchState(watch);
  const [src, setSrc] = useState<string | null>(null);
  if (src === null && state !== "live") return null;
  return (
    <div className={cn("relative bg-black", className)}>
      <div className="relative mx-auto aspect-video w-full max-w-4xl">
        {src ? (
          <iframe
            src={src}
            title={`${platform} stream: ${matchLabel}`}
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className="absolute inset-0 h-full w-full border-0"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <button
              type="button"
              // Twitch plays only inside the host its address names, so the
              // browser names its own.
              onClick={() =>
                setSrc(streamEmbedSrc(embed, window.location.hostname))
              }
              className={buttonClasses("danger", "md")}
            >
              <span aria-hidden>▶</span>
              Play the stream here
            </button>
            <p className="text-xs text-muted">
              {platform}&apos;s player loads when you press play.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
