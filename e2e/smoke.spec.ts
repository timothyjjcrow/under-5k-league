import { test, expect } from "@playwright/test";

test("home shows the signups phase for the seeded season", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Season 1" })).toBeVisible();
  await expect(page.getByText("Signups open")).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await expect(page.getByText("phase control")).toBeVisible();
  await expect(page.getByText("Create a new season")).toBeVisible();
});

test("non-admin is redirected away from admin", async ({ page }) => {
  const steamId = "7656119" + String(Date.now() + 1).slice(-10);
  await page.goto(
    `/api/auth/dev?name=Regular&steamId=${steamId}&redirect=/admin`,
  );
  // Redirected to home (no admin heading).
  await expect(page).toHaveURL("http://localhost:3000/");
});
