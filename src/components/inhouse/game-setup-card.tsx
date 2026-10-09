"use client";

import { useState } from "react";
import { textLink } from "@/components/ui";
import { pushToast } from "@/components/toaster";
import { cn } from "@/lib/utils";
import { DISCORD_INVITE_URL, INHOUSE } from "@/lib/constants";
import { inhouseHandLobbyName, inhouseVoiceChannel } from "@/lib/inhouse";
import type { InhouseState } from "@/lib/inhouse-service";
import {
  DotaLobbyControls,
  type LobbyBotAvailability,
} from "@/components/dota-lobby-controls";
import { sideMeta, type RoomLobby } from "@/components/inhouse/shared";

/** A monospace value with a click-to-copy button (name / password / etc.). */
function CopyChip({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          pushToast("success", `Copied ${label}: ${value}`);
        } catch {
          pushToast("error", "Couldn't copy — select it and copy manually");
        }
      }}
      title={`Copy ${label}`}
      className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface-2/60 px-3 py-2 font-mono text-sm font-semibold text-fg transition-colors hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      {value}
      <span aria-hidden className="text-xs text-muted">
        📋
      </span>
    </button>
  );
}

/**
 * The first thing after teams lock: how the ten get into one Dota lobby and
 * their team's voice channel. ONE path at a time, because two lobby names and
 * two start buttons on one card is how players end up in different lobbies:
 *
 * - Bot answering: its panel is the path (its lobby name and password, and
 *   "Create Dota lobby" for captains). The by-hand steps, and the manual
 *   `start` control, fold under "Bot not working?"; a bot-launched game starts
 *   the room's clock by itself.
 * - No bot, or still asking: the by-hand steps. Players never see a bot panel
 *   that can't help them; admins keep its status line, and a configured bot
 *   that is failing stays visible with the reason.
 *
 * Only the league's ticket admins can pick the league ticket in Dota, so a
 * lobby made by hand needs one of them as host (docs/DOTA-LOBBY-BOT.md).
 */
