import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// The mid-season dashboard: standings, the This-week strip (with the staged
// LIVE match), and the standings table's phone layout.

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

test("signed-out newcomers can find the mid-season standin signup", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");

  const cta = page.getByRole("link", { name: "Sign in to stand in →" });
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

test("standings columns line up on a phone, with points at the right edge", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const table = page.getByRole("table", { name: "League standings", exact: true });
  await expect(table).toBeVisible();
  // Last 5 hides on phones. It is the last column, so no visible cell slides
  // onto its zero-width <col>: points ends where the table ends.
  await expect(
    table.getByRole("columnheader", {
      name: "Last 5",
      exact: true,
      includeHidden: true,
    }),
  ).toBeHidden();
  const tableBox = (await table.boundingBox())!;
  const pointsHeader = table.getByRole("columnheader", { name: "Points", exact: true });
  const headerBox = (await pointsHeader.boundingBox())!;
  expect(
    Math.abs(tableBox.x + tableBox.width - (headerBox.x + headerBox.width)),
  ).toBeLessThan(2);
  const firstRow = table.locator("tbody tr").first();
  const lastCell = firstRow.locator("td:visible").last();
  const cellBox = (await lastCell.boundingBox())!;
  expect(Math.abs(cellBox.x - headerBox.x)).toBeLessThan(2);
  expect(Math.abs(cellBox.width - headerBox.width)).toBeLessThan(2);

  assertNoErrors();
});
