"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LOBBY_RECOVERY_POLL_MS } from "@/lib/dota-lobby";
import { inhouseLobbyCode } from "@/lib/inhouse";
import { requestSignal } from "@/lib/request-signal";
import { DotaLobbyControls } from "./dota-lobby-controls";
import { buttonClasses } from "./ui";

/** A check gives up after this long. */
const CHECK_TIMEOUT_MS = 20_000;

/** A failed check's line when the route gave no message of its own. */
const CHECK_FAILED = "Could not check bot recovery. Confirm the bot is online, then try again.";

/** The route's own fixed message: the only error text an admin sees. */
class RouteError extends Error {}

/** Mounted for admins only; the API independently verifies their session. */
export function DotaLobbyRecovery() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [steamId, setSteamId] = useState<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Only "Check bot connection" holds this (and disables itself): the
  // background checks every LOBBY_RECOVERY_POLL_MS never do, so the button
  // never flickers to "Checking bot…" or drops a press.
  const [pending, setPending] = useState(false);
  /** The check in flight, if any, and whether an admin pressed for it. */
  const inFlight = useRef<{ controller: AbortController; manual: boolean } | null>(null);
  const check = useCallback(async (manual = false, signal?: AbortSignal) => {
    const running = inFlight.current;
    // A background check stands down while any check runs; a press wins
    // over a background check in flight, whose answer is no newer.
    if (running && (!manual || running.manual)) return;
    running?.controller.abort();
    const controller = new AbortController();
    inFlight.current = { controller, manual };
    const stale = () => controller.signal.aborted || signal?.aborted === true;
    if (manual) setPending(true);
    const request = requestSignal(CHECK_TIMEOUT_MS, controller.signal, signal);
    try {
      const response = await fetch("/api/dota-lobby/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: request.signal,
      });
      const body = await response.json();
      if (stale()) return;
      if (!response.ok)
        throw new RouteError(typeof body?.error === "string" ? body.error : CHECK_FAILED);
      setEnabled(body.enabled === true);
      setOnline(body.online === true);
      setSteamId(typeof body.steamId === "string" ? body.steamId : null);
      setId(typeof body.id === "string" ? body.id : null);
      setError("");
    } catch (error) {
      if (!stale()) {
        // A failed check cannot confirm the previously displayed connection.
        setEnabled(true);
        setOnline(null);
        setSteamId(null);
        setId(null);
        // Never a caught browser error's text (a timeout, a dropped
        // connection, an unreadable body): only the route's own message.
        if (manual) setError(error instanceof RouteError ? error.message : CHECK_FAILED);
      }
    } finally {
      request.done();
      if (inFlight.current?.controller === controller) {
        inFlight.current = null;
        if (manual) setPending(false);
      }
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    const initial = setTimeout(() => void check(false, abort.signal), 0);
    // A background refresh of the status line while the tab is visible
    // (LOBBY_RECOVERY_POLL_MS), so a bot that drops offline, or one still
    // attached to a closed game, shows within seconds. Mounted for admins
    // only; "Check bot connection" asks at once.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void check(false, abort.signal);
    }, LOBBY_RECOVERY_POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      abort.abort();
    };
  }, [check]);

  if (enabled === false) return null;
  const status = enabled === null
    ? "Checking bot connection…"
    : online === true
      ? "Bot online"
      : online === false
        ? "Bot offline"
        : "Bot connection unavailable";
  // A row of the room's admin panel (InhouseAdminTools): the status and its
  // line beside "Check bot connection", then a closed game's recovery.
  return (
    <aside aria-label="Bot connection and recovery" className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p role="status" className="flex items-center gap-2 text-sm font-medium">
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${online === true ? "bg-success" : online === false ? "bg-accent" : "bg-muted"}`} />
            {status}
          </p>
          {enabled !== null ? (
            <p className="mt-0.5 break-words text-xs text-muted">
              {online === true
                ? `Connected to Steam and Dota${steamId ? ` · Steam account ${steamId}` : ""}.`
                : online === false
                  ? "Keep the bot host awake and online, then check again."
                  : "The site could not confirm the bot connection. Check again shortly."}
            </p>
          ) : null}
        </div>
        <button type="button" disabled={pending} className={buttonClasses("secondary", "sm")} onClick={() => void check(true)}>
          {pending ? "Checking bot…" : "Check bot connection"}
        </button>
      </div>
      {id ? (
        <>
          <p className="text-sm text-muted">
            The bot is still attached to closed game #{inhouseLobbyCode(id)}. It
            leaves by itself as soon as Dota lets it: at once if that lobby is
            gone, otherwise when that game ends in Dota. If the panel below
            still offers “Release bot…”, check that Dota lobby before you
            press it.
          </p>
          <DotaLobbyControls key={id} kind="inhouse" id={id} recoveryOnly />
        </>
      ) : null}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    </aside>
  );
}
