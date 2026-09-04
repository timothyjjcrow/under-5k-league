import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

test("home and schedule agree on progress and preserve the full standings behind the simple view", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 900 });
  let progress: string | null = null;
  for (const path of ["/", "/schedule"]) {
    await page.goto(path);
    const bar = page.getByRole("progressbar", {
      name: "Regular-season series complete",
    });
    await expect(bar).toBeVisible();
    const count = await bar.getAttribute("aria-valuenow");
    if (progress !== null) expect(count).toBe(progress);
    progress = count;
    const overview = page.getByRole("table", {
      name: "League standings overview",
    });
    await expect(overview).toBeVisible();
    const teams = await overview
      .locator('a[href^="/teams/"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    expect(teams.length).toBeGreaterThan(0);
    await page
      .getByRole("button", { name: "Detailed statistics", exact: true })
      .click();
    await expect(overview).toHaveCount(0);
    const detailed = page.getByRole("table").first();
    expect(
      await detailed
        .locator('a[href^="/teams/"]')
        .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
    ).toEqual(teams);
    await expect(page.getByRole("button", { name: /^Pts/ })).toBeVisible();
    await page
      .getByRole("button", { name: "Simple standings", exact: true })
      .click();
    await expect(overview).toBeVisible();
    await expectNoHorizontalOverflow(
      page,
      `${path} simple and detailed standings`,
    );
  }
  // The fixture's live/future matches are unfinished, not overdue results.
  await expect(
    page.getByText("Results outstanding", { exact: true }),
  ).toHaveCount(0);
  noErrors();
});

test("schedule keeps analysis discoverable and labels filtered counts for the selected team", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/schedule");
  const race = page
    .locator("details")
    .filter({
      has: page
        .locator("summary")
        .filter({ hasText: "Playoff race & possible matchups" }),
    })
    .first();
  await expect(race).not.toHaveAttribute("open", "");
  await race.locator("summary").first().click();
  await expect(
    page.getByRole("heading", { name: "Remaining opponents", exact: true }),
  ).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "Head-to-head results grid" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Head-to-head results", exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "expanded league analysis");
  await page
    .getByRole("combobox", { name: "Show matches for" })
    .selectOption({ label: "Dire Straits" });
  await expect(page.locator("#this-week")).toContainText(
    "0 of 1 series complete",
  );
  await expect(
    page.getByText(/Standings below still include the whole league/),
  ).toBeVisible();
  noErrors();
});
