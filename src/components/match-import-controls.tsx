"use client";

import { ActionForm, SubmitButton } from "@/components/action-form";
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
  const inputId = `dota-match-ref-${matchId}`;
  const helpId = `${inputId}-help`;

  async function submitImport(
    prev: ActionResult,
    formData: FormData,
  ): Promise<ActionResult> {
    const intent = formData.get("intent");
    if (intent === "detect") return detectAction(prev, formData);
    if (intent === "import") return importAction(prev, formData);
    return { error: "Choose Auto-fetch games or Add game." };
  }

  return (
    <ActionForm
      action={submitImport}
      hidden={{ matchId }}
      className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-end"
    >
      <SubmitButton
        name="intent"
        value="detect"
        formNoValidate
        variant="secondary"
        size="sm"
        className="w-full sm:w-auto"
      >
        Auto-fetch games
      </SubmitButton>

      <div className="min-w-0 space-y-1.5">
        <label
          htmlFor={inputId}
          className="block text-xs font-medium text-muted"
        >
          Dota match ID or URL
        </label>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <input
            id={inputId}
            name="dotaMatchRef"
            required
            aria-describedby={helpId}
            placeholder="Match ID or URL"
            className="h-9 w-full min-w-0 rounded-md border border-line bg-surface-2/50 px-2 text-sm outline-none focus:border-accent/60"
          />
          <SubmitButton
            name="intent"
            value="import"
            variant="secondary"
            size="sm"
            className="w-full shrink-0 sm:w-auto"
          >
            Add game
          </SubmitButton>
        </div>
        <p id={helpId} className="text-xs text-muted">
          Paste a numeric Dota match ID or an OpenDota/Dotabuff match URL.
        </p>
      </div>
    </ActionForm>
  );
}
