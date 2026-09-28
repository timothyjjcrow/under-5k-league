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

test("signed-out visitors sign in first, with the standin signup as a line", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");

  // The main button just signs in and comes back here: rostered players open
  // Discord links signed out, and must not be told to sign up as standins.
  const main = page.locator("#main");
  const signIn = main.getByRole("link", {
    name: "Sign in with Steam",
    exact: true,
  });
  await expect(signIn).toBeVisible();
  // Dev login is on in e2e, so these go through /login; with only Steam they
  // go straight to Steam, and the note beside them says what is shared.
  await expect(signIn).toHaveAttribute("href", "/login");
  const cta = main.getByRole("link", { name: "Sign in to join as a standin" });
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute("href", "/login?next=/me");
  await expect(main.getByRole("link", { name: "Sign in to stand in" })).toHaveCount(0);
  await expect(
    page.getByText(/so we never see your password or email\.$/),
  ).toBeVisible();

  assertNoErrors();
});

// A pinned post rides the strip under the hero and the League news card lists
// the latest of the rest, so the pinned one is printed once, not twice.
test("home shows a pinned post once, with the latest news below", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/");
  const main = page.locator("#main");
  await expect(
    main.getByRole("link", { name: /Pinned notice: Match night reminder/ }),
  ).toBeVisible();
  await expect(main.getByText(/Match night reminder/)).toHaveCount(1);
  await expect(
    main.getByRole("heading", { name: "League news", level: 2 }),
  ).toBeVisible();
  await expect(
    main.getByRole("link", { name: "Week schedule published", exact: true }),
  ).toBeVisible();
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
