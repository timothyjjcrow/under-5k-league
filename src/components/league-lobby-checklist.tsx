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

/** Captain-only match-night instructions for official Valve league lobbies. */
export function LeagueLobbyChecklist({
  leagueId,
  bestOf,
  homeTeamName,
}: {
  leagueId: string;
  bestOf: number;
  homeTeamName: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Card tone="feature">
      <CardHeader
        title="Official lobby checklist"
        subtitle="Use the current league ticket in every lobby so the result reaches the league feed."
        action={<Badge tone="accent">Captain check</Badge>}
      />
      <CardBody className="space-y-3 text-sm">
        <ol className="list-decimal space-y-1.5 pl-5 text-muted">
          <li>
            <strong className="text-fg">{homeTeamName}&apos;s captain</strong>{" "}
            creates the private lobby; the away captain is the backup host.
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
        {bestOf === 2 ? (
          <p className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-fg">
            This is a Bo2: create two separate Bo1 lobbies and select this
            league ticket in both.
          </p>
        ) : null}
        <p className="text-xs text-muted">
          If a lobby uses an old or incorrect ticket, automatic recovery checks
          the teams&apos; linked player accounts. You can also add the Dota
          match id below.
        </p>
      </CardBody>
    </Card>
  );
}
