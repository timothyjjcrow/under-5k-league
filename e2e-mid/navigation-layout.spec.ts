import { PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";

// This suite owns this exact local fixture database. Exercise every header
// state on an evergreen page, then restore the season for the other specs.
const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
const displayName = "Navigation Stress Tester With a Very Long Display Name";
const desktopWidths = [1024, 1100, 1279, 1280, 1440, 1920];
let season: { id: string; status: string; isActive: boolean };
let archiveId: string;

test.beforeAll(async () => {
  season = await db.season.findFirstOrThrow({
    where: { isActive: true },
    select: { id: true, status: true, isActive: true },
  });
  const archive = await db.season.create({
    data: {
      name: "Navigation history fixture",
      status: "COMPLETE",
      isActive: false,
    },
  });
  archiveId = archive.id;
});

test.beforeEach(async ({ page }) => {
  await db.season.update({
    where: { id: season.id },
    data: { status: "REGULAR_SEASON", isActive: true },
  });
  // Direct fixture writes bypass the season commands' public revision stamp.
  // Expire the previous fixture before asserting archived-season navigation.
  expect((await page.request.post("/api/test/cache")).ok()).toBe(true);
  await page.goto(
    `/api/auth/dev?name=${encodeURIComponent(displayName)}&steamId=76561190000991001&admin=1&redirect=/features`,
  );
});

test.afterAll(async ({ request }) => {
  try {
    if (season) {
      await db.season.update({
        where: { id: season.id },
        data: { status: season.status, isActive: season.isActive },
      });
    }
    if (archiveId) await db.season.delete({ where: { id: archiveId } });
    expect((await request.post("/api/test/cache")).ok()).toBe(true);
  } finally {
    await db.$disconnect();
  }
});

async function expectHeaderFits(page: Page) {
  const headerRow = page.getByRole("banner").locator(":scope > div");
  const issues = await headerRow.evaluate((row) => {
    const controls = [...row.querySelectorAll("a, button")]
      .map((element) => ({
        label:
          element.getAttribute("aria-label") || element.textContent?.trim(),
        rect: element.getBoundingClientRect(),
        clipped: element.scrollWidth > element.clientWidth + 1,
      }))
      .filter(({ rect }) => rect.width && rect.height);
    const problems: string[] = [];
    const bounds = row.getBoundingClientRect();
    for (const [index, control] of controls.entries()) {
      if (
        control.rect.left < 0 ||
        control.rect.right > innerWidth ||
        control.clipped
      ) {
        problems.push(`Clipped: ${control.label}`);
      }
      if (
        control.rect.top < bounds.top ||
        control.rect.bottom > bounds.bottom
      ) {
        problems.push(`Outside the header: ${control.label}`);
      }
      for (const other of controls.slice(index + 1)) {
        if (
          control.rect.left < other.rect.right &&
          control.rect.right > other.rect.left &&
          control.rect.top < other.rect.bottom &&
          control.rect.bottom > other.rect.top
        ) {
          problems.push(`Overlapping: ${control.label} / ${other.label}`);
        }
      }
    }
    return problems;
  });
  expect(issues).toEqual([]);
  await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
  await expect(
    page.getByRole("navigation", { name: "Quick navigation" }),
  ).toBeHidden();
  await expect(page.locator("body")).toHaveCSS("padding-bottom", "0px");
}

async function expectPanelFits(panel: Locator) {
  await expect(panel).toBeVisible();
  const bounds = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width: innerWidth,
      height: innerHeight,
      overflow: element.scrollWidth - element.clientWidth,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(12);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width - 12);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  expect(bounds.overflow).toBeLessThanOrEqual(1);
}

