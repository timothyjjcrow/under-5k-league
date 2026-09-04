import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { MID_DB_URL } from "../playwright.midseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

test("phone dock opens league tools in one tap and keeps feedback clear", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    "/api/auth/dev?name=Flow+Captain&steamId=76561190000991001&redirect=/schedule",
  );
  const dock = page.getByRole("navigation", { name: "Quick navigation" });
  await expect(
    dock.getByRole("link", { name: "My Team", exact: true }),
  ).toBeVisible();
  await expect(
    dock.getByRole("link", { name: "Matches", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  for (const target of await dock.locator("a, button").all()) {
    const bounds = (await target.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.width).toBeGreaterThanOrEqual(44);
  }
  const exploreButton = dock.getByRole("button", { name: "Explore league" });
  await exploreButton.click();
  const explore = page.getByRole("navigation", {
    name: "Explore league",
    exact: true,
  });
  await expect(
    explore.getByRole("link", { name: "Leaders", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(explore).toHaveCount(0);
  await expect(exploreButton).toBeFocused();
  await exploreButton.click();
  await explore.getByRole("link", { name: "Meta", exact: true }).click();
  await expect(page).toHaveURL(/\/meta$/);
  await expect(explore).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("ld2l-toast", {
        detail: { type: "success", message: "Navigation feedback check" },
      }),
    ),
  );
  const toast = page
    .getByRole("status")
    .filter({ hasText: "Navigation feedback check" });
  await expect(toast).toBeVisible();
  const toastBounds = (await toast.boundingBox())!;
  expect(toastBounds.y + toastBounds.height).toBeLessThan(
    (await dock.boundingBox())!.y,
  );
  await expectNoHorizontalOverflow(page, "mobile dock and Explore");
  // Global team navigation should not pretend a content row was clicked.
  await page.goto("/teams?view=flow-check");
  await dock.getByRole("link", { name: "My Team", exact: true }).click();
  await expect(page.locator("#main a[data-context-back]")).toHaveAttribute(
    "href",
    "/teams",
  );
  // A short landscape screen still leaves the bottom menu controls reachable.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole("button", { name: "Open menu" }).click();
  const menuBounds = (await page.locator("#mobile-nav").boundingBox())!;
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(
    (await dock.boundingBox())!.y,
  );
  noErrors();
});

test("match return restores an opened past week and the clicked scoreboard position", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/schedule?team=all");
  const week = page.getByRole("button", { name: "Week 1", exact: true });
  await expect(week).toHaveAttribute("aria-expanded", "false");
  await week.click();
  await expect(page).toHaveURL(/weeks=1/);
  const details = page
    .getByRole("article", { name: / · Final$/ })
    .first()
    .getByRole("link", { name: "details →" });
  await details.evaluate((link) =>
    window.scrollTo({
      top: window.scrollY + link.getBoundingClientRect().top - 350,
      behavior: "instant",
    }),
  );
  const anchorTop = (await details.boundingBox())!.y;
  const href = await details.getAttribute("href");
  const listUrl = page.url();
  await details.click();
  await expect(page).toHaveURL(/\/matches\//);
  const back = page.locator("#main a[data-context-back]");
  await expect(back).toHaveAttribute(
    "href",
    new URL(listUrl).pathname + new URL(listUrl).search,
  );
  await back.click();
  await expect(page).toHaveURL(listUrl);
  await expect(week).toHaveAttribute("aria-expanded", "true");
  const restored = page
    .locator(`#fixtures a[href="${href}"]`)
    .filter({ hasText: "details →" })
    .first();
  await expect(restored).toBeFocused();
  expect(Math.abs((await restored.boundingBox())!.y - anchorTop)).toBeLessThan(
    12,
  );
  noErrors();
});

test("player return keeps the searched directory and direct visits retain a safe fallback", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  // Mid-season fixtures contain rosters but no full-player registrations.
  // Stage one directory entry only in this disposable DB, then remove it.
  const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
  const member = await db.teamMember.findFirstOrThrow({
    where: {
      season: { isActive: true },
      user: { registrations: { none: {} } },
    },
    include: { user: true },
  });
  const registration = await db.registration.create({
    data: {
      userId: member.userId,
      seasonId: member.seasonId,
      mmr: 2500,
      roles: "1",
    },
  });
  try {
    await page.goto("/players?sort=name");
    const name = member.user.name;
    const href = `/players/${member.userId}`;
    await page.getByPlaceholder("Search players…").fill(name);
    // Click before the 250ms URL debounce: the return link must still retain
    // the visible search, not the earlier unfiltered directory.
    await page
      .locator(`#main li a[href="${href}"]`)
      .filter({ hasText: name })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(href));
    const back = page.getByRole("link", { name: "← All players", exact: true });
    await expect(back).toHaveAttribute("href", /[?&]q=/);
    const returnUrl = new URL((await back.getAttribute("href"))!, page.url());
    expect(returnUrl.searchParams.get("q")).toBe(name);
    expect(returnUrl.searchParams.get("sort")).toBe("name");
    await back.click();
    await expect(page.getByPlaceholder("Search players…")).toHaveValue(name);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(href);
    await expect(back).toHaveAttribute("href", "/players");
    noErrors();
  } finally {
    await db.registration.delete({ where: { id: registration.id } });
    await db.$disconnect();
  }
});
