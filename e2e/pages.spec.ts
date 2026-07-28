import { test, expect } from "@playwright/test";

// Read-only render checks for the enhanced UI — these catch client-render /
// hydration errors a browser sees but a raw HTML fetch would not. They must not
// mutate season state (so they stay compatible with the smoke tests).

test("players page renders the pool scouting tools", async ({ page }) => {
  await page.goto("/players");
  await expect(page.getByPlaceholder("Search players…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Wants captain" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Filter by role" })).toBeVisible();
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
  await expect(page.getByText("Pool composition")).toBeVisible();
  // The old hero tagline went away when the footer was slimmed down — anchor
  // the footer assertion on its stable Discord CTA instead.
  await expect(
    page.getByRole("contentinfo").getByText("Join our Discord"),
  ).toBeVisible();
});

test("mobile menu surfaces club pages and My profile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  // Signed in, so the account group carries My profile.
  await page.goto(
    "/api/auth/dev?name=Menu+Tester&steamId=76561190000000042&redirect=/",
  );
  await page.getByRole("button", { name: "Open menu" }).click();
  const menu = page.locator("#mobile-nav");
  await expect(menu.getByRole("link", { name: "News" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Hall of Fame" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Record book" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "My profile" })).toBeVisible();
  // SIGNUPS phase: Features is already an inline nav item — the club group
  // must not duplicate it.
  await expect(menu.getByRole("link", { name: "Features" })).toHaveCount(1);
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
  // Seeded DB sits in SIGNUPS — that chapter (and only a chapter, not the
  // whole page) carries the live badge.
  await expect(page.getByText("Happening now")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Pick your obsession" }),
  ).toBeVisible();
});

test("profile page renders the searchable hero picker", async ({ page }) => {
  const steamId = "76561199" + String(Date.now()).slice(-9);
  await page.goto(
    `/api/auth/dev?name=HeroFan&steamId=${steamId}&redirect=/me`,
  );
  await expect(page.getByRole("heading", { name: "Your profile" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Add heroes" })).toBeVisible();
});
