// ---- Desktop alerts: the browser's own notifications -----------------------
// The inhouse room's bell needs a click on the page after every load; a
// notification permission, once given, lasts for the site. Which alert, and
// when, is decided in `src/lib/inhouse-desktop-alert.ts`, where it is tested;
// this module only talks to the browser. Plain module like chime.ts: the
// permission is the browser's, so every component reads the same one.

import { useSyncExternalStore } from "react";
import { usePersistedFlag } from "@/components/room-clock";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  desktopAlertsActive,
  desktopAlertsSupported,
  type DesktopAlertPermission,
  type InhouseDesktopAlert,
} from "@/lib/inhouse-desktop-alert";

// A browser that turned out to refuse the constructor anyway: hide the row
// rather than offer what can't be shown.
let constructorRefused = false;
// The one notification showing, so a newer alert replaces it and coming
// back to the tab closes it.
let shown: Notification | null = null;
const LISTENERS = new Set<() => void>();

function changed() {
  for (const listener of LISTENERS) listener();
}

/** The browser's answer for this site, or "unsupported" (a phone). */
function desktopAlertPermission(): DesktopAlertPermission {
  if (typeof window === "undefined" || constructorRefused) return "unsupported";
  const supported = desktopAlertsSupported({
    hasNotificationApi: typeof window.Notification === "function",
    secureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });
  return supported ? Notification.permission : "unsupported";
}

/**
 * For useSyncExternalStore. A choice made in the browser's site settings
 * fires nothing on the page, so the permission is read again whenever the
 * viewer comes back to it.
 */
function subscribeDesktopAlertPermission(onChange: () => void): () => void {
  LISTENERS.add(onChange);
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    LISTENERS.delete(onChange);
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

/**
 * Ask the browser, on the viewer's click (browsers ignore a request made
 * without one). Asks only while it hasn't been answered: a "denied" is the
 * browser's to undo, in its site settings.
 */
export async function requestDesktopAlertPermission(): Promise<DesktopAlertPermission> {
  if (desktopAlertPermission() !== "default") return desktopAlertPermission();
  try {
    await Notification.requestPermission();
  } catch {
    // An old callback-only implementation: the read below says what it did.
  }
  changed();
  return desktopAlertPermission();
}

/**
 * Show one alert, replacing the last. Clicking it brings the viewer back to
 * the tab. Returns false when nothing was shown.
 */
export function showDesktopAlert(alert: InhouseDesktopAlert): boolean {
  if (desktopAlertPermission() !== "granted") return false;
  try {
    shown?.close();
    const notification = new Notification(alert.title, {
      body: alert.body,
      icon: LEAGUE_CONFIG.branding.appleIcon,
      tag: "inhouse",
      requireInteraction: alert.urgent,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    shown = notification;
    return true;
  } catch {
    constructorRefused = true;
    changed();
    return false;
  }
}

/**
 * Close the alert once the viewer is back on the tab: the room says it now,
 * and an urgent one would otherwise stay up after they acted. Returns the
 * cleanup for an effect.
 */
export function armDesktopAlertDismiss(): () => void {
  const onBack = () => {
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    shown?.close();
    shown = null;
  };
  window.addEventListener("focus", onBack);
  document.addEventListener("visibilitychange", onBack);
  return () => {
    window.removeEventListener("focus", onBack);
    document.removeEventListener("visibilitychange", onBack);
  };
}

/** Is the viewer on this tab right now (visible, and its window focused)? */
export function lookingAtTab(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * The browser's permission and the viewer's own switch (off until they turn
 * it on, kept in this browser). `active`: both say yes.
 */
export function useDesktopAlerts() {
  const permission = useSyncExternalStore(
    subscribeDesktopAlertPermission,
    desktopAlertPermission,
    () => "unsupported" as const,
  );
  const [enabled, setEnabled] = usePersistedFlag("inhouseDesktopAlerts", false);
  return {
    permission,
    enabled,
    setEnabled,
    active: desktopAlertsActive(permission, enabled),
  };
}
