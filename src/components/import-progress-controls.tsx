"use client";

import { ActionForm, SubmitButton } from "@/components/action-form";
import { ignoreImportCandidate, retryImportCandidate } from "@/app/actions/import-progress";

export function ImportProgressControls({
  candidateId,
  seasonId,
  revision,
}: {
  candidateId: string;
  seasonId: string;
  revision: number;
}) {
  const hidden = { candidateId, seasonId, expectedRevision: String(revision) };
  const reasonId = `import-ignore-reason-${candidateId}`;
  const helpId = `${reasonId}-help`;
  return (
    <div className="mt-3 space-y-3">
      <ActionForm action={retryImportCandidate} hidden={hidden}>
        <SubmitButton variant="secondary" size="sm">Retry next sync</SubmitButton>
      </ActionForm>
      <details className="rounded-md border border-line p-2">
        <summary className="cursor-pointer py-1 text-sm">Ignore this game</summary>
        <ActionForm action={ignoreImportCandidate} hidden={hidden} className="mt-2 space-y-2">
          <label htmlFor={reasonId} className="block text-xs font-medium">Reason for ignoring</label>
          <input id={reasonId} name="reason" required maxLength={300} aria-describedby={helpId}
            className="w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-sm"
            placeholder="For example, a practice game outside the league fixture" />
          <p id={helpId} className="text-xs text-muted">
            Excludes this game from automatic import and saves your reason in admin history.
            Existing results stay unchanged. Retry does not undo an exclusion.
          </p>
          <SubmitButton variant="danger" size="sm">Ignore game</SubmitButton>
        </ActionForm>
      </details>
    </div>
  );
}
