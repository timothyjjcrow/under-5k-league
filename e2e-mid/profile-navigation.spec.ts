import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

test("team sections jump to the roster and retain the team in its schedule link", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/teams");
  await page.locator('#main a[href^="/teams/"]').first().click();
  await expect(page).toHaveURL(/\/teams\/[^/]+$/);
  const teamId = new URL(page.url()).pathname.split("/").pop();
  const sections = page.getByRole("navigation", { name: "Team sections" });
  await sections.getByRole("link", { name: "Roster", exact: true }).click();
  await expect(page).toHaveURL(/#team-roster$/);
  await expect(page.locator("#team-roster h2").first()).toBeFocused();
  await sections.getByRole("link", { name: "Matches", exact: true }).click();
  await expect(page.locator("#team-matches h2").first()).toBeFocused();
  await expectNoHorizontalOverflow(page, "team sections");
  await page
    .getByRole("link", { name: "Team schedule →", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/schedule\\?team=${teamId}#fixtures$`),
  );
  assertNoErrors();
});

test("player match history has a reloadable section link without changing career scope", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/players");
  await page
    .locator('#main a[href^="/players/"]:not([href*="compare"])')
    .first()
    .click();
  const sections = page.getByRole("navigation", { name: "Player sections" });
  await sections.getByRole("link", { name: "Matches", exact: true }).click();
  await expect(page).toHaveURL(/#player-matches$/);
  await expect(
    page.getByRole("heading", { name: "Match history", exact: true }),
  ).toBeFocused();
  await page.reload();
  await expect(page.locator("#player-matches h2")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("#player-matches")
        .evaluate((element) => Math.round(element.getBoundingClientRect().top)),
    )
    .toBeGreaterThanOrEqual(80);
  await expect
    .poll(() =>
      page
        .locator("#player-matches")
        .evaluate((element) => Math.round(element.getBoundingClientRect().top)),
    )
    .toBeLessThan(684);
  await expectNoHorizontalOverflow(page, "player sections");
  await sections.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /^(Season|Career) form$/ }),
  ).toBeFocused();
  assertNoErrors();
});
