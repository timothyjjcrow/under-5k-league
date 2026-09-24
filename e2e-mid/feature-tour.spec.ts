import { test, expect } from "@playwright/test";
import { trackPageErrors } from "./helpers";

test("the feature tour opens season tools after the draft and keeps signup messaging honest", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/features");
  const directory = page.getByRole("region", {
    name: "Everything the league offers.",
  });
  for (const href of [
    "/schedule",
    "/fantasy",
    "/pickem",
    "/meta",
    "/leaders",
    "/scrims",
    "/teams",
  ]) {
    await expect(directory.locator(`a[href="${href}"]`).first()).toBeVisible();
  }
  await expect(page.locator('main a[href="/draft"]')).toHaveCount(0);
  await expect(page.locator('main a[href="/recap"]')).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Ready for next season?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Sign up with Steam" }),
  ).toHaveCount(0);
  await directory.getByRole("link", { name: "Fantasy", exact: true }).click();
  await expect(page).toHaveURL(/\/fantasy$/);
  await expect(
    page.getByRole("heading", { name: "Fantasy", exact: true, level: 1 }),
  ).toBeVisible();
  assertNoErrors();
});
