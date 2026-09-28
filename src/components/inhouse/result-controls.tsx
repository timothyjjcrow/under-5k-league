"use client";

import { useState } from "react";
import { buttonClasses } from "@/components/ui";

/** The automatic scan's status line (see inhouseScanStatus). */
export function scanStatusText(scan: { live: boolean; minutesLeft: number }) {
  return scan.live
    ? "Auto-scan is running · results appear after the game ends."
    : `Auto-scan starts in ${scan.minutesLeft} min.`;
}

/**
 * The manual result paths: "Game over? Check now" (scan the ten players'
 * recent games now) and "Record by match ID". The automatic scan normally
 * records the game with nobody pressing anything; these cover a game it can't
 * see yet. Shared by the Set up and Play screens, because a lobby is being
 * played from the moment teams lock whether or not anyone pressed Start.
 *
 * "Check now" only appears once the automatic scan's window opens
 * (inhouseScanStatus): before that the game can't be over, and each press is
 * a ten-player OpenDota scan that could only fail. `folded` (Set up) keeps
 * both behind one disclosure so they don't compete with getting into the
 * Dota lobby.
 */
export function ResultControls({
  folded = false,
  scan,
  pending,
  act,
}: {
  folded?: boolean;
  scan: { live: boolean; minutesLeft: number };
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  const [matchId, setMatchId] = useState("");
  const checkNow = scan.live ? (
    <button
      type="button"
      disabled={pending}
      onClick={() => act({ action: "detect" })}
      className={buttonClasses("secondary", "md")}
    >
      {pending ? "Fetching from OpenDota…" : "Game over? Check now"}
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
        <label
          htmlFor="inhouse-match-id"
          className="mb-1 block text-xs text-muted"
        >
          Dota match ID
        </label>
        <input
          id="inhouse-match-id"
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
          Game over and no result yet? Record it
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
      <div>
        <p className="text-sm">
          The result records automatically after the game.
        </p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted">
          {scanStatusText(scan)}
        </p>
      </div>
      {checkNow}
      <details className="mx-auto max-w-lg border-t border-info/20 pt-2 text-left">
        <summary className={summaryClass}>Record by match ID</summary>
        {form}
      </details>
    </div>
  );
}
