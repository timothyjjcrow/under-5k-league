import { test, expect } from "@playwright/test";
import { LEAGUE_CONFIG } from "../src/lib/league-config";
import {
  expectNoHorizontalOverflow,
  trackPageErrors,
} from "../e2e-mid/helpers";

// The signup fixture's Season 1 runs on the schema defaults (Bo2 / Bo3 / Bo5,
// teams of 5, a 4,500 soft MMR limit). Every sentence comes from leagueRules
// (src/lib/league-rules.ts); this checks the page renders it whole.
const SECTIONS = [
  "Series format",
  "Standings and tiebreakers",
  "Playoffs",
  "Forfeits and withdrawals",
  "Rosters and standins",
  "Match night and rescheduling",
  "Hosting the lobby",
  "Signups and eligibility",
  "The auction draft",
  "Results and game imports",
];

test("Rules puts the league's rules on one page, from the season's settings", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/rules");
  await expect(page).toHaveTitle(`Rules · ${LEAGUE_CONFIG.name}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rules");
  const main = page.locator("#main");
  for (const name of SECTIONS) {
    await expect(
      main.getByRole("heading", { level: 2, name, exact: true }),
    ).toBeVisible();
  }
  await expect(main).toContainText("How");
  await expect(main).toContainText(`plays Season 1.`);
  await expect(main).toContainText(
    "Regular season: best of 2. Playoffs: best of 3. Grand final: best of 5.",
  );
  await expect(main).toContainText("Bo2 = two separate lobbies.");
  await expect(main).toContainText("Players up to 5,000 MMR can join");
  await expect(main).toContainText("Above 4,500 MMR, an admin looks over");
  await expect(main).toContainText(
    `Lobbies are Captains Mode on ${LEAGUE_CONFIG.gameServerRegion} servers.`,
  );
  // Nothing on the page is a default when a season exists.
  await expect(main.getByText("First-season defaults")).toHaveCount(0);
  await expect(
    main.getByText("Admins rule on anything not written here.", {
      exact: true,
    }),
  ).toBeVisible();

  // The jump links land each section clear of the sticky header.
  await main
    .getByRole("navigation", { name: "Rules sections" })
    .getByRole("link", { name: "Forfeits and withdrawals", exact: true })
    .click();
  await expect(page).toHaveURL(/\/rules#forfeits$/);
  await expect(
    main.getByRole("heading", {
      level: 2,
      name: "Forfeits and withdrawals",
      exact: true,
    }),
  ).toBeInViewport();
  const top = await page.locator("#forfeits").evaluate(
    (card) => card.getBoundingClientRect().top,
  );
  expect(top).toBeGreaterThanOrEqual(64);
  assertNoErrors();
});

test("Rules fits phones and tablets without sideways scroll", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/rules");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rules");
    await expectNoHorizontalOverflow(page, `Rules at ${width}px`);
  }
  assertNoErrors();
});

test("How it works and the Explore menu lead to the rules", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/how-it-works");
  await page
    .locator("#main")
    .getByRole("link", { name: "League rules", exact: true })
    .click();
  await expect(page).toHaveURL(/\/rules$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rules");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  const explore = page.getByRole("navigation", { name: "Explore", exact: true });
  await expect(
    explore.getByRole("link", { name: "Rules", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  assertNoErrors();
});
