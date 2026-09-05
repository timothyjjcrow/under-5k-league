"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DotaLobbyControls } from "./dota-lobby-controls";
import { buttonClasses } from "./ui";

/** Mounted for admins only; the API independently verifies their session. */
export function DotaLobbyRecovery() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [steamId, setSteamId] = useState<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);
  const busy = useRef(false);
  const check = useCallback(async (manual = false, signal?: AbortSignal) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const response = await fetch("/api/dota-lobby/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not check bot recovery.");
      setEnabled(body.enabled === true);
      setOnline(body.online === true);
      setSteamId(typeof body.steamId === "string" ? body.steamId : null);
      setId(typeof body.id === "string" ? body.id : null);
      setError("");
    } catch (error) {
      if (!signal?.aborted) {
        // A failed check cannot confirm the previously displayed connection.
        setEnabled(true);
        setOnline(null);
        setSteamId(null);
        setId(null);
        if (manual) setError(error instanceof Error ? error.message : "Could not check bot recovery.");
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    const initial = setTimeout(() => void check(false, abort.signal), 0);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void check(false, abort.signal);
    }, 15_000);
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
  return (
    <aside aria-label="Bot connection and recovery" className="mt-4 space-y-3">
      <div>
        <p role="status" className="flex items-center gap-2 text-sm font-medium">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${online === true ? "bg-emerald-400" : online === false ? "bg-amber-400" : "bg-muted"}`} />
          {status}
        </p>
        {enabled !== null ? (
          <p className="mt-1 text-xs text-muted">
            {online === true
              ? `Connected to Steam and Dota${steamId ? ` · Steam account ${steamId}` : ""}.`
              : online === false
                ? "Keep the bot host awake and online, then check again."
                : "The site could not confirm the bot connection. Check again shortly."}
          </p>
        ) : null}
      </div>
      {id ? (
        <>
          <p className="text-sm text-muted">
            The bot is still attached to a closed in-house game. Check its Dota lobby before releasing it for the next game.
          </p>
          <DotaLobbyControls key={id} kind="inhouse" id={id} recoveryOnly />
        </>
      ) : null}
      {error ? <p role="alert" className="text-sm text-red-400">{error}</p> : null}
      <button type="button" disabled={pending} className={buttonClasses("secondary", "sm")} onClick={() => void check(true)}>
        {pending ? "Checking bot…" : "Check bot connection"}
      </button>
    </aside>
  );
}
