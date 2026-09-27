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
      // instead of repeating the home page's progress ring.
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
    page.getByRole("heading", { name: "Playoff picture", exact: true }),
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
  noErrors();
});

test("weekly result tiles preserve every series and open the underlying match", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/");
  const chart = page.getByRole("table", {
    name: "Weekly series results",
    exact: true,
  });
  await expect(chart).toBeVisible();
  const progress = page.getByRole("progressbar", {
    name: "Regular-season series complete",
  });
  const total = Number(await progress.getAttribute("aria-valuemax"));
  const complete = Number(await progress.getAttribute("aria-valuenow"));
  const tiles = chart.locator('a[href^="/matches/"]');
  // Every series appears once for each team; a visual tile never drops a fixture.
  await expect(tiles).toHaveCount(total * 2);
  const links = await tiles.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("href")),
  );
  expect(new Set(links).size).toBe(total);
  for (const href of new Set(links))
    expect(links.filter((link) => link === href)).toHaveLength(2);
  await expect(
    chart.getByRole("link", { name: /: (Won|Lost|Drew) / }),
  ).toHaveCount(complete * 2);
  const result = chart.getByRole("link", { name: /: Won / }).first();
  const href = await result.getAttribute("href");
  await result.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page, "weekly result to match details");
  noErrors();
});
