"use client";

import { useState, type ReactNode } from "react";
import { pushToast } from "@/components/toaster";
import { Badge, buttonClasses } from "@/components/ui";
import {
  requestDesktopAlertPermission,
  showDesktopAlert,
  useDesktopAlerts,
} from "@/components/desktop-alerts";
import { INHOUSE } from "@/lib/constants";
import {
  DESKTOP_ALERTS_ON_NOTICE,
  desktopAlertsRowState,
} from "@/lib/inhouse-desktop-alert";
import { INHOUSE_QUEUE_INVITE_PATH } from "@/lib/inhouse-queue-invite";
import { cn } from "@/lib/utils";

/**
 * What a player can do from under the queue card, as one panel (Tim,
 * 2026-10-21: the centred rows stacked under the card, each with its own
 * button, looked sloppy beside the card). Two tiles, side by side from md
 * and stacked on a phone: the queue's invite link, and desktop alerts where
 * the browser can show them (a signed-in desktop viewer; without them the
 * invite spans the panel). Its footer says tab switching keeps your spot.
 * Under the card, so the card keeps the first screen.
 */
export function QueueTools({
  signedIn,
  readyCheckHint,
}: {
  signedIn: boolean;
  /** A queued player waiting for their own game: a phone's footer starts
   *  "Listen for the ready check", which the card says only to screen
   *  readers there. */
  readyCheckHint: boolean;
}) {
  const alerts = useDesktopAlerts();
  const alertsRow = signedIn
    ? desktopAlertsRowState(alerts.permission, alerts.enabled)
    : null;
  return (
    <section
      aria-label="Queue tools"
      className="overflow-hidden rounded-xl border border-line bg-surface/60"
    >
      <div
        className={cn(
          "grid grid-cols-1 divide-y divide-line",
          alertsRow && "md:grid-cols-2 md:divide-x md:divide-y-0",
        )}
      >
        <InviteTile />
        {alertsRow ? (
          <DesktopAlertsTile row={alertsRow} setEnabled={alerts.setEnabled} />
        ) : null}
      </div>
      <p className="border-t border-line px-4 py-2 text-center text-xs text-muted">
        {readyCheckHint ? (
          <span aria-hidden className="md:hidden">
            Listen for the ready check ·{" "}
          </span>
        ) : null}
        Tab switching keeps your spot · queue clears after{" "}
        {INHOUSE.QUEUE_IDLE_HOURS}h without lobby activity
      </p>
    </section>
  );
}

/** One tile: its icon, what it is and a line on what it does, its control. */
function ToolTile({
  icon,
  title,
  badge,
  description,
  action,
}: {
  icon: string;
  title: string;
  badge?: ReactNode;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-3">
      <span
        aria-hidden
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line bg-surface-2/60 text-base"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-fg">
          {title}
          {badge}
        </p>
        <p className="text-xs text-muted">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * The queue's invite (Tim, 2026-10-19): "Copy queue link" copies the link
 * that joins whoever opens it to the queue in one tap
 * (INHOUSE_QUEUE_INVITE_PATH), for anyone to paste in Discord or anywhere
 * else; it unfurls as the queue, showing how full it is. The address comes
 * from `window.location.origin` at click time, so a preview, a custom domain
 * and localhost each copy themselves, as the night's invite does. Its name
 * is its own: /inhouse also has the night's "Copy invite link" and Play
 * later's "Copy link", and one name for two controls is two buttons a
 * screen reader can't tell apart.
 */
function InviteTile() {
  const [copied, setCopied] = useState(false);
  return (
    <ToolTile
      icon="🔗"
      title="Invite friends"
      description="The link puts them in the queue in one tap."
      action={
        <button
          type="button"
          className={buttonClasses("secondary", "sm")}
          onClick={async () => {
            const url = `${window.location.origin}${INHOUSE_QUEUE_INVITE_PATH}`;
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              pushToast(
                "success",
                `Copied ${url}: paste it in Discord and it shows the queue. Opening it joins.`,
              );
              setTimeout(() => setCopied(false), 2500);
            } catch {
              // Clipboard access is permission-gated; never claim a copy that
              // didn't happen.
              pushToast("error", `Couldn't copy: the invite link is ${url}`);
            }
          }}
        >
          {copied ? "Copied!" : "Copy queue link"}
        </button>
      }
    />
  );
}

/**
 * The switch for desktop alerts (players asked for an alert they get on
 * another tab, 2026-10-20). Turning them on asks the browser once, on this
 * click, and shows a first alert, so the player sees what one looks like,
 * or learns their system hides them. "blocked": only the browser's site
 * settings can change it, so the tile says where and offers no button.
 */
function DesktopAlertsTile({
  row,
  setEnabled,
}: {
  row: "off" | "on" | "blocked";
  setEnabled: (next: boolean) => void;
}) {
  const turnOn = async () => {
    const answer = await requestDesktopAlertPermission();
    if (answer === "granted") {
      if (showDesktopAlert(DESKTOP_ALERTS_ON_NOTICE)) {
        setEnabled(true);
      } else {
        pushToast("error", "This browser can't show desktop alerts.");
      }
    } else if (answer === "denied") {
      pushToast(
        "info",
        "Your browser blocked notifications from this site. Allow them in its site settings to get desktop alerts.",
      );
    }
    // "default": the viewer closed the browser's question; nothing changed.
  };

  return (
    <ToolTile
      icon="🖥️"
      title="Desktop alerts"
      badge={
        row === "on" ? (
          <Badge tone="success" className="py-0">On</Badge>
        ) : row === "blocked" ? (
          <Badge className="py-0">Blocked</Badge>
        ) : null
      }
      description={
        row === "on"
          ? "A pop-up when your match is found while you’re away from this tab."
          : row === "blocked"
            ? "Your browser blocks this site’s notifications. Allow them in its site settings."
            : "Get a pop-up when your match is found, even on another tab."
      }
      action={
        row === "blocked" ? null : (
          <button
            type="button"
            aria-label={row === "on" ? "Turn off desktop alerts" : "Turn on desktop alerts"}
            className={buttonClasses("secondary", "sm")}
            onClick={row === "on" ? () => setEnabled(false) : () => void turnOn()}
          >
            {row === "on" ? "Turn off" : "Turn on"}
          </button>
        )
      }
    />
  );
}
