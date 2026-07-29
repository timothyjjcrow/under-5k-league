import { test, expect } from "@playwright/test";
import { trackPageErrors } from "./helpers";

/**
 * The type-to-confirm barrier, exercised in a real browser.
 *
 * The source guard (src/components/danger-submit.test.ts) proves the component
 * is WIRED to the unrecoverable actions; only a browser can prove the barrier
 * actually holds — that the destructive form does not submit until the season
 * name has been typed, and that Enter cannot complete it. Both are the whole
 * point of the mechanism and both are invisible to every other suite.
 *
 * The fixture is mid-season with a full schedule, so "Regenerate schedule" is
 * the DangerSubmit on screen and its damage (every check-in, pick and standin
 * booking) is exactly the kind this protects.
 */
test.beforeEach(async ({ page }) => {
  await page.goto("/api/auth/dev?name=Danger%20Admin&admin=1");
});

async function openRegenerateDialog(page: import("@playwright/test").Page) {
  await page.goto("/admin");
  const button = page.getByRole("button", { name: "Regenerate schedule" });
  await expect(button).toBeVisible();
  await button.click();
  return page.getByRole("dialog");
}

test("a destructive action cannot be submitted until the name is typed", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  const dialog = await openRegenerateDialog(page);

  // The dialog states what dies rather than hiding it behind one sentence.
  await expect(dialog).toContainText("Replace the regular-season schedule?");
  await expect(dialog).toContainText("fixture(s) are deleted and recreated");

  // The confirming button exists but is INERT until the token matches.
  const confirm = dialog.getByRole("button", { name: "Regenerate schedule" });
  await expect(confirm).toBeDisabled();

  // A wrong token keeps it inert — this is the case a reflex produces.
  await dialog.getByRole("textbox").fill("regenerate");
  await expect(confirm).toBeDisabled();

  assertNoErrors();
});

test("Enter in the token field cannot complete a destructive action", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  const dialog = await openRegenerateDialog(page);

  // Type the CORRECT token, then press Enter — the one-keypress path that
  // window.confirm allows and this component must not.
  const seasonName = await page
    .locator("b")
    .filter({ hasText: /Season/ })
    .first()
    .textContent();
  await dialog.getByRole("textbox").fill(seasonName?.trim() ?? "");
  await dialog.getByRole("textbox").press("Enter");

  // Still open, still nothing submitted: the admin has to aim at the button.
  await expect(dialog).toBeVisible();
  assertNoErrors();
});

test("cancelling disarms, so reopening starts from a blank field", async ({
  page,
}) => {
  // A lingering token would mean the next open is armed from the first frame —
  // reintroducing exactly the single-keypress hazard this replaces.
  const assertNoErrors = trackPageErrors(page);
  const dialog = await openRegenerateDialog(page);
  await dialog.getByRole("textbox").fill("something");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  const reopened = await openRegenerateDialog(page);
  await expect(reopened.getByRole("textbox")).toHaveValue("");
  await expect(
    reopened.getByRole("button", { name: "Regenerate schedule" }),
  ).toBeDisabled();
  assertNoErrors();
});
