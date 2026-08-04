import { test, expect, type Dialog, type Page } from "@playwright/test";
import {
  ROOM_ACTION_TIMEOUT_MS,
  ROOM_POLL_TIMEOUT_MS,
} from "../src/lib/constants";

// Both live rooms poll with a self-scheduling setTimeout guarded by an
// `inFlight` latch that is cleared only in the awaited fetch's `finally`. A
// request that CONNECTS BUT NEVER ANSWERS — flaky mobile data, a socket
// resumed from a suspended tab — therefore used to stop every later tick, the
// `visibilitychange` wake-up included. Nothing settled, so `pollFail()` never
// ran and `usePollHealth` never tripped: the room sat on stale state with
// `disconnected` FALSE and every control still live. A captain watching a
// frozen auction sell their player is exactly what the health strip exists to
// prevent, and this failure mode walked straight past it.
//
// `AbortSignal.timeout(ROOM_POLL_TIMEOUT_MS)` on each poll is the fix: the
// abort throws into the loop's existing catch, which fails the poll and
// reschedules. The observable proof is simply that a SECOND request happens —
// without the timeout the count stays at exactly 1, forever.
//
// The transport-only checks are read-only. The two live-draft checks call the
// guarded fixture helper below so this file is also valid when selected on its
// own, instead of silently relying on zz-admin-draft having run first.

/**
 * Use the real admin workflow to make Playwright's disposable fixture live.
 * Running through captain designation and Start draft keeps the fixture inside
 * the same phase, roster, budget, audit, and optimistic-lock invariants as the
 * application. It is idempotent after the full draft-night browser scenario.
 */
