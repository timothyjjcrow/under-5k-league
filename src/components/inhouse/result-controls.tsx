"use client";

import { useId, useState } from "react";
import { buttonClasses } from "@/components/ui";

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
 * Dota lobby. Never worded "Game over": that is the button that frees the
 * ten (GameOverControl), and one name per control.
 */
export function ResultControls({
  folded = false,
  pendingResult = false,
  scan,
  pending,
  act,
}: {
  folded?: boolean;
  /** On a game marked over: just the two controls, no "after the game" copy. */
  pendingResult?: boolean;
  scan: { live: boolean; minutesLeft: number };
  pending: boolean;
  act: (body: Record<string, unknown>) => unknown;
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
      className="mt-2 flex flex-wrap items-end justify-center gap-2"
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
    "cursor-pointer rounded py-2 text-center text-xs text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

  if (folded) {
    return (
      <details className="mx-auto mt-4 max-w-lg border-t border-accent/20 pt-2 text-left">
        <summary className={summaryClass}>
          Played already and no result yet? Record it
        </summary>
        <div className="mt-2 space-y-3 text-center">
          <p className="text-xs text-muted">{scanStatusText(scan)}</p>
          {checkNow}
          {form}
        </div>
      </details>
    );
  }
  return (
    <div className="mt-4 space-y-3">
      {pendingResult ? null : (
        <div>
          <p className="text-sm">
            The result records automatically after the game.
          </p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted">
            {scanStatusText(scan)}
          </p>
        </div>
      )}
      {checkNow}
      <details className="mx-auto max-w-lg border-t border-info/20 pt-2 text-left">
        <summary className={summaryClass}>Record by match ID</summary>
        {form}
      </details>
    </div>
  );
}
