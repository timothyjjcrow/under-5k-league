import { expect, test } from "@playwright/test";

const EXPLORE_LINKS = [
  "Leaders",
  "Hero meta",
  "Fantasy",
  "Pick'em",
  "Scrims",
] as const;

test("league tools live under Explore on desktop and mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // A rostered admin adds My Team and account actions. The primary row must
  // fit without horizontal scrolling while Explore keeps side tools nearby.
  await page.goto(
    "/api/auth/dev?name=Navigation%20Stress%20Tester&steamId=76561190000991001&admin=1&redirect=/pickem",
  );

  const desktopPrimary = page.locator('header > div nav[aria-label="Primary"]');
  await expect(desktopPrimary).toBeVisible();
  await expect(
    desktopPrimary.getByRole("link", { name: "My Team", exact: true }),
  ).toBeVisible();
  const desktopWidth = await desktopPrimary.evaluate((nav) => ({
    client: nav.clientWidth,
    scroll: nav.scrollWidth,
  }));
  expect(
    desktopWidth.scroll,
    "desktop primary nav should not need horizontal scrolling",
  ).toBeLessThanOrEqual(desktopWidth.client);
  for (const label of EXPLORE_LINKS) {
    await expect(
      desktopPrimary.getByRole("link", { name: label, exact: true }),
    ).toHaveCount(0);
  }

  const desktopExploreButton = page.getByRole("button", {
    name: /Explore/,
  });
  await desktopExploreButton.click();
  const desktopExplore = page.getByRole("navigation", { name: "Explore" });
  for (const label of EXPLORE_LINKS) {
    await expect(
      desktopExplore.getByRole("link", { name: label, exact: true }),
    ).toBeVisible();
  }

  for (const group of ["Play", "Statistics", "League"]) {
    await expect(
      desktopExplore.getByText(group, { exact: true }),
    ).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(desktopExplore).toHaveCount(0);
  await expect(desktopExploreButton).toBeFocused();

  // Phones have one menu: the sheet behind the tab bar's last slot.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Quick navigation" })
    .getByRole("button", { name: "Explore league" })
    .click();
  const sheet = page.getByRole("navigation", {
    name: "Explore league",
    exact: true,
  });
  for (const label of EXPLORE_LINKS) {
    await expect(
      sheet.getByRole("link", { name: label, exact: true }),
    ).toBeVisible();
  }
  await sheet.getByRole("link", { name: "Hero meta", exact: true }).click();
  await expect(page).toHaveURL(/\/meta$/);
  await expect(
    page.getByRole("heading", { name: "Hero meta", exact: true }),
  ).toBeVisible();
  await expect(sheet).toHaveCount(0);
});
