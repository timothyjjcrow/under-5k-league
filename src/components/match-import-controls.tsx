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
  idPrefix = "",
  describedBy,
}: {
  matchId: string;
  importAction: ImportFormAction;
  detectAction: ImportFormAction;
  /** Keeps ids unique if a page ever shows two of these for one match. The
   *  match page's Admin tools pass "admin-"; for an admin who captains the
   *  match they point at Captain tools instead of rendering a second copy. */
  idPrefix?: string;
  /**
   * The id of help text printed ONCE elsewhere on the page. The admin panel
   * lists every fixture, so it says "paste an ID or URL" once per card and
   * points each field at that; without it the hint renders under the field.
   */
  describedBy?: string;
}) {
  const inputId = `${idPrefix}dota-match-ref-${matchId}`;
  const helpId = describedBy ?? `${inputId}-help`;

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
      className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start"
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
        {/* One line from sm: label, field, Add game (the label above the
            field cost every admin result row a line). A phone keeps the
            label on its own line and the field beside Add game. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          <label
            htmlFor={inputId}
            className="block basis-full text-xs font-medium text-muted sm:shrink-0 sm:basis-auto"
          >
            Dota match ID or URL
          </label>
          <input
            id={inputId}
            name="dotaMatchRef"
            required
            aria-describedby={helpId}
            placeholder="Match ID or URL"
            className="h-9 min-w-0 flex-1 basis-40 rounded-md border border-line bg-surface-2/50 px-2 text-sm outline-none focus:border-accent/60 sm:max-w-md"
          />
          <SubmitButton
            name="intent"
            value="import"
            variant="secondary"
            size="sm"
            className="shrink-0"
          >
            Add game
          </SubmitButton>
        </div>
        {describedBy ? null : (
          <p id={helpId} className="text-xs text-muted">
            Paste a numeric Dota match ID or an OpenDota/Dotabuff match URL.
          </p>
        )}
      </div>
    </ActionForm>
  );
}
