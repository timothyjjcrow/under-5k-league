import { test, expect } from "@playwright/test";

// Runs last (zz-*) because it transitions the seeded season into DRAFT, which
// would otherwise break the smoke tests that assume the SIGNUPS phase.

test("admin runs draft night: captains nominate, bid, and get outbid in the browser", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  page.on("dialog", (d) => d.accept()); // accept the confirm() prompts

  // Two KNOWN captains-to-be register while signups are open — so the live
  // auction below can be driven from their own browser sessions.
  const capOne = await browser.newContext();
  const capOnePage = await capOne.newPage();
  await capOnePage.goto(
    "/api/auth/dev?name=Cap+One&steamId=76561190000003001&redirect=/me",
  );
  await capOnePage.getByLabel("Dota 2 MMR").fill("3500");
  await capOnePage
    .getByRole("button", { name: /Join the season|Update signup/ })
    .click();
  await expect(capOnePage.getByText("Playing").first()).toBeVisible();

  const capTwo = await browser.newContext();
  const capTwoPage = await capTwo.newPage();
  await capTwoPage.goto(
    "/api/auth/dev?name=Cap+Two&steamId=76561190000003002&redirect=/me",
  );
  await capTwoPage.getByLabel("Dota 2 MMR").fill("3200");
  await capTwoPage
    .getByRole("button", { name: /Join the season|Update signup/ })
    .click();
  await expect(capTwoPage.getByText("Playing").first()).toBeVisible();

  await page.goto(
    "/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=/admin",
  );
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();

  // Promote exactly OUR two players to captains (Cap One first → they get
  // draft order 0 and the opening nomination). Rows are divs in the
  // "Eligible players" scroller.
  await page
    .locator(".max-h-80 div.rounded-lg", { hasText: "Cap One" })
    .getByRole("button", { name: "make captain" })
    .click();
  await expect(page.getByRole("heading", { name: /Captains \(1\)/ })).toBeVisible();
  await page
    .locator(".max-h-80 div.rounded-lg", { hasText: "Cap Two" })
    .getByRole("button", { name: "make captain" })
    .click();
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
  await expect(playerPage.getByText("How the auction works")).toBeVisible();
  await expect(
    playerPage.getByText(/Every bid resets the 30s clock/),
  ).toBeVisible();
  // Non-admins must NOT be pointed at the admin panel (it bounces them home).
  await expect(
    playerPage.getByRole("link", { name: /admin panel/i }),
  ).toHaveCount(0);

  // Park both captains on /draft BEFORE the start — their pages must flip
  // live via their own polls, no reload.
  await capOnePage.goto("/draft");
  await capTwoPage.goto("/draft");
  await expect(
    capOnePage.getByText("Waiting for the admin to start the auction"),
  ).toBeVisible();

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

  // --- The live auction, driven from the captains' own browsers ------------

  // Cap One (draft order 0) is on the clock: pick Topson from the pool and
  // nominate at the default opening $1.
  await expect(capOnePage.getByText("You're on the clock")).toBeVisible({
    timeout: 15_000,
  });
  await capOnePage
    .locator("#player-pool")
    .getByRole("button", { name: /Topson/ })
    .click();
  await capOnePage.getByRole("button", { name: "Nominate", exact: true }).click();
  await expect(capOnePage.getByText("You hold the high bid.")).toBeVisible();

  // Cap Two sees the lot and raises via the quick-bid stepper (which shows
  // the absolute amount it will submit).
  await expect(capTwoPage.getByText(/high bid|opening/).first()).toBeVisible();
  await capTwoPage
    .getByRole("button", { name: /Bid \$2/ })
    .first()
    .click();
  await expect(capTwoPage.getByText("You hold the high bid.")).toBeVisible();

  // Cap One gets the outbid alarm with a one-tap re-bid…
  await expect(capOnePage.getByText("💸 Outbid!")).toBeVisible({
    timeout: 10_000,
  });
  await capOnePage.getByRole("button", { name: /Re-bid \$3/ }).click();
  // …and takes the high bid back. The lot's bid trail is on show for everyone.
  await expect(capOnePage.getByText("You hold the high bid.")).toBeVisible();
  await expect(capOnePage.getByText("Bid trail:")).toBeVisible();

  await capOne.close();
  await capTwo.close();

  // Back on the admin panel the draft is locked: no re-run button (a re-run
  // would reset budgets over drafted rosters), no captain management — just
  // the way into the live room, plus the night-of controls.
  await page.goto("/admin");
  await expect(page.getByRole("link", { name: /draft room/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start draft" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "make captain" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Randomize order" }),
  ).toHaveCount(0);
  // The draft-night recovery controls are available while the auction runs.
  await expect(page.getByRole("button", { name: "Pause auction" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Undo last sale" }),
  ).toBeVisible();
});
