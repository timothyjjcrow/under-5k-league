import { test, expect } from "@playwright/test";

test("home shows the signups phase for the seeded season", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Season 1" })).toBeVisible();
  // The phase badge appears in the hero and the footer — scope to main.
  await expect(
    page.locator("#main").getByText("Signups open", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/players to start/)).toBeVisible();
});

test("a new player can sign in and join the season", async ({ page }) => {
  const name = `E2E Player ${Date.now()}`;
  const steamId = "7656119" + String(Date.now()).slice(-10);

  // Dev login (mock Steam) and land on the profile page.
  await page.goto(
    `/api/auth/dev?name=${encodeURIComponent(name)}&steamId=${steamId}&redirect=/me`,
  );
  await expect(page.getByRole("heading", { name: "Your profile" })).toBeVisible();

  await page.getByLabel("Dota 2 MMR").fill("3500");
  await page.getByRole("button", { name: /Join the season|Update signup/ }).click();

  // Confirmed signed up.
  await expect(page.getByText("Playing").first()).toBeVisible();

  // A player with an active signup but no imported league games gets an
  // honest, useful public-profile starting state instead of a blank stat area.
  await page.getByRole("link", { name: "View public profile →" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ready for the first game" }),
  ).toBeVisible();

  // And visible on the home dashboard's signup list (scoped to main content,
  // since the name also appears in the header nav).
  await page.goto("/");
  await expect(page.getByRole("main").getByText(name)).toBeVisible();
});

test("a player can link their Dota account on their profile", async ({
  page,
}) => {
  const steamId = "765611980" + String(Date.now()).slice(-8);
  await page.goto(
    `/api/auth/dev?name=Linker&steamId=${steamId}&redirect=/me`,
  );
  await expect(
    page.getByRole("heading", { name: "Dota / Dotabuff account" }),
  ).toBeVisible();
  await page
    .getByPlaceholder("Dotabuff/OpenDota URL or account id")
    .fill("70388657");
  await page.getByRole("button", { name: /Link/ }).click();
  await expect(page.getByText("(manual)")).toBeVisible();
});

test("admin sees the league control panel", async ({ page }) => {
  await page.goto(
    "/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=/admin",
  );
  // exact: the panel also has a "Recent admin activity" heading, and a loose
  // match resolves to both under strict mode.
  await expect(
    page.getByRole("heading", { name: "Admin", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("phase control")).toBeVisible();
  await expect(page.getByText("Create a new season")).toBeVisible();
});

test("a player confirms the draft schedule and admin sees the readiness change", async ({
  page,
  browser,
}) => {
  const name = `Draft Ready ${Date.now()}`;
  const steamId = "7656118" + String(Date.now()).slice(-10);

  // Schedule draft night from the real admin form. The datetime-local helper
  // converts this browser-local value to the epoch the confirmation action
  // later binds to its revision.
  await page.goto(
    "/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=/admin",
  );
  await page.getByLabel(/Draft night/).fill("2026-08-15T18:00");
  await page.getByRole("button", { name: "Set draft night" }).click();
  await expect(page.getByText(/0\/\d+ ready/)).toBeVisible();

  const playerContext = await browser.newContext();
  const playerPage = await playerContext.newPage();
  await playerPage.goto(
    `/api/auth/dev?name=${encodeURIComponent(name)}&steamId=${steamId}&redirect=/me`,
  );
  await playerPage.getByLabel("Dota 2 MMR").fill("3100");
  await playerPage
    .getByRole("button", { name: /Join the season|Update signup/ })
    .click();
  await expect(playerPage.getByText("Playing").first()).toBeVisible();
  await expect(
    playerPage.getByRole("button", { name: "Confirm I’m ready for draft" }),
  ).toBeVisible();

  await playerPage
    .getByRole("button", { name: "Confirm I’m ready for draft" })
    .click();
  await expect(
    playerPage.getByText("Ready for draft ✓", { exact: true }),
  ).toBeVisible();

  await page.reload();
  const playerRow = page
    .locator(".max-h-80 div.rounded-lg", { hasText: name })
    .first();
  await expect(playerRow.getByText("ready ✓", { exact: true })).toBeVisible();

  // Moving the date must invalidate the old acknowledgement rather than
  // leaving a misleading permanent ready flag.
  await page.getByLabel(/Draft night/).fill("2026-08-15T19:00");
  await page.getByRole("button", { name: "Update draft night" }).click();
  await expect(
    page
      .locator(".max-h-80 div.rounded-lg", { hasText: name })
      .first()
      .getByText("reconfirm", { exact: true }),
  ).toBeVisible();

  await playerPage.reload();
  await expect(playerPage.getByText("Reconfirmation required")).toBeVisible();
  await expect(
    playerPage.getByRole("button", { name: "Confirm updated draft time" }),
  ).toBeVisible();
  await playerContext.close();
});

test("typed confirmation actually removes a designated captain", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(
    "/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=/admin",
  );

  const dendiRow = page.locator(".max-h-80 div.rounded-lg", {
    hasText: "Dendi",
  });
  await dendiRow.getByRole("button", { name: "make captain" }).click();
  await expect(
    page.getByRole("heading", { name: "Captains (1)" }),
  ).toBeVisible();

  const captainSection = page
    .getByRole("heading", { name: "Captains (1)" })
    .locator("..");
  await captainSection
    .getByRole("button", { name: "remove", exact: true })
    .click();
  const confirmation = page.getByRole("dialog");
  await confirmation.locator("input").fill("Dendi's Team");
  await confirmation
    .getByRole("button", { name: "remove", exact: true })
    .click();

  await expect(
    page.getByRole("heading", { name: "Captains (0)" }),
  ).toBeVisible();
  await expect(page.getByText("Dendi's Team", { exact: true })).toHaveCount(0);
});

test("non-admin is redirected away from admin", async ({ page }) => {
  const steamId = "7656119" + String(Date.now() + 1).slice(-10);
  await page.goto(
    `/api/auth/dev?name=Regular&steamId=${steamId}&redirect=/admin`,
  );
  // Redirected to home (no admin heading). Relative → resolved via baseURL.
  await expect(page).toHaveURL("/");
});
