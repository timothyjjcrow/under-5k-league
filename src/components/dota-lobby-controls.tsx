"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  inviteResultToast,
  inviteUnknownToast,
  LOBBY_OVER_NOTE,
  LOBBY_RELEASING_NOTE,
  lobbyListVisible,
  lobbyPanelPollMs,
  lobbyPlayerRow,
  lobbyStatusLabel,
  noPopupHelp,
  reinviteMissingOpen,
  releaseOpen,
  selfInviteOpen,
  startOpen,
  type DotaLobbyView,
  type LobbyAction,
  type LobbyInviteScope,
  type LobbyKind,
} from "@/lib/dota-lobby";
import { LEAGUE_GAME_MODE } from "@/lib/constants";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { requestSignal } from "@/lib/request-signal";
import { cn } from "@/lib/utils";
import { pushToast } from "./toaster";
import { buttonClasses } from "./ui";

const UNREACHABLE = "Could not reach the lobby bot.";
/** A request the panel sends gives up after this long. */
const REQUEST_TIMEOUT_MS = 20_000;

/** What /api/dota-lobby answers: a view, or an error and its unknown flag. */
type RouteBody =
  | (Partial<DotaLobbyView> & { error?: unknown; unknown?: unknown })
  | null;

/** The route's own fixed message, never a caught error's text. */
function routeError(body: unknown): string {
  const error = (body as RouteBody)?.error;
  return typeof error === "string" ? error : UNREACHABLE;
}

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
  // The ACTION lock: only Create, Start, an invite or Release hold it (and
  // disable the buttons). Background reads never take it, so a poll in
  // flight never disables a button or drops a click.
  const [pending, setPending] = useState(false);
  const [reading, setReading] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const acting = useRef(false);
  /** The read in flight, if any: one at a time, and an action cancels it. */
  const inFlightRead = useRef<AbortController | null>(null);
  /** Bumped by every action, so a read sent before it never lands after it. */
  const actions = useRef(0);
  const listHeading = useId();

  /**
   * One request and its body, bounded by REQUEST_TIMEOUT_MS from the send
   * to the last byte, and cancelled by any of `cancels`.
   */
  const send = useCallback(
    async (
      action: LobbyAction | "status",
      ...cancels: (AbortSignal | undefined)[]
    ): Promise<{ ok: boolean; body: unknown }> => {
      const request = requestSignal(REQUEST_TIMEOUT_MS, ...cancels);
      try {
        const response = await fetch("/api/dota-lobby", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, id, action }),
          signal: request.signal,
        });
        return { ok: response.ok, body: await response.json() };
      } finally {
        request.done();
      }
    },
    [kind, id],
  );

  /**
   * Read the bot's status: the background polls, the first read and
   * "Refresh bot status". Skipped while an action or another read is in
   * flight (their answer is as new); an action that starts meanwhile cancels
   * it, and its own reply wins.
   */
  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (acting.current || inFlightRead.current) return;
      const controller = new AbortController();
      inFlightRead.current = controller;
      const since = actions.current;
      const stale = () =>
        controller.signal.aborted ||
        signal?.aborted === true ||
        actions.current !== since;
      setReading(true);
      try {
        const { ok, body } = await send("status", controller.signal, signal);
        if (stale()) return;
        // Only the route's own fixed messages reach the viewer, never a
        // caught error's text.
        if (!ok) {
          setError(routeError(body));
          return;
        }
        setView(body as DotaLobbyView);
        setError("");
      } catch {
        if (!stale()) setError(UNREACHABLE);
      } finally {
        if (inFlightRead.current === controller) {
          inFlightRead.current = null;
          setReading(false);
        }
      }
    },
    [send],
  );

  /** Create, Start, an invite or Release: holds the action lock. */
  const act = useCallback(
    async (
      action: LobbyAction,
      /** An invite's button: whose invites it asked for, to word the toast. */
      inviteScope?: LobbyInviteScope,
    ) => {
      if (acting.current) return;
      acting.current = true;
      actions.current += 1;
      // An action wins over a read in flight: its reply is the newer state.
      inFlightRead.current?.abort();
      inFlightRead.current = null;
      setReading(false);
      setPending(true);
      let answered = false;
      try {
        const reply = await send(action);
        const body = reply.body as RouteBody;
        answered = true;
        // An action's failure is toasted, never set inline: the next
        // background read (3s on a playable game) clears the inline line,
        // and with it what the failure asked the presser to do.
        if (!reply.ok) {
          // The bot's leg lost the answer: the invites may have gone out.
          if (inviteScope && body?.unknown === true)
            pushToast("info", inviteUnknownToast(inviteScope));
          else pushToast("error", routeError(body));
          return;
        }
        setView(body as DotaLobbyView);
        setError("");
        if (inviteScope) {
          const toast = inviteResultToast({
            scope: inviteScope,
            invited: body?.invited,
            players: body?.players,
          });
          pushToast(toast.type, toast.message);
        }
      } catch {
        // No answer (timed out, dropped, unreadable): an invite may still
        // have gone out, so it is unknown, never failed.
        if (inviteScope && !answered)
          pushToast("info", inviteUnknownToast(inviteScope));
        else pushToast("error", UNREACHABLE);
      } finally {
        acting.current = false;
        setPending(false);
      }
    },
    [send],
  );

  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => void read(abort.signal), 0);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [read]);
  const state = view?.status?.state;
  const over = view?.status?.over === true;
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
  const playable = view?.playable === true;
  // No answer yet, and the last read failed: try again by itself.
  const unanswered = !view && error !== "";
  useEffect(() => {
    // Fast while the bot sets the lobby up, or while a playable game waits
    // for anyone to create it; every 15s once the game runs, or while a
    // failed first read retries; not at all once Dota showed it over
    // (lobbyPanelPollMs says why).
    const every = lobbyPanelPollMs(state, playable, over, unanswered);
    if (every === null) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, every);
    // A tab coming back reads at once instead of waiting out the interval.
    const onVisible = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state, playable, over, unanswered, read]);

  if (!lobbyPanelVisible(audience, availability)) return null;
  // Joiners can't create, start or release the lobby, so their copy says who
  // does. An admin on the players' panel can, and gets the hosts' copy.
  const joiner = audience === "player" && !view?.canRelease;
  // Only a bot that invites reports seats, and only while its lobby is ready
  // or Dota is starting the game: the list shows then, so it is never false
  // under an older bot.
  const players =
    view?.enabled && lobbyListVisible(state) && view.players?.length
      ? view.players
      : null;
  const releasing = view?.status?.releasing === true;

  return (
    <section
      aria-label="Steam lobby bot"
      className="min-w-0 space-y-3 rounded-xl border border-accent/30 bg-accent/5 p-5"
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
        {view?.status && state
          ? lobbyStatusLabel(view.status)
          : pending || reading
            ? "Checking bot status…"
            : ""}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      ) : null}
      {view?.enabled && state ? (
        <>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs text-muted">Lobby name</dt>
              <dd className="break-words font-mono">{view.name}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted">Password</dt>
              <dd className="break-words font-mono">{view.password}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted">Radiant</dt>
              <dd className="break-words">{view.radiantName}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted">Dire</dt>
              <dd className="break-words">{view.direName}</dd>
            </div>
          </dl>
          {joiner && ["idle", "released"].includes(state) ? (
            <p className="text-xs text-muted">
              Once a captain creates it, join with this name and password.
            </p>
          ) : null}
          {releasing ? (
            <p className="text-xs text-muted">{LOBBY_RELEASING_NOTE}</p>
          ) : over ? (
            <p className="text-xs text-muted">{LOBBY_OVER_NOTE}</p>
          ) : null}
          {players ? (
            <>
              {state === "ready" ? (
                <p className="text-xs text-muted">
                  The bot invites everyone in Dota once the lobby is ready:
                  accept the invite (no password needed), then take a slot on
                  your side. Anyone whose Dota is closed gets the invite when
                  they open it. {noPopupHelp(view.inviteScope)}
                </p>
              ) : (
                <p className="text-xs text-muted">
                  Dota is starting the game with the players below. Anyone
                  still missing can join with this name and password.
                </p>
              )}
              <p className="text-xs text-muted">
                Ticket {view.leagueId}. The bot checks the ticket, mode,
                region, and rosters before starting.
              </p>
              <div className="min-w-0">
                <h4 id={listHeading} className="mb-1.5 text-xs font-semibold">
                  Who&apos;s in the lobby
                </h4>
                <ul
                  aria-labelledby={listHeading}
                  className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line"
                >
                  {players.map((player, i) => {
                    const row = lobbyPlayerRow(player);
                    return (
                      <li
                        key={i}
                        className="flex min-w-0 flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
                      >
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="min-w-0 truncate text-sm font-medium">
                            {player.name}
                          </span>
                          {player.self ? (
                            <span className="shrink-0 text-xs text-muted">
                              (you)
                            </span>
                          ) : null}
                        </span>
                        <span
                          className={cn(
                            "min-w-0 text-xs sm:text-right",
                            row.settled ? "text-success" : "text-muted",
                          )}
                        >
                          {row.text}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted">
              Ticket {view.leagueId}. Join through Dota → Play → Custom Lobbies.
              The bot checks the ticket, mode, region, and rosters before
              starting.
            </p>
          )}
          {view.status.lobbyId ? (
            <p className="break-words text-xs text-muted">
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
          {state === "started" && kind === "inhouse" && !recoveryOnly && !over ? (
            <p className="text-xs text-muted">
              The result records itself from OpenDota after the game, and the
              game is marked over here as soon as Dota shows its end. If it
              isn&apos;t, press “Game over — queue again” once the game ends
              to play the next one straight away.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {!recoveryOnly && view.canControl && ["idle", "released"].includes(state) ? (
              <button
                type="button"
                disabled={pending}
                className={buttonClasses("primary", "sm")}
                onClick={() => void act("create")}
              >
                Create Dota lobby
              </button>
            ) : null}
            {!recoveryOnly && startOpen(view) ? (
              <button
                type="button"
                disabled={pending}
                className={buttonClasses("primary", "sm")}
                onClick={() => void act("start")}
              >
                Start game with bot
              </button>
            ) : null}
            {reinviteMissingOpen(view) ? (
              <button
                type="button"
                disabled={pending}
                className={buttonClasses("secondary", "sm")}
                onClick={() => void act("invite", "missing")}
              >
                Re-invite missing players
              </button>
            ) : null}
            {selfInviteOpen(view) ? (
              <button
                type="button"
                disabled={pending}
                className={buttonClasses("secondary", "sm")}
                onClick={() => void act("invite", "self")}
              >
                Send me an invite
              </button>
            ) : null}
            {releaseOpen(view) ? (
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
          {confirmRelease && releaseOpen(view) ? (
            <div className="space-y-2 rounded-lg border border-line p-3">
              <p className="text-sm">
                The bot will leave this Dota lobby: at once on the lobby
                screen, or when a running game ends. The lobby may remain
                open for its players; check it before creating another.
              </p>
              <button
                type="button"
                disabled={pending}
                className={buttonClasses("secondary", "sm")}
                onClick={() => {
                  setConfirmRelease(false);
                  void act("release");
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
          onClick={() => void read()}
        >
          Refresh bot status
        </button>
      ) : null}
    </section>
  );
}
