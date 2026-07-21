import { test, expect } from "@playwright/test";
import { trackPageErrors } from "./helpers";

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

test("standings headers sort on click and speak their state via aria-sort", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");

  const ptsButton = page
    .getByRole("button", { name: /^Pts/i })
    .first();
  await expect(ptsButton).toBeVisible();
  const th = page.locator("th", { has: ptsButton }).first();

  await ptsButton.click();
  await expect(th).toHaveAttribute("aria-sort", "descending");
  await ptsButton.click();
  await expect(th).toHaveAttribute("aria-sort", "ascending");

  assertNoErrors();
});
