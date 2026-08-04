import { test, expect } from "@playwright/test";

// Read-only render checks for the enhanced UI — these catch client-render /
// hydration errors a browser sees but a raw HTML fetch would not. They must not
// mutate season state (so they stay compatible with the smoke tests).

test("signed-out profile requests explain sign-in without a duplicate header CTA", async ({
  page,
}) => {
  await page.goto("/me");
  await expect(page).toHaveURL(/\/login\?next=%2Fme|\/login\?next=\/me/);
  await expect(
    page.getByRole("heading", { name: "Sign in to GGD2L", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Sign in to open your profile and continue setting up your league account.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("banner").getByRole("link", { name: "Sign in" }),
  ).toHaveCount(0);
  await expect(page.getByText("Steam signs you into this site.")).toBeVisible();
});

test("logout confirms the session ended", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const steamId = "76561198" + String(Date.now()).slice(-9);
  await page.goto(
    `/api/auth/dev?name=LogoutTester&steamId=${steamId}&redirect=/me`,
  );
  await page.getByRole("button", { name: "Logout", exact: true }).click();

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

test("home renders the season timeline, pool composition, and footer", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Pool composition", level: 2 }),
  ).toBeVisible();
  // The old hero tagline went away when the footer was slimmed down — anchor
  // the footer assertion on its stable Discord CTA instead.
  await expect(
    page.getByRole("contentinfo").getByText("Join our Discord"),
  ).toBeVisible();
});

test("internal pages keep the active league phase visible in the header", async ({
  page,
}) => {
  await page.goto("/features");
  await expect(
    page.getByRole("link", {
      name: "League status: Season 1 — Signups",
    }),
  ).toBeVisible();
});

test("mobile menu surfaces club pages and My profile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  // Signed in, so the account group carries My profile.
  await page.goto(
    "/api/auth/dev?name=Menu+Tester&steamId=76561190000000042&redirect=/",
  );
  const profile = page.getByRole("link", { name: "My profile — Menu Tester" });
  const menuButton = page.getByRole("button", { name: "Open menu" });
  await expect(profile).toHaveCSS("min-height", "44px");
  await expect(menuButton).toHaveCSS("height", "44px");
  await menuButton.click();
  const menu = page.locator("#mobile-nav");
  await expect(menu.getByRole("link", { name: "News" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Hall of Fame" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Record book" })).toBeVisible();
  await expect(
    menu.getByRole("link", { name: "Compare players" }),
  ).toBeVisible();
  await expect(menu.getByRole("link", { name: "My profile" })).toBeVisible();
  // SIGNUPS phase: Features is already an inline nav item — the club group
  // must not duplicate it.
  await expect(menu.getByRole("link", { name: "Features" })).toHaveCount(1);
});

test("desktop Explore menu keeps evergreen league pages discoverable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/features");
  const button = page.getByRole("button", { name: /Explore/ });
  await expect(button).toBeVisible();
  await button.click();
  const explore = page.getByRole("navigation", { name: "Explore" });
  await expect(
    explore.getByRole("link", { name: "League news" }),
  ).toBeVisible();
  await expect(
    explore.getByRole("link", { name: "Record book" }),
  ).toBeVisible();
  await expect(
    explore.getByRole("link", { name: "Compare players" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(explore).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("features tour renders the showcase and phase-aware chapters", async ({
  page,
}) => {
  await page.goto("/features");
  await expect(
    page.getByRole("heading", { name: "Everything the league offers" }),
  ).toBeVisible();
  // Showcase mockups render (report card demo + mini bracket).
  await expect(
    page.getByRole("heading", { name: "Not your average league site" }),
  ).toBeVisible();
  await expect(page.getByText("Every game gets graded")).toBeVisible();
  await expect(
    page.getByText("Illustrative preview", { exact: true }),
  ).toHaveCount(3);
  // SIGNUPS has no report cards, scenario board, or playoff bracket yet. The
  // examples stay visible, but must not masquerade as live destinations.
  await expect(
    page.getByRole("link", { name: "Open this feature" }),
  ).toHaveCount(0);
  await expect(page.getByText("Five phases. One champion.")).toBeVisible();
  // Seeded DB sits in SIGNUPS — that chapter (and only a chapter, not the
  // whole page) carries the live badge.
  await expect(page.getByText("Happening now")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Signups are open", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Sign up with Steam" }).last(),
  ).toHaveAttribute("href", "/login?next=/me");
  await expect(
    page.getByRole("heading", { name: "Pick your obsession" }),
  ).toBeVisible();
  const obsessions = page.getByRole("region", { name: "Pick your obsession" });
  await expect(obsessions.getByRole("link", { name: "Leaders" })).toHaveCount(
    0,
  );
  await expect(obsessions.getByRole("link", { name: "Pick'em" })).toHaveCount(
    0,
  );
  await expect(obsessions.getByRole("link", { name: "Records" })).toBeVisible();
  await expect(
    obsessions.getByText(/Opens when regular-season results arrive/).first(),
  ).toBeVisible();
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
  }
});

test("profile page renders the searchable hero picker", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const steamId = "76561199" + String(Date.now()).slice(-9);
  await page.goto(`/api/auth/dev?name=HeroFan&steamId=${steamId}&redirect=/me`);
  await expect(
    page.getByRole("heading", { name: "Your profile" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Dota / Dotabuff account", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Discord", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Signup —/, level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "+ Add heroes" }),
  ).toBeVisible();
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
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
