"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  createOpen,
  INHOUSE_SEAT_RULE_NOTE,
  inviteResultToast,
  inviteUnknownToast,
  LOBBY_LEFT_NOTE,
  LOBBY_OVER_NOTE,
  LOBBY_RELEASING_NOTE,
  lobbyBusyElsewhere,
  lobbyBusyLabel,
  lobbyBusyNote,
  lobbyListVisible,
  lobbyPanelPollMs,
  lobbyPlayerRow,
  lobbySeatSummary,
  lobbyStatusLabel,
  noPopupHelp,
  reinviteMissingOpen,
  releaseOpen,
  selfInviteOpen,
  startOpen,
  viewerLobbySeat,
  type DotaLobbyView,
  type LobbyAction,
  type LobbyInviteScope,
  type LobbyKind,
  type LobbySeat,
} from "@/lib/dota-lobby";
import { DUEL_GAME_MODE, LEAGUE_GAME_MODE } from "@/lib/constants";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { requestSignal } from "@/lib/request-signal";
import { cn } from "@/lib/utils";
import { CopyChip } from "./copy-chip";
import { pushToast } from "./toaster";
import { buttonClasses } from "./ui";

const UNREACHABLE = "Could not reach the lobby bot.";
/** A request the panel sends gives up after this long. */
const REQUEST_TIMEOUT_MS = 20_000;

/** What /api/dota-lobby answers: a view, or an error and its unknown flag. */
type RouteBody =
  | (Partial<DotaLobbyView> & {
      error?: unknown;
      unknown?: unknown;
      /** Create's BUSY self-heal sent a closed game's release: progress. */
      freeing?: unknown;
    })
  | null;

/** The route's own fixed message, never a caught error's text. */
function routeError(body: unknown): string {
  const error = (body as RouteBody)?.error;
  return typeof error === "string" ? error : UNREACHABLE;
}

/**
 * Whether the bot can host this game, for a page that lays itself out around
 * the panel: still asking, not set up at all, answering with a lobby state,
 * set up but failing (its error explains why), or hosting ANOTHER game still
 * being played while this one has no bot lobby ("busy": host it by hand).
 */
export type LobbyBotAvailability =
  | "checking"
  | "off"
  | "on"
  | "unavailable"
  | "busy";

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
  return audience === "host" || availability === "on" || availability === "busy";
}

