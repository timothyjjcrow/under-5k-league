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
  await expect(
    page.getByText(
      "A drafted, team-based Dota 2 league built around a soft 4.5K MMR limit.",
    ),
  ).toBeVisible();
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
