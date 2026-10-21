import { INHOUSE_STATUS } from "./constants";
import type { InhouseAlert } from "./inhouse";

/**
 * Desktop alerts: the browser's own notification for the moments that ring
 * the inhouse room's bell, shown while the viewer is away from the tab.
 *
 * The bell can't reach everyone. Browsers hold a page's audio until a click
 * on that page, after every load, and the player who most needs the bell is
 * the one who touches nothing: a Discord ping's one-tap join (`?join=1`), a
 * reload, a restored tab, then straight back to Dota (players asked in
 * Discord, 2026-10-20). A notification permission, once given, lasts for
 * the site, so these need no click after a load. They are opt-in: the
 * browser asks once, on the viewer's own click (`DesktopAlertsRow`).
 *
 * The room shows them from the poll it already runs, so they cost the box
 * nothing. A tab the browser has put to sleep (a phone's, or one Chrome
 * unloaded to save memory) gets neither; the Discord match-found ping
 * covers that.
 */

/** "unsupported": this browser shows no page notification (see below). */
export type DesktopAlertPermission =
  | "unsupported"
  | "default"
  | "granted"
  | "denied";

/**
 * Can this browser show a page's own notification (`new Notification`)?
 * Desktop Chrome, Edge, Firefox and Safari can, on https or localhost.
 * Phones can't: Android's Chrome has the API but throws on the constructor
 * (it shows only a service worker's), and iPhone and iPad Safari show
 * notifications only for a web app added to the Home Screen, through a
 * service worker. iPadOS asks for desktop sites as a Mac, so a Mac with a
 * touch screen is an iPad.
 */
export function desktopAlertsSupported(env: {
  hasNotificationApi: boolean;
  secureContext: boolean;
  userAgent: string;
  maxTouchPoints: number;
}): boolean {
  if (!env.hasNotificationApi || !env.secureContext) return false;
  if (/Android|iPhone|iPad|iPod/i.test(env.userAgent)) return false;
  if (/Macintosh/i.test(env.userAgent) && env.maxTouchPoints > 1) return false;
  return true;
}

export type InhouseDesktopAlert = {
  title: string;
  body: string;
  /** A clock is running: the notification stays up until the player acts. */
  urgent: boolean;
};

const MY_TURN: InhouseDesktopAlert = {
  title: "Your pick",
  body: "You're on the clock: pick a player for your team.",
  urgent: true,
};
const MATCH_FOUND: InhouseDesktopAlert = {
  title: "Match found — accept now",
  body: "Accept before the timer ends to keep your spot.",
  urgent: true,
};
const VOTE_OPEN: InhouseDesktopAlert = {
  title: "Captain vote is open",
  body: "Everyone accepted. Vote before the timer ends.",
  urgent: true,
};
const DRAFTING: InhouseDesktopAlert = {
  title: "Your inhouse game is drafting",
  body: "The captains are picking teams.",
  urgent: false,
};
const TEAMS_LOCKED: InhouseDesktopAlert = {
  title: "Teams locked",
  body: "Get into the Dota lobby.",
  urgent: false,
};
const RESULT_IN: InhouseDesktopAlert = {
  title: "Your inhouse result is in",
  body: "Open the room for the score and your Elo.",
  urgent: false,
};

/** The notification that confirms desktop alerts are on. */
export const DESKTOP_ALERTS_ON_NOTICE: InhouseDesktopAlert = {
  title: "Desktop alerts are on",
  body: "You'll get one like this when your match is found while you're away from this tab.",
  urgent: false,
};

/**
 * The ONE notification for a poll's alerts (`inhouseAlerts`), or null: like
 * the bell, coinciding moments make one alert, the one the player must act
 * on first. `status` is the viewer's lobby status now, because a hidden tab
 * can first see its new game already past the ready check (that is why
 * `lobby-formed` keys on the lobby appearing), and "accept now" would then
 * send them to a button that is gone.
 */
export function inhouseDesktopAlert(
  alerts: readonly InhouseAlert[],
  status: string | null,
): InhouseDesktopAlert | null {
  if (alerts.includes("my-turn")) return MY_TURN;
  if (alerts.includes("lobby-formed")) {
    if (status === INHOUSE_STATUS.READY_CHECK) return MATCH_FOUND;
    if (status === INHOUSE_STATUS.CAPTAIN_VOTE) return VOTE_OPEN;
    if (status === INHOUSE_STATUS.DRAFTING) return DRAFTING;
    return TEAMS_LOCKED;
  }
  if (alerts.includes("vote-opened")) return VOTE_OPEN;
  if (alerts.includes("teams-ready")) return TEAMS_LOCKED;
  if (alerts.includes("game-ended")) return RESULT_IN;
  return null;
}

/**
 * What the room shows for a poll: nothing unless the viewer turned desktop
 * alerts on, the browser allows them, and the viewer is away from this tab
 * (another tab, another app, a minimised window). On the tab, the room and
 * its bell say it already.
 */
export function desktopAlertToShow(o: {
  enabled: boolean;
  permission: DesktopAlertPermission;
  lookingAtTab: boolean;
  alerts: readonly InhouseAlert[];
  status: string | null;
}): InhouseDesktopAlert | null {
  if (!desktopAlertsActive(o.permission, o.enabled) || o.lookingAtTab) {
    return null;
  }
  return inhouseDesktopAlert(o.alerts, o.status);
}

/** Turned on, and the browser allows them. */
export function desktopAlertsActive(
  permission: DesktopAlertPermission,
  enabled: boolean,
): boolean {
  return enabled && permission === "granted";
}

/**
 * The row under the queue card, or null where the browser can't show them
 * (a phone). "blocked": the browser refuses this site's notifications, which
 * only its site settings can change, so the row says where and offers no
 * button.
 */
export function desktopAlertsRowState(
  permission: DesktopAlertPermission,
  enabled: boolean,
): "off" | "on" | "blocked" | null {
  if (permission === "unsupported") return null;
  if (permission === "denied") return "blocked";
  return desktopAlertsActive(permission, enabled) ? "on" : "off";
}

/**
 * The toast after a `?join=1` one-tap join. That player has touched nothing
 * on the page, so the bell is held (`soundLocked`) unless a desktop alert
 * will reach them anyway: say what will, or how to let the bell ring.
 */
export function autoJoinedToast(o: {
  soundLocked: boolean;
  desktopAlertsOn: boolean;
}): string {
  if (o.desktopAlertsOn) {
    return "You're in the queue. You'll get a desktop alert when your match is found.";
  }
  if (o.soundLocked) {
    return "You're in the queue. Click or tap anywhere on this page once so it can ring when your match is found.";
  }
  return "You're in the queue";
}
