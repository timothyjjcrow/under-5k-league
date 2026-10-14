import { test, expect } from "@playwright/test";
import { trackPageErrors } from "../e2e-mid/helpers";
import { SESSION_COOKIE } from "../src/lib/constants";
import {
  SESSION_REFRESH_AFTER_SECONDS,
  signSessionToken,
  verifySessionToken,
} from "../src/lib/session-token";

// The weekly session re-issue in the browser: a page whose server render finds
// the cookie a week old makes ONE call to POST /api/auth/refresh, which hands
// back the same session (user, epoch, sign-in time) issued anew; a fresh
// cookie makes no call at all. It replaced the Next proxy, a separate Vercel
// function on every signed-in page load (src/lib/auth.ts, DECISIONS.md).

const DAY_MS = 24 * 60 * 60 * 1000;
const isRefresh = (url: string) => new URL(url).pathname === "/api/auth/refresh";

test("a week-old session is re-issued by one call and stays the same session", async ({
  page,
  context,
}) => {
  const noErrors = trackPageErrors(page);
  // Dendi is a seeded signup; keep the seeded name for the later specs.
  await page.goto("/api/auth/dev?name=Dendi&steamId=7656119800001002&redirect=/me");
  const signedIn = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
  expect(signedIn, "the dev sign-in set the session cookie").toBeTruthy();
  // Proves this process signs with the server's key before forging an age.
  const session = await verifySessionToken(signedIn!.value);
  expect(session, "the test verifies the server's token").not.toBeNull();

  const issuedMs = Date.now() - (SESSION_REFRESH_AFTER_SECONDS * 1000 + DAY_MS);
  const signedInAt = Math.floor(issuedMs / 1000);
  const aged = await signSessionToken(
    { uid: session!.uid, ep: session!.ep, at: signedInAt },
    issuedMs,
  );
  await context.addCookies([{ ...signedIn!, value: aged }]);

  const refreshes: string[] = [];
  page.on("request", (request) => {
    if (isRefresh(request.url())) refreshes.push(request.method());
  });
  const answered = page.waitForResponse((response) => isRefresh(response.url()));
  await page.goto("/schedule");
  expect((await answered).status()).toBe(204);

  const reissued = async () =>
    (await context.cookies()).find((c) => c.name === SESSION_COOKIE)?.value;
  await expect.poll(reissued).not.toBe(aged);
  const fresh = await verifySessionToken((await reissued())!);
  expect(fresh).toMatchObject({ uid: session!.uid, ep: session!.ep, at: signedInAt });
  expect(fresh!.iat).toBeGreaterThan(Math.floor(Date.now() / 1000) - 300);
  // React's development double effect may send the one ask twice; never more.
  expect(refreshes.every((method) => method === "POST")).toBe(true);
  expect(refreshes.length).toBeGreaterThanOrEqual(1);
  expect(refreshes.length).toBeLessThanOrEqual(2);

  // Fresh now: the next pages ask nothing, and the player is still signed in.
  refreshes.length = 0;
  await page.goto("/me");
  await page.waitForLoadState("networkidle");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  expect(refreshes).toEqual([]);
  await page.goto("/me");
  await expect(page).toHaveURL(/\/me$/);
  noErrors();
});
