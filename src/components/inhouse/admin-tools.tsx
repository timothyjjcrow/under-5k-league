"use client";

import type { ReactNode } from "react";
import Link from "@/components/app-link";
import { pushToast } from "@/components/toaster";
import { LinkArrow, buttonClasses, textLink } from "@/components/ui";
import { AdminQueueRemoval } from "@/components/inhouse/admin-queue-removal";
import type { InhouseState } from "@/lib/inhouse-service";

type Act = (body: Record<string, unknown>) => Promise<boolean>;

/**
 * Every admin control the room has, as one panel at its end (Tim,
 * 2026-10-21: the admin rows were scattered under the queue, right-aligned
 * one by one, with the bot's status loose below them). One row per tool:
 * taking a player out of the queue (whenever anyone is queued, in every
 * stage), voiding the last result (between games), and the lobby bot's
 * status (`botStatus`, mounted by the page for admins); the players' medal
 * and MMR page is linked from its header.
 */
export function InhouseAdminTools({
  queue,
  lastResult,
  pending,
  act,
  botStatus,
}: {
  queue: InhouseState["queue"];
  /** The result banner's game, offered for voiding; null while in a game. */
  lastResult: InhouseState["lastResult"] | null;
  pending: boolean;
  act: Act;
  botStatus?: ReactNode;
}) {
  return (
    <section
      aria-label="Admin tools"
      className="overflow-hidden rounded-xl border border-line bg-surface/60"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-1.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">
          Admin
        </p>
        {/* Any player's inhouse MMR and medal, queued or not and signed up
            for the league or not, are set on their own admin page. */}
        <Link href="/admin/inhouse-players" className={textLink("text-xs")}>
          Players&apos; medal &amp; MMR <LinkArrow />
        </Link>
      </div>
      <div className="divide-y divide-line">
        {/* From any stage: the queue may not be on screen (a live game),
            and away players have no slot. */}
        {queue.length > 0 ? (
          <AdminQueueRemoval queue={queue} pending={pending} act={act} />
        ) : null}
        {lastResult ? (
          <VoidLastResult result={lastResult} pending={pending} act={act} />
        ) : null}
        {botStatus}
      </div>
    </section>
  );
}

/**
 * A wrong result used to be permanent — the ladder and history both filter
 * on COMPLETED, so voiding the lobby removes it and every player's Elo
 * recomputes from the surviving games on the next read.
 */
function VoidLastResult({
  result,
  pending,
  act,
}: {
  result: NonNullable<InhouseState["lastResult"]>;
  pending: boolean;
  act: Act;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg">
          Last result: {result.winnerSide} win {result.radiantScore}–
          {result.direScore}
        </p>
        <p className="text-xs text-muted">
          Voiding takes it off the ladder and history and recalculates
          everyone&apos;s Elo.
        </p>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          if (
            window.confirm(
              "Void the last inhouse result? It leaves the ladder and history, and everyone's Elo is recalculated without it.",
            )
          ) {
            // Name the target: the banner's own lobby, never "whatever
            // completed most recently at click time".
            if (await act({ action: "void", lobbyId: result.lobbyId })) {
              pushToast("success", "Result voided — Elo recalculated");
            }
          }
        }}
        className={buttonClasses("ghost", "sm", "text-danger hover:text-danger")}
      >
        Void the last result
      </button>
    </div>
  );
}
