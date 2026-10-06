import { LEAGUE_CONFIG } from "../src/lib/league-config";
import { test, expect } from "@playwright/test";
import { trackPageErrors } from "../e2e-mid/helpers";

// Read-only render checks for the enhanced UI — these catch client-render /
// hydration errors a browser sees but a raw HTML fetch would not. They must not
// mutate season state (so they stay compatible with the smoke tests).

test("signed-out profile requests explain sign-in without a duplicate header CTA", async ({
  page,
}) => {
  await page.goto("/me");
  await expect(page).toHaveURL(/\/login\?next=%2Fme|\/login\?next=\/me/);
  await expect(
    page.getByRole("heading", { name: `Sign in to ${LEAGUE_CONFIG.name}`, level: 1 }),
  ).toBeVisible();
  // The seed is in signups, so /me's sign-in says it is the way to join
  // (every Join link lands here with next=/me), not "continue setting up".
  await expect(
    page.getByText(/^Sign in with Steam to join .+\. Your signup form opens next\.$/),
  ).toBeVisible();
  await expect(
    page.getByRole("banner").getByRole("link", { name: "Sign in" }),
  ).toHaveCount(0);
  // One job: Steam is the one button, with the notice of what it shares
  // right under it. The Discord invite lives in the footer, not here.
  const main = page.locator("#main");
  await expect(
    main.getByRole("link", { name: "Sign in through Steam" }),
  ).toBeVisible();
  await expect(
    main.getByText(/so we never see your password or email\.$/),
  ).toBeVisible();
  await expect(main.getByRole("link", { name: /Discord/ })).toHaveCount(0);
  await expect(main.locator("img")).toHaveCount(0);
});

test("retired policy routes stay absent and the login page fits a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });

  const expectNoHorizontalOverflow = async () => {
    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(
      widths.document,
      `document width ${widths.document}px exceeds ${widths.viewport}px viewport`,
    ).toBeLessThanOrEqual(widths.viewport);
  };

  await page.goto("/login");
  await expect(page.locator('a[href="/privacy"]')).toHaveCount(0);
  await expect(page.locator('a[href="/terms"]')).toHaveCount(0);
  await expectNoHorizontalOverflow();

  const privacyResponse = await page.goto("/privacy");
  expect(privacyResponse?.status()).toBe(404);

  const termsResponse = await page.goto("/terms");
  expect(termsResponse?.status()).toBe(404);
});

test("logout confirms the session ended", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const steamId = "76561198" + String(Date.now()).slice(-9);
  await page.goto(
    `/api/auth/dev?name=LogoutTester&steamId=${steamId}&redirect=/me`,
  );
  await page.getByRole("button", { name: "Account — LogoutTester" }).click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();

  await expect(page).toHaveURL(/\/login\?signedOut=1$/);
  await expect(page.getByRole("status")).toContainText("You're signed out");
});

test("players page renders the pool scouting tools", async ({ page }) => {
  await page.goto("/players");
  await expect(page.getByPlaceholder("Search players…")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Wants captain" }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Filter by role" }),
  ).toBeVisible();
});

// Row density is the reader's own choice, kept on their device: one line a
// player, or the scouting line and the player's own words under each name.
// Signups open detailed; the reload is the assertion that matters.
test("the pool's scouting details toggle folds rows and survives a reload", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/players");
  const toggle = page.getByRole("button", { name: "Scouting details" });
  // A seeded signup's "about you" line, shown only in detailed rows. The seed
  // gives each signup one of these five notes at random (prisma/seed.ts
  // NOTES), so one fixed note is missing from about 1 seed in 36.
  const quote = page.getByText(
    /Flexible on role, good comms\.|Best on cores, can flex support\.|Reliable — rarely misses games\.|Aggressive playstyle, loves to gank\.|Comfortable drafting \/ shotcalling\./,
  );
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(quote.first()).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(quote).toHaveCount(0);

  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(quote).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(quote.first()).toBeVisible();
  assertNoErrors();
});

