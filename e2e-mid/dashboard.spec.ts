import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// The mid-season dashboard: standings, the This-week strip (with the staged
// LIVE match), and the sortable standings table's client behavior.

test("dashboard shows the regular-season hero, standings, and a LIVE chip", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");

  // Regular-season hero counts the weeks ("Week" / "5" / "of 5 weeks" are
  // separate stat elements — match the one contiguous fragment).
  await expect(page.locator("#main")).toContainText(/of \d+ weeks/);
  await expect(page.getByRole("table").first()).toBeVisible();

  // The staged LIVE 1–0 match pulses on the This-week strip.
  await expect(
    page.getByRole("img", { name: /Live — series at 1–0/ }).first(),
  ).toBeVisible();

  assertNoErrors();
});

// The header's status chip says what is happening now: with the staged LIVE
// series it reads "Series live" on every page, phones included, and opens
// this week's fixtures.
test("the header chip links the live series from any page, on phones too", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/news");
  const chip = page
    .getByRole("banner")
    .getByRole("link", { name: /^League status: .+ — Series live$/ });
  await expect(chip).toHaveAttribute("href", "/schedule#this-week");
  await expect(chip).toContainText("Series live");

  await page.setViewportSize({ width: 360, height: 812 });
  await expect(chip).toBeVisible();
  await expectNoHorizontalOverflow(page, "/news header chip");
  await chip.click();
  await expect(page).toHaveURL(/\/schedule#this-week$/);
  assertNoErrors();
});

test("signed-out newcomers can find the mid-season standin signup", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");

  const cta = page.getByRole("link", { name: "Sign in to stand in" });
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute("href", "/login?next=/me");

  assertNoErrors();
});

// The dashboard is the widest page in the app — standings table, bracket, the
// This-week grid — and it was the one page with no overflow tripwire at all.
test("dashboard has no horizontal page overflow on a phone", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 360, height: 812 });
  await page.goto("/");
  await expect(page.locator("#main")).toContainText(/of \d+ weeks/);
  await expectNoHorizontalOverflow(page, "/");
  assertNoErrors();
});

test("standings headers sort on click and speak their state via aria-sort", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");

  await page
    .getByRole("button", { name: "Detailed statistics", exact: true })
    .click();
  const ptsButton = page.getByRole("button", { name: /^Pts/i }).first();
  await expect(ptsButton).toBeVisible();
  const th = page.locator("th", { has: ptsButton }).first();

  await ptsButton.click();
  await expect(th).toHaveAttribute("aria-sort", "descending");
  await ptsButton.click();
  await expect(th).toHaveAttribute("aria-sort", "ascending");

  assertNoErrors();
});