export function DotaLobbyControls({
  kind,
  id,
  recoveryOnly = false,
  onAvailability,
  onViewerSeat,
  audience = "host",
}: {
  kind: LobbyKind;
  id: string;
  recoveryOnly?: boolean;
  /** Defaults to "host"; see LobbyPanelAudience. */
  audience?: LobbyPanelAudience;
  /** Called whenever the bot's availability changes (see LobbyBotAvailability). */
  onAvailability?: (availability: LobbyBotAvailability) => void;
  /**
   * Called whenever the viewer's own seat in the bot's lobby changes, from
   * the seat list this panel shows (`viewerLobbySeat`), or null while it
   * shows none: the setup card's "your side" line.
   */
  onViewerSeat?: (seat: LobbySeat | null) => void;
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
          // Create freed the bot from a closed game: press it again shortly.
          else if (body?.freeing === true)
            pushToast("info", routeError(body));
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
  const busy = view?.status ? lobbyBusyElsewhere(view) : null;
  // The bot is another game's, still being played: this one is hand-hosted.
  const busyLive = busy !== null && !busy.closed;
  const availability: LobbyBotAvailability =
    view?.enabled === false
      ? "off"
      : view?.enabled && state
        ? busyLive
          ? "busy"
          : "on"
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

  // Only a bot that invites reports seats, and only while its lobby is ready
  // or Dota is starting the game: the list shows then, so it is never false
  // under an older bot.
  const players =
    view?.enabled && lobbyListVisible(state) && view.players?.length
      ? view.players
      : null;
  // The setup card's "your side" line follows the same list.
  const mySeat = viewerLobbySeat(players);
  useEffect(() => {
    onViewerSeat?.(mySeat);
  }, [mySeat, onViewerSeat]);

  if (!lobbyPanelVisible(audience, availability)) return null;
  // Joiners can't create, start or release the lobby, so their copy says who
  // does. An admin on the players' panel can, and gets the hosts' copy.
  const joiner = audience === "player" && !view?.canRelease;
  const releasing = view?.status?.releasing === true;
  // A running game the bot has left early: the bot is free for the next one.
  const left = view?.status?.left === true;
  const duel = kind === "duel";
  // In-house only: how many sit on their own side, then "All ten seated",
  // which highlights Start for the viewers who have it and tells everyone
  // else a captain starts the game.
  const seatSummary =
    view?.enabled && view.status
      ? lobbySeatSummary({
          kind,
          playable,
          status: view.status,
          players,
          canStart: !recoveryOnly && startOpen(view),
        })
      : null;
  const startHighlighted = seatSummary?.start === true;

  return (
    <section
      aria-label="Steam lobby bot"
      className="min-w-0 space-y-3 rounded-xl border border-accent/30 bg-accent/5 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Steam lobby bot</h3>
        <span className="text-xs text-muted">
          {duel ? DUEL_GAME_MODE.name : LEAGUE_GAME_MODE.name} · {LEAGUE_CONFIG.gameServerRegion}
        </span>
      </div>
      {view?.enabled === false ? (
        <p className="text-sm text-muted">
          An admin needs to connect the Steam lobby bot. You can still create
          the lobby in Dota using the manual setup instructions.
        </p>
      ) : null}
      <p role="status" className="text-sm">
        {view?.status && state
          ? busy
            ? lobbyBusyLabel(busy)
            : lobbyStatusLabel(view.status)
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
          {busy ? (
            <p className="text-xs text-muted">
              {lobbyBusyNote(busy, view.canControl, kind)}
            </p>
          ) : null}
          {/* No bot lobby will exist for a game the bot can't host now, so
              its name and password stay off the card (the by-hand steps
              carry the lobby to join). */}
          {busyLive ? null : (
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="mb-1 text-xs text-muted">Lobby name</dt>
                <dd>
                  <CopyChip value={view.name} label="lobby name" />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="mb-1 text-xs text-muted">Password</dt>
                <dd>
                  <CopyChip value={view.password} label="password" />
                </dd>
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
          )}
          {/* Anyone who can't press Create (a player, not a captain) waits
              for a captain's lobby; the hosts get the Create button. */}
          {!duel && !view.canControl && !busy && ["idle", "released"].includes(state) ? (
            <p className="text-xs text-muted">
              Once a captain creates it, join with this name and password.
            </p>
          ) : null}
          {releasing ? (
            <p className="text-xs text-muted">{LOBBY_RELEASING_NOTE}</p>
          ) : over ? (
            <p className="text-xs text-muted">{LOBBY_OVER_NOTE}</p>
          ) : left ? (
            <p className="text-xs text-muted">{LOBBY_LEFT_NOTE}</p>
          ) : null}
          {players ? (
            <>
              {state === "ready" && releasing ? null : state === "ready" ? (
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
              {/* In-house games and 1v1s: the bot keeps its sides right
                  while the lobby fills (it moves nobody in a season lobby). */}
              {kind !== "season" && state === "ready" && !releasing ? (
                <p className="text-xs text-muted">{INHOUSE_SEAT_RULE_NOTE}</p>
              ) : null}
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
          ) : over || busyLive ? null : (
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
          {state === "started" && duel && !recoveryOnly && !over ? (
            <p className="text-xs text-muted">
              The result records itself from OpenDota after the game, and the
              1v1 is marked over here as soon as Dota shows its end.
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
          {/* Right above Start: how many sit on their side, then the "All
              ten seated" state (lobbySeatSummary). A status, so a screen
              reader hears the count change and "All ten seated". */}
          {seatSummary ? (
            <p
              role="status"
              className={cn(
                "min-w-0 break-words",
                seatSummary.allSeated
                  ? "rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm font-semibold text-fg"
                  : "text-xs text-muted",
              )}
            >
              {seatSummary.allSeated ? (
                <span aria-hidden className="mr-1.5 text-success">
                  ✓
                </span>
              ) : null}
              {seatSummary.text}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {!recoveryOnly && createOpen(view) ? (
              <button
                type="button"
                disabled={pending}
                className={buttonClasses("primary", "md")}
                onClick={() => void act("create")}
              >
                Create Dota lobby
              </button>
            ) : null}
            {!recoveryOnly && startOpen(view) ? (
              <button
                type="button"
                disabled={pending}
                className={buttonClasses(
                  "primary",
                  "md",
                  startHighlighted
                    ? "ring-2 ring-success ring-offset-2 ring-offset-surface"
                    : undefined,
                )}
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
                {duel
                  ? "The bot will leave this Dota lobby: at once on the lobby screen, or when a running game ends. A 1v1 that hasn't started stays paired, and the bot makes it a fresh lobby on its next check. To end the 1v1 instead, use “Call it off”."
                  : "The bot will leave this Dota lobby: at once on the lobby screen, or when a running game ends. The lobby may remain open for its players; check it before creating another."}
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
