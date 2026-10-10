"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DotaLobbyView, LobbyAction, LobbyKind } from "@/lib/dota-lobby";
import { LEAGUE_GAME_MODE } from "@/lib/constants";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { buttonClasses } from "./ui";

const labels = {
  idle: "No bot lobby yet",
  creating: "Creating lobby…",
  ready: "Lobby ready",
  starting: "Dota is starting the game…",
  started: "Game started",
  blocked: "Lobby needs attention",
  released: "Bot released",
};

/**
 * Whether the bot can host this game, for a page that lays itself out around
 * the panel: still asking, not set up at all, answering with a lobby state, or
 * set up but failing (its error explains why).
 */
export type LobbyBotAvailability = "checking" | "off" | "on" | "unavailable";

/**
 * Who the panel is for. "host": the people who make the lobby (inhouse
 * players and season captains, beside the manual setup steps), who need to
 * hear that the bot is missing or failing. "player": the season match page's
 * copy for the players, standins and admins who join it. Captain tools, where
 * the manual steps live, is not on their page, and they can't connect the bot
 * or set a ticket, so their panel shows only once the bot answers with a
 * lobby.
 */
export type LobbyPanelAudience = "host" | "player";

/** Whether the panel renders at all for this audience right now. */
export function lobbyPanelVisible(
  audience: LobbyPanelAudience,
  availability: LobbyBotAvailability,
): boolean {
  return audience === "host" || availability === "on";
}

export function DotaLobbyControls({
  kind,
  id,
  recoveryOnly = false,
  onAvailability,
  audience = "host",
}: {
  kind: LobbyKind;
  id: string;
  recoveryOnly?: boolean;
  /** Defaults to "host"; see LobbyPanelAudience. */
  audience?: LobbyPanelAudience;
  /** Called whenever the bot's availability changes (see LobbyBotAvailability). */
  onAvailability?: (availability: LobbyBotAvailability) => void;
}) {
  const [view, setView] = useState<DotaLobbyView | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const busy = useRef(false);
  const request = useCallback(
    async (action: LobbyAction | "status", signal?: AbortSignal) => {
      if (busy.current) return;
      busy.current = true;
      setPending(true);
      try {
        const response = await fetch("/api/dota-lobby", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, id, action }),
          signal: signal ?? AbortSignal.timeout(20_000),
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error ?? "Could not reach the lobby bot.");
        setView(body);
        setError("");
      } catch (error) {
        if (!signal?.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Could not reach the lobby bot.",
          );
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [kind, id],
  );

  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => void request("status", abort.signal), 0);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [request]);
  const state = view?.status?.state;
  const availability: LobbyBotAvailability =
    view?.enabled === false
      ? "off"
      : view?.enabled && state
        ? "on"
        : error
          ? "unavailable"
          : "checking";
  useEffect(() => {
    onAvailability?.(availability);
  }, [availability, onAvailability]);
  useEffect(() => {
    if (!state || ["idle", "released"].includes(state)) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void request("status");
    }, 5000);
    return () => clearInterval(timer);
  }, [state, request]);

  if (!lobbyPanelVisible(audience, availability)) return null;
  // Joiners can't create, start or release the lobby, so their copy says who
  // does. An admin on the players' panel can, and gets the hosts' copy.
  const joiner = audience === "player" && !view?.canRelease;

  return (
    <section
      aria-label="Steam lobby bot"
      className="space-y-3 rounded-xl border border-accent/30 bg-accent/5 p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Steam lobby bot</h3>
        <span className="text-xs text-muted">{LEAGUE_GAME_MODE.name} · {LEAGUE_CONFIG.gameServerRegion}</span>
      </div>
      {view?.enabled === false ? (
        <p className="text-sm text-muted">
          An admin needs to connect the Steam lobby bot. You can still create
          the lobby in Dota using the manual setup instructions.
        </p>
      ) : null}
      <p role="status" className="text-sm">
        {state ? labels[state] : pending ? "Checking bot status…" : ""}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      ) : null}
      {view?.enabled && state ? (
        <>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">Lobby name</dt>
              <dd className="break-words font-mono">{view.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Password</dt>
              <dd className="font-mono">{view.password}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Radiant</dt>
              <dd>{view.radiantName}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Dire</dt>
              <dd>{view.direName}</dd>
            </div>
          </dl>
          {joiner && ["idle", "released"].includes(state) ? (
            <p className="text-xs text-muted">
              Once a captain creates it, join with this name and password.
            </p>
          ) : null}
          <p className="text-xs text-muted">
            Ticket {view.leagueId}. Join through Dota → Play → Custom Lobbies.
            The bot checks the ticket, mode, region, and rosters before
            starting.
          </p>
          {view.status.lobbyId ? (
            <p className="text-xs text-muted">
              Dota lobby {view.status.lobbyId}
              {view.status.matchId ? ` · Match ${view.status.matchId}` : ""}
            </p>
          ) : null}
          {state === "blocked" ? (
            <p className="text-sm text-muted">
              {joiner
                ? "The bot can't run this lobby right now. Your captains can fix it or host the lobby by hand."
                : "Check that the bot is online and has permission to use this ticket. Refresh before retrying. Release the bot only after checking the existing lobby in Dota."}
            </p>
          ) : null}
          {state === "started" && kind === "season" ? (
            <p className="text-xs text-muted">
              After this result is imported, this page offers the next game in
              the series.
            </p>
          ) : null}
          {state === "started" && kind === "inhouse" && !recoveryOnly ? (
            <p className="text-xs text-muted">
              The result records itself from OpenDota after the game. When
              it ends, press “Game over — queue again” to play the next one
              straight away.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {!recoveryOnly && view.canControl && ["idle", "released"].includes(state) ? (
              <button
                type="button"
                disabled={pending}
                className={buttonClasses("primary", "sm")}
                onClick={() => void request("create")}
              >
                Create Dota lobby
              </button>
            ) : null}
            {!recoveryOnly && view.canControl && state === "ready" ? (
              <button
                type="button"
                disabled={pending}
                className={buttonClasses("primary", "sm")}
                onClick={() => void request("start")}
              >
                Start game with bot
              </button>
            ) : null}
            {view.canRelease &&
            ["ready", "blocked", "started"].includes(state) ? (
              <button
                type="button"
                disabled={pending}
                className={buttonClasses("secondary", "sm")}
                onClick={() => setConfirmRelease(true)}
              >
                Release bot…
              </button>
            ) : null}
          </div>
          {confirmRelease ? (
            <div className="space-y-2 rounded-lg border border-line p-3">
              <p className="text-sm">
                The bot will leave this Dota lobby. The lobby may remain open
                for its players; check it before creating another.
              </p>
              <button
                type="button"
                disabled={pending}
                className={buttonClasses("secondary", "sm")}
                onClick={() => {
                  setConfirmRelease(false);
                  void request("release");
                }}
              >
                Release bot
              </button>{" "}
              <button
                type="button"
                className={buttonClasses("secondary", "sm")}
                onClick={() => setConfirmRelease(false)}
              >
                Keep hosting
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {view?.enabled !== false ? (
        <button
          type="button"
          disabled={pending}
          className={buttonClasses("secondary", "sm")}
          onClick={() => void request("status")}
        >
          Refresh bot status
        </button>
      ) : null}
    </section>
  );
}
