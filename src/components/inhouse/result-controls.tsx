"use client";

import { useId, useState } from "react";
import { buttonClasses } from "@/components/ui";
import { cn } from "@/lib/utils";

/** The automatic scan's status line (see inhouseScanStatus). */
export function scanStatusText(scan: { live: boolean; minutesLeft: number }) {
  return scan.live
    ? "Auto-scan is running · results appear after the game ends."
    : `Auto-scan starts in ${scan.minutesLeft} min.`;
}

/**
 * The manual result paths: "Check OpenDota now" (look the game up now) and
 * "Record by match ID". The automatic scan normally records the game with
 * nobody pressing anything; these cover a game it can't see yet. Shared by the
 * Set up and Play screens, because a lobby is being played from the moment
 * teams lock whether or not anyone pressed Start, and by the card for a game
 * marked over whose result is on the way (`pendingResult`).
 *
 * "Check now" only appears once the automatic scan's window opens
 * (inhouseScanStatus): before that the game can't be over, and each press is
 * a ten-player OpenDota scan that could only fail. `folded` (Set up) keeps
 * both behind one disclosure so they don't compete with getting into the
 * Dota lobby. Otherwise they sit in one row (the match-ID form opens under
 * it), so the card holding them stays a few lines high. Never worded "Game
 * over": that is the button that frees the ten (GameOverControl), and one
 * name per control. The "records itself" sentence is the card's own line.
 */
export function ResultControls({
  folded = false,
  scan,
  pending,
  act,
  className,
}: {
  folded?: boolean;
  scan: { live: boolean; minutesLeft: number };
  pending: boolean;
  act: (body: Record<string, unknown>) => unknown;
  className?: string;
}) {
  const [matchId, setMatchId] = useState("");
  // Several of these can be on screen (a game marked over beside a live one).
  const inputId = useId();
  // "Fetching…" only for THIS button's own check: the room's one action lock
  // (`pending`) is also set by a join, a save or another card's check.
  const [checking, setChecking] = useState(false);
  const checkNow = scan.live ? (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        setChecking(true);
        void Promise.resolve(act({ action: "detect" })).finally(() =>
          setChecking(false),
        );
      }}
      className={buttonClasses("secondary", "md")}
    >
      {pending && checking ? "Fetching from OpenDota…" : "Check OpenDota now"}
    </button>
  ) : null;
  const form = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && matchId.trim())
          void act({ action: "record", matchId: matchId.trim() });
      }}
      className="mt-2 flex flex-wrap items-end gap-2"
    >
      <div className="min-w-0 flex-1">
        <label htmlFor={inputId} className="mb-1 block text-xs text-muted">
          Dota match ID
        </label>
        <input
          id={inputId}
          type="text"
          inputMode="numeric"
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={matchId}
          onChange={(e) => setMatchId(e.target.value)}
          placeholder="e.g. 7891234567"
          className="h-11 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
        />
      </div>
      <button
        type="submit"
        disabled={pending || !matchId.trim()}
        className={buttonClasses("secondary", "md", "min-h-11")}
      >
        Record
      </button>
    </form>
  );
  const summaryClass =
    "inline-flex min-h-10 cursor-pointer list-none items-center rounded py-2 text-xs text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-8 [&::-webkit-details-marker]:hidden";

  if (folded) {
    return (
      <details className={cn("text-left", className)}>
        <summary className={summaryClass}>
          <span aria-hidden className="mr-1.5">▸</span>
          Played already and no result yet? Record it
        </summary>
        <div className="mt-1 max-w-lg space-y-3">
          <p className="text-xs text-muted">{scanStatusText(scan)}</p>
          {checkNow}
          {form}
        </div>
      </details>
    );
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      {checkNow}
      {/* Takes a row of its own once open, so the form sits under both. */}
      <details className="min-w-0 open:basis-full">
        <summary className={summaryClass}>
          <span aria-hidden className="mr-1.5">▸</span>
          Record by match ID
        </summary>
        <div className="max-w-lg">{form}</div>
      </details>
    </div>
  );
}
