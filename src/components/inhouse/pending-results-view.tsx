"use client";

import { Badge, buttonClasses } from "@/components/ui";
import { ConfirmButton } from "@/components/inhouse/confirm-button";
import { pushToast } from "@/components/toaster";
import type { InhouseState } from "@/lib/inhouse-service";
import { ResultControls } from "@/components/inhouse/result-controls";
import { sideMeta } from "@/components/inhouse/shared";

type PendingResult = InhouseState["pendingResults"][number];

/** "checked just now" / "checked 4 min ago" / "not checked yet". */
function checkedLine(lastCheckedAt: number | null, serverNow: number) {
  if (lastCheckedAt == null) return "Not checked yet";
  const minutes = Math.floor(Math.max(0, serverNow - lastCheckedAt) / 60_000);
  return minutes < 1
    ? "Last checked just now"
    : `Last checked ${minutes} min ago`;
}

/**
 * Games marked over whose result is on the way (`state.pendingResults`: the
 * viewer's own, every one for an admin). Their ten are free — the queue is
 * right below — but "Check OpenDota now", "Record by match ID" and an admin's
 * give-up still live here, each naming its game.
 *
 * `folded` while the viewer is queued or in their next live game: one line,
 * no controls. Every room control shares one action lock, so a 45-second
 * OpenDota check pressed here would freeze ACCEPT (a ready check can open any
 * second while queued) or a pick in the game that matters now; the controls
 * come back once they're out of the queue and between games.
 */
export function PendingResultsView({
  results,
  serverNow,
  pending,
  act,
  folded = false,
}: {
  results: readonly PendingResult[];
  serverNow: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
  folded?: boolean;
}) {
  if (results.length === 0) return null;
  if (folded) {
    return (
      <details className="rounded-[var(--radius)] border border-line bg-surface/40">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 text-sm text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
          <span className="font-medium text-fg">
            {results.length === 1
              ? `Game #${results[0].code}`
              : `${results.length} earlier games`}
          </span>
          <span>· result on the way</span>
        </summary>
        <p className="border-t border-line px-4 py-3 text-xs text-muted">
          {results.length === 1
            ? "It records itself once OpenDota has the game."
            : "They record themselves once OpenDota has the games."}{" "}
          Checking by hand comes back here when you&apos;re not queued or in a
          game.
        </p>
      </details>
    );
  }
  return (
    <div className="space-y-3">
      {results.map((r) => (
        <PendingResultCard
          key={r.id}
          result={r}
          serverNow={serverNow}
          pending={pending}
          act={(body) => act({ ...body, lobbyId: r.id })}
        />
      ))}
    </div>
  );
}

function PendingResultCard({
  result,
  serverNow,
  pending,
  act,
}: {
  result: PendingResult;
  serverNow: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  // A few lines high, so the queue under it stays on a phone's first screen:
  // the game, its state and its check in one row; the teams and the match-ID
  // form behind one disclosure.
  return (
    <section
      aria-label={`Game #${result.code}, result on the way`}
      className="rounded-[var(--radius)] border border-info/40 bg-info/10 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
          {result.mine ? "Your last game" : "Game"}{" "}
          <span className="font-mono text-xs font-normal text-muted">
            #{result.code}
          </span>
          <Badge tone="info">Result on the way</Badge>
        </h2>
        <span className="text-xs text-muted">
          {checkedLine(result.lastCheckedAt, serverNow)}
        </span>
        {result.canRecord ? (
          <ResultControls
            className="sm:ml-auto"
            scan={{ live: true, minutesLeft: 0 }}
            pending={pending}
            act={act}
          />
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted">
        It records itself, Elo and all, once OpenDota has it (usually 10 to 30
        minutes after it ends).
        {result.mine ? " Queue for the next one meanwhile." : ""}
      </p>
      <details className="group mt-1">
        <summary className="inline-flex min-h-10 cursor-pointer list-none items-center rounded py-1 text-xs text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-8 [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="mr-1.5 transition-transform group-open:rotate-90">
            ▸
          </span>
          Who played
        </summary>
        <ul className="mt-1 grid max-w-3xl grid-cols-1 gap-1 text-xs sm:grid-cols-2">
          {result.sides.map((side) => {
            const meta = sideMeta(side.isRadiant);
            return (
              <li key={meta.name} className="min-w-0">
                <span className="font-medium text-fg">{meta.name}:</span>{" "}
                <span className="text-muted">{side.names.join(", ")}</span>
              </li>
            );
          })}
        </ul>
      </details>
      {result.canCancel ? (
        <div className="mt-2 flex justify-end">
          <ConfirmButton
            label={`Admin: give up on #${result.code}'s result`}
            disabled={pending}
            className={buttonClasses("ghost", "sm", "text-danger-soft")}
            prompt={`Give up on game #${result.code}'s result? It won't count for anyone. Nobody is requeued: its players are free already.`}
            confirmLabel="Give up on it"
            cancelLabel="Keep waiting"
            danger
            promptClassName="max-w-md"
            onConfirm={async () => {
              if (await act({ action: "giveup" })) {
                pushToast("success", `Gave up on game #${result.code}'s result`);
              }
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