async function ensureLiveDraftFixture(page: Page) {
  const acceptDialog = (dialog: Dialog) => dialog.accept();
  page.on("dialog", acceptDialog);
  try {
    await page.goto(
      "/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=/admin",
    );
    await expect(
      page.getByRole("heading", { name: "Captains & draft", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    const pause = page.getByRole("button", { name: "Pause auction" });
    if (await pause.isVisible()) return;

    const resume = page.getByRole("button", { name: "Resume auction" });
    if (await resume.isVisible()) {
      await resume.click();
      await expect(pause).toBeVisible({ timeout: 20_000 });
      return;
    }

    for (const name of ["Dendi", "Puppey"]) {
      const makeCaptain = page
        .locator(".max-h-80 div.rounded-lg", { hasText: name })
        .getByRole("button", { name: "make captain" });
      if (await makeCaptain.isVisible()) {
        await makeCaptain.click();
        await expect(makeCaptain).toHaveCount(0);
      }
    }

    const start = page.getByRole("button", { name: "Start draft" });
    await expect(
      start,
      "The live-draft fixture must begin in Signups or Draft setup",
    ).toBeEnabled({ timeout: 20_000 });
    await start.click();
    await expect(pause).toBeVisible({ timeout: 20_000 });
  } finally {
    page.off("dialog", acceptDialog);
  }
}

/** Hang every request to `pattern` and count how many the client attempted. */
async function hangAndCount(
  page: Page,
  pattern: string,
): Promise<() => number> {
  let attempts = 0;
  await page.route(pattern, () => {
    attempts += 1;
    // Never fulfil, continue or abort — the request stays pending until the
    // client's own deadline kills it. Playwright tears the handler down with
    // the page at test end.
  });
  return () => attempts;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Hold one already-started response, then the first poll that follows it. */
async function holdOldAndFreshPoll(page: Page, pattern: string) {
  let phase: "pass" | "old" | "fresh" = "pass";
  const oldStarted = deferred();
  const releaseOld = deferred();
  const freshStarted = deferred();
  const releaseFresh = deferred();

  await page.route(pattern, async (route) => {
    if (phase === "old") {
      // Capture the response before the synthetic outage, but do not deliver
      // it to the room until after reconnect. This is the transport race the
      // connectivity generation must reject.
      const response = await route.fetch();
      oldStarted.resolve();
      await releaseOld.promise;
      phase = "fresh";
      await route.fulfill({ response });
      return;
    }
    if (phase === "fresh") {
      freshStarted.resolve();
      await releaseFresh.promise;
      phase = "pass";
    }
    await route.continue();
  });

  return {
    arm: () => {
      phase = "old";
    },
    oldStarted: oldStarted.promise,
    releaseOld: releaseOld.resolve,
    freshStarted: freshStarted.promise,
    releaseFresh: releaseFresh.resolve,
  };
}

async function installSyntheticConnectivity(page: Page) {
  await page.addInitScript(() => {
    let online = true;
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => online,
    });
    Object.defineProperty(window, "__setLeagueOnline", {
      configurable: true,
      value: (next: boolean) => {
        online = next;
        window.dispatchEvent(new Event(next ? "online" : "offline"));
      },
    });
  });
}

async function setSyntheticConnectivity(page: Page, online: boolean) {
  await page.evaluate((next) => {
    (
      window as unknown as { __setLeagueOnline: (value: boolean) => void }
    ).__setLeagueOnline(next);
  }, online);
}

/**
 * One poll attempt, plus the client-side deadline, plus the reschedule and the
 * next attempt — with room for a slow dev-server compile of the route.
 */
const WAIT_FOR_SECOND_ATTEMPT = ROOM_POLL_TIMEOUT_MS + 12_000;

// These deliberately wait out a real client-side deadline, so they need more
// than the suite's 30s default. Still the cheapest honest proof available:
// the repo has no jsdom environment in which to fake timers for a hook.
test.describe.configure({ timeout: 75_000 });

test("draft room's poll loop survives a request that never answers", async ({
  page,
}) => {
  const attempts = await hangAndCount(page, "**/api/draft/tick");
  await page.goto("/draft");

  // The room mounts and fires its first poll, which we swallow.
  await expect.poll(() => attempts(), { timeout: 20_000 }).toBeGreaterThan(0);

  // THE assertion: the loop is not dead. Before the timeout this stayed at 1
  // for as long as the tab stayed open.
  await expect
    .poll(() => attempts(), { timeout: WAIT_FOR_SECOND_ATTEMPT })
    .toBeGreaterThan(1);
});

test("inhouse room's poll loop survives a request that never answers", async ({
  page,
}) => {
  const attempts = await hangAndCount(page, "**/api/inhouse");
  await page.goto("/inhouse");

  await expect.poll(() => attempts(), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect
    .poll(() => attempts(), { timeout: WAIT_FOR_SECOND_ATTEMPT })
    .toBeGreaterThan(1);
});

test("inhouse cold-start failure becomes an accessible retry state and recovers", async ({
  page,
}) => {
  let failing = true;
  let attempts = 0;
  await page.route("**/api/inhouse", async (route) => {
    attempts += 1;
    if (failing) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary outage" }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/inhouse");

  // Before the fix, the disconnected banner lived below `if (!state) return`
  // and could never render: a first-load outage said "Loading inhouse…"
  // forever, with no action the user could take.
  const alert = page.getByRole("alert", {
    name: "We can't load the inhouse room",
  });
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toContainText("reconnecting automatically");
  const retry = alert.getByRole("button", { name: "Try again now" });
  await expect(retry).toBeVisible();

  const beforeRetry = attempts;
  await retry.click();
  failing = false;
  await expect
    .poll(() => attempts, { timeout: 10_000 })
    .toBeGreaterThan(beforeRetry);

  // A successful state payload replaces the cold error instead of leaving a
  // sticky failure panel behind. The sound control only mounts after state.
  await expect(alert).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Sound on|Muted/ }),
  ).toBeVisible();
});

test("a loaded draft disables stale actions while offline and resyncs before recovery", async ({
  page,
  context,
}) => {
  await ensureLiveDraftFixture(page);
  await page.goto(
    "/api/auth/dev?name=Offline+Draft+Admin&steamId=76561190000009003&admin=1&redirect=/draft",
  );
  const pause = page.getByRole("button", { name: "Pause auction" });
  await expect(pause).toBeEnabled({ timeout: 20_000 });

  await context.setOffline(true);
  await expect(
    page.getByText(/You're offline — the auction keeps running on the server/),
  ).toBeVisible();
  await expect(pause).toBeDisabled();

  await context.setOffline(false);
  await expect(
    page.getByText(/You're offline — the auction keeps running on the server/),
  ).toHaveCount(0, { timeout: 20_000 });
  await expect(pause).toBeEnabled();
});

test("a loaded inhouse room disables stale actions while offline and resyncs before recovery", async ({
  page,
  context,
}) => {
  await page.goto(
    "/api/auth/dev?name=Offline+Inhouse&steamId=76561190000009004&redirect=/inhouse",
  );
  const join = page.getByRole("button", { name: /Join queue/ });
  await expect(join).toBeEnabled({ timeout: 20_000 });

  await context.setOffline(true);
  await expect(
    page.getByText(/You're offline — the queue and lobby keep running/),
  ).toBeVisible();
  await expect(join).toBeDisabled();

  await context.setOffline(false);
  await expect(
    page.getByText(/You're offline — the queue and lobby keep running/),
  ).toHaveCount(0, { timeout: 20_000 });
  await expect(join).toBeEnabled();
});

test("draft rejects a pre-outage response and waits for a post-reconnect poll", async ({
  page,
}) => {
  await ensureLiveDraftFixture(page);
  await installSyntheticConnectivity(page);
  const held = await holdOldAndFreshPoll(page, "**/api/draft/tick");
  await page.goto(
    "/api/auth/dev?name=Held+Draft+Admin&steamId=76561190000009005&admin=1&redirect=/draft",
  );
  const pause = page.getByRole("button", { name: "Pause auction" });
  await expect(pause).toBeEnabled({ timeout: 20_000 });

  held.arm();
  await held.oldStarted;
  await setSyntheticConnectivity(page, false);
  await expect(pause).toBeDisabled();
  await setSyntheticConnectivity(page, true);
  const resyncing = page.getByText(
    /Connection restored — checking the current lot/,
  );
  await expect(resyncing).toBeVisible();

  held.releaseOld();
  await held.freshStarted;
  // The held old payload has landed. Only the still-pending fresh payload may
  // remove this strip and re-enable the server-action recovery control.
  await expect(resyncing).toBeVisible();
  await expect(pause).toBeDisabled();

  held.releaseFresh();
  await expect(resyncing).toHaveCount(0, { timeout: 20_000 });
  await expect(pause).toBeEnabled();
});

test("inhouse rejects a pre-outage response and waits for a post-reconnect poll", async ({
  page,
}) => {
  await installSyntheticConnectivity(page);
  const held = await holdOldAndFreshPoll(page, "**/api/inhouse");
  await page.goto(
    "/api/auth/dev?name=Held+Inhouse&steamId=76561190000009006&redirect=/inhouse",
  );
  const join = page.getByRole("button", { name: /Join queue/ });
  await expect(join).toBeEnabled({ timeout: 20_000 });

  held.arm();
  await held.oldStarted;
  await setSyntheticConnectivity(page, false);
  await expect(join).toBeDisabled();
  await setSyntheticConnectivity(page, true);
  const resyncing = page.getByText(
    /Connection restored — checking the current queue and lobby/,
  );
  await expect(resyncing).toBeVisible();

  held.releaseOld();
  await held.freshStarted;
  await expect(resyncing).toBeVisible();
  await expect(join).toBeDisabled();

  held.releaseFresh();
  await expect(resyncing).toHaveCount(0, { timeout: 20_000 });
  await expect(join).toBeEnabled();
});

test("inhouse treats an unreadable successful action response as unknown", async ({
  page,
}) => {
  let holdNextState = false;
  const heldStateStarted = deferred();
  const releaseHeldState = deferred();
  await page.route("**/api/inhouse", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes('"action":"state"')) {
      if (holdNextState) {
        holdNextState = false;
        heldStateStarted.resolve();
        await releaseHeldState.promise;
      }
      await route.continue();
      return;
    }
    // Simulate a proxy truncating/replacing the JSON body after the origin has
    // returned success. The client cannot safely claim the mutation failed.
    await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
  });

  await page.goto(
    "/api/auth/dev?name=Unreadable+Action&steamId=76561190000009002&redirect=/inhouse",
  );
  const join = page.getByRole("button", { name: /Join queue/ });
  await expect(join).toBeEnabled({ timeout: 20_000 });
  holdNextState = true;
  await join.click();

  await expect(
    page.getByText(
      "The response was incomplete — checking the current room state",
    ),
  ).toBeVisible();
  await expect(join).toBeDisabled();
  await heldStateStarted.promise;
  const reconciling = page.getByText(
    /Checking the current queue and lobby after an interrupted action/,
  );
  await expect(reconciling).toBeVisible();
  await expect(join).toBeDisabled();

  releaseHeldState.resolve();
  await expect(reconciling).toHaveCount(0, { timeout: 10_000 });
  await expect(join).toBeEnabled();
});

test("inhouse preserves action reconciliation behind an in-flight state poll", async ({
  page,
}) => {
  let holdNextState = false;
  let stateAttempts = 0;
  const heldStateStarted = deferred();
  const releaseHeldState = deferred();

  await page.route("**/api/inhouse", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes('"action":"state"')) {
      stateAttempts += 1;
      if (holdNextState) {
        holdNextState = false;
        heldStateStarted.resolve();
        await releaseHeldState.promise;
      }
      await route.continue();
      return;
    }
    // The origin may have committed even though a proxy replaced the body.
    await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
  });

  await page.goto(
    "/api/auth/dev?name=Poll+Overlap&steamId=76561190000009007&redirect=/inhouse",
  );
  const join = page.getByRole("button", { name: /Join queue/ });
  await expect(join).toBeEnabled({ timeout: 20_000 });

  // Start and hold a state request that predates the action.
  holdNextState = true;
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await heldStateStarted.promise;
  const attemptsWithHeldPoll = stateAttempts;

  await join.click();
  await expect(
    page.getByText(
      "The response was incomplete — checking the current room state",
    ),
  ).toBeVisible();
  await expect(join).toBeDisabled();
  // Let the action's 250ms kick encounter the in-flight latch. Before the
  // queued-rerun fix that kick vanished here and no reconciliation followed.
  await page.waitForTimeout(400);
  releaseHeldState.resolve();

  await expect
    .poll(() => stateAttempts, { timeout: 5_000 })
    .toBeGreaterThan(attemptsWithHeldPoll);
  await expect(join).toBeEnabled();
});

// The other half of the same freeze: a hung mutation used to leave every
// control disabled forever. Simply clearing `pending` on timeout is unsafe,
// though — the server may have committed after the browser gave up. The room
// must hold the lock until a state poll that started after the action lands.

/**
 * One action attempt plus its deadline plus React's re-enable, with slack for
 * a dev-server compile.
 */
const WAIT_FOR_CONTROLS_BACK = ROOM_ACTION_TIMEOUT_MS + 15_000;

test("inhouse holds a timed-out action lock until a newer state poll lands", async ({
  page,
}) => {
  let cachedState: Record<string, unknown> | null = null;
  let actionStarted = false;
  let holdNextState = true;
  const postActionStateStarted = deferred();
  const releasePostActionState = deferred();

  await page.route("**/api/inhouse", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes('"action":"state"')) {
      if (!cachedState) {
        const response = await route.fetch();
        if (!response.ok()) {
          await route.fulfill({ response });
          return;
        }
        cachedState = (await response.json()) as Record<string, unknown>;
      }
      if (actionStarted && holdNextState) {
        holdNextState = false;
        postActionStateStarted.resolve();
        await releasePostActionState.promise;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...cachedState, now: Date.now() }),
      });
      return;
    }
    // A join that connects but never answers. It never reaches the origin, so
    // the cached state remains the authoritative no-commit result.
    actionStarted = true;
  });

  await page.goto(
    "/api/auth/dev?name=Hang+Tester&steamId=76561190000009001&redirect=/inhouse",
  );
  const join = page.getByRole("button", { name: /Join queue/ });
  await expect(join).toBeEnabled({ timeout: 20_000 });
  await join.click();

  // Immediately disabled by the request itself.
  await expect(join).toBeDisabled();
  const reconciling = page.getByText(
    /Checking the current queue and lobby after an interrupted action/,
  );
  await expect(reconciling).toBeVisible({ timeout: WAIT_FOR_CONTROLS_BACK });
  await postActionStateStarted.promise;
  // The request deadline has released `pending`, but the unknown-outcome lock
  // remains until this newer authoritative poll is allowed to land.
  await expect(join).toBeDisabled();

  releasePostActionState.resolve();
  await expect(reconciling).toHaveCount(0, { timeout: 10_000 });
  await expect(join).toBeEnabled();
});

// The draft room's act() is the same code and the same freeze, but its
// controls only exist during a live auction, which makes a UI-driven version
// of the test above depend on where the earlier draft specs left the season.
// It's covered instead by src/components/room-source-guards.test.ts, which
// asserts EVERY fetch in both rooms carries a signal — cheap, non-flaky, and
// it catches the actual regression (someone deleting the `signal:` line).
