import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import path from "node:path";
import { LEAGUE_CONFIG } from "../src/lib/league-config";
import {
  expectNoHorizontalOverflow,
  trackPageErrors,
} from "../e2e-mid/helpers";

// The same disposable database as playwright.config.ts. Never inherit
// DATABASE_URL from a developer's shell or .env file.
const db = new PrismaClient({
  datasources: { db: { url: `file:${path.resolve("prisma/e2e.db")}` } },
});

test.afterAll(async () => {
  await db.$disconnect();
});

test("How it works explains the league on one screen and asks newcomers to join", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/how-it-works");
  await expect(page).toHaveTitle(`How it works · ${LEAGUE_CONFIG.name}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "How it works",
  );
  const main = page.locator("#main");
  await expect(main).toContainText(
    "GGD2L stands for Good Game Dota 2 League.",
  );
  for (const step of ["Sign up", "Draft night", "Weekly matches and playoffs"]) {
    await expect(
      main.getByRole("heading", { name: step, exact: true, level: 3 }),
    ).toBeVisible();
  }
  await expect(main.getByText("Who can join", { exact: true })).toBeVisible();
  // The seed's soft limit is 4,500; the hard ceiling is 5,000.
  await expect(main).toContainText("Players up to 5,000 MMR can join");
  await expect(main).toContainText("Above 4,500 MMR, an admin looks over");
  await expect(main).toContainText(
    `Games are on ${LEAGUE_CONFIG.gameServerRegion} servers`,
  );
  // Cred betting is gone; the page must not advertise it.
  await expect(main).not.toContainText(/\bcred\b/i);
  // One button. The signup fixture is in signups, so it is the header's
  // "Join Season 1", through sign-in. With only Steam it goes straight to
  // Steam; e2e has dev login on, so it goes to /login, where both live. The
  // note says what signing in shares, since the button can skip /login.
  const join = main.getByRole("link", { name: "Join Season 1" });
  await expect(join).toHaveCount(1);
  await expect(join).toHaveAttribute("href", "/login?next=/me");
  await expect(
    main.getByText(/so we never see your password or email\.$/),
  ).toBeVisible();
  await join.click();
  await expect(
    page.getByRole("heading", { name: `Sign in to ${LEAGUE_CONFIG.name}` }),
  ).toBeVisible();
  assertNoErrors();
});

test("How it works shows the match night the admin set", async ({ page }) => {
  const season = await db.season.findFirstOrThrow({
    where: { isActive: true },
    select: { id: true, matchSchedule: true },
  });
  const when = page
    .locator("#main dt", { hasText: "When and where" })
    .locator("xpath=following-sibling::dd[1]");
  try {
    await page.goto("/how-it-works");
    await expect(when).toContainText(
      season.matchSchedule || LEAGUE_CONFIG.matchSchedule.label,
    );
    await db.season.update({
      where: { id: season.id },
      data: { matchSchedule: "Wednesdays, 8pm ET" },
    });
    await page.goto("/how-it-works");
    await expect(when).toContainText("Wednesdays, 8pm ET");
    await expect(when).not.toContainText(LEAGUE_CONFIG.matchSchedule.label);
  } finally {
    await db.season.update({
      where: { id: season.id },
      data: { matchSchedule: season.matchSchedule },
    });
  }
});

test("How it works questions open from the keyboard", async ({ page }) => {
  await page.goto("/how-it-works");
  const question = page
    .locator("summary")
    .filter({ hasText: "Do I need to bring a team?" });
  await question.focus();
  await page.keyboard.press("Enter");
  await expect(question.locator("..")).toHaveAttribute("open", "");
  await expect(question.locator("..")).toContainText(
    "captains build the teams in the draft",
  );
  await page.keyboard.press("Enter");
  await expect(question.locator("..")).not.toHaveAttribute("open", "");
});

test("the old feature tour address lands on How it works", async ({ page }) => {
  await page.goto("/features#join");
  await expect(page).toHaveURL(/\/how-it-works#join$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "How it works",
  );
});

test("How it works fits phones and desktop in about a screen", async ({
  page,
}) => {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/how-it-works");
    await expectNoHorizontalOverflow(page, `How it works at ${width}px`);
  }
  // The feature tour it replaced was 17,800px tall on a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/how-it-works");
  const height = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  expect(height).toBeLessThan(3200);
});

test("the How it works button follows the viewer's signup", async ({
  page,
}) => {
  await page.goto(
    "/api/auth/dev?name=TourVisitor&steamId=76561190000000432&redirect=/how-it-works",
  );
  const main = page.locator("#main");
  await expect(
    main.getByRole("link", { name: "Join Season 1" }),
  ).toHaveAttribute("href", "/me");
  // Dev login updates the supplied display name. Preserve the seeded player
  // identity used by the later captain and draft tests in this shared suite.
  // Dendi is already signed up, so the button is the league Discord.
  await page.goto(
    "/api/auth/dev?name=Dendi&steamId=7656119800001002&redirect=/how-it-works",
  );
  await expect(main.getByRole("link", { name: "Join Season 1" })).toHaveCount(
    0,
  );
  if (LEAGUE_CONFIG.discordInviteUrl) {
    await expect(
      main.getByRole("link", { name: "Join our Discord" }),
    ).toHaveAttribute("href", LEAGUE_CONFIG.discordInviteUrl);
  } else {
    await expect(
      main.getByRole("link", { name: "League news" }),
    ).toHaveAttribute("href", "/news");
  }
});
