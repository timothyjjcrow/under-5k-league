"use client";

// Play later's browser pieces (the card and the banner are inhouse-times.tsx):
// the time box that turns a clock time into the instant it names on the
// player's own clock, the button that copies a time's link, and a time's
// start as the banner says it ("Today, 8:00 PM").

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { pushToast } from "@/components/toaster";
import { buttonClasses } from "@/components/ui";
import { countdownLabel } from "@/lib/countdown";
import {
  defaultInhouseTimeClock,
  inhouseTimeDayWord,
  inhouseTimeLinkPath,
  inhouseTimeParam,
  nextInhouseTimeAt,
  parseInhouseTimeParam,
  quarterHourClock,
} from "@/lib/inhouse-times";

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * "Today, 8:00 PM" or "Tomorrow, 1:00 AM", on the viewer's clock
 * (inhouseTimeDayWord), or "Sun 1:00 AM" for one further out.
 */
function dayAndTime(ms: number, nowMs: number): string {
  const word = inhouseTimeDayWord(ms, nowMs, viewerZone());
  if (!word) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  }
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(ms),
  );
  return `${word}, ${time}`;
}

/** Re-read once a minute, so a page left open past midnight moves "Tomorrow" to "Today". */
function subscribeMinute(onChange: () => void): () => void {
  const id = setInterval(onChange, 60_000);
  return () => clearInterval(id);
}

/**
 * A time's start in the banner at the top of /inhouse: "Today, 8:00 PM" on
 * the viewer's clock. `initial` is the server's text, the same words on the
 * league's clock with its zone named, shown until the browser takes over
 * (<LocalTime>'s trick).
 */
export function InhouseTimeWhen({
  ts,
  initial,
  className,
}: {
  ts: number;
  initial: string;
  className?: string;
}) {
  const text = useSyncExternalStore(
    subscribeMinute,
    () => dayAndTime(ts, Date.now()),
    () => initial,
  );
  return (
    <time dateTime={new Date(ts).toISOString()} className={className}>
      {text}
    </time>
  );
}

/**
 * A time box for "Post a time": the player picks a clock time and it means
 * the next time their clock reads it (today, or tomorrow once it has
 * passed), on the quarter hour. Only the browser knows the player's zone, so
 * the instant is worked out here into the hidden `at` field, and the line
 * under the box says exactly which time will be posted, including a rounding
 * the box let through, a time someone already posted (`taken`), which
 * posting joins instead, and one the player is already in on (`mine`).
 * Re-reads the clock on every change and submit, and puts its starting time
 * back after the form resets on a save.
 */
export function InhouseTimePicker({
  id,
  taken,
  mine,
  describedBy,
  children,
}: {
  id: string;
  /** The starts already on the list (inhouseTimeParam). */
  taken: readonly string[];
  /** The ones the player is in on. */
  mine: readonly string[];
  /** The hint's id, for screen readers. */
  describedBy?: string;
  /** The submit button, beside the box. */
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const takenKey = taken.join(" ");
  const mineKey = mine.join(" ");

  useEffect(() => {
    const input = inputRef.current;
    const hidden = hiddenRef.current;
    if (!input || !hidden) return;
    const takenSet = new Set(takenKey ? takenKey.split(" ") : []);
    const mineSet = new Set(mineKey ? mineKey.split(" ") : []);
    const prefill = () => {
      if (!input.value) input.value = defaultInhouseTimeClock(Date.now(), viewerZone());
    };
    const sync = () => {
      const clock = quarterHourClock(input.value);
      if (!clock) {
        hidden.value = "";
        setPreview(null);
        return;
      }
      const nowMs = Date.now();
      const ms = nextInhouseTimeAt(nowMs, clock, viewerZone());
      const at = inhouseTimeParam(ms);
      hidden.value = at;
      const parts = [dayAndTime(ms, nowMs), countdownLabel(ms, nowMs)];
      if (mineSet.has(at)) parts.push("you're already in on it");
      else if (takenSet.has(at)) parts.push("already up: posting it puts you in on it");
      setPreview(parts.filter(Boolean).join(" · "));
    };
    prefill();
    sync();
    const onReset = () =>
      queueMicrotask(() => {
        prefill();
        sync();
      });
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
    const form = input.form;
    form?.addEventListener("submit", sync);
    form?.addEventListener("reset", onReset);
    return () => {
      input.removeEventListener("input", sync);
      input.removeEventListener("change", sync);
      form?.removeEventListener("submit", sync);
      form?.removeEventListener("reset", onReset);
    };
  }, [takenKey, mineKey]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <input
          ref={inputRef}
          id={id}
          type="time"
          name="clock"
          step={900}
          required
          aria-describedby={describedBy}
          className="h-11 min-w-0 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        />
        {/* No defaultValue: on a hidden input it IS the value, and React
            would write it back over the time on every re-render (each
            new line under the box is one). */}
        <input ref={hiddenRef} type="hidden" name="at" />
        {children}
      </div>
      {/* Filled in the browser: only it knows the viewer's clock. */}
      <p className="min-h-4 text-xs text-fg" aria-live="polite">
        {preview}
      </p>
    </>
  );
}

/**
 * Copies a time's link (inhouseTimeLinkPath): pasted in Discord it unfurls
 * as the time, and it opens /inhouse as it always looks, with that time
 * leading the banner and outlined in the card under the room. It never
 * signs anyone up. The address comes from `window.location.origin` at click
 * time, so a preview, a custom domain and localhost each copy themselves.
 */
export function CopyInhouseTimeLink({ at }: { at: string }) {
  const [copied, setCopied] = useState(false);
  const startsAtMs = parseInhouseTimeParam(at);
  if (startsAtMs === null) return null;
  return (
    <button
      type="button"
      className={buttonClasses("ghost", "sm", "px-2")}
      onClick={async () => {
        const url = `${window.location.origin}${inhouseTimeLinkPath(startsAtMs)}`;
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          pushToast("success", `Copied ${url}: paste it in Discord and it shows this time.`);
          setTimeout(() => setCopied(false), 2500);
        } catch {
          // Clipboard access is permission-gated; never claim a copy that
          // didn't happen.
          pushToast("error", `Couldn't copy: the link is ${url}`);
        }
      }}
    >
      <span aria-hidden>{copied ? "✓" : "🔗"}</span>
      {copied ? "Copied!" : "Copy link"}
    </button>
  );
}
