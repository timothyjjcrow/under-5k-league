import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

// Desktop alerts and the held bell (2026-10-20). Players on another tab
// missed "match found": the browser holds a page's audio until a click on
// it, and a one-tap joiner touches nothing. Here a player sees the toggle
// say so, turns desktop alerts on from the row under the queue card, tabs
// away, and their match forming shows a notification that stays up while
// the accept clock runs and closes when they come back. Back on the tab, the
// next moment shows none. Forms a game, so it runs with the zz4 specs, and
// empties the room after itself for the history spec behind it.
//
// The browser's notifications, "another tab in front" and the autoplay rule
// are faked in the page. Playwright can neither show a real notification nor
// hide a tab, and its headless Chromium lets any page play sound and reports
// it already clicked, so a real browser's held bell never shows there. The
// room only ever reads Notification, visibilityState, hasFocus,
// navigator.userActivation and AudioContext's state.

const BASE = "http://localhost:3210";
type Json = Record<string, unknown>;
type Shown = {
  title: string;
  body?: string;
  requireInteraction?: boolean;
  closed: boolean;
};

async function apiPlayer(
  name: string,
  steamId: string,
  admin = false,
): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const res = await ctx.get(
    `/api/auth/dev?name=${encodeURIComponent(name)}&steamId=${steamId}${admin ? "&admin=1" : ""}&redirect=/inhouse`,
  );
  expect(res.ok()).toBe(true);
  return ctx;
}

async function act(
  ctx: APIRequestContext,
  body: Json,
): Promise<{ ok: boolean; json: Json }> {
  const res = await ctx.post("/api/inhouse", {
    data: body,
    headers: { Origin: BASE },
  });
  return { ok: res.ok(), json: await res.json() };
}

/** Uncaught client errors crash silently in raw-HTML checks — track them. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** A browser that asks once and says yes, and a tab that can be "away". */
function fakeNotificationsAndAway() {
  const w = window as unknown as {
    __shown: Shown[];
    __away: boolean;
    __permission: NotificationPermission;
  };
  w.__shown = [];
  w.__away = false;
  w.__permission = "default";
  class FakeNotification {
    static get permission() {
      return w.__permission;
    }
    static requestPermission() {
      w.__permission = "granted";
      return Promise.resolve(w.__permission);
    }
    onclick: (() => void) | null = null;
    entry: Shown;
    constructor(title: string, options: NotificationOptions = {}) {
      this.entry = {
        title,
        body: options.body,
        requireInteraction: options.requireInteraction,
        closed: false,
      };
      w.__shown.push(this.entry);
    }
    close() {
      this.entry.closed = true;
    }
  }
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: FakeNotification,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (w.__away ? "hidden" : "visible"),
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => w.__away,
  });
  document.hasFocus = () => !w.__away;

  // A real browser's autoplay rule: no click on the page yet, no sound. A
  // context made before the first real click stays suspended until one.
  let activated = false;
  for (const type of ["pointerup", "touchend", "click", "keydown"]) {
    window.addEventListener(
      type,
      (event) => {
        if (event.isTrusted) activated = true;
      },
      true,
    );
  }
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: {
      get hasBeenActive() {
        return activated;
      },
      get isActive() {
        return activated;
      },
    },
  });
  const RealAudioContext = window.AudioContext;
  class HeldAudioContext extends RealAudioContext {
    constructor(options?: AudioContextOptions) {
      super(options);
      if (!activated) void this.suspend();
    }
    resume() {
      return activated ? super.resume() : Promise.resolve();
    }
  }
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: HeldAudioContext,
  });
}

const shown = (page: Page) =>
  page.evaluate(() => (window as unknown as { __shown: Shown[] }).__shown);

/** Another tab in front (away), or back on this one. */
async function setAway(page: Page, away: boolean) {
  await page.evaluate((value) => {
    (window as unknown as { __away: boolean }).__away = value;
    document.dispatchEvent(new Event("visibilitychange"));
    if (!value) window.dispatchEvent(new Event("focus"));
  }, away);
}

