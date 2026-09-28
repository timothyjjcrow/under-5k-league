"use client";

import { useState } from "react";
import { pushToast } from "@/components/toaster";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  buttonClasses,
} from "@/components/ui";

/**
 * Captain-only match-night instructions for official Valve league lobbies.
 *
 * Opens with the same "How to host" line a ticketless season gets on its own
 * (`howToHostParts`: who hosts, region, mode, how many lobbies), so the steps
 * below don't repeat the host or the Bo2 rule. Each fact appears once.
 */
export function LeagueLobbyChecklist({
  leagueId,
  hostParts,
}: {
  leagueId: string;
  /** `howToHostParts` for this match. */
  hostParts: string[];
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Card tone="feature">
      {/* The badge rides in the title: in the action slot it sat beside the
          title column and squeezed the subtitle into a narrow strip on
          phones. */}
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            Official lobby checklist
            <Badge tone="accent">Captain check</Badge>
          </span>
        }
        subtitle="Use the current league ticket in every lobby so the result reaches the league feed."
      />
      <CardBody className="space-y-3 text-sm">
        <p className="[overflow-wrap:anywhere]">
          <b className="text-fg">How to host:</b>{" "}
          <span className="text-muted">{hostParts.join(" · ")}</span>
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-muted">
          <li>
            The host creates the private lobby; the away captain is the backup
            host.
          </li>
          <li>
            Set the lobby&apos;s <strong className="text-fg">League</strong>{" "}
            field to the current league id below.
          </li>
          <li>The away captain verifies the league name and both rosters.</li>
          <li>
            Do that again for every new lobby before anyone starts the game.
          </li>
        </ol>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2/50 p-3">
          <span className="text-xs text-muted">Current league id</span>
          <code className="rounded bg-black/20 px-2 py-1 font-mono font-semibold text-fg">
            {leagueId}
          </code>
          <button
            type="button"
            className={buttonClasses("secondary", "sm")}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(leagueId);
                setCopied(true);
                pushToast("success", `Copied league id ${leagueId}`);
                setTimeout(() => setCopied(false), 2500);
              } catch {
                pushToast(
                  "error",
                  `Couldn't copy — select league id ${leagueId} manually`,
                );
              }
            }}
          >
            <span aria-hidden>{copied ? "✓" : "📋"}</span>
            {copied ? "Copied" : "Copy league id"}
          </button>
        </div>
        <p className="text-xs text-muted">
          If a lobby uses an old or incorrect ticket, automatic recovery checks
          the teams&apos; linked player accounts. You can also add the Dota
          match id below.
        </p>
      </CardBody>
    </Card>
  );
}
