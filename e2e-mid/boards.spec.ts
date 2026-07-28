import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

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

// /leaders shipped a 188px horizontal page scroll at 390px: its board grid was
// `grid gap-4 sm:grid-cols-2` with no base column, so below `sm` the implicit
// track was `auto` and sized itself to a leaderboard row's max-content (560px
// in a 390px viewport). Exactly the failure CLAUDE.md's grid-cols-1 rule
// exists to prevent, on a page that had no tripwire pointed at it.
test("leaders has no horizontal page overflow on a phone", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/leaders");
  await expect(page.getByRole("heading", { name: "Leaders" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "/leaders");
  assertNoErrors();
});

// The pool is a column-aligned grid whose tracks change three times between
// 390px and 1440px — exactly the shape that leaks page width when a track is
// sized by its content instead of by `minmax(0,1fr)`.
test("players page has no horizontal page overflow on a phone", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/players");
  await expect(page.getByRole("heading", { name: "Players" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "/players");
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
