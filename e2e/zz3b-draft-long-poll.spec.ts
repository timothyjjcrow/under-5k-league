import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import { DRAFT_ROOM } from "../src/lib/constants";
import { trackPageErrors } from "../e2e-mid/helpers";

// The draft room's long-poll in a real browser: each tick sends back the
// `roomVersion` of the last reply the room applied, the server holds it
// until the room changes, and the room re-issues straight away. So:
//
// - a bid reaches every open tab, signed in or out, within about a second;
// - a paused auction costs about one request per hold, per tab;
// - going offline releases the held tick, and coming back answers at once;
// - a server that answers with no version (an old slot during a release)
//   puts the room on its fallback ladder, never in a loop.
//
// Runs after zz-admin-draft and zz3 (a live auction between Cap One and Cap
// Two) and leaves the auction live.

const BASE = "http://localhost:3210";

type Tick = {
  start: number;
  since: string | null;
  holdMs: number | null;
  seasonId: string | null;
  /** When its reply arrived (null: still held, or it failed). */
  end: number | null;
  failed: boolean;
  currentBid: number | null;
  nominatedUserId: string | null;
};

/** Every tick a page makes, with its `since` and its reply. */
function watchTicks(page: Page): Tick[] {
  const log: Tick[] = [];
  const byRequest = new Map<object, Tick>();
  page.on("request", (req) => {
    if (req.method() !== "POST" || !req.url().endsWith("/api/draft/tick")) return;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
    } catch {
      return;
    }
    const entry: Tick = {
      start: Date.now(),
      since: typeof body.since === "string" ? body.since : null,
      holdMs: typeof body.holdMs === "number" ? body.holdMs : null,
      seasonId: typeof body.seasonId === "string" ? body.seasonId : null,
      end: null,
      failed: false,
      currentBid: null,
      nominatedUserId: null,
    };
    byRequest.set(req, entry);
    log.push(entry);
  });
  page.on("requestfailed", (req) => {
    const entry = byRequest.get(req);
    if (entry) entry.failed = true;
  });
  page.on("response", async (res) => {
    const entry = byRequest.get(res.request());
    if (!entry) return;
    entry.end = Date.now();
    try {
      const json = (await res.json()) as {
        currentBid?: number;
        nominatedUserId?: string | null;
      };
      entry.currentBid = json.currentBid ?? null;
      entry.nominatedUserId = json.nominatedUserId ?? null;
    } catch {
      // A 204 for a tick the page released, or a navigation.
    }
  });
  return log;
}

/** A page on /draft, signed in as `name` (or signed out), logging its ticks. */
async function roomTab(browser: Browser, as: { name: string; steamId: string } | null) {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  const errors = trackPageErrors(page);
  const log = watchTicks(page);
  await page.goto(
    as
      ? `/api/auth/dev?name=${encodeURIComponent(as.name)}&steamId=${as.steamId}&redirect=/draft`
      : "/draft",
  );
  await expect(page.getByRole("heading", { name: /Draft room/ })).toBeVisible({
    timeout: 20_000,
  });
  return { page, context, errors, log };
}
type Tab = Awaited<ReturnType<typeof roomTab>>;

/** How long a tick must have been in flight to count as held. */
const HELD_MS = 500;

/**
 * Until the tab has a tick held: sent with `since`, unanswered, for HELD_MS,
 * and started at or after `startedAfter`.
 */
