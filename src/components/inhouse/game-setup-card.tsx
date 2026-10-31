"use client";

import { useCallback, useState } from "react";
import { textLink } from "@/components/ui";
import { CopyChip } from "@/components/copy-chip";
import { cn } from "@/lib/utils";
import { DISCORD_INVITE_URL, INHOUSE } from "@/lib/constants";
import type { LobbySeat } from "@/lib/dota-lobby";
import {
  inhouseHandLobbyName,
  inhouseViewerSideLine,
  inhouseVoiceChannel,
} from "@/lib/inhouse";
import type { InhouseState } from "@/lib/inhouse-service";
import {
  DotaLobbyControls,
  type LobbyBotAvailability,
} from "@/components/dota-lobby-controls";
import { inhouseSetupPath } from "@/lib/inhouse-room-view";
import { sideMeta, type RoomLobby } from "@/components/inhouse/shared";

/**
 * The first thing after teams lock: how the ten get into one Dota lobby and
 * their team's voice channel. ONE path at a time, because two lobby names and
 * two start buttons on one card is how players end up in different lobbies:
 *
 * - Bot answering: its panel is the path (its lobby name and password, and
 *   "Create Dota lobby" for captains). The by-hand steps, and the manual
 *   `start` control, fold under "Bot not working?"; a bot-launched game starts
 *   the room's clock by itself.
 * - No bot (not set up, failing, or busy with the other game): the by-hand
 *   steps. Players never see a bot panel that can't help them; admins keep
 *   its status line, and a configured bot that is failing stays visible with
 *   the reason.
 * - Still asking (the panel's first read): one "Checking the lobby bot…"
 *   line, never the by-hand steps the bot is about to fold away
 *   (inhouseSetupPath).
 *
 * Only the league's ticket admins can pick the league ticket in Dota, so a
 * lobby made by hand needs one of them as host (docs/DOTA-LOBBY-BOT.md).
 */
