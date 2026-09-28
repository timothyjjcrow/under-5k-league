import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// stage.ts leaves one LIVE 1–0 series inside the result window and retimes the
// rest of the open week to three hours from now: a match night in progress.
test("Tonight leads /admin on match night and jumps to each result row", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.goto(
    "/api/auth/dev?name=Tonight+Admin&steamId=76561190000991998&admin=1&redirect=/admin",
  );
  const tonight = page.locator("#adm-tonight");
  await expect(
    tonight.getByRole("heading", { name: "Tonight", level: 2 }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Admin sections" })
      .getByRole("link", { name: "Tonight", exact: true }),
  ).toBeVisible();

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

  const jump = live.getByRole("link", { name: "Result controls ↓" });
  const target = await jump.getAttribute("href");
  expect(target).toMatch(/^#adm-match-/);
  await jump.click();
  const row = page.locator(target!);
  await expect(row).toBeInViewport();
  await expect(row.getByRole("button", { name: "Save ruling" })).toBeVisible();
  await expect(row.getByTestId("auto-check")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "admin tonight");
  noErrors();
});
