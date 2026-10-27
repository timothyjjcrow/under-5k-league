import { test, expect } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  expectOneRoomPollAtATime,
  recordRoomPolls,
  trackPageErrors,
} from "../e2e-mid/helpers";

// Runs last (zz-*) because it transitions the seeded season into DRAFT, which
// would otherwise break the smoke tests that assume the SIGNUPS phase.

test("admin runs draft night: captains nominate, bid, and get outbid in the browser", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  page.on("dialog", (d) => d.accept()); // accept the confirm() prompts
  // Every page this spec opens must finish with zero uncaught client errors.
  const assertAdminErrors = trackPageErrors(page);

  // Two KNOWN captains-to-be register while signups are open — so the live
  // auction below can be driven from their own browser sessions.
  const capOne = await browser.newContext();
  await recordRoomPolls(capOne, "/api/draft/tick");
  const capOnePage = await capOne.newPage();
  const assertCapOneErrors = trackPageErrors(capOnePage);
  await capOnePage.goto(
    "/api/auth/dev?name=Cap+One&steamId=76561190000003001&redirect=/me",
  );
  await capOnePage.getByLabel("Dota 2 MMR").fill("3500");
  await capOnePage
    .getByRole("button", { name: /Join the season|Update signup/ })
    .click();
  await expect(capOnePage.getByText("Playing").first()).toBeVisible();

  const capTwo = await browser.newContext();
  await recordRoomPolls(capTwo, "/api/draft/tick");
  const capTwoPage = await capTwo.newPage();
  const assertCapTwoErrors = trackPageErrors(capTwoPage);
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
  // exact: the panel also has a "Recent admin activity" heading, and a loose
  // match resolves to both under strict mode.
  await expect(
    page.getByRole("heading", { name: "Admin", exact: true }),
  ).toBeVisible();

  // Promote exactly OUR two players to captains (Cap One first → they get
  // draft order 0 and the opening nomination). Rows are the items of the
  // "Eligible players" list.
  await page
    .getByRole("list", { name: "Eligible players" })
    .getByRole("listitem")
    .filter({ hasText: "Cap One" })
    .getByRole("button", { name: "make captain" })
    .click();
  await expect(
    page.getByRole("heading", { name: /Captains \(1\)/ }),
  ).toBeVisible();
  await page
    .getByRole("list", { name: "Eligible players" })
    .getByRole("listitem")
    .filter({ hasText: "Cap Two" })
    .getByRole("button", { name: "make captain" })
    .click();
  await expect(
    page.getByRole("heading", { name: /Captains \(2\)/ }),
  ).toBeVisible();

  // Close signups moves the season into DRAFT without starting the auction:
  // /draft must be a live waiting room for players, not a static dead end.
  await page.getByRole("button", { name: "Close signups", exact: true }).click();
  // The header nav gains "Teams" only once the season is in DRAFT — a
  // reliable signal that the phase move committed before we proceed.
  await expect(
    page
      .getByLabel("Primary")
      .getByRole("link", { name: "Teams", exact: true })
      .first(),
  ).toBeVisible();

  // DRAFT is the league chapter, not proof that the auction is already live.
  // Before Start draft, the dashboard must say setup/waiting rather than tell
  // every visitor that captains are actively bidding.
  await page.goto("/");
  // The phase badge appears in the hero and the footer — scope to main.
  await expect(
    page.locator("#main").getByText("Draft setup", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/draft is being prepared/i)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View the draft room →" }),
  ).toBeVisible();
  await page.goto("/admin");

  const playerContext = await browser.newContext();
  const playerPage = await playerContext.newPage();
  const assertWatcherErrors = trackPageErrors(playerPage);
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
  // The header chip is the root layout's render, which the room's poll never
  // repeats. Parked here before Start, it names the phase as it is now…
  const parkedChip = (label: string) =>
    playerPage
      .getByRole("banner")
      .getByRole("link", {
        name: new RegExp(`^League status: .+ — ${label}$`),
      });
  await expect(parkedChip("Draft setup")).toBeVisible();

  // Park both captains on /draft BEFORE the start — their pages must flip
  // live via their own polls, no reload.
  await capOnePage.goto("/draft");
  await capTwoPage.goto("/draft");
  await expect(
    capOnePage.getByText("Waiting for the admin to start the auction"),
  ).toBeVisible();

  // Start the auction from the draft room's waiting room: an admin gets the
  // same Start draft button as /admin (same action, same confirm), and the
  // team cards show the opening nomination order (Cap One was made captain
  // first, so they open).
  await page.goto("/draft");
  await expect(
    page.getByText("Waiting for the admin to start the auction"),
  ).toBeVisible();
  const rosterCards = page.locator('section[aria-label="Team rosters"] > div');
  await expect(
    rosterCards.filter({ hasText: "Cap One" }).getByText("Nominates 1st"),
  ).toBeVisible();
  await expect(
    rosterCards.filter({ hasText: "Cap Two" }).getByText("Nominates 2nd"),
  ).toBeVisible();
  // Both captains are parked on /draft, so their own polls mark them as in
  // the room: the admin sees it above Start draft and on each team card.
  await expect(
    page.getByText("All 2 captains are in the draft room."),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    rosterCards
      .filter({ hasText: "Cap One" })
      .getByText("in room", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Captains & draft setup on the admin panel" }),
  ).toHaveAttribute("href", "/admin#adm-captains");
  await page.getByRole("button", { name: "Start draft" }).click();

  // The parked player's page flips live via its own poll — NO reload.
  await expect(playerPage.getByText(/Available ·/)).toBeVisible({
    timeout: 15_000,
  });
  // …and so does its header. REGRESSION: the chip kept the pre-Start phase
  // through the whole auction; the room now refreshes the layout's render
  // once when its poll sees the auction status move (draftRoomNeedsRefresh).
  await expect(parkedChip("Draft live")).toBeVisible({ timeout: 15_000 });
  await expect(parkedChip("Draft live")).toHaveAttribute("href", "/draft");
  // Every page loaded from now on says the auction is live in its header,
  // and the chip opens the draft room.
  await playerPage.goto("/news");
  await expect(
    playerPage
      .getByRole("banner")
      .getByRole("link", { name: /^League status: .+ — Draft live$/ }),
  ).toHaveAttribute("href", "/draft");
  assertWatcherErrors();
  await playerContext.close();

  await expect(page).toHaveURL(/\/draft/);
  await expect(page.getByText(/On the clock/)).toBeVisible();
  await expect(page.getByText(/Available ·/)).toBeVisible();
  // Admin recovery travels with the live room; an operator should not have to
  // leave the clock to pause or correct the auction.
  await expect(
    page.getByRole("button", { name: "Pause auction" }),
  ).toBeVisible();
  // The room's admin bar shows only buttons that work right now: nothing has
  // sold yet, so there is no Undo, and the full set is one link away.
  await expect(
    page.getByRole("button", { name: "Undo last sale" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "More controls" }),
  ).toHaveAttribute("href", "/admin#adm-captains");

  // --- The live auction, driven from the captains' own browsers ------------

  // Cap One (draft order 0) is on the clock: pick Topson from the pool and
  // nominate at the default opening $1.
  await expect(capOnePage.getByText("You're on the clock")).toBeVisible({
    timeout: 15_000,
  });
  // The auction has the same persisted sound toggle as the inhouse room. It
  // renders only for viewers the room can ring for — a captain always — so
  // it is checked here rather than on the admin's page (whether the admin
  // qualifies depends on the seed putting them in the pool).
  await expect(
    capOnePage.getByRole("button", { name: /Sound on|Muted/ }),
  ).toBeVisible();

  // REGRESSION (2026-08-01): a tab that parked on /draft pre-start and
  // flipped live via its own poll never attached the compact clock bar's
  // IntersectionObserver (the banner element mounts AFTER the hook's effect
  // already ran), so captains scrolled into the pool had no clock and no
  // one-tap action for the whole auction. Cap One parked before Start, so
  // this page is exactly that tab: scroll the banner away and the sticky
  // bar must pin under the header. (Target by title — the bar deliberately
  // has no aria-label; its content is its accessible name.)
  await capOnePage.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, document.body.scrollHeight);
  });
  await expect(
    capOnePage.getByTitle("Back to the auction clock"),
  ).toBeVisible();
  await capOnePage.evaluate(() => window.scrollTo(0, 0));
  // The scouting map comes with the page render, so this tab, parked before
  // Start, gets it from the room's refresh at Start. Once it lands the pool
  // says what a tap does for a captain on the clock.
  const capOnePool = capOnePage.locator("#player-pool");
  await expect(
    capOnePool.getByText(
      "Tap a player to line them up and see their scouting.",
    ),
  ).toBeVisible({ timeout: 15_000 });
  const topsonRow = capOnePool.getByRole("button", { name: /Topson/ });
  await topsonRow.click();
  // Lining Topson up opens his scouting under his row (seeded by
  // e2e/seed-draft-scouting.ts), and the row is still the one pick button.
  const topsonPoolCard = capOnePool.getByRole("group", {
    name: "Scouting: Topson",
  });
  await expect(topsonPoolCard).toBeVisible({ timeout: 15_000 });
  await expect(topsonPoolCard).toContainText("Recent pubs");
  await expect(topsonPoolCard).toContainText(/Their last \d+ public games/);
  await expect(topsonRow).toHaveCount(1);
  await expect(topsonRow).toHaveAttribute("aria-pressed", "true");
  await expect(topsonRow).toHaveAttribute(
    "aria-controls",
    (await topsonPoolCard.getAttribute("id"))!,
  );
  const nominate = capOnePage.getByRole("button", {
    name: "Nominate",
    exact: true,
  });
  await expect(nominate).toHaveCount(1);
  await nominate.click();
  await expect(capOnePage.getByText("You hold the high bid.")).toBeVisible();
  // On the block, Topson's scouting moves from the pool to the lot card:
  // the pool's card closes, and the lot's shows his pub record (from the
  // page's map) and his about text (from the tick).
  await expect(topsonPoolCard).toHaveCount(0);
  const topsonLotCard = capOnePage.getByRole("group", {
    name: "Scouting: Topson",
  });
  await expect(topsonLotCard).toHaveCount(1);
  await expect(topsonLotCard).toBeVisible();
  await expect(topsonLotCard).toContainText(/Pubs \d+% in last \d+/);
  await expect(topsonLotCard).toContainText("About this player:");

  // With a lot live the admin can't line anyone up, so a pool row opens that
  // player's scouting instead: a disclosure, one tap open, the next shut.
  const adminPool = page.locator("#player-pool");
  await expect(
    adminPool.getByText("Tap a player to see their scouting."),
  ).toBeVisible({ timeout: 15_000 });
  const dendiRow = adminPool.getByRole("button", { name: /Dendi/ });
  await expect(dendiRow).toHaveCount(1);
  await expect(dendiRow).toHaveAttribute("aria-expanded", "false");
  await expect(dendiRow).not.toHaveAttribute("aria-pressed", /.*/);
  const dendiCard = adminPool.getByRole("group", { name: "Scouting: Dendi" });
  await expect(dendiCard).toHaveCount(0);
  await dendiRow.click();
  await expect(dendiRow).toHaveAttribute("aria-expanded", "true");
  await expect(dendiCard).toBeVisible();
  await expect(dendiCard).toContainText("Recent pubs");
  await expect(dendiRow).toHaveAttribute(
    "aria-controls",
    (await dendiCard.getAttribute("id"))!,
  );
  await dendiRow.click();
  await expect(dendiRow).toHaveAttribute("aria-expanded", "false");
  await expect(dendiCard).toHaveCount(0);

  // Cap Two sees the lot on a phone-sized room. The bid controls fit without
  // horizontal overflow, and an exact amount is available alongside quick
  // raises for captains coordinating a deliberate budget.
  await capTwoPage.setViewportSize({ width: 375, height: 812 });
  await expect(capTwoPage.getByText(/high bid|opening/).first()).toBeVisible();
  const exactBid = capTwoPage.getByLabel("Exact bid amount");
  await expect(exactBid).toBeVisible();
  expect(
    await capTwoPage.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await exactBid.fill("2");
  const bidResponsePromise = capTwoPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/draft/bid" &&
      response.request().method() === "POST",
  );
  await exactBid
    .locator("..")
    .getByRole("button", { name: "Bid $2", exact: true })
    .click();
  const bidResponse = await bidResponsePromise;
  const bidBody = await bidResponse.text();
  expect(
    bidResponse.ok(),
    `Bid endpoint returned ${bidResponse.status()}: ${bidBody}`,
  ).toBe(true);
  expect(JSON.parse(bidBody)).toMatchObject({ currentBid: 2 });
  await expect(capTwoPage.getByText("You hold the high bid.")).toBeVisible();

  // Cap One gets the outbid alarm with a one-tap re-bid…
  await expect(capOnePage.getByText("💸 Outbid!")).toBeVisible({
    timeout: 10_000,
  });
  await capOnePage.getByRole("button", { name: /Re-bid \$3/ }).click();
  // …and takes the high bid back. The lot's bid trail is on show for everyone.
  await expect(capOnePage.getByText("You hold the high bid.")).toBeVisible();
  await expect(capOnePage.getByText("Bid trail:")).toBeVisible();

  // Cap Two, next to nominate, lines Dendi up on the phone while Topson's lot
  // runs: his card opens under his row, and the room still fits 375px.
  const capTwoPool = capTwoPage.locator("#player-pool");
  await capTwoPool.getByRole("button", { name: /Dendi/ }).click();
  const capTwoDendiCard = capTwoPool.getByRole("group", {
    name: "Scouting: Dendi",
  });
  await expect(capTwoDendiCard).toBeVisible({ timeout: 15_000 });
  await expect(capTwoDendiCard).toContainText(/Their last \d+ public games/);
  // Topson is still on the block, his lot card on this page too.
  await expect(
    capTwoPage.getByRole("group", { name: "Scouting: Topson" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(
    capTwoPage,
    "Draft room at 375px with a lot live and a pool card open",
  );

  // Since each captain parked on /draft, through the start, the nomination
  // and three bids (each re-runs the room's poll effect): one tick in flight
  // at a time. Of two at once the server may read the later one first, and
  // request-start ordering would then keep the older lot.
  await expectOneRoomPollAtATime(capOnePage, "Cap One");
  await expectOneRoomPollAtATime(capTwoPage, "Cap Two");

  assertCapOneErrors();
  assertCapTwoErrors();
  await capOne.close();
  await capTwo.close();

  // Back on the admin panel the draft is locked: no re-run button (a re-run
  // would reset budgets over drafted rosters), no captain management — just
  // the way into the live room, plus the night-of controls.
  await page.goto("/admin");
  // Both the next-step line under the title and the Captains & draft card
  // lead into the live room.
  for (const room of ["Open the draft room", "Go to draft room"]) {
    const link = page.getByRole("link", { name: room });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/draft");
  }
  await expect(page.getByRole("button", { name: "Start draft" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "make captain" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Randomize order" }),
  ).toHaveCount(0);
  // The draft-night recovery controls are available while the auction runs.
  await expect(
    page.getByRole("button", { name: "Pause auction" }),
  ).toBeVisible();
  // Undo shows only once something has sold, and Topson's lot is still open:
  // there is nothing to undo yet, so there is no button to be refused.
  await expect(
    page.getByRole("button", { name: "Undo last sale" }),
  ).toHaveCount(0);
  assertAdminErrors();
});
