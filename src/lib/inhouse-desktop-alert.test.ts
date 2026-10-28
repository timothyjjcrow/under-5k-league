import { describe, expect, it } from "vitest";
import {
  autoJoinedToast,
  desktopAlertToShow,
  desktopAlertsActive,
  desktopAlertsRowState,
  desktopAlertsSupported,
  inhouseDesktopAlert,
  type DesktopAlertPermission,
} from "./inhouse-desktop-alert";
import { inhouseAlerts, type InhouseAlertSnapshot } from "./inhouse";

const UA = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  firefoxLinux:
    "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
};

describe("desktopAlertsSupported", () => {
  const desktop = {
    hasNotificationApi: true,
    secureContext: true,
    userAgent: UA.chromeWindows,
    maxTouchPoints: 0,
  };

  it("is on for desktop browsers with the API on https or localhost", () => {
    for (const userAgent of [UA.chromeWindows, UA.safariMac, UA.firefoxLinux]) {
      expect(desktopAlertsSupported({ ...desktop, userAgent })).toBe(true);
    }
    // A touch-screen Windows laptop is still a desktop.
    expect(desktopAlertsSupported({ ...desktop, maxTouchPoints: 10 })).toBe(true);
  });

  it("is off without the API or outside a secure context", () => {
    expect(desktopAlertsSupported({ ...desktop, hasNotificationApi: false })).toBe(false);
    expect(desktopAlertsSupported({ ...desktop, secureContext: false })).toBe(false);
  });

  it("is off on phones and tablets, where only a service worker can notify", () => {
    // Android's Chrome HAS the API and throws on the constructor: the row
    // would ask for a permission that can never show anything.
    expect(desktopAlertsSupported({ ...desktop, userAgent: UA.chromeAndroid })).toBe(false);
    expect(desktopAlertsSupported({ ...desktop, userAgent: UA.safariIphone })).toBe(false);
    // An iPad asking for the desktop site says it is a Mac.
    expect(
      desktopAlertsSupported({ ...desktop, userAgent: UA.safariMac, maxTouchPoints: 5 }),
    ).toBe(false);
  });
});

describe("inhouseDesktopAlert", () => {
  it("says nothing when the poll earned no alert", () => {
    expect(inhouseDesktopAlert([], "READY_CHECK")).toBeNull();
  });

  it("asks a paired 1v1 player to accept, after any 5v5 moment they must act on first", () => {
    expect(inhouseDesktopAlert(["duel-found"], null)).toMatchObject({
      title: "1v1 found — accept now",
      urgent: true,
    });
    expect(inhouseDesktopAlert(["lobby-formed", "duel-found"], "READY_CHECK")).toMatchObject({
      title: "Match found — accept now",
    });
    expect(inhouseDesktopAlert(["my-turn", "duel-found"], "DRAFTING")).toMatchObject({
      title: "Your pick",
    });
  });

  it("names the stage the player's new game is in now, not the one it started in", () => {
    // A hidden tab can first see its game already in the vote or the draft
    // (lobby-formed keys on the lobby appearing): "accept now" would send
    // the player to a button that is gone.
    expect(inhouseDesktopAlert(["lobby-formed"], "READY_CHECK")).toMatchObject({
      title: "Match found — accept now",
      urgent: true,
    });
    expect(inhouseDesktopAlert(["lobby-formed"], "CAPTAIN_VOTE")).toMatchObject({
      title: "Captain vote is open",
      urgent: true,
    });
    expect(inhouseDesktopAlert(["lobby-formed"], "DRAFTING")).toMatchObject({
      title: "Your inhouse game is drafting",
      urgent: false,
    });
    expect(inhouseDesktopAlert(["lobby-formed"], "READY")).toMatchObject({
      title: "Teams locked",
      body: "Get into the Dota lobby.",
    });
  });

  it("makes ONE alert of coinciding moments, the one to act on first", () => {
    expect(
      inhouseDesktopAlert(["lobby-formed", "my-turn"], "DRAFTING"),
    ).toMatchObject({ title: "Your pick", urgent: true });
    expect(
      inhouseDesktopAlert(["vote-opened", "teams-ready"], "READY"),
    ).toMatchObject({ title: "Captain vote is open" });
    expect(inhouseDesktopAlert(["teams-ready", "game-ended"], null)).toMatchObject({
      title: "Teams locked",
    });
  });

  it("keeps only clocked stages up until the player acts", () => {
    expect(inhouseDesktopAlert(["vote-opened"], "CAPTAIN_VOTE")?.urgent).toBe(true);
    expect(inhouseDesktopAlert(["my-turn"], "DRAFTING")?.urgent).toBe(true);
    expect(inhouseDesktopAlert(["teams-ready"], "READY")?.urgent).toBe(false);
    expect(inhouseDesktopAlert(["game-ended"], null)).toMatchObject({
      title: "Your inhouse result is in",
      urgent: false,
    });
  });

  it("covers every alert the bell rings for", () => {
    // A new InhouseAlert with no notification would ring the bell and leave
    // a player on another tab with nothing.
    const kinds = ["lobby-formed", "vote-opened", "my-turn", "teams-ready", "game-ended"] as const;
    for (const kind of kinds) {
      expect(inhouseDesktopAlert([kind], "READY_CHECK"), kind).not.toBeNull();
    }
  });

  it("follows inhouseAlerts: a queued player's match turning up is 'match found'", () => {
    const queued: InhouseAlertSnapshot = {
      status: null,
      inLobby: false,
      isOnClock: false,
      resultId: null,
      inQueue: true,
    };
    const matched: InhouseAlertSnapshot = {
      ...queued,
      status: "READY_CHECK",
      inLobby: true,
      inQueue: false,
      lobbyId: "lobby-1",
    };
    expect(
      inhouseDesktopAlert(inhouseAlerts(queued, matched), matched.status),
    ).toMatchObject({ title: "Match found — accept now" });
  });
});

