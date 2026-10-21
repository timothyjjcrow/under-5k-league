"use client";

import { pushToast } from "@/components/toaster";
import { buttonClasses } from "@/components/ui";
import {
  requestDesktopAlertPermission,
  showDesktopAlert,
  useDesktopAlerts,
} from "@/components/desktop-alerts";
import {
  DESKTOP_ALERTS_ON_NOTICE,
  desktopAlertsRowState,
} from "@/lib/inhouse-desktop-alert";

/**
 * The switch for desktop alerts, under the queue card where a player waits
 * for their match (players asked for an alert they get on another tab,
 * 2026-10-20). Under the card, so the card keeps the first screen. Hidden
 * where the browser can't show a page's notification (a phone). Turning it
 * on asks the browser once, on this click, and shows a first alert, so the
 * player sees what one looks like, or learns their system hides them.
 */
export function DesktopAlertsRow() {
  const { permission, enabled, setEnabled } = useDesktopAlerts();
  const row = desktopAlertsRowState(permission, enabled);
  if (!row) return null;

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
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 px-1 text-center text-xs text-muted">
      {row === "blocked" ? (
        <span>
          Your browser blocks notifications from this site. Allow them in its
          site settings to get a desktop alert when your match is found.
        </span>
      ) : row === "on" ? (
        <>
          <span>
            Desktop alerts are on: you’ll get one when your match is found
            while you’re away from this tab.
          </span>
          <button
            type="button"
            className={buttonClasses("secondary", "sm")}
            onClick={() => setEnabled(false)}
          >
            Turn off desktop alerts
          </button>
        </>
      ) : (
        <>
          <span>Away from this tab? Get a desktop alert when your match is found.</span>
          <button
            type="button"
            className={buttonClasses("secondary", "sm")}
            onClick={() => void turnOn()}
          >
            <span aria-hidden>🖥️</span>
            Turn on desktop alerts
          </button>
        </>
      )}
    </div>
  );
}