export function GameSetupCard({
  lobby,
  me,
  manualStart = null,
  collapsed = false,
}: {
  lobby: RoomLobby;
  me: InhouseState["me"];
  /** The optional "Start the game clock" control (Set up screen only). */
  manualStart?: React.ReactNode;
  /**
   * Under way (Play): the ten are in the game, so the lobby's details fold
   * under one line. The side line stays out (it only shows while the bot
   * still reports seats), and the bot panel stays mounted, reporting.
   */
  collapsed?: boolean;
}) {
  const [bot, setBot] = useState<LobbyBotAvailability>("checking");
  // The bot was hosting another game when this card looked (one bot, one
  // game at a time): this game goes by hand, and stays so for this card even
  // once the bot frees up, so its ten never get a second lobby name midway.
  const [handHosted, setHandHosted] = useState(false);
  const onAvailability = useCallback((next: LobbyBotAvailability) => {
    setBot(next);
    if (next === "busy") setHandHosted(true);
  }, []);
  // The viewer's own seat in the bot's lobby, from the panel's seat list
  // (null while it shows none).
  const [viewerSeat, setViewerSeat] = useState<LobbySeat | null>(null);
  // The first thing a player needs once teams lock: which side to sit on,
  // and, while the bot reports seats, whether they're on it yet.
  const sideLine = inhouseViewerSideLine({
    status: lobby.status,
    myTeam: me.myTeam,
    teams: lobby.teams,
    seat: viewerSeat,
  });
  const botOn = bot === "on";
  // The bot as this game's way in (the by-hand steps fold away under it),
  // the by-hand steps, or a line while the bot's first answer is on the way.
  const path = inhouseSetupPath({ bot, handHosted });
  const botFirst = path === "bot";
  const showBotPanel =
    me.isAdmin ||
    botOn ||
    bot === "unavailable" ||
    bot === "busy" ||
    handHosted;
  // Each live game has its own voice channels and hand-hosted lobby name, so
  // two games set up at once never meet in the same place.
  const voiceByTeam = (team: number) => inhouseVoiceChannel(lobby.slot, team);
  const handLobbyName = inhouseHandLobbyName(lobby.slot);

  // The steps lay out by the card's own width (it sits beside the rosters
  // on a wide screen): stacked, then the lobby beside the ticket with voice
  // under both, then all three in a row. Under the bot they are two.
  const stepClass = (step: "lobby" | "ticket" | "voice") =>
    cn(
      "min-w-0 p-4 sm:p-5",
      step === "lobby" &&
        (botFirst
          ? "border-b border-line @xl:border-b-0 @xl:border-r"
          : "border-b border-line @xl:border-r @4xl:border-b-0"),
      step === "ticket" &&
        !botFirst &&
        "border-b border-line @4xl:border-b-0 @4xl:border-r",
      step === "voice" && "@xl:col-span-2 @4xl:col-span-1",
    );
  const stepLabel = (text: string) => (
    <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-accent">
      {text}
    </p>
  );

  const lobbyStep = (
    <div className={stepClass("lobby")}>
      {stepLabel("01 · Dota lobby")}
      <h4 className="text-sm font-semibold">Create or join</h4>
      <p className="mt-1 text-xs text-muted">Dota 2 → Play → Custom Lobbies</p>
      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-3">
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

  const ticketStep = (
    <div className={cn(stepClass("ticket"), "bg-accent/5")}>
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
    <div className={stepClass("voice")}>
      {stepLabel(numbered ? "03 · Team voice" : "Team voice")}
      <h4 className="text-sm font-semibold">Meet in Discord</h4>
      <p className="mt-1 text-xs text-muted">Join your side’s voice channel.</p>
      <ul
        className={cn(
          "mt-3 grid grid-cols-2 gap-2",
          numbered && "@4xl:grid-cols-1",
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
      className="@container min-w-0 overflow-hidden rounded-2xl border border-line bg-surface/90"
    >
      {collapsed ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
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
      )}
      {/* Straight under the heading, so it is on a phone's first screen:
          the side to sit on, from the game's teams, and from the bot's seat
          list whether the viewer is on it yet. */}
      {sideLine ? (
        <div
          role="status"
          aria-label="Your side"
          className={cn(
            "flex min-w-0 items-start gap-2.5 border-b border-line px-4 py-3 sm:px-5",
            sideLine.tone === "move"
              ? "bg-accent/10"
              : sideLine.side === "radiant"
                ? "bg-success/10"
                : "bg-danger/10",
          )}
        >
          {sideLine.tone === "join" ? (
            <span
              aria-hidden
              className={cn(
                "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
                sideMeta(sideLine.side === "radiant").dot,
              )}
            />
          ) : (
            <span
              aria-hidden
              className={cn(
                "shrink-0 text-sm font-bold",
                sideLine.tone === "move"
                  ? "text-accent"
                  : sideLine.side === "radiant"
                    ? "text-success"
                    : "text-danger-soft",
              )}
            >
              {sideLine.tone === "move" ? "!" : "✓"}
            </span>
          )}
          <p className="min-w-0 break-words text-sm font-semibold text-fg">
            {sideLine.text}
          </p>
        </div>
      ) : null}
      <SetupDetails collapsed={collapsed}>
        {/* Always mounted, so it keeps reporting whether the bot answers; only
            shown when it can help (or to an admin, as a status line). */}
        <div
          className={
            showBotPanel ? "border-b border-line p-3 sm:p-4" : "hidden"
          }
        >
          <DotaLobbyControls
            key={lobby.id}
            kind="inhouse"
            id={lobby.id}
            onAvailability={onAvailability}
            onViewerSeat={setViewerSeat}
          />
        </div>
        {path === "checking" ? (
          <>
            {/* An admin sees the panel's own "Checking bot status…". */}
            {showBotPanel ? null : (
              <p
                role="status"
                className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm text-muted sm:px-5"
              >
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
                />
                Checking the lobby bot…
              </p>
            )}
            {voiceStep(false)}
          </>
        ) : botFirst ? (
          <>
            {voiceStep(false)}
            <details className="group border-t border-line">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs sm:px-5 text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [&::-webkit-details-marker]:hidden">
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
              <div className="grid gap-0 border-t border-line @xl:grid-cols-2">
                {lobbyStep}
                {ticketStep}
              </div>
              {manualStart}
            </details>
          </>
        ) : (
          <>
            <div className="grid gap-0 @xl:grid-cols-2 @4xl:grid-cols-3">
              {lobbyStep}
              {ticketStep}
              {voiceStep(true)}
            </div>
            {manualStart}
          </>
        )}
      </SetupDetails>
    </section>
  );
}

/**
 * The card's body, or (`collapsed`) the same body folded under one line. A
 * closed <details> keeps its children mounted, so the bot panel inside keeps
 * reading the bot (and marking the game started or over).
 */
function SetupDetails({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: React.ReactNode;
}) {
  if (!collapsed) return <>{children}</>;
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-surface-2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:px-5 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="font-semibold">Lobby and voice channels</span>
          <span className="text-muted"> · name, password, ticket</span>
        </span>
        <span
          aria-hidden
          className="text-muted transition-transform group-open:rotate-180"
        >
          ⌄
        </span>
      </summary>
      <div className="border-t border-line">{children}</div>
    </details>
  );
}
