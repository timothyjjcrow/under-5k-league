import { test, expect } from "@playwright/test";
import { trackPageErrors } from "./helpers";

test("during the season How it works asks newcomers to stand in", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/how-it-works");
  const main = page.locator("#main");
  // Player signups are closed mid-season; standins can still sign up. The
  // rule is Home's "Register as a standin" rule.
  // Dev login is on in e2e, so sign-in goes through /login (with only Steam
  // it goes straight to Steam); the note beside it says what is shared.
  await expect(
    main.getByRole("link", { name: "Sign up as a standin" }),
  ).toHaveAttribute("href", "/login?next=/me");
  await expect(
    main.getByText(/so we never see your password or email\.$/),
  ).toBeVisible();
  await expect(main.getByRole("link", { name: /^Join / })).toHaveCount(0);
  await expect(
    main.getByRole("link", { name: "Join our Discord" }),
  ).toHaveCount(0);
  await main.getByRole("link", { name: "inhouses", exact: true }).click();
  await expect(page).toHaveURL(/\/inhouse$/);
  assertNoErrors();
});
