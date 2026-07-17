import { test, expect } from "@playwright/test";

// Runs last (zz-*) because it transitions the seeded season into DRAFT, which
// would otherwise break the smoke tests that assume the SIGNUPS phase.

test("admin designates captains, starts the draft, and opens the draft room", async ({
  page,
  browser,
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

  // Move the season into DRAFT without starting the auction: /draft must be
  // a live waiting room for players, not a static dead end.
  await page.getByRole("button", { name: "Draft", exact: true }).click();
  // The header nav gains "Teams" only once the season is in DRAFT — a
  // reliable signal that the phase move committed before we proceed.
  await expect(
    page
      .getByLabel("Primary")
      .getByRole("link", { name: "Teams", exact: true })
      .first(),
  ).toBeVisible();

  const playerContext = await browser.newContext();
  const playerPage = await playerContext.newPage();
  await playerPage.goto(
    "/api/auth/dev?name=Draft+Watcher&steamId=76561190000000077&redirect=/draft",
  );
  await expect(
    playerPage.getByText("Waiting for the admin to start the auction"),
  ).toBeVisible();
  // First-time draftees get the rules up front, with real timer numbers.
  await expect(
    playerPage.getByText("How the auction works"),
  ).toBeVisible();
  await expect(
    playerPage.getByText(/Every bid resets the 30s clock/),
  ).toBeVisible();
  // Non-admins must NOT be pointed at the admin panel (it bounces them home).
  await expect(
    playerPage.getByRole("link", { name: /admin panel/i }),
  ).toHaveCount(0);

  // Start the auction and jump into the draft room.
  await page.getByRole("button", { name: "Start draft" }).click();
  await page.getByRole("link", { name: /draft room/i }).click();

  // The parked player's page flips live via its own poll — NO reload.
  await expect(playerPage.getByText(/Available ·/)).toBeVisible({
    timeout: 15_000,
  });
  await playerContext.close();

  await expect(page).toHaveURL(/\/draft/);
  await expect(page.getByText(/On the clock/)).toBeVisible();
  await expect(page.getByText(/Available ·/)).toBeVisible();
  // The auction has the same persisted sound toggle as the inhouse room.
  await expect(page.getByRole("button", { name: /Sound on|Muted/ })).toBeVisible();

  // Back on the admin panel the draft is locked: no re-run button (a re-run
  // would reset budgets over drafted rosters), no captain management — just
  // the way into the live room.
  await page.goto("/admin");
  await expect(page.getByRole("link", { name: /draft room/i })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start draft" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "make captain" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Randomize order" }),
  ).toHaveCount(0);
});