for (const phase of [
  null,
  "SIGNUPS",
  "DRAFT",
  "REGULAR_SEASON",
  "PLAYOFFS",
  "COMPLETE",
]) {
  test(`desktop navigation fits with history and a rostered admin: ${phase ?? "OFFSEASON"}`, async ({
    page,
  }) => {
    await db.season.update({
      where: { id: season.id },
      data: { status: phase ?? season.status, isActive: phase !== null },
    });
    await page.goto("/features");

    for (const width of desktopWidths) {
      await test.step(`${width}px`, async () => {
        await page.setViewportSize({ width, height: 800 });
        await expectHeaderFits(page);
        const exploreButton = page.getByRole("button", {
          name: "Explore",
          exact: true,
        });
        await exploreButton.click();
        const explore = page.getByRole("navigation", {
          name: "Explore",
          exact: true,
        });
        await expectPanelFits(explore);
        await expect(
          explore.getByRole("link", { name: "Past seasons" }),
        ).toBeVisible();
        await expect(
          explore.getByRole("link", { name: "Feature tour" }),
        ).toHaveAttribute("aria-current", "page");
        await page.keyboard.press("Escape");
        await expect(exploreButton).toBeFocused();

        const accountButton = page.getByRole("button", {
          name: `Account — ${displayName}`,
        });
        await accountButton.click();
        const account = page.getByRole("navigation", {
          name: "Account",
          exact: true,
        });
        await expectPanelFits(account);
        await expect(
          account.getByRole("link", { name: "Admin", exact: true }),
        ).toBeVisible();
        await expect(
          account.getByRole("link", { name: "My profile", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(accountButton).toBeFocused();
      });
    }
  });
}

test("desktop disclosures work by keyboard, dismiss each other, and follow links", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const exploreButton = page.getByRole("button", {
    name: "Explore",
    exact: true,
  });
  const accountButton = page.getByRole("button", {
    name: `Account — ${displayName}`,
  });
  const account = page.getByRole("navigation", {
    name: "Account",
    exact: true,
  });
  const explore = page.getByRole("navigation", {
    name: "Explore",
    exact: true,
  });

  await exploreButton.focus();
  await page.keyboard.press("Enter");
  await expect(explore).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    explore.getByRole("link", { name: "Scrims", exact: true }),
  ).toBeFocused();
  await accountButton.click();
  await expect(account).toBeVisible();
  await expect(explore).toHaveCount(0);
  await exploreButton.click();
  await expect(account).toHaveCount(0);
  await expect(explore).toBeVisible();
  await explore.getByRole("link", { name: "Feature tour" }).click();
  await expect(explore).toHaveCount(0);

  await accountButton.click();
  await page.locator("h1").click();
  await expect(account).toHaveCount(0);
  await accountButton.click();
  await account.getByRole("link", { name: "My profile" }).click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(account).toHaveCount(0);

  await page.goto("/players/compare");
  const primary = page.locator('header > div nav[aria-label="Primary"]');
  await expect(
    primary.getByRole("link", { name: "Players", exact: true }),
  ).not.toHaveAttribute("aria-current", "page");
  await exploreButton.click();
  await expect(
    explore.getByRole("link", { name: "Compare players" }),
  ).toHaveAttribute("aria-current", "page");
});

test("switching layouts clears hidden panels and keeps phone navigation reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.setViewportSize({ width: 1023, height: 768 });
  await expect(page.locator("#desktop-explore-nav")).toHaveCount(0);
  await page.goto("/");

  for (const width of [320, 375, 768, 1023]) {
    await page.setViewportSize({ width, height: 812 });
    const menuButton = page.getByRole("button", { name: "Open menu" });
    await menuButton.click();
    const menu = page.locator("#mobile-nav");
    const merch = menu.getByRole("link", { name: /Merch/ });
    await expect(merch).toBeVisible();
    await expect(merch).toHaveCSS("min-height", "44px");
    await menu.getByRole("link", { name: "Home", exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Quick navigation" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  }

  await page
    .getByRole("button", { name: "Explore league", exact: true })
    .click();
  await expect(page.locator("#mobile-discovery")).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator("#mobile-discovery")).toHaveCount(0);
  await expectHeaderFits(page);
  await page.getByRole("button", { name: `Account — ${displayName}` }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator("#desktop-account-nav")).toHaveCount(0);
  await expect(page.locator("#mobile-nav")).toHaveCount(0);
});

test("signed-out desktop and merch stay usable at the laptop breakpoint", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  await expectHeaderFits(page);
  await expect(
    page.getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expectPanelFits(
    page.getByRole("navigation", { name: "Explore", exact: true }),
  );
  await page.keyboard.press("Escape");

  // Assert the new-tab flow without making CI depend on Fourthwall uptime.
  await context.route("https://ggd2l-shop.fourthwall.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>GGD2L shop</title>",
    }),
  );
  const popupReady = page.waitForEvent("popup");
  await page.locator("header").getByRole("link", { name: /Merch/ }).click();
  const shop = await popupReady;
  await expect(shop).toHaveURL("https://ggd2l-shop.fourthwall.com/");
  await expect(page).toHaveURL("http://localhost:3212/");
  await shop.close();
});
