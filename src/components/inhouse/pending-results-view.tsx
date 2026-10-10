"use client";

import { Badge } from "@/components/ui";
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
  return (
    <section
      aria-label={`Game #${result.code}, result on the way`}
      className="rounded-[var(--radius)] border border-info/40 bg-info/10 px-4 py-4 text-center sm:px-6"
    >
      <h2 className="flex flex-wrap items-center justify-center gap-2 font-semibold">
        {result.mine ? "Your last game" : "Game"}{" "}
        <span className="font-mono text-sm font-normal text-muted">
          #{result.code}
        </span>
        <Badge tone="info">Result on the way</Badge>
      </h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted">
        It records itself, Elo and all, once OpenDota publishes the game:
        usually 10 to 30 minutes after it ends.
        {result.mine ? " Queue for the next one meanwhile." : ""}
      </p>
      <ul className="mx-auto mt-3 grid max-w-xl grid-cols-1 gap-1 text-left text-xs sm:grid-cols-2">
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
      <p className="mt-2 text-xs text-muted">
        {checkedLine(result.lastCheckedAt, serverNow)}
      </p>
      {result.canRecord ? (
        <ResultControls
          pendingResult
          scan={{ live: true, minutesLeft: 0 }}
          pending={pending}
          act={act}
        />
      ) : null}
      {result.canCancel ? (
        <div className="mt-3 text-right">
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              if (
                window.confirm(
                  `Give up on game #${result.code}'s result? It won't count for anyone. Nobody is requeued: its players are free already.`,
                ) &&
                (await act({ action: "giveup" }))
              ) {
                pushToast("success", `Gave up on game #${result.code}'s result`);
              }
            }}
            className="rounded text-xs text-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
          >
            Admin: give up on #{result.code}&apos;s result
          </button>
        </div>
      ) : null}
    </section>
  );
}
