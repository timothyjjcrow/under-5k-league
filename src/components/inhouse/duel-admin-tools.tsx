"use client";

import { useId, useState } from "react";
import { buttonClasses } from "@/components/ui";
import { pushToast } from "@/components/toaster";
import { duelAdminToolsVisible, type DuelState } from "@/lib/inhouse-duel";

const dangerGhost = buttonClasses("ghost", "sm", "text-danger hover:text-danger");

/**
 * Admin rows on the 1v1 card: take a player out of the 1v1 queue
 * (`duelRemove`), cancel any 1v1 a result can still land on (`duelCancel`),
 * and void a recent 1v1 result (`duelVoid`, which the 1v1 leaderboard
 * recomputes without). Each confirms first and claims success only once the
 * server agrees. Logged by the server (logAdminAction).
 */
export function DuelAdminTools({
  duel,
  pending,
  act,
  onVoided,
}: {
  duel: DuelState;
  pending: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
  /** A void landed: the server-rendered 1v1 leaderboard needs a refresh. */
  onVoided: () => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState("");
  const queued = duel.queue.players;
  const picked = queued.find((p) => p.userId === choice) ?? null;
  const games = duel.games.filter((g) => g.canCancel);
  const results = duel.results.filter((r) => r.canVoid);
  if (!duelAdminToolsVisible(duel)) return null;
  return (
    <div className="divide-y divide-line rounded-lg border border-line bg-surface/40">
      <p className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted">
        Admin · 1v1
      </p>
      {duel.canRemoveFromQueue && queued.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <label htmlFor={id} className="min-w-0 basis-full text-sm text-fg sm:flex-1 sm:basis-auto">
            Remove from the 1v1 queue
          </label>
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
            <select
              id={id}
              value={picked ? picked.userId : ""}
              onChange={(e) => setChoice(e.target.value)}
              disabled={pending}
              className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface-2/50 px-2 text-sm text-fg sm:h-8 sm:w-56 sm:flex-none"
            >
              <option value="">Choose a player…</option>
              {queued.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.present ? p.name : `${p.name} (away)`}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending || !picked}
              onClick={async () => {
                if (!picked) return;
                if (
                  !window.confirm(
                    `Remove ${picked.name} from the 1v1 queue? They can join again.`,
                  )
                ) {
                  return;
                }
                if (await act({ action: "duelRemove", userId: picked.userId })) {
                  pushToast("success", `${picked.name} is out of the 1v1 queue`);
                  setChoice("");
                }
              }}
              className={dangerGhost}
            >
              Remove from 1v1
            </button>
          </div>
        </div>
      ) : null}
      {games.map((g) => {
        const label = `${g.radiant.name} vs ${g.dire.name}`;
        return (
          <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <span className="min-w-0 truncate text-sm text-muted">{label}</span>
            <button
              type="button"
              disabled={pending}
              onClick={async () => {
                if (
                  !window.confirm(
                    `Cancel the 1v1 ${label}? It ends without a result, and the bot lets its lobby go.`,
                  )
                ) {
                  return;
                }
                if (await act({ action: "duelCancel", duelId: g.id })) {
                  pushToast("success", "1v1 cancelled");
                }
              }}
              className={dangerGhost}
            >
              Admin: cancel 1v1
            </button>
          </div>
        );
      })}
      {results.map((r) => {
        const winner =
          r.winnerUserId === r.radiant.id ? r.radiant.name : r.dire.name;
        const loser =
          r.winnerUserId === r.radiant.id ? r.dire.name : r.radiant.name;
        const label = `${winner} beat ${loser}`;
        return (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <span className="min-w-0 truncate text-sm text-muted">
              {label}
              {r.dotaMatchId ? ` · match ${r.dotaMatchId}` : ""}
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={async () => {
                if (
                  !window.confirm(
                    `Void the 1v1 result "${label}"? It leaves the 1v1 leaderboard, which recalculates without it.`,
                  )
                ) {
                  return;
                }
                if (await act({ action: "duelVoid", duelId: r.id })) {
                  pushToast("success", "1v1 result voided");
                  onVoided();
                }
              }}
              className={dangerGhost}
            >
              Admin: void 1v1 result
            </button>
          </div>
        );
      })}
    </div>
  );
}
