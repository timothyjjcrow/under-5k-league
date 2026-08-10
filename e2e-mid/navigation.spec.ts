import { expect, test } from "@playwright/test";

const EXPLORE_LINKS = ["Leaders", "Meta", "Fantasy", "Pick'em"] as const;

test("league tools live under Explore on desktop and mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // A rostered admin produces the most crowded real account cluster: My Team,
  // Admin, profile and logout all render together. This is the state from the
  // reported screenshot, and the one that must fit without a hidden nav scroll.
  await page.goto(
    "/api/auth/dev?name=Navigation%20Stress%20Tester&steamId=76561190000991001&admin=1&redirect=/pickem",
  );

  const desktopPrimary = page.locator(
    'header > div nav[aria-label="Primary"]',
  );
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

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "Open menu" }).click();
  const mobileMenu = page.locator("#mobile-nav");
  const mobileExploreButton = mobileMenu.getByRole("button", {
    name: "Explore",
  });
  await expect(mobileExploreButton).toHaveAttribute("aria-expanded", "false");
  for (const label of EXPLORE_LINKS) {
    await expect(
      mobileMenu.getByRole("link", { name: label, exact: true }),
    ).toHaveCount(0);
  }

  await mobileExploreButton.click();
  const mobileExplore = mobileMenu.getByRole("group", { name: "Explore" });
  for (const label of EXPLORE_LINKS) {
    await expect(
      mobileExplore.getByRole("link", { name: label, exact: true }),
    ).toBeVisible();
  }
});
