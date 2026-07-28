import { test, expect, type Page } from "@playwright/test";
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
// Read-only and signed out: these tests hang a poll endpoint but never mutate
// league or inhouse state, so they're safe anywhere in the ordering.

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

// The other half of the same freeze: both rooms flip `pending` on before an
// ACTION fetch and off in its `finally`, so a hung mutation left EVERY control
// disabled until the player reloaded — a captain locked out of bidding under a
// 30s lot clock, a player locked out of ACCEPT during a 45s ready check.
//
// A timeout here is not proof the action failed (the server keeps going and
// may have committed), so the copy only promises to go and look — but the
// controls must come back either way. The assertion is exactly that.

/**
 * One action attempt plus its deadline plus React's re-enable, with slack for
 * a dev-server compile.
 */
const WAIT_FOR_CONTROLS_BACK = ROOM_ACTION_TIMEOUT_MS + 15_000;

test("inhouse room re-enables its controls when an action never answers", async ({
  page,
}) => {
  // Hang ONLY the mutation — the `state` poll must keep flowing, otherwise
  // `disconnected` would disable the controls for an unrelated reason and the
  // test would pass without proving anything.
  await page.route("**/api/inhouse", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes('"action":"state"')) return route.continue();
    // A join that never answers.
  });

  await page.goto(
    "/api/auth/dev?name=Hang+Tester&steamId=76561190000009001&redirect=/inhouse",
  );
  const join = page.getByRole("button", { name: /Join queue/ });
  await expect(join).toBeEnabled({ timeout: 20_000 });
  await join.click();

  // Immediately disabled — that's `pending`, and before the deadline it was
  // permanent.
  await expect(join).toBeDisabled();
  await expect(join).toBeEnabled({ timeout: WAIT_FOR_CONTROLS_BACK });
});

// The draft room's act() is the same code and the same freeze, but its
// controls only exist during a live auction, which makes a UI-driven version
// of the test above depend on where the earlier draft specs left the season.
// It's covered instead by src/components/room-source-guards.test.ts, which
// asserts EVERY fetch in both rooms carries a signal — cheap, non-flaky, and
// it catches the actual regression (someone deleting the `signal:` line).
