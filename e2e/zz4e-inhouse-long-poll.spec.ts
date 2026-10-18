import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import { INHOUSE } from "../src/lib/constants";
import { trackPageErrors } from "../e2e-mid/helpers";

// The inhouse room's long-poll in a real browser: each state request sends
// back the `roomVersion` of the last reply the room applied, the server holds
// it until the room changes, and the room re-issues straight away. So:
//
// - a change reaches every open tab, signed in or out, within about a second;
// - an idle room costs about one request per hold, per tab;
// - going offline releases the held request, and coming back answers at once;
// - an action releases it too, and its outcome shows through a fresh request;
// - a server that answers with no version (an old slot during a release)
//   puts the room on its fallback ladder, never in a loop.
//
// Runs after zz4d (which leaves no live game and an empty queue) and leaves
// the queue as it found it.

const BASE = "http://localhost:3210";

type StateRequest = {
  start: number;
  since: string | null;
  holdMs: number | null;
  /** When its reply arrived (null: still held, or it failed). */
  end: number | null;
  failed: boolean;
  queue: { userId: string; name: string }[] | null;
};

/** Dev-login a fresh user and return an authed API context. */
async function apiPlayer(name: string, steamId: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const res = await ctx.get(
    `/api/auth/dev?name=${encodeURIComponent(name)}&steamId=${steamId}&redirect=/inhouse`,
  );
  expect(res.ok()).toBe(true);
  return ctx;
}

async function act(ctx: APIRequestContext, body: Record<string, unknown>) {
  const res = await ctx.post("/api/inhouse", { data: body, headers: { Origin: BASE } });
  expect(res.ok(), JSON.stringify(body)).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

/** Every state request a page makes, with its `since` and its reply. */
function watchStateRequests(page: Page): StateRequest[] {
  const log: StateRequest[] = [];
  const byRequest = new Map<object, StateRequest>();
  page.on("request", (req) => {
    if (req.method() !== "POST" || !req.url().endsWith("/api/inhouse")) return;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
    } catch {
      return;
    }
    if (body.action !== "state") return;
    const entry: StateRequest = {
      start: Date.now(),
      since: typeof body.since === "string" ? body.since : null,
      holdMs: typeof body.holdMs === "number" ? body.holdMs : null,
      end: null,
      failed: false,
      queue: null,
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
      const json = (await res.json()) as { queue?: StateRequest["queue"] };
      entry.queue = json.queue ?? null;
    } catch {
      // A 204 for a request the page released, or a navigation.
    }
  });
  return log;
}

/** A page on /inhouse, signed in as `name` (or signed out), logging its polls. */
async function roomTab(browser: Browser, as: { name: string; steamId: string } | null) {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  const errors = trackPageErrors(page);
  const log = watchStateRequests(page);
  await page.goto(
    as
      ? `/api/auth/dev?name=${encodeURIComponent(as.name)}&steamId=${as.steamId}&redirect=/inhouse`
      : "/inhouse",
  );
  await expect(page.getByRole("progressbar").first()).toBeVisible({ timeout: 20_000 });
  return { page, context, errors, log };
}
type Tab = Awaited<ReturnType<typeof roomTab>>;

/** Until the tab has a long-poll in flight (sent with `since`, no reply yet). */
async function untilHeld(tab: Tab) {
  await expect
    .poll(() => tab.log.some((r) => r.since !== null && r.end === null && !r.failed), {
      timeout: 15_000,
    })
    .toBe(true);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a change reaches every open tab, signed in or out, within about a second", async ({ browser }) => {
  test.setTimeout(90_000);
  const spectator = await roomTab(browser, null);
  const watcher = await roomTab(browser, { name: "LP Watcher", steamId: "76561190000007001" });
  const joiner = await apiPlayer("LP Joiner", "76561190000007002");
  for (const tab of [spectator, watcher]) await untilHeld(tab);

  const joined = await act(joiner, { action: "join", mmr: 3100 });
  const joinedAt = Date.now();
  const joinerId = String((joined.me as { userId: string }).userId);
  for (const tab of [spectator, watcher]) {
    await expect
      .poll(
        () => tab.log.find((r) => r.end !== null && r.end >= joinedAt && r.queue?.some((q) => q.userId === joinerId)),
        { timeout: 5_000, intervals: [50] },
      )
      .toBeTruthy();
    const seen = tab.log.find((r) => r.end !== null && r.end >= joinedAt && r.queue?.some((q) => q.userId === joinerId))!;
    // The held request answered: it was sent before the join, with `since`.
    expect(seen.since).not.toBeNull();
    expect(seen.start).toBeLessThan(joinedAt);
    // Coalesce (100 ms), jitter (up to 150 ms), the poll, the dev server.
    expect(seen.end! - joinedAt).toBeLessThan(1_500);
    await expect(tab.page.getByText("LP Joiner").first()).toBeVisible();
  }

  await act(joiner, { action: "leave" });
  spectator.errors();
  watcher.errors();
  await joiner.dispose();
  for (const tab of [spectator, watcher]) await tab.context.close();
});