async function untilHeld(tab: Tab, startedAfter = 0) {
  await expect
    .poll(
      () =>
        tab.log.some(
          (r) =>
            r.since !== null &&
            r.end === null &&
            !r.failed &&
            r.start >= startedAfter &&
            Date.now() - r.start >= HELD_MS,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Dev-login a captain and return an authed API context. */
async function apiCaptain(name: string, steamId: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const res = await ctx.get(
    `/api/auth/dev?name=${encodeURIComponent(name)}&steamId=${steamId}&redirect=/draft`,
  );
  expect(res.ok()).toBe(true);
  return ctx;
}

type DraftReply = {
  seasonId: string;
  status: string;
  draftVersion: number;
  currentLotId: string | null;
  nominatorTeamId: string | null;
  nominationEndsAt: number | null;
  nominatedUserId: string | null;
  currentBid: number;
  currentBidTeamId: string | null;
  bidEndsAt: number | null;
  available: { userId: string }[];
  me: { canBid: boolean; canNominate: boolean; myMaxBid: number };
};

async function post(ctx: APIRequestContext, path: string, data: Record<string, unknown>) {
  const res = await ctx.post(path, { data, headers: { Origin: BASE } });
  return { status: res.status(), json: (await res.json().catch(() => null)) as DraftReply | null };
}

/**
 * Move the auction once, as whichever captain can: a bid of $1 more on the
 * live lot, or the nominator's opening nomination. Returns when the action
 * answered, and the price it set.
 */
async function moveTheAuction(seasonId: string, captains: APIRequestContext[]) {
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const cap of captains) {
      const tick = await post(cap, "/api/draft/tick", { seasonId });
      const s = tick.json!;
      if (s.me.canBid && s.me.myMaxBid > s.currentBid) {
        const res = await post(cap, "/api/draft/bid", {
          seasonId,
          amount: s.currentBid + 1,
          draftVersion: s.draftVersion,
          nominatedUserId: s.nominatedUserId,
          currentLotId: s.currentLotId,
          currentBid: s.currentBid,
          currentBidTeamId: s.currentBidTeamId,
          bidEndsAt: s.bidEndsAt,
        });
        if (res.status === 200) return { at: Date.now(), price: s.currentBid + 1 };
      }
      if (s.me.canNominate && s.available.length > 0) {
        const res = await post(cap, "/api/draft/nominate", {
          seasonId,
          playerId: s.available[0].userId,
          amount: 1,
          draftVersion: s.draftVersion,
          nominatorTeamId: s.nominatorTeamId,
          nominationEndsAt: s.nominationEndsAt,
        });
        if (res.status === 200) return { at: Date.now(), price: 1 };
      }
    }
    await sleep(500);
  }
  throw new Error("Neither captain could bid or nominate");
}

/** The admin page's Pause or Resume, when it is on offer. */
async function setPaused(browser: Browser, paused: boolean) {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto("/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=/admin");
  const pause = page.getByRole("button", { name: "Pause auction" });
  const resume = page.getByRole("button", { name: "Resume auction" });
  await expect(pause.or(resume).first()).toBeVisible({ timeout: 20_000 });
  if (paused && (await pause.isVisible())) {
    await pause.click();
    await expect(resume).toBeVisible({ timeout: 20_000 });
  }
  if (!paused && (await resume.isVisible())) {
    await resume.click();
    await expect(pause).toBeVisible({ timeout: 20_000 });
  }
  await context.close();
}

test.beforeAll(async ({ browser }) => {
  await setPaused(browser, false);
});

test("a bid reaches every open tab, signed in or out, within about a second", async ({ browser }) => {
  test.setTimeout(90_000);
  const spectator = await roomTab(browser, null);
  const watcher = await roomTab(browser, { name: "LP Draft Watcher", steamId: "76561190000008001" });
  const captains = [
    await apiCaptain("Cap One", "76561190000003001"),
    await apiCaptain("Cap Two", "76561190000003002"),
  ];
  for (const tab of [spectator, watcher]) await untilHeld(tab);
  const seasonId = spectator.log.find((r) => r.seasonId)!.seasonId!;
  // A captain's first tick puts them back in the room, which publishes and
  // wakes every held tab. Do it before the holds this test measures: a wake
  // just ahead of the bid sends a watcher into its 3s gap
  // (LONG_POLL_WATCH_GAP_MS), and the bid then waits for its next tick.
  for (const cap of captains) await post(cap, "/api/draft/tick", { seasonId });
  const inTheRoom = Date.now();
  for (const tab of [spectator, watcher]) await untilHeld(tab, inTheRoom);

  const moved = await moveTheAuction(seasonId, captains);
  for (const tab of [spectator, watcher]) {
    const seen = () =>
      tab.log.find((r) => r.end !== null && r.end >= moved.at && r.currentBid === moved.price);
    await expect.poll(seen, { timeout: 5_000, intervals: [50] }).toBeTruthy();
    const reply = seen()!;
    // The held tick answered: sent before the move, with `since`.
    expect(reply.since).not.toBeNull();
    expect(reply.start).toBeLessThan(moved.at);
    // Coalesce (100 ms), jitter (up to 250 ms), the tick, the dev server.
    expect(reply.end! - moved.at).toBeLessThan(1_500);
    expect(reply.holdMs).toBe(DRAFT_ROOM.LONG_POLL_HOLD_MS);
  }
  spectator.errors();
  watcher.errors();
  for (const cap of captains) await cap.dispose();
  for (const tab of [spectator, watcher]) await tab.context.close();
});

test("a paused auction costs about one request per hold, per tab", async ({ browser }) => {
  test.setTimeout(120_000);
  await setPaused(browser, true);
  try {
    const spectator = await roomTab(browser, null);
    const watcher = await roomTab(browser, { name: "LP Draft Idle", steamId: "76561190000008002" });
    for (const tab of [spectator, watcher]) await untilHeld(tab);

    const WINDOW_MS = 30_000;
    const from = Date.now();
    await sleep(WINDOW_MS);
    const counts = [spectator, watcher].map(
      (tab) => tab.log.filter((r) => r.start >= from && r.start < from + WINDOW_MS).length,
    );
    // Nothing changed: each tab's held tick ends at the hold (25s), and the
    // next is held again. The fallback ladder (and the room before
    // 2026-10-23) sent 6 in this window (POLL_WATCH_MS, 5s).
    for (const n of counts) expect(n).toBeLessThanOrEqual(2);
    console.log(
      `[draft long-poll e2e] paused ${WINDOW_MS / 1000}s: spectator ${counts[0]} tick(s), watcher ${counts[1]} tick(s)`,
    );
    spectator.errors();
    watcher.errors();
    for (const tab of [spectator, watcher]) await tab.context.close();
  } finally {
    await setPaused(browser, false);
  }
});

test("going offline releases the held tick; coming back answers at once", async ({ browser }) => {
  test.setTimeout(60_000);
  const tab = await roomTab(browser, { name: "LP Draft Offline", steamId: "76561190000008003" });
  await untilHeld(tab);

  await tab.context.setOffline(true);
  await expect(tab.page.getByText(/You're offline — the auction keeps running/)).toBeVisible();
  await sleep(500);
  const back = Date.now();
  await tab.context.setOffline(false);
  // Not after the held tick's 25s: the resync is a fresh tick, answered at
  // once.
  await expect(tab.page.getByText(/You're offline|Connection restored/)).toHaveCount(0, {
    timeout: 5_000,
  });
  const resync = tab.log.find((r) => r.start >= back && r.end !== null)!;
  expect(resync.since).toBeNull();
  tab.errors();
  await tab.context.close();
});

test("a server that answers with no version puts the room on its ladder, never in a loop", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  const errors = trackPageErrors(page);
  // An old slot during a release: it ignores `since` and names no version.
  await page.route("**/api/draft/tick", async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    delete json.roomVersion;
    await route.fulfill({ response, json });
  });
  const log = watchTicks(page);
  await page.goto("/api/auth/dev?name=LP+Draft+Old+Slot&steamId=76561190000008004&redirect=/draft");
  await expect(page.getByRole("heading", { name: /Draft room/ })).toBeVisible({ timeout: 20_000 });

  const WINDOW_MS = 12_000;
  await sleep(2_000);
  const from = Date.now();
  await sleep(WINDOW_MS);
  const inWindow = log.filter((r) => r.start >= from && r.start < from + WINDOW_MS);
  // A watcher's ladder rate in a live auction (POLL_WATCH_MS, 5s): two or
  // three, never a loop.
  expect(inWindow.length).toBeGreaterThanOrEqual(2);
  expect(inWindow.length).toBeLessThanOrEqual(Math.ceil(WINDOW_MS / DRAFT_ROOM.POLL_WATCH_MS) + 1);
  expect(log.every((r) => r.since === null)).toBe(true);
  errors();
  await context.close();
});
