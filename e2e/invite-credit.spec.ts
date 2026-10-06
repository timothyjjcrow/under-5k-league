import { test, expect, type BrowserContext } from "@playwright/test";
import { trackPageErrors } from "../e2e-mid/helpers";

// The small invite credit in the browser (src/lib/invite-credit.ts): a tagged
// link is remembered for 30 days, the first link wins, and the tag leaves the
// address bar; a signed-up player's "Copy invite link" carries their tag. The
// credit itself, "invited by" on the Discord signup post, is covered by
// test/integration/invite-credit.itest.ts.

const FIRST = "cme2einvitefirst0001";
const SECOND = "cme2einvitesecond002";

async function rememberedTag(context: BrowserContext) {
  return (await context.cookies()).find((cookie) => cookie.name === "ggd2l_ref")?.value ?? null;
}

test("an invite link is remembered, the first link wins, and the tag leaves the address bar", async ({
  page,
  context,
}) => {
  const noErrors = trackPageErrors(page);
  await page.goto(`/?ref=${FIRST}`);
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => rememberedTag(context)).toBe(FIRST);

  await page.goto(`/how-it-works?ref=${SECOND}`);
  await expect(page).toHaveURL(/\/how-it-works$/);
  expect(await rememberedTag(context)).toBe(FIRST);
  noErrors();
});

test("a signed-up player's invite link carries their tag", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const noErrors = trackPageErrors(page);
  // Dendi is a seeded signup; keep the seeded name for the later specs.
  await page.goto("/api/auth/dev?name=Dendi&steamId=7656119800001002&redirect=/me");
  await page.getByRole("button", { name: "Copy invite link" }).first().click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Copied .+\/\?ref=[A-Za-z0-9_-]{8,64}$/ }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /^https?:\/\/[^/]+\/\?ref=[A-Za-z0-9_-]{8,64}$/,
  );
  noErrors();
});
