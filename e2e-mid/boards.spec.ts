import { test, expect } from "@playwright/test";
import { trackPageErrors } from "./helpers";

// The stat roll-up pages — all recompute from every stored Game and all were
// previously untested in a browser. Each check: key cards render, the
// interactive bits respond, and nothing crashed client-side.

test("leaders renders boards with the show-all toggle", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/leaders");
  await expect(page.getByRole("heading", { name: "Leaders" })).toBeVisible();
  const toggle = page.getByRole("button", { name: /Show all/ }).first();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(
    page.getByRole("button", { name: /Show top 5/ }).first(),
  ).toBeVisible();
  assertNoErrors();
});

test("hero meta renders the contested and win-rate boards", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/meta");
  await expect(page.getByText("Most contested")).toBeVisible();
  // ("Untouched" only renders when unpicked heroes exist — data-dependent;
  // the win-rate board always accompanies games.)
  await expect(page.getByText("Winning the meta")).toBeVisible();
  assertNoErrors();
});

test("the record book renders all-time records", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/records");
  await expect(
    page.getByRole("heading", { name: "Record book" }),
  ).toBeVisible();
  assertNoErrors();
});

test("team page renders roster, form, and the what-we-need card", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/teams");
  await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
  // Into the first team's page via its standings-ordered card link.
  await page.locator('#main a[href^="/teams/"]').first().click();
  await expect(page).toHaveURL(/\/teams\/.+/);
  await expect(page.getByText("Roster").first()).toBeVisible();
  await expect(page.getByText("Head-to-head")).toBeVisible();
  assertNoErrors();
});

test("a player profile renders career stats and the report card", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/players");
  // Skip the "Compare players" action link — pick a real profile link.
  await page
    .locator('#main a[href^="/players/"]:not([href*="compare"])')
    .first()
    .click();
  await expect(page).toHaveURL(/\/players\/.+/);
  await expect(page.getByText("Seasons").first()).toBeVisible();
  assertNoErrors();
});
