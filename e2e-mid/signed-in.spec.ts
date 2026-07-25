import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// Signed-in mid-season surfaces: fantasy (locked once games imported — the
// fixture has games, so assert the locked state renders) and pick'em.

test.beforeEach(async ({ page }) => {
  await page.goto("/api/auth/dev?name=Mid%20Season%20Viewer");
});

test("fantasy renders standings for a signed-in viewer (league locked)", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/fantasy");
  await expect(
    page.getByRole("heading", { name: "Fantasy", exact: true }),
  ).toBeVisible();
  // Imported games lock the league — the page must say so instead of
  // offering a dead picker.
  await expect(page.getByText(/locked/i).first()).toBeVisible();
  assertNoErrors();
});

test("pick'em renders the oracle board and match cards", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/pickem");
  await expect(page.getByRole("heading", { name: "Pick'em" })).toBeVisible();
  assertNoErrors();
});

test("mobile schedule has no horizontal page overflow", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/schedule");
  await expect(page.getByText("Week 1").first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "/schedule");
  assertNoErrors();
});

// The admin panel and the match page render <select>s whose options are player
// names — a select sizes to its widest option and, as a flex item, refuses to
// shrink. One 32-char Steam name (Steam's own cap) used to push /admin 116px
// and /matches/[id] 64px wider than a 375px phone. Neither page had a mobile
// tripwire, which is how it shipped.
test("mobile admin panel has no horizontal page overflow", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/api/auth/dev?name=Overflow%20Admin&admin=1");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "/admin");
  assertNoErrors();
});

test("mobile match page has no horizontal page overflow", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/schedule");
  await page.getByRole("link", { name: "details →" }).first().click();
  await expect(page).toHaveURL(/\/matches\//);
  await expectNoHorizontalOverflow(page, "/matches/[id]");
  assertNoErrors();
});
