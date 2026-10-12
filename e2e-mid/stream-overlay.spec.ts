import { test, expect, type Page } from "@playwright/test";
import { trackPageErrors } from "./helpers";

// The casters' OBS overlay (/overlay/<match id>, docs/features/pages-and-ui.md
// "Stream overlay"), on the staged LIVE 1–0 series: reached from the match
// page's folded links, it draws the matchup bar and the player cards, is
// see-through inside OBS, and loads its data once instead of polling the
// server.

async function liveMatchOverlayLinks(page: Page) {
  await page.goto("/schedule");
  await page
    .getByRole("article", { name: / · Live$/ })
    .first()
    .getByRole("link", { name: /^Match page ?: / })
    .click();
  await expect(page).toHaveURL(/\/matches\//);
  const links = page.locator("#match-overlay");
  await links.locator(":scope > summary").click();
  await expect(links).toHaveJSProperty("open", true);
  // Chrome puts a space before the screen-reader suffix (match.spec.ts).
  const preview = (label: string) =>
    links
      .getByRole("link", { name: new RegExp(`^Preview ?: ${label}$`) })
      .getAttribute("href");
  return {
    matchup: (await preview("Matchup bar"))!,
    players: (await preview("Player cards"))!,
    both: (await preview("Both together"))!,
  };
}

test("the match page links an overlay that draws the live matchup", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  const links = await liveMatchOverlayLinks(page);
  expect(links.matchup).toMatch(/^\/overlay\/[\w-]+\?widget=matchup&preview=1$/);
  expect(links.both).toMatch(/^\/overlay\/[\w-]+\?preview=1$/);

  await page.setViewportSize({ width: 1620, height: 250 });
  await page.goto(links.matchup);
  const bar = page.getByRole("region", { name: / versus / });
  await expect(bar).toBeVisible();
  await expect(bar.locator(".ov-score-home")).toHaveText("1");
  await expect(bar.locator(".ov-score-away")).toHaveText("0");
  await expect(bar.getByRole("timer")).toContainText("Live");
  await expect(bar.getByRole("timer")).toContainText(/Game 2 · Bo\d/);
  // Each side names its record and table place.
  await expect(bar.locator(".ov-team-meta")).toHaveCount(2);
  await expect(bar.locator(".ov-team-meta").first()).toHaveText(/^\d+W \d+D \d+L · \d(st|nd|rd|th) of \d$/);
  // The layout the link names fits its own size exactly.
  const box = await bar.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(1620);
  expect(box!.y + box!.height).toBeLessThanOrEqual(250);
  assertNoErrors();
});

test("the player cards show tonight's players with their season", async ({ page }) => {
  const assertNoErrors = trackPageErrors(page);
  const links = await liveMatchOverlayLinks(page);
  await page.setViewportSize({ width: 1020, height: 400 });
  await page.goto(links.players);
  const card = page.getByRole("article").last();
  await expect(card).toBeVisible();
  await expect(card.locator(".ov-card-count")).toHaveText(/^\d \/ 5$/);
  await expect(card.locator(".ov-name")).not.toBeEmpty();
  await expect(card.getByText("Games", { exact: true })).toBeVisible();
  await expect(card.getByText("K / D / A", { exact: true })).toBeVisible();
  // The matchup bar is not part of this layout.
  await expect(page.getByRole("region", { name: / versus / })).toHaveCount(0);
  assertNoErrors();
});

test("inside OBS the page is see-through and asks the server for its data once", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  const links = await liveMatchOverlayLinks(page);
  // OBS's Browser source announces itself with window.obsstudio.
  await page.addInitScript(() => {
    (window as unknown as { obsstudio: object }).obsstudio = { pluginVersion: "2.24.0" };
  });
  const requests: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/")) requests.push(pathname);
  });
  await page.setViewportSize({ width: 1620, height: 650 });
  await page.goto(links.both.replace("?preview=1", ""));
  await expect(page.getByRole("region", { name: / versus / })).toBeVisible();
  await expect(page.getByRole("article").last()).toBeVisible();

  const backgrounds = await page.evaluate(() => [
    getComputedStyle(document.documentElement).backgroundColor,
    getComputedStyle(document.body).backgroundColor,
    document.documentElement.classList.contains("ov-preview"),
  ]);
  expect(backgrounds).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", false]);

  // One status read and one data read; the next only when the version moves.
  expect(requests.filter((p) => p === "/api/sync")).toHaveLength(1);
  const data = requests.filter((p) => p.startsWith("/api/overlay/"));
  expect(data).toHaveLength(1);
  expect(data[0]).toMatch(/^\/api\/overlay\/[\w-]+\/[0-9a-z]+\.[0-9a-z]+$/);
  expect(requests).toHaveLength(2);
  assertNoErrors();
});

test("a link to no match says so in the preview, and draws nothing in OBS", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/overlay/no-such-match?preview=1");
  await expect(page.getByText("No match with this link.")).toBeVisible();
  await expect(page.getByRole("region")).toHaveCount(0);
  assertNoErrors();
});
