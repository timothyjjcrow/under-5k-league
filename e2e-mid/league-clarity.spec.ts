import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

test("home and schedule agree on progress and show one standings table with game difference", async ({
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
    if (path === "/") {
      await expect(bar).toBeVisible();
      progress = `${await bar.getAttribute("aria-valuenow")} of ${await bar.getAttribute("aria-valuemax")} series played`;
    } else {
      // Schedule leads with the fixtures: the same count rides the subtitle
      // instead of repeating the home page's progress block.
      await expect(bar).toHaveCount(0);
      await expect(
        page.locator("h1 + p").filter({ hasText: progress! }),
      ).toBeVisible();
    }
    const table = page.getByRole("table", {
      name: "League standings",
      exact: true,
    });
    await expect(table).toBeVisible();
    const teams = await table
      .locator('a[href^="/teams/"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    expect(teams.length).toBeGreaterThan(0);
    // One layout: no Simple/Detailed toggle and no sort buttons, and game
    // difference (the first tiebreak) stays on screen on a phone.
    await expect(
      page.getByRole("button", { name: /Detailed statistics|Simple standings/ }),
    ).toHaveCount(0);
    await expect(table.getByRole("button")).toHaveCount(0);
    for (const header of ["Series won, drawn and lost", "Game difference", "Points"]) {
      await expect(
        table.getByRole("columnheader", { name: header, exact: true }),
      ).toBeVisible();
    }
    await expectNoHorizontalOverflow(page, `${path} standings`);
  }
  // The fixture's live/future matches are unfinished, not overdue results.
  await expect(
    page.getByText("Overdue results", { exact: true }),
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
    page.getByRole("heading", { name: "Playoff picture", exact: true }),
  ).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "Head-to-head results grid" })
    .click();
  await expect(
    page.getByRole("table", { name: /^Head-to-head results\./ }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "expanded league analysis");
  await page
    .getByRole("combobox", { name: "Show matches for" })
    .selectOption({ label: "Dire Straits" });
  await expect(page.locator("#this-week")).toContainText(
    "0 of 1 series complete",
  );
  noErrors();
});

test("home lists recent results as a short list that opens the underlying match", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/");
  // Home has no week-by-week results grid: the standings' form column and
  // Recent results already say it, and Schedule keeps the head-to-head grid.
  await expect(
    page.getByRole("table", { name: /^Weekly series results/ }),
  ).toHaveCount(0);
  const heading = page.getByRole("heading", {
    name: "Recent results",
    level: 2,
  });
  await expect(heading).toBeVisible();
  const card = heading.locator(
    "xpath=ancestor::div[.//a[contains(., 'All results')]][1]",
  );
  await expect(
    card.getByRole("link", { name: "All results" }),
  ).toHaveAttribute("href", "/schedule#fixtures");
  const results = card.locator('li a[href^="/matches/"]');
  const count = await results.count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(4);
  // Each row says who won, or that it was drawn, to a screen reader too.
  await expect(results.first()).toHaveAccessibleName(
    /(won the series|Series drawn) · Match details$/,
  );
  // A plain list: no box that scrolls inside the page.
  const innerScrollers = await card.evaluate(
    (root) =>
      [root, ...Array.from(root.querySelectorAll("*"))].filter(
        (el) =>
          /(auto|scroll)/.test(getComputedStyle(el).overflowY) &&
          el.scrollHeight > el.clientHeight + 1,
      ).length,
  );
  expect(innerScrollers).toBe(0);
  const href = await results.first().getAttribute("href");
  await results.first().click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page, "recent result to match details");
  noErrors();
});
