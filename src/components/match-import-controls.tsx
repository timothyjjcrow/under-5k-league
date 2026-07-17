"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui";
import type { ActionResult } from "@/lib/action-result";

type ImportFormAction = (
  prev: ActionResult,
  formData: FormData,
) => Promise<ActionResult>;

// Shared by the admin panel (admin import actions) and the match page's
// captain "Report your result" card (captain-guarded actions) — the server
// actions arrive as props, which is legal for a client component.
export function MatchImportControls({
  matchId,
  importAction,
  detectAction,
}: {
  matchId: string;
  importAction: ImportFormAction;
  detectAction: ImportFormAction;
}) {
  const [autoState, autoAction, autoPending] = useActionState(
    detectAction,
    null,
  );
  const [impState, impAction, impPending] = useActionState(
    importAction,
    null,
  );

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <form action={autoAction}>
          <input type="hidden" name="matchId" value={matchId} />
          <Button type="submit" variant="secondary" size="sm" disabled={autoPending}>
            {autoPending ? "Scanning…" : "Auto-fetch games"}
          </Button>
        </form>
        <form action={impAction} className="flex items-center gap-2">
          <input type="hidden" name="matchId" value={matchId} />
          <input
            name="dotaMatchRef"
            placeholder="Match ID or URL"
            className="h-8 w-44 rounded-md border border-line bg-surface-2/50 px-2 text-sm outline-none focus:border-accent/60"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={impPending}>
            {impPending ? "Importing…" : "Add game"}
          </Button>
        </form>
      </div>
      {autoState?.error || autoState?.message ? (
        <p className={`text-xs ${autoState.error ? "text-danger" : "text-success"}`}>
          {autoState.error ?? autoState.message}
        </p>
      ) : null}
      {impState?.error || impState?.message ? (
        <p className={`text-xs ${impState.error ? "text-danger" : "text-success"}`}>
          {impState.error ?? impState.message}
        </p>
      ) : null}
    </div>
  );
}