// The pool's filters live in the URL, so a captain can send someone "the pos-1
// free agents" and a reload doesn't silently drop what they were reading. The
// reload is the assertion that matters — mirroring TO the URL is easy to get
// right and seeding FROM it on mount is the half that rots.
test("pool filters survive a reload and a shared link", async ({ page }) => {
  await page.goto("/players");
  await page.getByRole("button", { name: "Position 1 — Carry" }).click();
  await page.getByRole("button", { name: "Wants captain" }).click();
  await expect(page).toHaveURL(/[?&]pos=1/);
  await expect(page).toHaveURL(/[?&]cap=1/);

  // Re-open the URL cold, as a recipient of the link would.
  await page.goto(page.url());
  await expect(
    page.getByRole("button", { name: "Position 1 — Carry" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Wants captain" }),
  ).toHaveAttribute("aria-pressed", "true");

  // Clearing returns to a bare /players rather than leaving dead params.
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/players$/);
});

test("season history lists every season with the current one badged", async ({
  page,
}) => {
  // Same dev-server caveat as the mid suite's /admin check: this is the only
  // visit to /seasons, so the navigation pays that route's first compile. It
  // renders in <1s warm, but on a loaded CI runner the cold compile has blown
  // the default budget and failed here — a timeout wearing an
  // element-not-found costume.
  test.slow();
  await page.goto("/seasons");
  await expect(
    page.getByRole("heading", { name: "Season history" }),
  ).toBeVisible();
  await expect(page.locator("#main").getByText("Season 1")).toBeVisible();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
});

test("home renders the season timeline, who's in, and footer", async ({
  page,
}) => {
  await page.goto("/");
  // The signup list carries the captains and the roles in short supply; the
  // old Pool composition card of role and MMR bars is gone.
  await expect(
    page.getByRole("heading", { name: "Who's in", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Pool composition" }),
  ).toHaveCount(0);
  // The old hero tagline went away when the footer was slimmed down — anchor
  // the footer assertion on its stable Discord CTA instead.
  const discord = page.getByRole("contentinfo").getByText("Join our Discord");
  if (LEAGUE_CONFIG.discordInviteUrl) {
    await expect(discord).toBeVisible();
    await expect(discord).toHaveAttribute("href", LEAGUE_CONFIG.discordInviteUrl);
  } else {
    await expect(discord).toHaveCount(0);
  }
  // One line on who runs the league and who fixes or removes a profile.
  await expect(page.getByRole("contentinfo")).toContainText(
    LEAGUE_CONFIG.footerNote,
  );
  const support = page.getByRole("contentinfo").getByRole("link", {
    name: "Support the league on Buy Me a Coffee (opens in a new tab)",
  });
  await expect(support).toHaveAttribute(
    "href",
    "https://buymeacoffee.com/vgedota",
  );
  await expect(support).toHaveAttribute("target", "_blank");
  await expect(support).toHaveAttribute("rel", "noopener noreferrer");
});

test("internal pages keep the active league phase visible in the header", async ({
  page,
}) => {
  await page.goto("/how-it-works");
  await expect(
    page.getByRole("link", {
      name: "League status: Season 1 — Signups open",
    }),
  ).toBeVisible();
});

test("signups put Join Season 1 in the header and the phone tab bar", async ({
  page,
}) => {
  await page.goto("/inhouse");
  const header = page.getByRole("banner");
  // Signed out: join through sign-in, and sign-in stays for returning players.
  await expect(
    header.getByRole("link", { name: "Join Season 1", exact: true }),
  ).toHaveAttribute("href", "/login?next=/me");
  await expect(
    header.getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const dock = page.getByRole("navigation", { name: "Quick navigation" });
  await expect(
    dock.getByRole("link", { name: "Join Season 1", exact: true }),
  ).toHaveAttribute("href", "/login?next=/me");
  // Join takes the Players tab; Inhouse keeps its tab and Players waits in
  // the tab bar's sheet.
  await expect(
    dock.getByRole("link", { name: "Inhouse", exact: true }),
  ).toHaveAttribute("href", "/inhouse");
  await expect(dock.getByRole("link", { name: "Players" })).toHaveCount(0);
  await dock.getByRole("button", { name: "Explore league" }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Explore league", exact: true })
      .getByRole("link", { name: "Players", exact: true }),
  ).toBeVisible();

  // Signed in without a signup, both go straight to the form on /me.
  const steamId = "76561197" + String(Date.now()).slice(-9);
  await page.goto(
    `/api/auth/dev?name=Join+Tester&steamId=${steamId}&redirect=/inhouse`,
  );
  await expect(
    dock.getByRole("link", { name: "Join Season 1", exact: true }),
  ).toHaveAttribute("href", "/me");
  await page.setViewportSize({ width: 1280, height: 800 });
  await header.getByRole("link", { name: "Join Season 1", exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  // The form is right there, so the header button steps aside.
  await expect(
    header.getByRole("link", { name: "Join Season 1", exact: true }),
  ).toHaveCount(0);
});

test("phones get one menu: the tab bar's sheet, plus the avatar's account menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(
    "/api/auth/dev?name=Menu+Tester&steamId=76561190000000042&redirect=/",
  );
  // The ☰ menu is gone: it listed the same pages as the tab bar's sheet.
  await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);

  // The avatar opens the same account menu as on desktop.
  const account = page.getByRole("button", { name: "Account — Menu Tester" });
  await expect(account).toHaveCSS("min-height", "44px");
  await account.click();
  const accountMenu = page.getByRole("navigation", {
    name: "Account",
    exact: true,
  });
  await expect(
    accountMenu.getByRole("link", { name: "My account" }),
  ).toBeVisible();
  await expect(
    accountMenu.getByRole("button", { name: "Log out" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(accountMenu).toHaveCount(0);
  await expect(account).toBeFocused();

  const dock = page.getByRole("navigation", { name: "Quick navigation" });
  await dock.getByRole("button", { name: "Explore league" }).click();
  const sheet = page.getByRole("navigation", {
    name: "Explore league",
    exact: true,
  });
  await expect(sheet.getByRole("link", { name: "League news" })).toBeVisible();
  // This league has no games or champion yet, so its empty statistics pages
  // and the Hall of Fame are not offered (they stay reachable by address).
  for (const label of ["Hall of Fame", "Record book", "Compare players"]) {
    await expect(sheet.getByRole("link", { name: label })).toHaveCount(0);
  }
  // How it works lives in Explore's League group, listed once; Merch once too.
  await expect(sheet.getByRole("link", { name: "How it works" })).toHaveCount(1);
  await expect(sheet.getByRole("link", { name: /Merch/ })).toHaveCount(1);
  // No page is both a tab and an entry in the sheet.
  for (const label of await dock.getByRole("link").allTextContents()) {
    await expect(
      sheet.getByRole("link", { name: label.trim(), exact: true }),
    ).toHaveCount(0);
  }
});

test("desktop Explore menu keeps evergreen league pages discoverable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/how-it-works");
  const button = page.getByRole("button", { name: /Explore/ });
  await expect(button).toBeVisible();
  await button.click();
  const explore = page.getByRole("navigation", { name: "Explore" });
  await expect(
    explore.getByRole("link", { name: "League news" }),
  ).toBeVisible();
  // No league game is on record yet, so the statistics pages (all empty)
  // and the Hall of Fame (no champion) wait; the Statistics group with them.
  for (const label of ["Record book", "Compare players", "Hall of Fame"]) {
    await expect(explore.getByRole("link", { name: label })).toHaveCount(0);
  }
  await expect(explore.getByText("Statistics", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(explore).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("public statistics and news explain their pre-result empty states", async ({
  page,
}) => {
  for (const [path, emptyTitle] of [
    ["/leaders", "No stats yet"],
    ["/meta", "No games yet"],
    ["/records", "No records yet"],
    ["/players/compare", "No player careers yet"],
    ["/news", "Nothing yet"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByText(emptyTitle, { exact: true })).toBeVisible();
    // Every statistics page is empty too, so the tab bar between them is
    // left out until the first game.
    await expect(
      page.getByRole("navigation", { name: "Statistics" }),
    ).toHaveCount(0);
  }
  // Nor do other pages point at them: no game yet means nothing to compare,
  // and no champion means no Hall of Fame.
  await page.goto("/records");
  await expect(
    page.locator('#main a[href="/hall-of-fame"]'),
  ).toHaveCount(0);
  await page.goto("/players");
  await expect(
    page.locator('#main a[href^="/players/compare"]'),
  ).toHaveCount(0);
  await page.goto("/seasons");
  await expect(
    page.locator('#main a[href="/hall-of-fame"]'),
  ).toHaveCount(0);
});

test("profile page renders the searchable hero picker", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const steamId = "76561199" + String(Date.now()).slice(-9);
  await page.goto(`/api/auth/dev?name=HeroFan&steamId=${steamId}&redirect=/me`);
  await expect(
    page.getByRole("heading", { name: "My account" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Steam & Dota", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Discord", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Signup —/, level: 2 }),
  ).toBeVisible();
  await page.locator("summary").filter({ hasText: "Optional scouting profile" }).click();
  await expect(
    page.getByRole("button", { name: "+ Add heroes" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "+ Add heroes" }).click();
  await page.getByPlaceholder("Search heroes…").fill("Axe");
  await page.getByRole("button", { name: "Axe", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("captain setup and draft preflight fit a phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(
    "/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=/admin",
  );
  await expect(
    page.getByRole("heading", { name: "Captains & draft", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Draft preflight", level: 3 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Randomize order" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Start draft" }),
  ).toBeDisabled();
  const runner = page.locator("#adm-automation");
  await expect(
    runner.getByRole("heading", { name: "Automation runner", level: 3 }),
  ).toBeVisible();
  // A healthy runner folds to one line; its details stay one click away.
  const folded = runner.locator("details:not([open]) > summary");
  if (await folded.count()) await folded.click();
  await expect(
    runner.getByRole("button", { name: "Run maintenance now" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
