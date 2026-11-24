import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// stage.ts leaves one LIVE 1–0 series inside the result window and retimes the
// rest of the open week to three hours from now: a match night in progress.
test("Tonight leads Overview on match night and opens each result row on Matches", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.goto(
    "/api/auth/dev?name=Tonight+Admin&steamId=76561190000994002&admin=1&redirect=/admin",
  );
  const tonight = page.locator("#adm-tonight");
  await expect(
    tonight.getByRole("heading", { name: "Tonight", level: 2 }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Admin sections" })
      .getByRole("link", { name: "Overview", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  const rows = tonight.getByTestId("admin-tonight-match");
  const live = rows.filter({ hasText: "Live · 1–0" });
  await expect(live).toHaveCount(1);
  // The staged season has a league ticket; a LIVE series is scanned at once.
  await expect(live.getByTestId("auto-check")).toContainText(
    "player-account check",
  );
  // The rest of the open week kicks off later tonight.
  await expect(
    rows.filter({ hasText: "First automatic check" }).first(),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "admin tonight");

  // The row's controls are on Matches, inside its folded week.
  const jump = live.getByRole("link", { name: "Result controls →" });
  const target = await jump.getAttribute("href");
  expect(target).toMatch(/^\/admin\/matches#adm-match-/);
  await jump.click();
  await expect(page).toHaveURL(new RegExp(`${target!.replace(/[/#]/g, "\\$&")}$`));
  const row = page.locator(`#${target!.split("#")[1]}`);
  await expect(row).toBeInViewport();
  await expect(row.getByRole("button", { name: "Save ruling" })).toBeVisible();
  await expect(row.getByTestId("auto-check")).toBeVisible();
  noErrors();
});

test("Needs attention titles itself by count and links each line to its section", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.goto(
    "/api/auth/dev?name=Tonight+Admin&steamId=76561190000994002&admin=1&redirect=/admin",
  );
  const card = page.locator("#adm-attention");
  await expect(card.getByRole("heading", { level: 2 })).toHaveText(
    /: (all clear|1 thing needs attention|\d+ things need attention)$/,
  );
  await expect(card).not.toContainText("match-night checklist");
  const hrefs = await card
    .locator('a[href*="#adm-"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(hrefs.length).toBeGreaterThan(0);
  // Each line opens its card, or a match's own row (#adm-match-<id>), on
  // the tab that renders it.
  for (const href of new Set(hrefs)) {
    expect(href).toMatch(/^\/admin(\/[a-z]+)?#adm-[a-z0-9-]+$/);
    await page.goto(href!);
    await expect(page.locator(`#${href!.split("#")[1]}`), href!).toHaveCount(1);
  }
  noErrors();
});
