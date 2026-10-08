import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// The hero pages (/meta/<hero>): the search on Hero meta, one hero's games
// with the items each player finished with, and items on the match page's
// box score. The fixture stores items on every game but the first two
// (legacy box scores), so both shapes show.

test("Hero meta links each hero to a page of its games and builds", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/meta");
  const table = page.getByRole("table");
  const firstRow = table.locator("tbody tr").first();
  await expect(firstRow).toBeVisible();
  const heroLink = firstRow.locator("th a");
  const heroName = (await heroLink.textContent())!.trim();
  // The table's record for this hero (the W–L column); the hero page counts
  // the same games, so its Record reads the same.
  const record = (await firstRow.locator("td").nth(1).textContent())!.trim();
  expect(record).toMatch(/^\d+–\d+$/);

  await heroLink.click();
  await expect(page).toHaveURL(/\/meta\/[a-z0-9-]+$/);
  await expect(page.getByRole("heading", { name: heroName, level: 1 })).toBeVisible();
  await expect(page.getByText(record, { exact: true }).first()).toBeVisible();

  await expect(page.getByRole("heading", { name: "Most-built items", level: 2 })).toBeVisible();
  await expect(page.getByRole("list", { name: "Most-built items" }).getByRole("listitem").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Games", level: 2 })).toBeVisible();
  // Each game links to its match, and a game with stored items shows them.
  await expect(page.getByRole("link", { name: "Match", exact: true }).first()).toHaveAttribute("href", /^\/matches\//);
  await expect(page.getByRole("group", { name: "Items" }).first().getByRole("img").first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "hero page");
  assertNoErrors();
});

test("the hero search finds a hero by shorthand and opens its page", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/meta");
  const search = page.getByRole("searchbox", { name: "Find a hero" });
  await search.fill("am");
  const matches = page.getByRole("list", { name: "Matching heroes" });
  await expect(matches.getByRole("link").first()).toHaveText("Anti-Mage");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/meta\/anti-mage$/);
  await expect(page.getByRole("heading", { name: "Anti-Mage", level: 1 })).toBeVisible();

  await search.fill("zzzz");
  await expect(page.getByText("No hero matches “zzzz”.")).toBeVisible();
  assertNoErrors();
});

test("the search works without scripts, through a plain redirect", async ({ page }) => {
  const response = await page.request.get("/meta/find?q=jugg", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers().location).toMatch(/\/meta\/juggernaut$/);
  const nothing = await page.request.get("/meta/find?q=zzzz", { maxRedirects: 0 });
  expect(nothing.headers().location).toMatch(/\/meta$/);
});

test("a hero nobody played says so, and an unknown hero is not found", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  // The fixture picks only heroes with ids 1-30; Wraith King is 42.
  await page.goto("/meta/wraith-king");
  await expect(page.getByRole("heading", { name: "Wraith King", level: 1 })).toBeVisible();
  await expect(page.getByText(/^No Wraith King games in /)).toBeVisible();
  await expect(page.getByRole("link", { name: "See the heroes that were picked" })).toHaveAttribute("href", "/meta");

  await page.goto("/meta/not-a-hero");
  await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
  assertNoErrors();
});

test("match box scores show each player's items", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/meta");
  await page.getByRole("table").locator("tbody tr th a").first().click();
  // A game whose items are stored (the staged live game and the fixture's
  // two legacy games have none).
  await page
    .getByRole("listitem")
    .filter({ has: page.getByRole("group", { name: "Items" }) })
    .first()
    .getByRole("link", { name: "Match", exact: true })
    .click();
  await expect(page).toHaveURL(/\/matches\//);
  const items = page.getByRole("group", { name: "Items" });
  await expect(items.first()).toBeVisible();
  await expect(items.first().getByRole("img").first()).toHaveAttribute("alt", /\S/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "match box score with items");
  assertNoErrors();
});
