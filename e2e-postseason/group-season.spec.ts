import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { POSTSEASON_DB_URL } from "../playwright.postseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "../e2e-mid/helpers";

// A ten-team league plays two groups of five (season-format.ts). The seeder
// builds it the way the site would: an MMR-strength snake into groups A and B,
// each a round robin on the same weeks, then a crossover bracket.
async function seedTenTeams(page: Page, mode: "regular" | "playoffs") {
  execFileSync(process.execPath, ["--import", "tsx", "e2e-postseason/seed.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: POSTSEASON_DB_URL,
      FIXTURE_MODE: mode,
      FIXTURE_TEAMS: "10",
    },
    stdio: "pipe",
  });
  expect((await page.request.post("/api/test/cache")).ok()).toBe(true);
}

test("a ten-team regular season shows two group tables, the season plan and the format", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await seedTenTeams(page, "regular");
  const assertNoErrors = trackPageErrors(page);

  await page.goto("/schedule");
  for (const key of ["A", "B"]) {
    const table = page.getByRole("table", { name: `Group ${key} standings`, exact: true });
    await expect(table).toBeVisible();
    // A header row and five teams.
    await expect(table.getByRole("row")).toHaveCount(6);
  }
  await expect(
    page.getByRole("table", { name: "League standings", exact: true }),
  ).toHaveCount(0);
  // Each group draws its own cut, under its fourth place.
  await expect(page.locator("#standings").getByText("Playoff cut · 4 places")).toHaveCount(2);
  await expect(page.locator("#standings")).toContainText(
    "Top 4 of each group make the playoffs",
  );

  const plan = page.locator("details").filter({ hasText: "Season plan" });
  await expect(plan).toContainText("Two groups of 5");
  await plan.locator("summary").click();
  const steps = plan.getByRole("list", { name: "Season plan" });
  await expect(steps).toContainText("Group stage");
  await expect(steps).toContainText("Tiebreakers");
  await expect(steps).toContainText("Quarterfinals");
  await expect(steps).toContainText("Grand final");

  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page, "/schedule in a group season");
  await page.goto("/");
  await expect(
    page.getByRole("table", { name: "Group A standings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Group B standings", exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "Home in a group season");
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto("/rules");
  const format = page.locator("#format");
  await expect(format.getByRole("heading", { name: "Season format" })).toBeVisible();
  await expect(format).toContainText("This season has 10 teams: two groups of 5.");
  await expect(page.locator("#playoffs")).toContainText(
    "Round one crosses the groups: A1 v B4, B2 v A3, B1 v A4, A2 v B3",
  );

  await page.goto("/api/auth/dev?name=Group%20Admin&admin=1");
  await page.goto("/admin#adm-schedule");
  const box = page.getByRole("region", { name: "Season format" });
  await expect(box).toContainText("Season format · 10 teams");
  await expect(box.getByRole("heading", { name: "Group A", exact: true })).toBeVisible();
  await expect(box.getByRole("heading", { name: "Group B", exact: true })).toBeVisible();
  // Results are in, so the groups can no longer be swapped.
  await expect(box.getByRole("button", { name: "Swap teams" })).toHaveCount(0);
  assertNoErrors();
});

test("a group season's bracket crosses the groups and names its seeds", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await seedTenTeams(page, "playoffs");
  const assertNoErrors = trackPageErrors(page);

  await page.goto("/schedule");
  const bracket = page.getByRole("region", { name: "Playoff bracket" });
  await expect(
    bracket.getByRole("heading", { name: "Quarterfinals", level: 3 }),
  ).toHaveCount(2);
  // Every quarterfinal is one group against the other, seeds named by group.
  for (const seed of ["A1", "B1", "A2", "B2", "A3", "B3", "A4", "B4"]) {
    await expect(bracket.getByText(seed, { exact: true })).toHaveCount(1);
  }
  const traced = await bracket
    .locator('button[title^="Trace "]')
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label") ?? ""));
  expect(traced.some((label) => /seed A1/.test(label))).toBe(true);

  await page.goto("/teams");
  const rosters = page.getByRole("region", { name: "Team rosters" });
  await expect(rosters).toBeVisible();
  await expect(rosters.getByText("Missed the playoffs", { exact: true })).toHaveCount(2);
  assertNoErrors();
});