describe("desktopAlertToShow", () => {
  const away = {
    enabled: true,
    permission: "granted" as DesktopAlertPermission,
    lookingAtTab: false,
    alerts: ["lobby-formed"] as const,
    status: "READY_CHECK",
  };

  it("notifies a player who turned them on and is away from the tab", () => {
    expect(desktopAlertToShow(away)).toMatchObject({ title: "Match found — accept now" });
  });

  it("stays quiet on the tab, where the room and its bell say it", () => {
    expect(desktopAlertToShow({ ...away, lookingAtTab: true })).toBeNull();
  });

  it("stays quiet unless the player turned them on AND the browser allows them", () => {
    expect(desktopAlertToShow({ ...away, enabled: false })).toBeNull();
    for (const permission of ["default", "denied", "unsupported"] as const) {
      expect(desktopAlertToShow({ ...away, permission }), permission).toBeNull();
    }
  });

  it("stays quiet when the poll earned no alert", () => {
    expect(desktopAlertToShow({ ...away, alerts: [] })).toBeNull();
  });
});

describe("desktopAlertsRowState", () => {
  it("hides the row where the browser can't notify", () => {
    expect(desktopAlertsRowState("unsupported", true)).toBeNull();
  });

  it("is on only when turned on and allowed", () => {
    expect(desktopAlertsRowState("granted", true)).toBe("on");
    expect(desktopAlertsActive("granted", true)).toBe(true);
    // Allowed for the site but turned off here, or turned on before the
    // browser was asked: off, with the button.
    expect(desktopAlertsRowState("granted", false)).toBe("off");
    expect(desktopAlertsRowState("default", true)).toBe("off");
    expect(desktopAlertsActive("default", true)).toBe(false);
  });

  it("says blocked when the browser refuses, whatever was turned on", () => {
    expect(desktopAlertsRowState("denied", true)).toBe("blocked");
    expect(desktopAlertsRowState("denied", false)).toBe("blocked");
    expect(desktopAlertsActive("denied", true)).toBe(false);
  });
});

describe("autoJoinedToast", () => {
  it("tells a one-tap joiner how to let the bell ring while it is held", () => {
    expect(autoJoinedToast({ soundLocked: true, desktopAlertsOn: false })).toBe(
      "You're in the queue. Click or tap anywhere on this page once so it can ring when your match is found.",
    );
  });

  it("names the desktop alert when one will reach them anyway", () => {
    for (const soundLocked of [true, false]) {
      expect(autoJoinedToast({ soundLocked, desktopAlertsOn: true })).toBe(
        "You're in the queue. You'll get a desktop alert when your match is found.",
      );
    }
  });

  it("stays short when the bell can already ring", () => {
    expect(autoJoinedToast({ soundLocked: false, desktopAlertsOn: false })).toBe(
      "You're in the queue",
    );
  });
});
