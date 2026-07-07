import { test, expect } from "@playwright/test";

// Runs last (zz-*) because it transitions the seeded season into DRAFT, which
// would otherwise break the smoke tests that assume the SIGNUPS phase.

test("admin designates captains, starts the draft, and opens the draft room", async ({
  page,
}) => {
  page.on("dialog", (d) => d.accept()); // accept the confirm() prompts

  await page.goto(
    "/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=/admin",
  );
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();

  // Promote two eligible players to captains.
  await page.getByRole("button", { name: "make captain" }).first().click();
  await expect(page.getByRole("heading", { name: /Captains \(1\)/ })).toBeVisible();
  await page.getByRole("button", { name: "make captain" }).first().click();
  await expect(page.getByRole("heading", { name: /Captains \(2\)/ })).toBeVisible();

  // Start the auction and jump into the draft room.
  await page.getByRole("button", { name: "Start draft" }).click();
  await page.getByRole("link", { name: /draft room/i }).click();

  await expect(page).toHaveURL(/\/draft/);
  await expect(page.getByText(/On the clock/)).toBeVisible();
  await expect(page.getByText(/Available ·/)).toBeVisible();
});