export function GameSetupCard({
  lobby,
  me,
  manualStart = null,
}: {
  lobby: RoomLobby;
  me: InhouseState["me"];
  /** The optional "Start the game clock" control (Set up screen only). */
  manualStart?: React.ReactNode;
}) {
  const [bot, setBot] = useState<LobbyBotAvailability>("checking");
  const botOn = bot === "on";
  const showBotPanel = me.isAdmin || botOn || bot === "unavailable";
  // Each live game has its own voice channels and hand-hosted lobby name, so
  // two games set up at once never meet in the same place.
  const voiceByTeam = (team: number) => inhouseVoiceChannel(lobby.slot, team);
  const handLobbyName = inhouseHandLobbyName(lobby.slot);

  const stepClass = (last: boolean) =>
    cn(
      "min-w-0 p-5",
      last ? "" : "border-b border-line lg:border-b-0 lg:border-r",
    );
  const stepLabel = (text: string) => (
    <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-accent">
      {text}
    </p>
  );

  const lobbyStep = (
    <div className={stepClass(false)}>
      {stepLabel("01 · Dota lobby")}
      <h4 className="text-sm font-semibold">Create or join</h4>
      <p className="mt-1 text-xs text-muted">Dota 2 → Play → Custom Lobbies</p>
      <dl className="mt-4 space-y-3">
        <div>
          <dt className="mb-1 text-[11px] text-muted">Lobby name</dt>
          <dd>
            <CopyChip value={handLobbyName} label="lobby name" />
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-[11px] text-muted">Password</dt>
          <dd>
            <CopyChip value={INHOUSE.LOBBY_PASSWORD} label="password" />
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted">
        The host must be one of the league&apos;s ticket admins: only they can
        pick the league ticket in Dota. Everyone else joins the lobby or asks
        the host for an invite.
      </p>
    </div>
  );

  const ticketStep = (last: boolean) => (
    <div className={cn(stepClass(last), "bg-accent/5")}>
      {stepLabel("02 · Match tracking")}
      <h4 className="text-sm font-semibold">Set the league ticket</h4>
      <p className="mt-1 text-xs text-muted">Host → Lobby Settings → League</p>
      <div className="mt-4">
        {INHOUSE.LOBBY_TICKET_CONFIGURED ? (
          <CopyChip value={INHOUSE.LOBBY_TICKET} label="league ticket" />
        ) : (
          <p className="text-xs text-muted">{INHOUSE.LOBBY_TICKET}</p>
        )}
      </div>
      <p className="mt-3 text-xs text-muted">
        {INHOUSE.LOBBY_TICKET_CONFIGURED
          ? "Required: without this ticket, the game will not appear on OpenDota and cannot be recorded on the site."
          : "The league administrators will provide the European ticket before tracked inhouse games begin."}
      </p>
      <a
        href="#opendota-setup"
        className={textLink("mt-3 inline-flex min-h-8 items-center text-xs")}
      >
        Check your match-data setup ↓
      </a>
    </div>
  );

  const voiceStep = (numbered: boolean) => (
    <div className={stepClass(true)}>
      {stepLabel(numbered ? "03 · Team voice" : "Team voice")}
      <h4 className="text-sm font-semibold">Meet in Discord</h4>
      <p className="mt-1 text-xs text-muted">Join your side’s voice channel.</p>
      <ul
        className={cn(
          "mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2",
          numbered && "lg:grid-cols-1",
        )}
      >
        {lobby.teams.map((t) => {
          const meta = sideMeta(t.isRadiant);
          const mine = me.myTeam === t.team;
          return (
            <li
              key={t.team}
              className={cn(
                "rounded-xl border px-3 py-2.5",
                mine ? meta.chip : "border-line bg-surface-2/40",
              )}
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span
                  className={cn(
                    "font-semibold",
                    t.isRadiant ? "text-success" : "text-danger",
                  )}
                >
                  {meta.name}
                </span>
                {mine ? <span className="font-medium">Your team</span> : null}
              </div>
              <span className="block break-words text-sm text-fg">
                {voiceByTeam(t.team)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <section
      aria-label="Game setup"
      className="overflow-hidden rounded-2xl border border-line bg-surface/90"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
        <h3 className="text-sm font-semibold">Get into the Dota lobby</h3>
        {DISCORD_INVITE_URL ? (
          <a
            href={DISCORD_INVITE_URL}
            target="_blank"
            rel="noreferrer"
            className={textLink("inline-flex min-h-8 items-center text-xs")}
          >
            League Discord ↗
          </a>
        ) : null}
      </div>
      {/* Always mounted, so it keeps reporting whether the bot answers; only
          shown when it can help (or to an admin, as a status line). */}
      <div className={showBotPanel ? "border-b border-line p-5" : "hidden"}>
        <DotaLobbyControls
          key={lobby.id}
          kind="inhouse"
          id={lobby.id}
          onAvailability={setBot}
        />
      </div>
      {botOn ? (
        <>
          {voiceStep(false)}
          <details className="group border-t border-line">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-xs text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [&::-webkit-details-marker]:hidden">
              <span>
                Bot not working?{" "}
                <span className="font-medium text-fg">
                  Set up the lobby by hand
                </span>
              </span>
              <span
                aria-hidden
                className="transition-transform group-open:rotate-180"
              >
                ⌄
              </span>
            </summary>
            <div className="grid gap-0 border-t border-line lg:grid-cols-2">
              {lobbyStep}
              {ticketStep(true)}
            </div>
            {manualStart}
          </details>
        </>
      ) : (
        <>
          <div className="grid gap-0 lg:grid-cols-3">
            {lobbyStep}
            {ticketStep(false)}
            {voiceStep(true)}
          </div>
          {manualStart}
        </>
      )}
    </section>
  );
}