// The history spec after this one needs an empty room: no live game and
// nobody queued. Runs even when a check fails.
let emptyTheRoom: (() => Promise<void>) | null = null;
test.afterEach(async () => {
  await emptyTheRoom?.();
  emptyTheRoom = null;
});

test("a player away from the tab gets a desktop alert when their match is found", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  const errors = trackPageErrors(page);
  await page.addInitScript(fakeNotificationsAndAway);
  const others: APIRequestContext[] = [];
  for (let i = 0; i < 9; i++) {
    others.push(await apiPlayer(`DA Player ${i}`, `7656119000000810${i}`));
  }
  const admin = await apiPlayer("DA Admin", "76561190000008099", true);
  let liveGame: string | null = null;
  emptyTheRoom = async () => {
    // A refusal (the game already gone, a player not queued) is fine here.
    if (liveGame) {
      await act(admin, { action: "cancel", lobbyId: liveGame }).catch(() => null);
    }
    for (const ctx of [...others, page.request]) {
      await act(ctx, { action: "leave" }).catch(() => null);
    }
    for (const ctx of [...others, admin]) await ctx.dispose();
    await context.close();
  };

  await page.goto(
    "/api/auth/dev?name=DA+Away+Player&steamId=76561190000008000&redirect=/inhouse",
  );
  await expect(
    page.getByRole("heading", { name: "Inhouse queue", exact: true }),
  ).toBeVisible();

  // Nothing clicked yet: the browser holds the bell, and the toggle says so
  // instead of "Sound on".
  await expect(
    page.getByRole("button", { name: "Turn on sound", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");

  // Desktop alerts are off until the player turns them on; the browser asks
  // on that click, and a first alert shows what one looks like.
  await page.getByRole("button", { name: "Turn on desktop alerts" }).click();
  await expect(
    page.getByRole("button", { name: "Turn off desktop alerts" }),
  ).toBeVisible();
  await expect
    .poll(async () => (await shown(page)).map((n) => n.title))
    .toEqual(["Desktop alerts are on"]);
  // That click was a gesture on the page, so the bell can ring now too.
  await expect(
    page.getByRole("button", { name: "Sound on", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("MMR").fill("3000");
  await page.getByRole("button", { name: /Join queue/ }).click();
  await expect(page.getByRole("button", { name: /Leave queue/ })).toBeVisible();

  // Another tab in front. Nine more players fill the queue: the match forms
  // while the player is away.
  await setAway(page, true);
  for (const [i, ctx] of others.entries()) {
    expect((await act(ctx, { action: "join", mmr: 2900 - i * 50 })).ok).toBe(true);
  }
  const formed = await act(page.request, { action: "state" });
  const lobby = formed.json.lobby as { id: string; status: string } | null;
  expect(lobby?.status).toBe("READY_CHECK");
  liveGame = lobby!.id;

  // The hidden tab's poll brings it, and the alert stays up while the accept
  // clock runs.
  await expect
    .poll(async () => (await shown(page)).slice(1), { timeout: 20_000 })
    .toEqual([
      {
        title: "Match found — accept now",
        body: "Accept before the timer ends to keep your spot.",
        requireInteraction: true,
        closed: false,
      },
    ]);

  // Back on the tab: the alert closes, its job done.
  await setAway(page, false);
  await expect
    .poll(async () => (await shown(page))[1]?.closed)
    .toBe(true);

  // On the tab, the next moment (everyone accepts, the vote opens) rings the
  // bell but shows no alert: the room says it already.
  await page.getByRole("button", { name: "ACCEPT MATCH" }).click();
  for (const ctx of others) {
    expect((await act(ctx, { action: "accept", lobbyId: liveGame })).ok).toBe(true);
  }
  await expect(page.getByText("Captain vote").first()).toBeVisible({
    timeout: 20_000,
  });
  expect((await shown(page)).length).toBe(2);

  expect(errors).toEqual([]);
  // afterEach empties the room for the specs after this one.
});