test("an idle room costs about one request per hold, per tab", async ({ browser }) => {
  test.setTimeout(120_000);
  const spectator = await roomTab(browser, null);
  const queued = await roomTab(browser, { name: "LP Queued", steamId: "76561190000007003" });
  await queued.page.getByLabel("MMR").fill("3200");
  await queued.page.getByRole("button", { name: /Join queue/ }).click();
  await expect(queued.page.getByRole("button", { name: /Leave queue/ })).toBeVisible();
  for (const tab of [spectator, queued]) await untilHeld(tab);

  const WINDOW_MS = 30_000;
  const from = Date.now();
  await sleep(WINDOW_MS);
  const counts = [spectator, queued].map(
    (tab) => tab.log.filter((r) => r.start >= from && r.start < from + WINDOW_MS).length,
  );
  // Nothing changed: each tab's held request ends at the hold (25s), and
  // the next is held again. The fallback ladder would have sent 3 (spectator,
  // 10s) and 10 (queued, 3s); before 2026-10-18, 1 (30s) and 3 (10s).
  for (const n of counts) expect(n).toBeLessThanOrEqual(2);
  console.log(
    `[long-poll e2e] idle ${WINDOW_MS / 1000}s: spectator ${counts[0]} request(s), queued ${counts[1]} request(s)`,
  );
  for (const r of [spectator, queued].flatMap((tab) => tab.log)) {
    if (r.since !== null) expect(r.holdMs).toBe(INHOUSE.LONG_POLL_HOLD_MS);
  }

  await queued.page.getByRole("button", { name: /Leave queue/ }).click();
  await expect(queued.page.getByRole("button", { name: /Join queue/ })).toBeVisible();
  spectator.errors();
  queued.errors();
  for (const tab of [spectator, queued]) await tab.context.close();
});

test("going offline releases the held request; coming back answers at once", async ({ browser }) => {
  test.setTimeout(60_000);
  const tab = await roomTab(browser, { name: "LP Offline", steamId: "76561190000007004" });
  const join = tab.page.getByRole("button", { name: /Join queue/ });
  await expect(join).toBeEnabled();
  await untilHeld(tab);

  await tab.context.setOffline(true);
  await expect(tab.page.getByText(/You're offline — the queue and lobby keep running/)).toBeVisible();
  await expect(join).toBeDisabled();
  await sleep(500);
  const back = Date.now();
  await tab.context.setOffline(false);
  // Not after the held request's 25s: the resync is a fresh request,
  // answered at once.
  await expect(tab.page.getByText(/You're offline|Connection restored/)).toHaveCount(0, {
    timeout: 5_000,
  });
  await expect(join).toBeEnabled();
  const resync = tab.log.find((r) => r.start >= back && r.end !== null)!;
  expect(resync.since).toBeNull();
  tab.errors();
  await tab.context.close();
});

test("an action releases the held request and shows its outcome at once", async ({ browser }) => {
  test.setTimeout(60_000);
  const tab = await roomTab(browser, { name: "LP Actor", steamId: "76561190000007005" });
  await untilHeld(tab);
  const held = tab.log.find((r) => r.since !== null && r.end === null && !r.failed)!;

  await tab.page.getByLabel("MMR").fill("3300");
  const clickedAt = Date.now();
  await tab.page.getByRole("button", { name: /Join queue/ }).click();
  await expect(tab.page.getByRole("button", { name: /Leave queue/ })).toBeVisible({ timeout: 3_000 });
  // The held request ended at once, either way round. The action's reply
  // landed first: bumpPollRef released it. Or the hold woke on the join's
  // own publish and its reply landed first, showing the join: the room
  // applied it, which is just as current. Only the order of the two
  // responses decides which, so the spec accepts both.
  await expect
    .poll(
      () =>
        held.failed ||
        (held.end !== null &&
          held.end >= clickedAt &&
          !!held.queue?.some((q) => q.name === "LP Actor")),
      { timeout: 3_000 },
    )
    .toBe(true);
  // And a fresh request answered for the action.
  await expect
    .poll(() => tab.log.some((r) => r.start > clickedAt && r.end !== null && r.end - clickedAt < 3_000), {
      timeout: 5_000,
    })
    .toBe(true);

  await tab.page.getByRole("button", { name: /Leave queue/ }).click();
  await expect(tab.page.getByRole("button", { name: /Join queue/ })).toBeVisible();
  tab.errors();
  await tab.context.close();
});

test("a server that answers with no version puts the room on its ladder, never in a loop", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  const errors = trackPageErrors(page);
  // An old slot during a release: it ignores `since` and names no version.
  await page.route("**/api/inhouse", async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    delete json.roomVersion;
    await route.fulfill({ response, json });
  });
  const log = watchStateRequests(page);
  await page.goto("/api/auth/dev?name=LP+Old+Slot&steamId=76561190000007006&redirect=/inhouse");
  await expect(page.getByRole("button", { name: /Join queue/ })).toBeEnabled({ timeout: 20_000 });

  const WINDOW_MS = 12_000;
  const from = Date.now();
  await sleep(WINDOW_MS);
  const inWindow = log.filter((r) => r.start >= from && r.start < from + WINDOW_MS);
  // A signed-in spectator's ladder rate (POLL_IDLE_MS, 10s): one or two.
  expect(inWindow.length).toBeGreaterThanOrEqual(1);
  expect(inWindow.length).toBeLessThanOrEqual(Math.ceil(WINDOW_MS / INHOUSE.POLL_IDLE_MS));
  expect(log.every((r) => r.since === null)).toBe(true);
  errors();
  await context.close();
});
